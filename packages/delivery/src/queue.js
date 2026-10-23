import { randomUUID } from 'node:crypto';
import { DeliveryError, requireValue, stableHash } from './common.js';
import { buildJob, checksPass, isEvidenceCurrent } from './jobs.js';
import { expiredEntries, frozenAt, policyOf, selectEntries } from './machine.js';
import { queueView } from './insight.js';

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
  /**
   * `clock` (ms) stamps queue times and evaluates freeze windows and timeouts; tests pass a fake one. `reconfigure`
   * lets a named queue adopt changed policy (lanes, freeze windows, retries) instead of refusing a different config.
   */
  constructor({ store, queueId, config, adapter, leaseMs = 60_000, clock = Date.now, reconfigure = false }) {
    this.store = store; this.queueId = queueId; this.adapter = adapter; this.leaseMs = leaseMs; this.clock = clock;
    store.initialize(queueId, this.#config(config), { reconfigure, at: clock() });
  }
  #config(config) { return { ...config, publication: config.publication ?? this.adapter.publication ?? 'fast-forward-push' }; }
  get state() { return this.store.read(this.queueId); }
  /** Live view: ordered entries, attempts, freeze, ETA and metrics. */
  view({ windowMs } = {}) { return queueView(this.state, this.clock(), { windowMs }); }
  /** Adopt a changed configuration. Attempts in flight are retested when the candidate recipe changes. */
  reconfigure(config) { return this.store.initialize(this.queueId, this.#config(config), { reconfigure: true, at: this.clock() }); }
  enqueue(entry, { idempotencyKey }) {
    return this.store.dispatch(this.queueId, { type: 'enqueue', entry, at: this.clock() }, { idempotencyKey, receiptBody: { type: 'enqueue', entry } });
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
    try { return this.store.dispatch(this.queueId, { ...action, at: this.clock() }, { idempotencyKey, token, receiptBody: action }); }
    finally { this.store.release(this.queueId, token); }
  }
  /**
   * Owner commands. They never wait for the worker lease: each is one atomic transition, and a step that raced one
   * finds its attempt gone and stops quietly. Entries already publishing cannot be ejected or requeued.
   */
  freeze({ reason, by } = {}, { idempotencyKey }) { return this.#command({ type: 'freeze', ...(reason ? { reason } : {}), ...(by ? { by } : {}) }, idempotencyKey); }
  unfreeze({ idempotencyKey }) { return this.#command({ type: 'unfreeze' }, idempotencyKey); }
  eject({ entryId, reason = 'Ejected by the owner.' }, { idempotencyKey }) { return this.#command({ type: 'eject', entryId, reason }, idempotencyKey); }
  requeueEntry({ entryId, reason }, { idempotencyKey }) { return this.#command({ type: 'requeue-entry', entryId, ...(reason ? { reason } : {}) }, idempotencyKey); }
  prioritize({ entryId, lane, priority }, { idempotencyKey }) {
    return this.#command({ type: 'prioritize', entryId, ...(lane !== undefined ? { lane } : {}), ...(priority !== undefined ? { priority } : {}) }, idempotencyKey);
  }
  #command(action, idempotencyKey) {
    const original = this.store.receipt(this.queueId, idempotencyKey, action);
    if (original) return original;
    return this.store.dispatch(this.queueId, { ...action, at: this.clock() }, { idempotencyKey, receiptBody: action });
  }
  recordJobResult(result, { idempotencyKey }) {
    // Receipt lookup precedes active-attempt lookup so a retry still works after merge.
    // The persisted action includes the attempt; historical jobs let retries reconstruct it.
    const state = this.state;
    const job = state.jobs.find(job => job.id === result.id);
    requireValue(job, 'Job not found in this queue.', 'NOT_FOUND');
    const action = { type: 'result', attemptId: job.queueAttemptId, result };
    return this.store.dispatch(this.queueId, { ...action, at: this.clock() }, { idempotencyKey, receiptBody: action });
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
  #job(state, attempt, revision, id) {
    const config = state.config;
    const entries = attempt.entryIds.map(entryId => state.entries.find(entry => entry.id === entryId));
    const workItem = { headSha: revision, ...(entries.length === 1 ? { id: entries[0].workItemId, runId: entries[0].runId } : {}) };
    // Optional IDs are omitted rather than serialized as undefined.
    Object.keys(workItem).forEach(key => { if (workItem[key] === undefined) delete workItem[key]; });
    const job = buildJob({ id, projectId: config.projectId, repo: config.repo, config: config.ci, workItem });
    job.queueAttemptId = attempt.id;
    return job;
  }
  async #advance(token, stepKey) {
    const state = this.state;
    const config = state.config;
    const at = this.clock();
    // Owner commands commit without the lease, so a transition may find its attempt already gone: stop quietly.
    const dispatch = (action, key) => {
      try { return this.store.dispatch(this.queueId, { ...action, at }, { token, stepKey, idempotencyKey: key }); }
      catch (error) {
        if (error?.code === 'STALE_ATTEMPT' || (error?.code === 'CONFLICT' && /selection changed/.test(error.message))) return null;
        throw error;
      }
    };
    if (expiredEntries(state, at).length) { dispatch({ type: 'expire' }, `internal:expire:${randomUUID()}`); return; }
    if (!state.active) {
      const entries = selectEntries(state, { at });
      if (!entries.length) return;
      const baseSha = await this.adapter.getBase(config.baseBranch, config.publication);
      dispatch({ type: 'start', attemptId: `mq_${randomUUID()}`, entryIds: entries.map(entry => entry.id), baseSha }, `internal:start:${randomUUID()}`);
      return;
    }
    if (await this.#head(state, at, token, dispatch)) return;
    if (config.strategy === 'speculative') await this.#speculate(state, at, dispatch);
  }
  /** Advance the head attempt. Returns false only while it waits (CI running, or frozen), so speculation may proceed. */
  async #head(state, at, token, dispatch) {
    const config = state.config;
    const active = state.active;
    const entries = active.entryIds.map(id => state.entries.find(entry => entry.id === id));
    const transition = (type, fields = {}) => dispatch({ type, attemptId: active.id, ...fields }, `internal:${active.id}:${type}:${stableHash(fields)}`);
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
        transition('reject', { entryId, reason: 'PR head changed during merge; enqueue the new revision.', cause: 'head-changed' });
      }
      else if (result.status === 'rejected') transition('reject', { reason: result.reason });
      else if (result.status === 'pending') transition('publication-pending', { publicationState: result.publicationState ?? 'pending' });
      else {
        requireValue(result.status === 'merged' && (result.revision === active.revision ||
          (config.publication === 'github-merge-queue' && result.publication === 'github-merge-queue')),
        'Adapter did not confirm publication of the tested revision or native GitHub merge.', 'ADAPTER_ERROR');
        transition('merged', { revision: result.revision });
      }
      return true;
    }
    if (await this.adapter.getBase(config.baseBranch, config.publication) !== active.baseSha) {
      transition('requeue', { reason: 'Base changed; speculative CI must run again.' }); return true;
    }
    for (const entry of entries) {
      if (await this.adapter.getHead(entry) !== entry.headSha) {
        transition('reject', { entryId: entry.id, reason: 'PR head changed; enqueue the new revision.', cause: 'head-changed' }); return true;
      }
    }
    if (active.phase === 'preparing') {
      let candidate;
      try {
        candidate = await this.adapter.prepare({ baseSha: active.baseSha, entries, method: config.method, idempotencyKey: active.id, publication: config.publication });
      } catch (error) {
        if (error.code !== 'MERGE_CONFLICT') throw error;
        transition('reject', { ...(error.entryId ? { entryId: error.entryId } : {}), reason: 'Merge conflict with the speculative base.', rejectionKind: 'conflict' }); return true;
      }
      transition('prepared', { job: this.#job(state, active, candidate.revision, `job_${active.id}`) }); return true;
    }
    if (active.phase === 'testing') {
      const job = state.jobs.find(job => job.id === active.jobId);
      if (['queued', 'leased', 'running'].includes(job.status)) return false;
      if (!isEvidenceCurrent(job, { revision: active.revision, configHash: stableHash(config.ci) }) || !checksPass(job, config.requiredChecks)) {
        const retries = active.retries ?? 0;
        // Flaky retry: run the same candidate again before treating the failure as real.
        if (['failed', 'error'].includes(job.status) && retries < (policyOf(state).flakyRetries ?? 0)) {
          transition('retry', { job: this.#job(state, active, active.revision, `job_${active.id}_retry${retries + 1}`) }); return true;
        }
        transition('ci-failed', { rejectionKind: ['failed', 'passed'].includes(job.status) ? 'ci' : 'other',
          reason: job.status === 'passed' ? 'Required checks are missing or stale.' : `Speculative CI ${job.status}${retries ? ` after ${retries + 1} runs` : ''}.` });
        return true;
      }
      // A freeze holds tested work until it lifts; publication then rechecks the base as usual.
      if (frozenAt(state, at)) return false;
      transition('approve'); return true;
    }
    return true;
  }
  /**
   * Speculative strategy: up to depth-1 further attempts, each prepared on the candidate ahead of it, so their CI runs
   * while the head is still testing. Only the head's verdict decides; a failed or changed head discards them. A
   * speculative attempt that cannot be prepared waits, blocked, until it reaches the head and is prepared on the base.
   */
  async #speculate(state, at, dispatch) {
    const config = state.config;
    const pipeline = state.pipeline ?? [];
    for (const [index, attempt] of pipeline.entries()) {
      if (attempt.phase !== 'preparing') continue;
      const previous = index === 0 ? state.active : pipeline[index - 1];
      if (!previous.revision) return;
      const entries = attempt.entryIds.map(id => state.entries.find(entry => entry.id === id));
      for (const entry of entries) {
        if (await this.adapter.getHead(entry) !== entry.headSha) {
          dispatch({ type: 'reject', attemptId: attempt.id, entryId: entry.id, reason: 'PR head changed; enqueue the new revision.', cause: 'head-changed' }, `internal:${attempt.id}:reject`);
          return;
        }
      }
      let candidate;
      try {
        candidate = await this.adapter.prepare({ baseSha: previous.revision, entries, method: config.method, idempotencyKey: attempt.id, publication: config.publication });
      } catch (error) {
        const reason = error?.code === 'MERGE_CONFLICT' ? 'Conflicts with the change ahead; it is prepared again when it reaches the head.'
          : 'Speculative preparation failed; it is prepared again when it reaches the head.';
        dispatch({ type: 'block', attemptId: attempt.id, reason }, `internal:${attempt.id}:block`);
        return;
      }
      dispatch({ type: 'prepared', attemptId: attempt.id, baseSha: previous.revision, job: this.#job(state, attempt, candidate.revision, `job_${attempt.id}`) }, `internal:${attempt.id}:prepared`);
      return;
    }
    if (pipeline.length >= (policyOf(state).depth ?? 3) - 1) return;
    const entries = selectEntries(state, { at });
    if (!entries.length) return;
    dispatch({ type: 'speculate', attemptId: `mq_${randomUUID()}`, entryIds: entries.map(entry => entry.id) }, `internal:speculate:${randomUUID()}`);
  }
}
