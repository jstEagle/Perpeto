import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeliveryError, LocalGitAdapter, MergeQueue, MergeQueueStore } from '@perpeto/delivery';

import { githubAdapter, githubRepository } from './github.js';

const TERMINAL = new Set(['merged', 'rejected']);
const ACTIVE_JOB = new Set(['queued', 'leased', 'running']);
const MAX_STEPS = 8;
const MAX_BACKOFF_MS = 60000;
const now = () => new Date().toISOString();
const sorted = value => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');

class Unsupported extends Error {}

/** Local repository paths used by the local adapter. GitHub uses a separate hub-owned mirror. */
export function localRepository(repo = {}) {
  const candidate = repo.localPath ?? repo.url;
  if (typeof candidate !== 'string') return null;
  if (candidate.startsWith('file://')) {
    try { return fileURLToPath(candidate); } catch { throw new Unsupported('The project repository file URL is not a usable local path.'); }
  }
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
    // Per queue: consecutive step failures of one attempt and when to retry. Per entry: why the hub rejected it.
    this.failures = new Map(); this.rejected = new Map();
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
      // Entries are admitted one by one, so one project's unusable repository never halts admission for the others.
      // A blocked entry stays queued and is retried, for example after the project's repo is corrected.
      let record;
      try { record = this.queueRecord(entry); }
      catch (error) {
        const reason = error instanceof Unsupported ? error.message : 'Merge queue admission failed; it will retry.';
        if (entry.deliveryError === reason) continue;
        entry.deliveryError = reason; store.put('merge-entry', entry);
        this.hub.emit('merge-entry.blocked', 'merge-entry', entry, { reason }); continue;
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
      let state;
      try { state = this.queue(record).state; } catch { return false; }
      // Open means work to do: an attempt, waiting entries, outcomes the hub has not mirrored, or queued jobs it has not
      // registered. Cancelled job history that was never mirrored is not pending work.
      return state.active || state.entries.some(value => !TERMINAL.has(value.status)) ||
        state.entries.some(entry => TERMINAL.has(entry.status) && this.unmirrored(entry, store.get('merge-entry', entry.id))) ||
        state.jobs.some(job => job.status === 'queued' && !store.get('job', job.id)) || this.errors.has(record.id) || record.lastError;
    }).map(record => record.id);
  }
  /** A terminal delivery outcome the hub entry does not show yet. A published merge always wins over a hub rejection. */
  unmirrored(entry, hubEntry) {
    return Boolean(hubEntry) && hubEntry.status !== entry.status && (!TERMINAL.has(hubEntry.status) || entry.status === 'merged');
  }
  /** Withdraw entries their run already closed, including ones under test, before the queue can publish them. */
  withdrawClosed(queue) {
    for (const entry of queue.state.entries) {
      const hubEntry = TERMINAL.has(entry.status) ? null : this.hub.store.get('merge-entry', entry.id);
      if (hubEntry?.status !== 'rejected') continue;
      try { queue.withdraw({ entryId: entry.id, reason: hubEntry.reason ?? 'Closed by its run.' }, { idempotencyKey: `withdraw:${entry.id}` }); this.dirty = true; }
      catch (error) { if (!(error instanceof DeliveryError)) throw error; }
    }
  }
  async advance(id) {
    const queue = this.queues.get(id);
    for (let index = 0; index < MAX_STEPS && !this.closed; index++) {
      await this.hub.serialize(() => this.withdrawClosed(queue));
      if ((this.failures.get(id)?.retryAt ?? 0) > Date.now()) return;
      const before = JSON.stringify(queue.state);
      try { await queue.step({ idempotencyKey: `tick:${randomUUID()}` }); }
      catch (error) {
        // BUSY means another worker holds the queue lease; anything else counts toward the attempt's retry bound.
        if (error?.code !== 'BUSY') await this.failed(id, queue, error);
        return;
      }
      this.errors.delete(id); this.failures.delete(id);
      if (JSON.stringify(queue.state) === before) return;
    }
    this.dirty = true;
  }
  /**
   * Bounded retries: a failing attempt backs off exponentially, and after `deliveryMaxStepFailures` consecutive failures
   * its entries are rejected with the reason, which sync reports to their runs. A batch rejects only entries whose PR
   * head cannot be read when that identifies them. Without an attempt no entry is at fault (for example a missing base
   * branch), so the queue error stays visible instead.
   */
  async failed(id, queue, error) {
    const message = safe(error); this.errors.set(id, message);
    const active = queue.state.active;
    const previous = this.failures.get(id);
    const count = previous && previous.attemptId === (active?.id ?? null) ? previous.count + 1 : 1;
    const { deliveryMaxStepFailures: limit, deliveryRetryBackoffMs: backoff } = this.hub.config;
    this.failures.set(id, { attemptId: active?.id ?? null, count, retryAt: Date.now() + Math.min(backoff * 2 ** (count - 1), MAX_BACKOFF_MS) });
    if (!active || count < limit) return;
    // A merging attempt may already be published. Reject it only once the base is known not to contain the candidate.
    if (active.phase === 'merging' && !(await this.unpublished(queue, active))) return;
    const entries = active.entryIds.map(entryId => queue.state.entries.find(entry => entry.id === entryId));
    const culprits = entries.length > 1 ? await this.unreadable(queue, entries) : entries;
    const reason = `Merge queue gave up after ${count} failed attempts (${message}).`;
    for (const entry of culprits.length ? culprits : entries) {
      try { queue.rejectEntry({ entryId: entry.id, reason }, { idempotencyKey: `reject:${entry.id}:${active.id}` }); }
      catch (rejection) { if (!(rejection instanceof DeliveryError)) throw rejection; return; }
      this.rejected.set(entry.id, message);
    }
    this.failures.delete(id); this.errors.delete(id); this.dirty = true;
  }
  async unreadable(queue, entries) {
    const found = [];
    for (const entry of entries) {
      try { if (await queue.adapter.getHead(entry) !== entry.headSha) found.push(entry); } catch { found.push(entry); }
    }
    return found;
  }
  async unpublished(queue, active) {
    const { config } = queue.state;
    if (config.publication === 'github-merge-queue' || typeof queue.adapter.isMerged !== 'function') return false;
    try { return !(await queue.adapter.isMerged({ baseBranch: config.baseBranch, revision: active.revision, publication: config.publication })); }
    catch { return false; }
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
      const state = queue.state;
      const failing = state.active ? this.errors.get(id) : null;
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
        if (!hubEntry || (TERMINAL.has(hubEntry.status) && !this.unmirrored(entry, hubEntry))) continue;
        // deliveryError shows why an entry is stuck while its attempt keeps failing, and why the hub rejected it.
        const deliveryError = this.rejected.get(entry.id) ?? (failing && state.active.entryIds.includes(entry.id) ? failing : undefined);
        const next = { status: entry.status, jobId: entry.jobId, reason: entry.reason, testedRevision: entry.testedRevision, mergedRevision: entry.mergedRevision, deliveryError };
        if (TERMINAL.has(entry.status)) this.rejected.delete(entry.id);
        if (Object.entries(next).every(([key, value]) => hubEntry[key] === value)) continue;
        const value = { ...hubEntry, ...next };
        for (const key of Object.keys(next)) if (value[key] === undefined) delete value[key];
        store.put('merge-entry', value); this.hub.emit('merge-entry.updated', 'merge-entry', value, { status: value.status, ...(value.reason ? { reason: value.reason } : {}) }); changed = true;
        const run = TERMINAL.has(entry.status) && !TERMINAL.has(hubEntry.status) && value.runId ? store.get('run', value.runId) : null;
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
      if (!(error instanceof DeliveryError) || !['STALE_ATTEMPT', 'CONFLICT', 'STALE_EVIDENCE', 'IDEMPOTENCY_CONFLICT'].includes(error.code)) throw error;
      // Delivery already holds a different result for this job, from a hub request that rolled back after delivery
      // committed. Delivery's result decides the queue, so the hub job shows it instead of failing every retry.
      const recorded = error.code === 'IDEMPOTENCY_CONFLICT' && this.queue(record).state.jobs.find(value => value.id === job.id);
      if (recorded && recorded.status !== 'queued') { job.status = recorded.status; job.artifacts = recorded.artifacts ?? []; this.hub.store.put('job', job); }
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
