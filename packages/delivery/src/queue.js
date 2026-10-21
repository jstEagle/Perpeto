import { randomUUID } from 'node:crypto';
import { DeliveryError, requireValue, stableHash } from './common.js';
import { buildJob, checksPass, isEvidenceCurrent } from './jobs.js';
import { selectEntries } from './machine.js';

/**
 * Git/forge adapter: getBase(branch), getHead(entry), prepare({baseSha, entries, method,
 * idempotencyKey}), isMerged({baseBranch, revision}), merge({baseBranch, baseSha,
 * revision, entries, method, idempotencyKey}). Publication adapters declare their guarantees: local ref transaction, remote
 * fast-forward-only push, or GitHub-owned native queue. See the README for limits.
 *
 * The hub submits persisted queued jobs and calls recordJobResult with lease-validated
 * results. This library never executes CI or trusts an arbitrary result submitter.
 */
export class MergeQueue {
  constructor({ store, queueId, config, adapter, leaseMs = 60_000 }) {
    this.store = store; this.queueId = queueId; this.adapter = adapter; this.leaseMs = leaseMs;
    store.initialize(queueId, { ...config, publication: config.publication ?? adapter.publication ?? 'fast-forward-push' });
  }
  get state() { return this.store.read(this.queueId); }
  enqueue(entry, { idempotencyKey }) {
    return this.store.dispatch(this.queueId, { type: 'enqueue', entry }, { idempotencyKey });
  }
  /** Cancel an entry and its active attempt, requeuing surviving batch members. */
  withdraw({ entryId, reason }, { idempotencyKey }) {
    return this.#rejectEntry('withdraw', { entryId, reason }, idempotencyKey);
  }
  /** Host calls this after bounded adapter retries or a permanent input failure. */
  rejectEntry({ entryId, reason }, { idempotencyKey }) {
    return this.#rejectEntry('reject-entry', { entryId, reason }, idempotencyKey);
  }
  #rejectEntry(type, { entryId, reason }, idempotencyKey) {
    const action = { type, entryId, reason };
    const original = this.store.receipt(this.queueId, idempotencyKey, action);
    if (original) return original;
    const token = this.store.acquire(this.queueId, this.leaseMs);
    try { return this.store.dispatch(this.queueId, action, { idempotencyKey, token }); }
    finally { this.store.release(this.queueId, token); }
  }
  recordJobResult(result, { idempotencyKey }) {
    // Receipt lookup precedes active-attempt lookup so a retry still works after merge.
    // The persisted action includes the attempt; historical jobs let retries reconstruct it.
    const state = this.state;
    const job = state.jobs.find(job => job.id === result.id);
    requireValue(job, 'Job not found in this queue.', 'NOT_FOUND');
    return this.store.dispatch(this.queueId, { type: 'result', attemptId: job.queueAttemptId, result }, { idempotencyKey });
  }
  /** One durable phase per call. Reusing a key returns its original snapshot. */
  async step({ idempotencyKey }) {
    const original = this.store.receipt(this.queueId, idempotencyKey, { type: 'step' });
    if (original) return original;
    const token = this.store.acquire(this.queueId, this.leaseMs);
    try {
      const duplicate = this.store.receipt(this.queueId, idempotencyKey, { type: 'step' });
      if (duplicate) return duplicate;
      await this.#advance(token, idempotencyKey);
      return this.store.completeStep(this.queueId, idempotencyKey, this.state, token);
    } finally { this.store.release(this.queueId, token); }
  }
  async #advance(token, stepKey) {
    const state = this.state;
    const config = state.config;
    if (!state.active) {
      const entries = selectEntries(state);
      if (!entries.length) return;
      const baseSha = await this.adapter.getBase(config.baseBranch, config.publication);
      this.store.dispatch(this.queueId, { type: 'start', attemptId: `mq_${randomUUID()}`,
        entryIds: entries.map(entry => entry.id), baseSha }, { token, stepKey, idempotencyKey: `internal:start:${randomUUID()}` });
      return;
    }
    const active = state.active;
    const entries = active.entryIds.map(id => state.entries.find(entry => entry.id === id));
    const transition = (type, fields = {}) => this.store.dispatch(this.queueId,
      { type, attemptId: active.id, ...fields }, { token, stepKey, idempotencyKey: `internal:${active.id}:${type}:${stableHash(fields)}` });
    // Publication owns recovery and forge finalization too. In native queue mode,
    // GitHub may advance the base while this attempt waits, so do not requeue it.
    if (active.phase === 'merging') {
      if (this.adapter.atomicMerge !== true) throw new DeliveryError('ATOMIC_MERGE_UNSUPPORTED', 'This adapter cannot safely publish a merge candidate.');
      this.store.renew(this.queueId, token, this.leaseMs);
      const result = await this.adapter.merge({ baseBranch: config.baseBranch, baseSha: active.baseSha,
        revision: active.revision, entries, method: config.method, idempotencyKey: active.id,
        publication: config.publication, publicationState: active.publicationState, evidence: state.jobs.find(job => job.id === active.jobId) });
      if (result.status === 'base_changed') transition('requeue', { reason: 'Base changed during merge; speculative CI must run again.' });
      else if (result.status === 'head_changed') {
        // Legacy adapters may omit the identity. Reread heads before rejecting
        // so a single changed PR never poisons the rest of a batch.
        let entryId = result.entryId;
        if (!entryId) {
          for (const entry of entries) if (await this.adapter.getHead(entry) !== entry.headSha) { entryId = entry.id; break; }
        }
        requireValue(entryId && entries.some(entry => entry.id === entryId), 'Adapter did not identify the changed PR.', 'ADAPTER_ERROR');
        transition('reject', { entryId, reason: 'PR head changed during merge; enqueue the new revision.' });
      }
      else if (result.status === 'rejected') transition('reject', { reason: result.reason });
      else if (result.status === 'pending') transition('publication-pending', { publicationState: result.publicationState ?? 'pending' });
      else {
        requireValue(result.status === 'merged' && (result.revision === active.revision ||
          (config.publication === 'github-merge-queue' && result.publication === 'github-merge-queue')),
        'Adapter did not confirm publication of the tested revision or native GitHub merge.', 'ADAPTER_ERROR');
        transition('merged', { revision: result.revision });
      }
      return;
    }
    if (await this.adapter.getBase(config.baseBranch, config.publication) !== active.baseSha) {
      transition('requeue', { reason: 'Base changed; speculative CI must run again.' }); return;
    }
    for (const entry of entries) {
      if (await this.adapter.getHead(entry) !== entry.headSha) {
        transition('reject', { entryId: entry.id, reason: 'PR head changed; enqueue the new revision.' }); return;
      }
    }
    if (active.phase === 'preparing') {
      let candidate;
      try {
        candidate = await this.adapter.prepare({ baseSha: active.baseSha, entries, method: config.method, idempotencyKey: active.id, publication: config.publication });
      } catch (error) {
        if (error.code !== 'MERGE_CONFLICT') throw error;
        transition('reject', { ...(error.entryId ? { entryId: error.entryId } : {}), reason: 'Merge conflict with the speculative base.', rejectionKind: 'conflict' }); return;
      }
      const workItem = { headSha: candidate.revision, ...(entries.length === 1 ? { id: entries[0].workItemId, runId: entries[0].runId } : {}) };
      // Optional IDs are omitted rather than serialized as undefined.
      Object.keys(workItem).forEach(key => { if (workItem[key] === undefined) delete workItem[key]; });
      const job = buildJob({ id: `job_${active.id}`, projectId: config.projectId, repo: config.repo, config: config.ci, workItem });
      job.queueAttemptId = active.id;
      transition('prepared', { job }); return;
    }
    if (active.phase === 'testing') {
      const job = state.jobs.find(job => job.id === active.jobId);
      if (['queued', 'leased', 'running'].includes(job.status)) return;
      if (!isEvidenceCurrent(job, { revision: active.revision, configHash: stableHash(config.ci) }) || !checksPass(job, config.requiredChecks)) {
        transition('ci-failed', { rejectionKind: ['failed', 'passed'].includes(job.status) ? 'ci' : 'other', reason: job.status === 'passed' ? 'Required checks are missing or stale.' : `Speculative CI ${job.status}.` });
        return;
      }
      transition('approve'); return;
    }
  }
}
