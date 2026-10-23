import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PIPELINE_FILE, parsePipelineConfig, expandPipeline, describePipelines, pipelineConfigHash, cronMatches } from '@perpeto/delivery';
import { fail, integer, nonblank, object, requireValue } from '../errors.js';
import { hubRepository, localRepository, servedFromHub } from '../delivery/index.js';
import { CiStore } from './store.js';
import { Runners } from './runners.js';
import { insights } from './insights.js';

const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
export const TERMINAL_RUN = new Set(['passed', 'failed', 'cancelled', 'error']);
const TERMINAL_JOB = new Set(['passed', 'failed', 'cancelled', 'error', 'skipped']);
const ACTIVE_HUB_JOB = new Set(['queued', 'leased', 'running']);
const SUPERSEDABLE = new Set(['manual', 'pull-request', 'schedule']);
const RUN_STATUSES = ['queued', 'running', 'passed', 'failed', 'cancelled', 'error'];

/**
 * Pipeline runs: a repository pipeline (`.perpeto/ci.json`, or the project's hub-stored fallback) run at one revision as
 * a DAG of hub Jobs. Jobs are created only once everything they need passed, so runners never lease blocked work; a
 * failure skips its dependents and finishes the run once nothing is left running. Workflow `ci` nodes that name a
 * pipeline, and merge-queue candidates whose required checks name pipelines, are "proxy" jobs: the hub never leases
 * them and instead completes them, once, from the outcome of the pipeline runs they started.
 */
export class HubPipelines {
  constructor(hub) {
    this.hub = hub; this.store = hub.store;
    this.ci = new CiStore(hub); this.runners = new Runners(hub);
    this.configs = new Map(); this.lastMinute = null; this.lastSweep = 0; this.quiet = false;
  }
  now() { return this.hub.now(); }

