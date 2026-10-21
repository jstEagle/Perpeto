import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeliveryError, LocalGitAdapter, MergeQueue, MergeQueueStore } from '@perpeto/delivery';

import { githubAdapter, githubRepository } from './github.js';

const TERMINAL = new Set(['merged', 'rejected']);
const ACTIVE_JOB = new Set(['queued', 'leased', 'running']);
const MAX_STEPS = 8;
const now = () => new Date().toISOString();
const sorted = value => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');

class Unsupported extends Error {}

/** Local repository paths used by the local adapter. GitHub uses a separate hub-owned mirror. */
export function localRepository(repo = {}) {
  const candidate = repo.localPath ?? repo.url;
  if (typeof candidate !== 'string') return null;
  if (candidate.startsWith('file://')) return fileURLToPath(candidate);
  return isAbsolute(candidate) ? candidate : null;
}

function requirements(list) {
  if (list.length <= 1) return structuredClone(list[0] ?? {});
  const os = list.map(value => value.os).find(Boolean);
  const union = key => [...new Set(list.flatMap(value => value[key] ?? []))];
  return { ...(os ? { os } : {}), ...(union('labels').length ? { labels: union('labels') } : {}), ...(union('providers').length ? { providers: union('providers') } : {}) };
}

const safe = error => error instanceof DeliveryError ? `${error.code}: ${error.message}` : 'Merge queue step failed; it will retry.';

/**
 * Mounts `@perpeto/delivery` merge queues into the hub. The delivery store is the source of truth for queue
 * progress; `sync` reconciles it into hub merge entries and jobs, so a crash between the two stores is repaired on the
 * next pump. Speculative Jobs run through the hub job queue like any other Job.
 */