  // ---- configuration --------------------------------------------------------------------------------------------
  git(repository, args) {
    try {
      return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repository, encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    } catch { return null; }
  }
  repositoryOf(project) { try { return localRepository(project.repo); } catch { return null; } }
  head(repository, branch) {
    if (!repository || !BRANCH.test(branch ?? '')) return null;
    const sha = this.git(repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])?.trim();
    return sha && SHA.test(sha) ? sha : null;
  }
  /**
   * The pipeline configuration for a project at a revision: the repository file when the hub holds the repository
   * and the file exists at that revision, else the project's hub-stored configuration. Invalid repository files are
   * reported, never silently replaced by the fallback.
   */
  resolve(project, revision, repository = this.repositoryOf(project)) {
    if (repository && revision && SHA.test(revision)) {
      const key = `${repository}\0${revision}`;
      const cached = this.configs.get(key);
      if (cached) return cached;
      const text = this.git(repository, ['show', `${revision}:${PIPELINE_FILE}`]);
      if (text !== null) {
        const parsed = parsePipelineConfig(text);
        const result = parsed.errors.length ? { source: 'repo', revision, errors: parsed.errors }
          : { source: 'repo', revision, config: parsed.config, configHash: pipelineConfigHash(parsed.config) };
        if (this.configs.size >= 256) this.configs.delete(this.configs.keys().next().value);
        this.configs.set(key, result);
        return result;
      }
    }
    const stored = this.store.get('ci-config', project.id);
    if (stored?.config) {
      const parsed = parsePipelineConfig(stored.config);
      return parsed.errors.length ? { source: 'project', revision: revision ?? null, errors: parsed.errors }
        : { source: 'project', revision: revision ?? null, config: parsed.config, configHash: pipelineConfigHash(parsed.config) };
    }
    return { source: 'none', revision: revision ?? null };
  }
  /** Pipeline names a project offers now: at its default branch head, or from its hub-stored configuration. */
  names(project) {
    const repository = this.repositoryOf(project);
    const resolved = this.resolve(project, this.head(repository, project.repo.defaultBranch), repository);
    return Object.keys(resolved.config?.pipelines ?? {});
  }
  /**
   * Pipelines a merge-queue entry must pass: ci nodes that name a pipeline, and required checks that name a project
   * pipeline rather than a ci node. With neither, pipelines declaring a `merge-queue` trigger apply when the graph has
   * no inline CI. Returns `{ pipelines, checks }`, where `checks` are the required names the pipelines prove.
   */
  forMerge(project, required, sources, ciNodes) {
    const nodeIds = new Set(ciNodes.map(node => node.id));
    const fromNodes = sources.filter(node => node.config.pipeline).map(node => node.config.pipeline);
    const wanted = required.filter(name => !nodeIds.has(name));
    if (!fromNodes.length && !wanted.length && sources.some(node => node.config.steps?.length)) return { pipelines: [], checks: [] };
    const repository = this.repositoryOf(project);
    const resolved = this.resolve(project, this.head(repository, project.repo.defaultBranch), repository);
    const available = resolved.config?.pipelines ?? {};
    const fromChecks = wanted.filter(name => Object.hasOwn(available, name));
    const triggered = !fromNodes.length && !fromChecks.length && !ciNodes.length
      ? Object.entries(available).filter(([, pipeline]) => pipeline.triggers.some(trigger => trigger.on === 'merge-queue')).map(([name]) => name) : [];
    return { pipelines: [...new Set([...fromNodes, ...fromChecks, ...triggered])], checks: fromChecks };
  }

  // ---- runs -----------------------------------------------------------------------------------------------------
  /**
   * Create a pipeline run and queue its first jobs. `strict` (manual triggers) refuses unknown pipelines and invalid
   * configuration; automatic triggers record an `error` run instead, so the outcome is visible and proxies settle.
   */
  create({ project, pipeline, revision, ref, trigger, repository = this.repositoryOf(project), strict = false }) {
    requireValue(typeof revision === 'string' && SHA.test(revision), 'A full commit SHA revision is required.');
    const resolved = this.resolve(project, revision, repository);
    const expanded = resolved.config ? expandPipeline(resolved.config, pipeline) : null;
    const at = this.now();
    const run = { id: id('plr'), projectId: project.id, pipeline, revision, ...(ref ? { ref } : {}), trigger, status: 'queued',
      configSource: resolved.source, ...(resolved.configHash ? { configHash: resolved.configHash } : {}), jobs: [], createdAt: at };
    if (!expanded) {
      const reason = resolved.errors ? `Invalid ${resolved.source === 'repo' ? PIPELINE_FILE : 'project CI configuration'}: ${resolved.errors[0].path} ${resolved.errors[0].message}`
        : resolved.source === 'none' ? `No CI configuration: add ${PIPELINE_FILE} or a project CI configuration.` : `No pipeline named "${pipeline}".`;
      if (strict) fail(resolved.errors ? 400 : 404, resolved.errors ? 'PIPELINE_CONFIG_INVALID' : 'PIPELINE_NOT_FOUND', reason);
      Object.assign(run, { status: 'error', reason, finishedAt: at, durationMs: 0 });
      this.store.put('pipeline-run', run); this.hub.emit('pipeline-run.finished', 'pipeline-run', run, { status: 'error', reason });
      return run;
    }
    run.jobs = expanded.jobs.map(job => ({ key: job.key, name: job.name, ...(job.matrix ? { matrix: job.matrix } : {}), needs: job.needs, runsOn: job.runsOn,
      status: 'waiting', attempt: 0, maxAttempts: job.maxAttempts, attempts: [] }));
    this.store.put('pipeline-def', { id: run.id, repository: repository ?? null, jobs: Object.fromEntries(expanded.jobs.map(job => [job.key, job])) });
    if (ref && SUPERSEDABLE.has(trigger.kind)) {
      for (const old of this.store.byStatus('pipeline-run', ['queued', 'running'], value => value.projectId === project.id && value.pipeline === pipeline && value.ref === ref && SUPERSEDABLE.has(value.trigger?.kind))) {
        old.supersededBy = run.id;
        this.cancelRun(old, `Superseded by ${run.id}.`);
        this.hub.emit('pipeline-run.superseded', 'pipeline-run', old, { by: run.id });
      }
    }
    this.hub.emit('pipeline-run.created', 'pipeline-run', run, { pipeline, revision, trigger: trigger.kind });
    this.advance(run);
    this.store.put('pipeline-run', run);
    return run;
  }
  /** Queue every waiting job whose needs passed and skip those whose needs cannot pass, then finish a settled run. */
  advance(run) {
    const def = this.store.get('pipeline-def', run.id);
    for (let changed = true; changed;) {
      changed = false;
      for (const job of run.jobs.filter(item => item.status === 'waiting')) {
        const needs = job.needs.map(key => run.jobs.find(item => item.key === key));
        if (needs.some(item => !item || ['failed', 'error', 'cancelled', 'skipped'].includes(item.status))) { job.status = 'skipped'; changed = true; }
        else if (needs.every(item => item.status === 'passed')) { this.enqueue(run, job, def.jobs[job.key]); changed = true; }
      }
    }
    this.finalize(run);
  }
  enqueue(run, job, definition) {
    const project = this.store.need('project', run.projectId);
    const def = this.store.get('pipeline-def', run.id);
    const at = this.now();
    const value = { id: id('job'), projectId: run.projectId, pipelineRunId: run.id, pipelineJob: job.key, revision: run.revision, steps: definition.steps,
      requirements: definition.runsOn.os ? { os: definition.runsOn.os } : {}, runsOn: { ...(definition.runsOn.pool ? { pool: definition.runsOn.pool } : {}), labels: definition.runsOn.labels },
      env: definition.env, cache: definition.cache, collect: definition.artifacts, timeoutSec: definition.timeoutSec,
      configHash: definition.configHash, status: 'queued', attempt: 1, artifacts: [], createdAt: at };
    // A revision the hub holds is fetched from the hub by any machine; otherwise runners clone the project repository.
    const job$ = def?.repository ? servedFromHub(value, project.repo) : { ...value, repo: structuredClone(project.repo) };
    this.store.put('job', job$); this.hub.emit('job.updated', 'job', job$, { status: 'queued', source: 'pipeline', pipelineRunId: run.id });
    job.status = 'queued'; job.jobId = job$.id; job.attempt += 1; job.queuedAt = at;
    for (const key of ['startedAt', 'finishedAt', 'durationMs', 'queueWaitMs', 'machineId']) delete job[key];
    job.attempts.push({ jobId: job$.id, status: 'queued', queuedAt: at });
  }
  finalize(run) {
    if (TERMINAL_RUN.has(run.status) || run.jobs.some(job => !TERMINAL_JOB.has(job.status))) return;
    const has = status => run.jobs.some(job => job.status === status);
    run.status = run.cancelRequested ? 'cancelled' : has('failed') ? 'failed' : has('error') ? 'error' : has('cancelled') ? 'cancelled' : has('skipped') ? 'failed' : 'passed';
    run.finishedAt = this.now(); run.durationMs = Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt ?? run.createdAt));
    this.hub.emit('pipeline-run.finished', 'pipeline-run', run, { status: run.status, durationMs: run.durationMs, pipeline: run.pipeline });
  }
  cancelRun(run, reason) {
    if (TERMINAL_RUN.has(run.status)) return run;
    run.cancelRequested = true; run.reason = reason;
    this.quiet = true;
    try {
      for (const job of run.jobs) {
        if (TERMINAL_JOB.has(job.status)) continue;
        const value = job.jobId && this.store.get('job', job.jobId);
        if (value && ACTIVE_HUB_JOB.has(value.status)) this.hub.cancelWork('job', value);
        const attempt = job.attempts.at(-1);
        if (attempt && !TERMINAL_JOB.has(attempt.status)) { attempt.status = 'cancelled'; attempt.finishedAt = this.now(); }
        job.status = 'cancelled';
      }
    } finally { this.quiet = false; }
    this.finalize(run);
    this.store.put('pipeline-run', run);
    return run;
  }
  retry(run, key) {
    requireValue(TERMINAL_RUN.has(run.status), 'Only a finished pipeline run can be retried.');
    const retryable = job => ['failed', 'error', 'cancelled', 'skipped'].includes(job.status);
    const targets = key === undefined ? run.jobs.filter(retryable) : [run.jobs.find(job => job.key === key)];
    if (key !== undefined && !targets[0]) fail(404, 'NOT_FOUND', 'No job with that key in this run.');
    requireValue(targets.length && targets.every(retryable), 'Nothing to retry: choose a failed, cancelled or skipped job.');
    // The job and everything downstream of it that has not passed runs again.
    const reset = new Set(targets.map(job => job.key));
    for (let grew = true; grew;) {
      grew = false;
      for (const job of run.jobs) if (!reset.has(job.key) && job.status !== 'passed' && job.needs.some(need => reset.has(need))) { reset.add(job.key); grew = true; }
    }
    for (const job of run.jobs) {
      if (!reset.has(job.key)) continue;
      const needs = job.needs.map(need => run.jobs.find(item => item.key === need));
      requireValue(needs.every(item => item.status === 'passed' || reset.has(item.key)), `Retry the jobs "${job.key}" needs first.`);
      job.status = 'waiting';
    }
    for (const field of ['finishedAt', 'durationMs', 'cancelRequested', 'reason']) delete run[field];
    run.status = 'running'; run.retries = (run.retries ?? 0) + 1;
    this.hub.emit('pipeline-run.retried', 'pipeline-run', run, { ...(key !== undefined ? { job: key } : {}), jobs: [...reset] });
    this.advance(run);
    this.store.put('pipeline-run', run);
    return run;
  }

  // ---- job lifecycle hooks (called by the hub inside its request transaction) ---------------------------------------
  /** Every job event: stamp start times, and move the pipeline job it belongs to. */
  jobEvent(value, type) {
    if (type !== 'started') return;
    value.startedAt ??= this.now();
    if (!value.pipelineRunId) return;
    const run = this.store.get('pipeline-run', value.pipelineRunId);
    const job = run?.jobs.find(item => item.jobId === value.id);
    if (!job || TERMINAL_JOB.has(job.status)) return;
    const at = this.now(); const attempt = job.attempts.at(-1);
    job.status = 'running'; job.startedAt = at; job.machineId = value.machineId;
    job.queueWaitMs = Math.max(0, Date.parse(at) - Date.parse(job.queuedAt));
    Object.assign(attempt, { status: 'running', startedAt: at, machineId: value.machineId });
    if (run.status === 'queued') { run.status = 'running'; run.startedAt = at; this.hub.emit('pipeline-run.started', 'pipeline-run', run, { pipeline: run.pipeline }); }
    this.store.put('pipeline-run', run);
  }
  /** A pipeline job's final result: record evidence, apply the retry policy, detect flakiness and move the DAG on. */
  async finished(value, data) {
    const run = this.store.get('pipeline-run', value.pipelineRunId);
    const job = run?.jobs.find(item => item.jobId === value.id);
    if (!job || TERMINAL_JOB.has(job.status)) return;
    if (TERMINAL_RUN.has(run.status)) return;
    const at = this.now(); const attempt = job.attempts.at(-1);
    Object.assign(attempt, { status: value.status, finishedAt: at, machineId: value.machineId });
    job.finishedAt = at; job.machineId = value.machineId;
    job.durationMs = Math.max(0, Date.parse(at) - Date.parse(job.startedAt ?? at));
    if (Array.isArray(data.cache)) job.cache = data.cache.slice(0, 8).filter(item => item && typeof item.key === 'string').map(item => ({ key: item.key.slice(0, 300), hit: item.hit === true }));
    const artifacts = this.ci.artifacts(value.id).filter(item => item.complete);
    job.artifacts = artifacts.map(item => ({ id: item.id, jobId: value.id, name: item.name, path: item.path, size: item.size }));
    value.artifacts = artifacts.map(item => ({ id: item.id, name: item.name, path: item.path, size: item.size, sha256: item.sha256, ref: `/api/v1/jobs/${value.id}/artifacts/${item.id}` }));
    this.store.put('job', value);
    job.status = value.status;
    if (['passed', 'failed'].includes(value.status)) this.detectFlaky(run, job);
    if (['failed', 'error'].includes(value.status) && job.attempts.length < job.maxAttempts && !run.cancelRequested) {
      this.hub.emit('pipeline-job.retried', 'pipeline-run', run, { job: job.key, attempt: job.attempt + 1, reason: 'policy', previous: value.status });
      this.enqueue(run, job, this.store.need('pipeline-def', run.id).jobs[job.key]);
    }
    this.advance(run);
    this.store.put('pipeline-run', run);
    if (TERMINAL_RUN.has(run.status)) await this.settle(run);
  }
  /** A hub job was cancelled: a proxy cancels its pipeline runs; a pipeline job's cancellation skips its dependents. */
  onCancel(value) {
    if (value.pipelineProxy) {
      for (const runId of value.pipelineProxy.runIds) { const run = this.store.get('pipeline-run', runId); if (run) this.cancelRun(run, 'Its job was cancelled.'); }
      return;
    }
    if (!value.pipelineRunId || this.quiet) return;
    const run = this.store.get('pipeline-run', value.pipelineRunId);
    const job = run?.jobs.find(item => item.jobId === value.id);
    if (!job || TERMINAL_JOB.has(job.status)) return;
    const attempt = job.attempts.at(-1);
    Object.assign(attempt, { status: 'cancelled', finishedAt: this.now() });
    job.status = 'cancelled'; job.finishedAt = attempt.finishedAt;
    this.advance(run);
    this.store.put('pipeline-run', run);
  }
  /** Same revision, same job, both a pass and a failure: the job is flaky. Counted once per revision. */
  detectFlaky(run, job) {
    const outcomes = new Set(job.attempts.map(item => item.status));
    if (!(outcomes.has('passed') && outcomes.has('failed'))) {
      const others = this.store.db.prepare(`SELECT data FROM entities WHERE kind='pipeline-run' AND json_extract(data,'$.projectId')=? AND json_extract(data,'$.revision')=? AND id<>?`)
        .all(run.projectId, run.revision, run.id).map(row => JSON.parse(row.data)).filter(other => other.pipeline === run.pipeline);
      for (const other of others) for (const item of other.jobs.find(candidate => candidate.key === job.key)?.attempts ?? []) outcomes.add(item.status);
    }
    if (!(outcomes.has('passed') && outcomes.has('failed'))) return;
    job.flaky = true;
    const key = `${run.projectId}:${run.pipeline}:${job.key}`;
    const record = this.store.get('ci-flaky', key) ?? { id: key, projectId: run.projectId, pipeline: run.pipeline, job: job.key, name: job.name, occurrences: 0, revisions: [], firstSeenAt: this.now() };
    if (record.revisions.includes(run.revision)) { record.lastRunId = run.id; record.lastSeenAt = this.now(); this.store.put('ci-flaky', record); return; }
    record.occurrences += 1; record.revisions = [...record.revisions, run.revision].slice(-20);
    Object.assign(record, { lastRevision: run.revision, lastRunId: run.id, lastSeenAt: this.now() });
    this.store.put('ci-flaky', record);
    this.hub.emit('ci.flaky-detected', 'pipeline-run', run, { pipeline: run.pipeline, job: job.key, revision: run.revision, occurrences: record.occurrences });
  }

  // ---- proxies --------------------------------------------------------------------------------------------------
  /**
   * Turn a new engine or merge-queue job that names pipelines into a proxy: start one pipeline run per name at the
   * job's revision and mark the job running without a lease. Its result is reported once the runs finish.
   */
  adopt(job) {
    const names = [...new Set(job.pipelines ?? [job.pipeline])];
    const project = this.store.need('project', job.projectId);
    const repository = hubRepository(this.store, job);
    const trigger = { kind: job.delivery ? 'merge-queue' : 'workflow', jobId: job.id, ...(job.runId ? { runId: job.runId } : {}),
      ...(job.workItemId ? { workItemId: job.workItemId } : {}), ...(job.delivery ? { mergeEntryIds: job.delivery.mergeEntryIds } : {}) };
    const runs = names.map(pipeline => this.create({ project, pipeline, revision: job.revision, trigger, repository }));
    job.status = 'running'; job.startedAt = this.now(); job.pipelineProxy = { runIds: runs.map(run => run.id) };
    job.logRef = `/api/v1/pipeline-runs/${runs[0].id}`;
    return job;
  }
  /** Complete the proxy a finished run belongs to once all its runs finished. */
  async settle(run) {
    const proxy = run.trigger?.jobId && this.store.get('job', run.trigger.jobId);
    if (!proxy?.pipelineProxy || proxy.status !== 'running') return false;
    const runs = proxy.pipelineProxy.runIds.map(runId => runId === run.id ? run : this.store.get('pipeline-run', runId));
    if (!runs.every(item => item && TERMINAL_RUN.has(item.status))) return false;
    const status = runs.every(item => item.status === 'passed') ? 'passed' : runs.some(item => item.status === 'failed') ? 'failed'
      : runs.some(item => item.status === 'cancelled') ? 'cancelled' : 'error';
    proxy.status = status; proxy.artifacts = []; delete proxy.leaseExpiresAt;
    this.store.put('job', proxy);
    const steps = runs.flatMap(item => item.jobs.length ? item.jobs.filter(job => job.status !== 'passed').map(job => ({ name: `${item.pipeline}: ${job.key}`, status: job.status }))
      : [{ name: item.pipeline, status: item.status }]);
    const data = { status, revision: proxy.revision, configHash: proxy.configHash, artifacts: [], steps };
    this.hub.emit('job.completed', 'job', proxy, { status, revision: proxy.revision, source: 'pipeline', pipelineRunIds: proxy.pipelineProxy.runIds });
    if (proxy.delivery) this.hub.delivery.record(proxy, data);
    else if (proxy.runId) {
      const workflowRun = this.store.get('run', proxy.runId);
      if (workflowRun && ['running', 'paused'].includes(workflowRun.status)) {
        this.hub.observation.interaction('gate.result', proxy, { nodeId: proxy.nodeId, source: 'ci', result: status, revision: proxy.revision });
        await this.hub.engineEvent(workflowRun, { type: 'job.finished', jobId: proxy.id, data, value: proxy });
      }
    }
    return true;
  }
  /** The hub repository a pipeline job's revision is fetched from (merge-queue candidates live in the queue's). */
  repository(job) {
    if (!job.pipelineRunId) return null;
    return this.store.get('pipeline-def', job.pipelineRunId)?.repository ?? null;
  }

  // ---- triggers and maintenance ---------------------------------------------------------------------------------
  /** An agent reported a head commit: run the project's pull-request pipelines at it, superseding older runs of the branch. */
  onHead(assignment) {
    const result = assignment.result;
    if (!this.hub.config.ci.pullRequestTriggers || result?.outcome !== 'success' || !SHA.test(result.headSha ?? '') || !assignment.projectId) return;
    const project = this.store.get('project', assignment.projectId);
    if (!project) return;
    const repository = this.repositoryOf(project);
    const resolved = this.resolve(project, result.headSha.toLowerCase(), repository);
    for (const [name, pipeline] of Object.entries(resolved.config?.pipelines ?? {})) {
      const trigger = pipeline.triggers.find(item => item.on === 'pull-request' && (!item.branches || item.branches.includes(result.branch)));
      if (!trigger) continue;
      const existing = this.store.db.prepare(`SELECT 1 FROM entities WHERE kind='pipeline-run' AND json_extract(data,'$.projectId')=? AND json_extract(data,'$.revision')=?
        AND json_extract(data,'$.pipeline')=? AND json_extract(data,'$.trigger.kind')='pull-request' LIMIT 1`).get(project.id, result.headSha.toLowerCase(), name);
      if (existing) continue;
      this.create({ project, pipeline: name, revision: result.headSha.toLowerCase(), ref: result.branch ?? `work-item:${assignment.workItemId}`, repository,
        trigger: { kind: 'pull-request', ...(assignment.runId ? { runId: assignment.runId } : {}), ...(assignment.workItemId ? { workItemId: assignment.workItemId } : {}), assignmentId: assignment.id } });
    }
  }
  /** Maintenance: settle proxies, fire schedule triggers once per UTC minute, and apply CI retention. */
  async tick(time) {
    for (const proxy of this.store.byStatus('job', ['running'], value => Boolean(value.pipelineProxy))) {
      const run = this.store.get('pipeline-run', proxy.pipelineProxy.runIds[0]);
      if (run && TERMINAL_RUN.has(run.status)) await this.settle(run);
    }
    const minute = Math.floor(time / 60000);
    if (this.hub.config.ci.scheduleTriggers && minute !== this.lastMinute) { this.lastMinute = minute; this.schedules(new Date(minute * 60000)); }
    if (time - this.lastSweep >= this.hub.config.retentionSweepIntervalMs) { this.lastSweep = time; this.sweep(time); }
  }
  schedules(at) {
    const stamp = at.toISOString();
    for (const project of this.store.list('project')) {
      const repository = this.repositoryOf(project);
      if (!repository) continue;
      const head = this.head(repository, project.repo.defaultBranch);
      const resolved = this.resolve(project, head, repository);
      for (const [name, pipeline] of Object.entries(resolved.config?.pipelines ?? {})) {
        for (const trigger of pipeline.triggers.filter(item => item.on === 'schedule' && cronMatches(item.cron, at))) {
          const branch = trigger.branch ?? project.repo.defaultBranch;
          const marker = `${project.id}:${name}:${branch}`;
          if (this.store.get('ci-schedule', marker)?.at === stamp) continue;
          this.store.put('ci-schedule', { id: marker, at: stamp });
          const revision = branch === project.repo.defaultBranch ? head : this.head(repository, branch);
          if (!revision) continue;
          this.create({ project, pipeline: name, revision, ref: `refs/heads/${branch}`, repository, trigger: { kind: 'schedule', cron: trigger.cron } });
        }
      }
    }
  }
  sweep(time) {
    const counts = this.ci.sweep(time);
    const before = new Date(time - this.hub.config.ci.runRetentionMs).toISOString();
    const old = this.store.db.prepare(`SELECT id FROM entities WHERE kind='pipeline-run' AND json_extract(data,'$.finishedAt')<? LIMIT 500`).all(before);
    for (const row of old) { this.store.remove('pipeline-run', row.id); this.store.remove('pipeline-def', row.id); }
    for (const record of this.store.list('ci-flaky', value => value.lastSeenAt < before)) this.store.remove('ci-flaky', record.id);
    return { ...counts, runs: old.length };
  }

  // ---- views and routes -----------------------------------------------------------------------------------------
  /** A run with the live status of its queued jobs (leased is visible only on the hub job). */
  view(run) {
    const value = structuredClone(run);
    delete value.cancelRequested;
    for (const job of value.jobs) {
      if (job.status !== 'queued' || !job.jobId) continue;
      const hubJob = this.store.get('job', job.jobId);
      if (hubJob?.status === 'leased') { job.status = 'leased'; job.machineId = hubJob.machineId; }
    }
    return value;
  }
  pipelinesView(project, revision) {
    const repository = this.repositoryOf(project);
    const at = revision ?? this.head(repository, project.repo.defaultBranch);
    const resolved = this.resolve(project, at, repository);
    const runs = this.store.forProject('pipeline-run', project.id);
    const latest = new Map();
    for (const run of runs) if (!latest.has(run.pipeline) || latest.get(run.pipeline).createdAt < run.createdAt) latest.set(run.pipeline, run);
    return { projectId: project.id, source: resolved.source, revision: resolved.revision ?? at ?? null, path: resolved.source === 'repo' ? PIPELINE_FILE : null,
      pipelines: resolved.config ? describePipelines(resolved.config).map(pipeline => ({ ...pipeline,
        jobs: pipeline.jobs.map(({ env, cache, artifacts, configHash, ...job }) => ({ ...job, cache: cache.map(item => item.key), artifacts: artifacts.map(item => item.name), configHash })),
        ...(latest.has(pipeline.name) ? { lastRun: summary(latest.get(pipeline.name)) } : {}) })) : [],
      ...(resolved.errors ? { error: { code: 'PIPELINE_CONFIG_INVALID', message: `${resolved.errors[0].path} ${resolved.errors[0].message}` }, errors: resolved.errors } : {}) };
  }
  list(query) {
    const projectId = query.get('projectId'); if (projectId !== null) nonblank(projectId, 'projectId', 200);
    const pipeline = query.get('pipeline'); const status = query.get('status');
    if (status !== null) requireValue(RUN_STATUSES.includes(status), 'Invalid pipeline run status.');
    const limit = integer(Number(query.get('limit') ?? 50), 'limit', 1, 500);
    const runs = projectId ? this.store.forProject('pipeline-run', projectId) : this.store.list('pipeline-run');
    return { runs: runs.filter(run => (!pipeline || run.pipeline === pipeline) && (!status || run.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, limit).map(run => this.view(run)) };
  }
  /** Owner routes. Returns a hub route result, or null when the path is not a CI route. */
  async route(method, segments, query, body) {
    const [collection, entityId, action, childId] = segments;
    const reply = (value, status = 200) => ({ status, body: value });
    const project = projectId => this.store.need('project', nonblank(projectId, 'projectId', 200));
    if (collection === 'pipelines' && segments.length === 1 && method === 'GET') {
      const revision = query.get('revision'); if (revision !== null) requireValue(SHA.test(revision), 'revision must be a full commit SHA.');
      return reply(this.pipelinesView(project(query.get('projectId')), revision ?? undefined));
    }
    if (collection === 'pipeline-runs' && segments.length === 1) {
      if (method === 'GET') return reply(this.list(query));
      if (method === 'POST') {
        const target = project(body.projectId); nonblank(body.pipeline, 'pipeline', 64);
        if (body.ref !== undefined) nonblank(body.ref, 'ref', 300);
        let revision = body.revision;
        if (revision === undefined) {
          const branch = body.ref?.replace(/^refs\/heads\//, '') ?? target.repo.defaultBranch;
          revision = this.head(this.repositoryOf(target), branch);
          if (!revision) fail(400, 'REVISION_REQUIRED', 'Name a revision: the hub cannot read this project branch.');
        }
        requireValue(typeof revision === 'string' && SHA.test(revision.toLowerCase()), 'revision must be a full commit SHA.');
        const run = this.create({ project: target, pipeline: body.pipeline, revision: revision.toLowerCase(), ref: body.ref ?? (body.revision === undefined ? `refs/heads/${target.repo.defaultBranch}` : undefined),
          trigger: { kind: 'manual' }, strict: true });
        return reply(this.view(run), 201);
      }
    }
    if (collection === 'pipeline-runs' && entityId && segments.length <= 3) {
      const run = this.store.need('pipeline-run', entityId);
      if (!action && method === 'GET') return reply(this.view(run));
      if (action === 'cancel' && method === 'POST') {
        if (body.reason !== undefined) nonblank(body.reason, 'reason', 1000);
        const cancelled = this.cancelRun(run, body.reason ?? 'Cancelled by the owner.');
        this.hub.emit('pipeline-run.cancelled', 'pipeline-run', cancelled, {});
        await this.settle(cancelled);
        return reply(this.view(cancelled));
      }
      if (action === 'retry' && method === 'POST') {
        if (body.job !== undefined) nonblank(body.job, 'job', 300);
        return reply(this.view(this.retry(run, body.job)));
      }
    }
    if (collection === 'jobs' && entityId && action === 'artifacts' && method === 'GET' && segments.length <= 4) {
      if (!this.store.find('job', entityId)) fail(404, 'NOT_FOUND', 'job not found.');
      if (!childId) return reply({ jobId: entityId, artifacts: this.ci.artifacts(entityId) });
      return { status: 200, body: null, file: this.ci.artifact(entityId, childId) };
    }
    if (collection === 'runners' && segments.length === 1 && method === 'GET') return reply(this.runners.view());
    if (collection === 'ci' && segments.length === 2) {
      if (entityId === 'flaky' && method === 'GET') {
        const projectId = query.get('projectId');
        const flaky = this.store.list('ci-flaky', value => !projectId || value.projectId === projectId)
          .sort((a, b) => b.occurrences - a.occurrences || b.lastSeenAt.localeCompare(a.lastSeenAt)).map(({ revisions, ...value }) => value);
        return reply({ flaky });
      }
      if (entityId === 'insights' && method === 'GET') return reply(insights(this, query));
      if (entityId === 'validate' && method === 'POST') {
        requireValue(body.config !== undefined, 'config is required.');
        const parsed = parsePipelineConfig(body.config);
        return reply({ valid: !parsed.errors.length, errors: parsed.errors, pipelines: Object.keys(parsed.config?.pipelines ?? {}) });
      }
    }
    if (collection === 'projects' && entityId && action === 'ci-config' && segments.length === 3) {
      const target = this.store.need('project', entityId);
      if (method === 'GET') return reply({ projectId: target.id, config: this.store.get('ci-config', target.id)?.config ?? null });
      if (method === 'PUT') {
        requireValue(Object.hasOwn(body, 'config'), 'config is required (null removes it).');
        if (body.config === null) { this.store.remove('ci-config', target.id); }
        else {
          object(body.config, 'config');
          const parsed = parsePipelineConfig(body.config);
          if (parsed.errors.length) return reply({ error: { code: 'PIPELINE_CONFIG_INVALID', message: `${parsed.errors[0].path} ${parsed.errors[0].message}` }, errors: parsed.errors }, 400);
          this.store.put('ci-config', { id: target.id, config: body.config, updatedAt: this.now() });
        }
        this.hub.emit('project.ci-config-updated', 'project', { ...target, projectId: target.id }, { removed: body.config === null });
        return reply({ projectId: target.id, config: body.config });
      }
    }
    return null;
  }
}

export function summary(run) {
  return { id: run.id, status: run.status, revision: run.revision, createdAt: run.createdAt, ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}), ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}) };
}