export class HubDelivery {
  constructor(hub) {
    this.hub = hub; this.store = new MergeQueueStore(hub.config.deliveryDatabasePath);
    this.queues = new Map(); this.errors = new Map(); this.running = null; this.again = false; this.closed = false; this.dirty = false;
  }
  queue(record) {
    let queue = this.queues.get(record.id);
    if (!queue) {
      queue = new MergeQueue({ store: this.store, queueId: record.id, config: record.config, adapter: record.github ? githubAdapter(record) : new LocalGitAdapter({ repository: record.repository }), leaseMs: this.hub.config.deliveryLeaseDurationMs });
      this.queues.set(record.id, queue);
    }
    return queue;
  }
  /** One queue per project repository, base and merge configuration. CI comes from the ci nodes the merge requires. */
  queueRecord(entry) {
    const store = this.hub.store;
    const project = store.need('project', entry.projectId);
    const github = githubRepository(project.repo.url) ?? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/[1-9][0-9]*$/.exec(entry.prUrl)?.[1];
    const repository = github ? join(this.hub.config.deliveryRepositoriesPath, `${project.id}-${digest(project.repo.url).slice(0, 12)}.git`) : localRepository(project.repo);
    if (!repository) throw new Unsupported('Automatic publication supports GitHub repositories and local bare repositories.');
    const graph = store.need('run-workflow', entry.runId).workflow.graph;
    const node = graph.nodes.find(value => value.id === entry.nodeId) ?? { config: {} };
    const required = entry.requiredChecks ?? node.config.requiredChecks ?? [];
    const ciNodes = graph.nodes.filter(value => value.type === 'ci');
    const referenced = ciNodes.filter(value => required.includes(value.id));
    const sources = referenced.length ? referenced : ciNodes;
    const steps = sources.length === 1 ? sources[0].config.steps
      : sources.flatMap(value => value.config.steps.map(item => ({ ...item, name: `${value.id}:${item.name}` })));
    const config = { projectId: entry.projectId, repo: { url: repository, defaultBranch: project.repo.defaultBranch }, baseBranch: entry.baseBranch,
      strategy: entry.strategy ?? node.config.strategy ?? 'serial', method: entry.method ?? node.config.method ?? 'squash', requiredChecks: required,
      ...(github || node.config.publication ? { publication: node.config.publication ?? 'fast-forward-push' } : {}),
      ci: { steps: steps.length ? steps : [{ name: 'candidate', run: 'git rev-parse --verify HEAD' }], requirements: requirements(sources.map(value => value.config.requirements ?? {})) } };
    const id = `dq_${digest(config).slice(0, 24)}`;
    // Required checks named after ci nodes are proven by the speculative job running those nodes' steps.
    return store.get('delivery-queue', id) ?? store.put('delivery-queue', { id, projectId: entry.projectId, repository, ...(github ? { github, remote: project.repo.url } : {}), config, checks: referenced.map(value => value.id) });
  }
  schedule() { if (!this.closed) setImmediate(() => this.pump().catch(() => {})); }
  async pump() {
    if (this.closed) return;
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        do {
          this.again = false; this.dirty = false;
          const ids = await this.hub.serialize(() => this.hub.store.transaction(() => this.admit()));
          for (const id of ids) await this.advance(id);
          if (this.closed) break;
          const changed = await this.hub.serialize(() => this.hub.store.transaction(() => this.sync(ids)));
          if (changed) this.hub.notify();
        } while ((this.again || this.dirty) && !this.closed);
      } finally { this.running = null; }
    })();
    return this.running;
  }
  /** Enqueue newly created hub merge entries and return the queues with open work. */
  admit() {
    const { store } = this.hub;
    for (const entry of store.list('merge-entry', value => value.status === 'queued' && !value.queueId && !value.deliveryRejected)) {
      let record;
      try { record = this.queueRecord(entry); }
      catch (error) {
        if (!(error instanceof Unsupported)) throw error;
        if (entry.deliveryError === error.message) continue;
        entry.deliveryError = error.message; store.put('merge-entry', entry);
        this.hub.emit('merge-entry.blocked', 'merge-entry', entry, { reason: error.message }); continue;
      }
      try {
        this.queue(record).enqueue({ id: entry.id, projectId: entry.projectId, prUrl: entry.prUrl, headSha: entry.headSha, baseBranch: entry.baseBranch,
          ...(entry.workItemId ? { workItemId: entry.workItemId } : {}), ...(entry.runId ? { runId: entry.runId } : {}) }, { idempotencyKey: `enqueue:${entry.id}` });
      } catch (error) {
        if (!(error instanceof DeliveryError)) throw error;
        // The entry itself is unusable (for example a PR URL that is not local:<branch>); hand it back to the run.
        entry.deliveryError = safe(error); entry.deliveryRejected = true; store.put('merge-entry', entry);
        this.hub.emit('merge-entry.blocked', 'merge-entry', entry, { reason: entry.deliveryError });
        continue;
      }
      entry.queueId = record.id; delete entry.deliveryError; store.put('merge-entry', entry);
      this.hub.emit('merge-entry.enqueued', 'merge-entry', entry, { queueId: record.id });
    }
    return store.list('delivery-queue').filter(record => {
      const state = this.queue(record).state;
      return state.active || state.entries.some(value => !TERMINAL.has(value.status)) ||
        state.entries.some(entry => TERMINAL.has(entry.status) && !TERMINAL.has(store.get('merge-entry', entry.id)?.status)) ||
        state.jobs.some(job => !store.get('job', job.id)) || this.errors.has(record.id) || record.lastError;
    }).map(record => record.id);
  }
  async advance(id) {
    const queue = this.queues.get(id);
    for (let index = 0; index < MAX_STEPS && !this.closed; index++) {
      const before = JSON.stringify(queue.state);
      try { await queue.step({ idempotencyKey: `tick:${randomUUID()}` }); }
      catch (error) {
        // BUSY means another worker holds the queue lease; anything else is retried on the next pump.
        if (error?.code !== 'BUSY') this.errors.set(id, safe(error));
        return;
      }
      this.errors.delete(id);
      if (JSON.stringify(queue.state) === before) return;
    }
    this.dirty = true;
  }
  /** Mirror queue state into hub jobs and merge entries, and report finished entries to their runs. */
  async sync(ids) {
    const { store } = this.hub; let changed = false;
    for (const entry of store.list('merge-entry', value => value.deliveryRejected && !TERMINAL.has(value.status))) {
      const run = entry.runId && store.get('run', entry.runId);
      if (!run || !['running', 'paused'].includes(run.status)) continue;
      await this.hub.engineEvent(run, { type: 'merge.finished', mergeEntryId: entry.id, data: { status: 'rejected', reason: `Merge queue refused the entry (${entry.deliveryError}).` } });
      changed = true;
    }
    for (const id of ids) {
      const record = store.need('delivery-queue', id); const queue = this.queue(record);
      const error = this.errors.get(id) ?? null;
      if ((record.lastError ?? null) !== error) {
        record.lastError = error; store.put('delivery-queue', record);
        if (error) this.hub.emit('merge-queue.error', 'merge-queue', record, { message: error });
      }
      for (const entry of queue.state.entries) {
        const hubEntry = store.get('merge-entry', entry.id);
        if (entry.status === 'queued' && !queue.state.active?.entryIds.includes(entry.id) && hubEntry && TERMINAL.has(hubEntry.status)) {
          queue.withdraw({ entryId: entry.id, reason: hubEntry.reason ?? 'Closed by its run.' }, { idempotencyKey: `withdraw:${entry.id}` });
        }
      }
      const state = queue.state;
      for (const job of state.jobs) {
        const hubJob = store.get('job', job.id);
        if (!hubJob) {
          if (job.status !== 'queued') continue;
          const members = state.entries.filter(entry => entry.jobId === job.id).map(entry => store.get('merge-entry', entry.id)).filter(Boolean);
          const value = { id: job.id, projectId: job.projectId, ...(job.runId ? { runId: job.runId } : {}), ...(job.workItemId ? { workItemId: job.workItemId } : {}),
            ...(members[0]?.nodeId ? { nodeId: members[0].nodeId } : {}), repo: job.repo, revision: job.revision, steps: job.steps, requirements: job.requirements,
            status: 'queued', attempt: 1, artifacts: [], configHash: job.configHash, delivery: { queueId: id, mergeEntryIds: members.map(entry => entry.id) }, createdAt: now() };
          this.hub.requirements(value.requirements);
          store.put('job', value); this.hub.emit('job.updated', 'job', value, { status: 'queued', source: 'merge-queue' }); changed = true;
          if (members.length && members.every(entry => TERMINAL.has(entry.status))) this.hub.cancelWork('job', value);
          continue;
        }
        if (['passed', 'failed', 'error'].includes(job.status) && ACTIVE_JOB.has(hubJob.status)) {
          hubJob.status = job.status; hubJob.artifacts = job.artifacts ?? []; delete hubJob.leaseExpiresAt;
          store.put('job', hubJob); this.hub.emit('job.updated', 'job', hubJob, { status: job.status, source: 'merge-queue-recovery' }); changed = true;
        }
        if (job.status === 'cancelled' && ACTIVE_JOB.has(hubJob.status)) { this.hub.cancelWork('job', hubJob); changed = true; }
      }
      for (const entry of state.entries) {
        const hubEntry = store.get('merge-entry', entry.id);
        if (!hubEntry || TERMINAL.has(hubEntry.status)) continue;
        const next = { status: entry.status, jobId: entry.jobId, reason: entry.reason, testedRevision: entry.testedRevision, mergedRevision: entry.mergedRevision };
        if (Object.entries(next).every(([key, value]) => hubEntry[key] === value)) continue;
        const value = { ...hubEntry, ...next };
        for (const key of Object.keys(next)) if (value[key] === undefined) delete value[key];
        store.put('merge-entry', value); this.hub.emit('merge-entry.updated', 'merge-entry', value, { status: value.status, ...(value.reason ? { reason: value.reason } : {}) }); changed = true;
        const run = TERMINAL.has(entry.status) && value.runId ? store.get('run', value.runId) : null;
        if (run && ['running', 'paused'].includes(run.status)) await this.hub.engineEvent(run, { type: 'merge.finished', mergeEntryId: entry.id, data: next });
      }
    }
    return changed;
  }
  /** Record a node's lease-validated result for a speculative job. Called inside the hub's request transaction. */
  record(job, data) {
    const record = this.hub.store.need('delivery-queue', job.delivery.queueId);
    const checks = data.status === 'passed' ? (record.checks ?? []).map(name => ({ name, status: 'passed', revision: job.revision, configHash: job.configHash })) : [];
    try {
      this.queue(record).recordJobResult({ id: job.id, revision: job.revision, configHash: job.configHash, status: data.status, artifacts: data.artifacts ?? [],
        ...(job.logRef ? { logRef: job.logRef } : {}), ...(checks.length ? { checks } : {}) }, { idempotencyKey: `result:${job.id}` });
    } catch (error) {
      // The attempt moved on (base changed or job superseded); the queue already scheduled new work.
      if (!(error instanceof DeliveryError) || !['STALE_ATTEMPT', 'CONFLICT', 'STALE_EVIDENCE'].includes(error.code)) throw error;
      this.hub.emit('merge-queue.result-ignored', 'job', job, { reason: error.code });
    }
    this.dirty = true;
  }
  async close() {
    this.closed = true;
    await this.running?.catch(() => {});
    this.store.close();
  }
}
