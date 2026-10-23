import { checksPass, normalizeCI } from './jobs.js';
import { requireValue, sha, stableHash, string } from './common.js';
import { freezeAt, laneFor, normalizePolicy } from './queue-config.js';

const STRATEGIES = ['serial', 'batch', 'speculative'];
const KINDS = ['conflict', 'ci', 'other'];
/** Why an entry left the queue without merging. Metrics group failures by these. */
export const CAUSES = Object.freeze(['ci', 'conflict', 'head-changed', 'timeout', 'manual', 'approvals', 'other']);
const ACTIVE_JOB = ['queued', 'leased', 'running'];
const TERMINAL = ['merged', 'rejected'];
const HISTORY_LIMIT = 200;
const defined = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
const kindCause = kind => kind === 'conflict' ? 'conflict' : kind === 'ci' ? 'ci' : 'other';

/** Private durable fields extend MergeEntry without changing its public contract. */
export function createQueueState(config) {
  requireValue(config && typeof config === 'object', 'Queue configuration is required.');
  string(config.projectId, 'projectId'); string(config.baseBranch, 'baseBranch');
  requireValue(STRATEGIES.includes(config.strategy), 'Unknown merge strategy.');
  requireValue(['merge', 'squash', 'rebase'].includes(config.method), 'Unknown merge method.');
  requireValue(Array.isArray(config.requiredChecks) && config.requiredChecks.every(name => typeof name === 'string' && name.trim()), 'requiredChecks must be an array of names.');
  requireValue(config.repo && typeof config.repo.url === 'string', 'repo.url is required.');
  const publication = config.publication ?? 'fast-forward-push';
  requireValue(['fast-forward-push', 'github-merge-queue'].includes(publication), 'Unknown publication strategy.');
  requireValue(publication !== 'github-merge-queue' || config.strategy === 'serial', 'Native GitHub publication requires a serial queue.');
  const batchSize = config.batchSize ?? 8;
  requireValue(Number.isSafeInteger(batchSize) && batchSize > 0 && batchSize <= 100, 'batchSize must be between 1 and 100.');
  // Policy is optional and only carries set fields, so queues without one keep their original configuration hash.
  const policy = config.policy === undefined ? {} : normalizePolicy(config.policy);
  return {
    schema: 1,
    config: { projectId: config.projectId, repo: structuredClone(config.repo), baseBranch: config.baseBranch,
      strategy: config.strategy, method: config.method, publication, requiredChecks: [...new Set(config.requiredChecks)],
      ci: normalizeCI(config.ci), batchSize, ...(Object.keys(policy).length ? { policy } : {}) },
    entries: [], jobs: [], groups: [], active: null,
  };
}

export const policyOf = state => state.config.policy ?? {};
/** The head attempt first, then speculative attempts stacked on it. */
export const attemptsOf = state => [state.active, ...(state.pipeline ?? [])].filter(Boolean);
/** The freeze in force: a manual freeze, or a configured window when `at` (ms) is known. */
export const frozenAt = (state, at) => freezeAt({ manual: state.freeze, windows: policyOf(state).freezeWindows }, at);
const ordinal = (entry, index) => entry.seq ?? index;

/** Queued entries in service order: higher lane priority first, then the order they joined (or were requeued). */
export function queuedOrder(state) {
  return state.entries.map((entry, index) => ({ entry, index })).filter(item => item.entry.status === 'queued')
    .sort((a, b) => (b.entry.priority ?? 0) - (a.entry.priority ?? 0) || ordinal(a.entry, a.index) - ordinal(b.entry, b.index))
    .map(item => item.entry);
}

/** Entries an expiring queue ejects at `at`: still waiting or testing, never ones being published. */
export function expiredEntries(state, at) {
  const limit = policyOf(state).ejectAfterMs;
  if (!limit || !Number.isFinite(at)) return [];
  return state.entries.filter(entry => ['queued', 'testing'].includes(entry.status) && Number.isFinite(entry.enqueuedAt) && entry.enqueuedAt + limit <= at);
}

/**
 * Select the next unit of work: a bisection group first, else the head of the priority order. Serial and speculative
 * queues take one entry, batches up to batchSize; maxInFlight caps every attempt together. Freezes select nothing.
 */
export function selectEntries(state, { at } = {}) {
  if (frozenAt(state, at)) return [];
  const queued = queuedOrder(state);
  const { maxInFlight } = policyOf(state);
  const room = maxInFlight ? maxInFlight - state.entries.filter(entry => ['testing', 'merging'].includes(entry.status)).length : Infinity;
  if (room <= 0) return [];
  const group = state.groups.map(ids => ids.filter(id => queued.some(entry => entry.id === id))).find(ids => ids.length);
  const ids = group ? group.slice(0, room) : queued.slice(0, Math.min(state.config.strategy === 'batch' ? state.config.batchSize : 1, room)).map(entry => entry.id);
  return ids.map(id => queued.find(entry => entry.id === id));
}

function history(state, attempt, outcome, at, cause) {
  state.history ??= [];
  state.history.push(defined({ id: attempt.id, entryIds: [...attempt.entryIds], startedAt: attempt.startedAt, finishedAt: at, outcome, cause,
    ...(attempt.retries ? { retries: attempt.retries } : {}) }));
  if (state.history.length > HISTORY_LIMIT) state.history.splice(0, state.history.length - HISTORY_LIMIT);
}
function cancelJob(state, attempt) {
  const job = state.jobs.find(job => job.id === attempt.jobId);
  if (job && ACTIVE_JOB.includes(job.status)) job.status = 'cancelled';
}
/** Return speculative attempts from `index` on to the queue; their entries keep their place in the order. */
function discard(state, index, at, reason) {
  const pipeline = state.pipeline ?? [];
  for (const attempt of pipeline.slice(index)) {
    cancelJob(state, attempt); history(state, attempt, 'discarded', at);
    for (const entry of state.entries.filter(entry => attempt.entryIds.includes(entry.id))) {
      entry.status = 'queued'; entry.reason = reason; delete entry.jobId;
    }
  }
  if (pipeline.length > index) state.pipeline = pipeline.slice(0, index);
}
function reject(entry, { reason, kind = 'other', cause = kindCause(kind), at }) {
  entry.status = 'rejected'; entry.reason = reason; entry.rejectionKind = kind; entry.cause = cause;
  if (at !== undefined) entry.finishedAt = at;
}
function nextSeq(state) {
  const seq = state.seq ?? state.entries.length;
  state.seq = seq + 1;
  return seq;
}
function assignLane(state, entry) {
  if (entry.pinned) return;
  const lane = laneFor(policyOf(state), entry);
  if (lane) { entry.lane = lane.name; entry.priority = lane.priority; } else { delete entry.lane; delete entry.priority; }
}
function validateJob(state, job, attempt) {
  sha(job.revision);
  requireValue(job.configHash === stableHash(state.config.ci) &&
    stableHash({ steps: job.steps, requirements: job.requirements }) === job.configHash &&
    job.projectId === state.config.projectId && job.queueAttemptId === attempt.id &&
    job.status === 'queued' && !state.jobs.some(other => other.id === job.id), 'Prepared job differs from queue CI configuration.');
}

/** Pure deterministic transition. All IDs, times (`at`, ms) and external observations arrive in the action. */
export function reduceQueue(previous, action) {
  const state = structuredClone(previous);
  const at = action.at;
  if (at !== undefined) requireValue(Number.isSafeInteger(at) && at >= 0, 'at must be a time in milliseconds.');
  if (action.rejectionKind !== undefined) requireValue(KINDS.includes(action.rejectionKind), 'Invalid rejection kind.');
  if (action.cause !== undefined) requireValue(CAUSES.includes(action.cause), 'Invalid rejection cause.');
  const policy = policyOf(state);
  if (action.type === 'enqueue') {
    const entry = structuredClone(action.entry);
    requireValue(entry && typeof entry === 'object', 'Merge entry is required.');
    for (const key of ['id', 'projectId', 'prUrl', 'baseBranch']) string(entry[key], key);
    for (const key of ['workItemId', 'runId', 'headBranch']) if (entry[key] !== undefined) string(entry[key], key);
    if (entry.labels !== undefined) requireValue(Array.isArray(entry.labels) && entry.labels.length <= 50 && entry.labels.every(label => typeof label === 'string' && label.trim()), 'labels must be an array of names.');
    if (entry.approvals !== undefined) requireValue(Number.isSafeInteger(entry.approvals) && entry.approvals >= 0, 'approvals must be a count.');
    sha(entry.headSha);
    requireValue(entry.projectId === state.config.projectId && entry.baseBranch === state.config.baseBranch, 'Entry belongs to a different queue.');
    requireValue(!state.entries.some(item => item.id === entry.id), 'Entry id already exists.', 'CONFLICT');
    requireValue(!state.entries.some(item => item.prUrl === entry.prUrl && !TERMINAL.includes(item.status)), 'PR already has active queue work.', 'CONFLICT');
    const required = policy.requiredApprovals ?? 0;
    requireValue((entry.approvals ?? 0) >= required, `This queue needs ${required} approving review${required === 1 ? '' : 's'}; the change has ${entry.approvals ?? 0}.`, 'APPROVALS_REQUIRED');
    // Caller cannot inject status, a job reference, a lane, or a prior merge receipt.
    const value = { id: entry.id, projectId: entry.projectId, prUrl: entry.prUrl, headSha: entry.headSha,
      baseBranch: entry.baseBranch, status: 'queued', ...(entry.workItemId ? { workItemId: entry.workItemId } : {}),
      ...(entry.runId ? { runId: entry.runId } : {}) };
    // Policy-era fields appear only when used, so legacy queues keep byte-identical snapshots.
    if (entry.headBranch) value.headBranch = entry.headBranch;
    if (entry.labels?.length) value.labels = [...new Set(entry.labels)];
    if (entry.approvals !== undefined && required) value.approvals = entry.approvals;
    if (at !== undefined) value.enqueuedAt = at;
    if (state.seq !== undefined || policy.lanes) value.seq = nextSeq(state);
    assignLane(state, value);
    state.entries.push(value);
    return state;
  }
  if (action.type === 'start' || action.type === 'speculate') {
    if (action.type === 'start') requireValue(!state.active, 'A queue attempt is already active.', 'CONFLICT');
    else {
      requireValue(state.config.strategy === 'speculative' && state.active, 'Only a speculative queue with a head attempt can speculate.', 'CONFLICT');
      requireValue((state.pipeline ?? []).length < (policy.depth ?? 3) - 1, 'Speculation depth is full.', 'CONFLICT');
    }
    const selected = selectEntries(state, { at }).map(entry => entry.id);
    requireValue(selected.length > 0 && JSON.stringify(selected) === JSON.stringify(action.entryIds), 'Queue selection changed.', 'CONFLICT');
    string(action.attemptId, 'attemptId');
    requireValue(!attemptsOf(state).some(attempt => attempt.id === action.attemptId), 'Attempt id already exists.', 'CONFLICT');
    state.groups = state.groups.map(ids => ids.filter(id => !selected.includes(id))).filter(ids => ids.length);
    const attempt = { id: action.attemptId, entryIds: selected, phase: 'preparing', ...(at !== undefined ? { startedAt: at } : {}) };
    if (action.type === 'start') { sha(action.baseSha); state.active = { ...attempt, baseSha: action.baseSha }; }
    else (state.pipeline ??= []).push(attempt);
    for (const entry of state.entries.filter(entry => selected.includes(entry.id))) {
      entry.status = 'testing'; delete entry.reason; delete entry.jobId; delete entry.rejectionKind; delete entry.cause;
    }
    return state;
  }
  if (action.type === 'freeze') {
    if (action.reason !== undefined) string(action.reason, 'reason');
    state.freeze = defined({ reason: action.reason ?? 'Frozen manually.', at, by: action.by });
    return state;
  }
  if (action.type === 'unfreeze') { delete state.freeze; return state; }
  if (action.type === 'configure') {
    const next = createQueueState(action.config).config;
    requireValue(next.projectId === state.config.projectId && next.baseBranch === state.config.baseBranch, 'A queue keeps its project and base branch.');
    const identity = config => stableHash({ repo: config.repo, strategy: config.strategy, method: config.method, publication: config.publication, ci: config.ci, requiredChecks: config.requiredChecks });
    let result = state;
    // A changed candidate recipe invalidates attempts in flight, but never one already publishing.
    if (identity(next) !== identity(state.config) && state.active && state.active.phase !== 'merging') {
      result = reduceQueue(state, { type: 'requeue', attemptId: state.active.id, reason: 'Queue configuration changed; testing again.', ...(at !== undefined ? { at } : {}) });
    } else if (identity(next) !== identity(state.config)) discard(result, 0, at, 'Queue configuration changed; testing again.');
    result.config = next;
    for (const entry of result.entries.filter(entry => !TERMINAL.includes(entry.status))) assignLane(result, entry);
    if (next.policy?.lanes && result.seq === undefined) result.seq = result.entries.length;
    return result;
  }
  if (['withdraw', 'reject-entry', 'eject', 'prioritize', 'requeue-entry'].includes(action.type)) {
    const entry = state.entries.find(item => item.id === action.entryId);
    requireValue(entry, 'Merge entry not found.', 'NOT_FOUND');
    requireValue(!TERMINAL.includes(entry.status), 'Merge entry is already terminal.', 'CONFLICT');
    if (action.type === 'prioritize') {
      if (action.lane !== undefined) {
        const lane = (policy.lanes ?? []).find(item => item.name === action.lane);
        requireValue(lane, 'Unknown lane for this queue.');
        entry.lane = lane.name; entry.priority = lane.priority;
      }
      if (action.priority !== undefined) {
        requireValue(Number.isSafeInteger(action.priority) && action.priority >= 0 && action.priority <= 10000, 'priority must be an integer from 0 to 10000.');
        entry.priority = action.priority;
      }
      requireValue(action.lane !== undefined || action.priority !== undefined, 'Give a lane or a priority.');
      entry.pinned = true;
      state.seq ??= state.entries.length;
      return state;
    }
    const attempt = attemptsOf(state).find(item => item.entryIds.includes(entry.id));
    if (['eject', 'requeue-entry'].includes(action.type)) requireValue(entry.status !== 'merging', 'The entry is being published and can no longer leave the queue.', 'CONFLICT');
    if (action.type === 'requeue-entry') {
      state.groups = state.groups.map(ids => ids.filter(id => id !== entry.id)).filter(ids => ids.length);
      state.seq ??= state.entries.length;
      let result = state;
      if (attempt) {
        result = reduceQueue(state, { type: 'release-entry', attemptId: attempt.id, entryId: entry.id, reason: action.reason ?? 'Requeued by the owner.', ...(at !== undefined ? { at } : {}) });
      }
      const moved = result.entries.find(item => item.id === entry.id);
      moved.status = 'queued'; moved.seq = nextSeq(result); moved.reason = action.reason ?? 'Requeued by the owner.'; delete moved.jobId;
      if (at !== undefined) moved.enqueuedAt = at;
      return result;
    }
    string(action.reason, 'reason');
    const kind = action.rejectionKind ?? 'other';
    const cause = action.cause ?? (action.type === 'eject' ? 'manual' : kindCause(kind));
    if (attempt) {
      return reduceQueue(state, defined({ type: 'reject', attemptId: attempt.id, entryId: entry.id, reason: action.reason, rejectionKind: kind, cause, at }));
    }
    reject(entry, { reason: action.reason, kind, cause, at }); delete entry.jobId;
    state.groups = state.groups.map(ids => ids.filter(id => id !== entry.id)).filter(ids => ids.length);
    return state;
  }
  if (action.type === 'expire') {
    let result = state;
    const minutes = Math.round((policy.ejectAfterMs ?? 0) / 60000);
    for (const entry of expiredEntries(state, at)) {
      result = reduceQueue(result, { type: 'reject-entry', entryId: entry.id, reason: `Waited longer than ${minutes} minutes; ejected.`, cause: 'timeout', at });
    }
    return result;
  }
  const attempt = attemptsOf(state).find(item => item.id === action.attemptId);
  requireValue(attempt, 'Queue attempt is no longer current.', 'STALE_ATTEMPT');
  const head = attempt === state.active;
  const index = head ? -1 : state.pipeline.indexOf(attempt);
  const entries = state.entries.filter(entry => attempt.entryIds.includes(entry.id));
  const onlyHead = () => requireValue(head, 'Only the head attempt can do this.', 'CONFLICT');
  /** End the attempt. A head that does not merge takes every speculation stacked on it with it. */
  const end = (outcome, cause) => {
    cancelJob(state, attempt); history(state, attempt, outcome, at, cause);
    if (!head) { state.pipeline.splice(index, 1); discard(state, index, at, 'An earlier speculative attempt changed; testing again.'); return; }
    if (outcome === 'merged' && state.pipeline?.length) {
      const next = state.pipeline.shift();
      // The promoted attempt was stacked on the head's candidate, which is now the published base.
      if (next.phase === 'blocked' || !next.baseSha) { next.baseSha = attempt.revision; if (next.phase === 'blocked') { next.phase = 'preparing'; delete next.reason; } }
      state.active = next;
      return;
    }
    discard(state, 0, at, 'The attempt ahead changed; testing again.');
    state.active = null;
  };
  const finish = entry => { if (at !== undefined) entry.finishedAt = at; };
  switch (action.type) {
    case 'prepared':
      requireValue(attempt.phase === 'preparing', 'Attempt is not preparing.', 'CONFLICT');
      validateJob(state, action.job, attempt);
      if (!head) attempt.baseSha = sha(action.baseSha);
      attempt.phase = 'testing'; attempt.revision = action.job.revision; attempt.jobId = action.job.id;
      state.jobs.push(structuredClone(action.job));
      entries.forEach(entry => { entry.jobId = action.job.id; });
      break;
    case 'block':
      requireValue(!head && attempt.phase === 'preparing', 'Only a preparing speculative attempt can wait for the head.', 'CONFLICT');
      string(action.reason, 'reason');
      attempt.phase = 'blocked'; attempt.reason = action.reason;
      break;
    case 'result': {
      requireValue(attempt.phase === 'testing', 'Attempt is not awaiting CI.', 'STALE_ATTEMPT');
      const job = state.jobs.find(job => job.id === attempt.jobId);
      const result = action.result;
      if (result.checks !== undefined) requireValue(Array.isArray(result.checks) && result.checks.every(check =>
        check && typeof check.name === 'string' && ['passed', 'failed', 'pending'].includes(check.status)), 'Checks must be named status records.');
      requireValue(result.id === job.id && result.revision === job.revision && result.configHash === job.configHash, 'Result identity does not match the speculative job.', 'STALE_EVIDENCE');
      requireValue(['passed', 'failed', 'error', 'cancelled'].includes(result.status), 'A terminal job status is required.');
      requireValue(job.status === 'queued', 'Job already has a result.', 'CONFLICT');
      job.status = result.status;
      for (const key of ['logRef', 'artifacts', 'checks']) if (result[key] !== undefined) job[key] = structuredClone(result[key]);
      if (at !== undefined) job.finishedAt = at;
      break;
    }
    case 'retry': {
      // Flaky retry: the same candidate revision runs CI again before the queue gives up on it.
      requireValue(attempt.phase === 'testing', 'Attempt is not testing.', 'CONFLICT');
      const old = state.jobs.find(job => job.id === attempt.jobId);
      requireValue(old && ['failed', 'error'].includes(old.status), 'Only a failed job can be retried.', 'CONFLICT');
      requireValue((attempt.retries ?? 0) < (policy.flakyRetries ?? 0), 'No flaky retries remain.', 'CONFLICT');
      validateJob(state, action.job, attempt);
      requireValue(action.job.revision === attempt.revision, 'A retry tests the same candidate revision.');
      attempt.retries = (attempt.retries ?? 0) + 1; attempt.jobId = action.job.id;
      state.jobs.push(structuredClone(action.job));
      entries.forEach(entry => { entry.jobId = action.job.id; entry.retries = attempt.retries; });
      break;
    }
    case 'requeue':
      onlyHead();
      entries.forEach(entry => { entry.status = 'queued'; entry.reason = action.reason; delete entry.jobId; });
      state.groups.unshift(attempt.entryIds);
      end('requeued');
      break;
    case 'release-entry': {
      // One entry leaves an attempt without a verdict (requeue by the owner). Batch survivors retry as a group.
      const remaining = attempt.entryIds.filter(id => id !== action.entryId);
      for (const entry of entries.filter(entry => entry.id !== action.entryId)) { entry.status = 'queued'; delete entry.jobId; }
      if (remaining.length) state.groups.unshift(remaining);
      end('requeued');
      break;
    }
    case 'reject': {
      const rejected = action.entryId ? entries.filter(entry => entry.id === action.entryId) : entries;
      requireValue(rejected.length > 0, 'Rejected entry is not in this attempt.');
      const kind = action.rejectionKind ?? 'other';
      for (const entry of entries) {
        if (rejected.includes(entry)) reject(entry, { reason: action.reason, kind, cause: action.cause ?? kindCause(kind), at });
        else { entry.status = 'queued'; delete entry.jobId; }
      }
      const remaining = attempt.entryIds.filter(id => !rejected.some(entry => entry.id === id));
      if (remaining.length) state.groups.unshift(remaining);
      end('rejected', action.cause ?? kindCause(kind));
      break;
    }
    case 'ci-failed':
      onlyHead();
      if (entries.length === 1 || policy.bisect === false) {
        for (const entry of entries) reject(entry, { reason: action.reason, kind: action.rejectionKind ?? 'ci', cause: 'ci', at });
      } else {
        entries.forEach(entry => { entry.status = 'queued'; entry.reason = 'Batch failed; testing a smaller group.'; delete entry.jobId; });
        const middle = Math.ceil(attempt.entryIds.length / 2);
        state.groups.unshift(attempt.entryIds.slice(0, middle), attempt.entryIds.slice(middle));
      }
      end('failed', 'ci');
      break;
    case 'approve':
      onlyHead();
      requireValue(attempt.phase === 'testing', 'Attempt is not testing.', 'CONFLICT');
      requireValue(!frozenAt(state, at), 'The queue is frozen; publication waits.', 'FROZEN');
      requireValue(checksPass(state.jobs.find(job => job.id === attempt.jobId), state.config.requiredChecks), 'CI has not passed all required checks.', 'STALE_EVIDENCE');
      attempt.phase = 'merging'; entries.forEach(entry => { entry.status = 'merging'; });
      break;
    case 'publication-pending':
      onlyHead();
      requireValue(attempt.phase === 'merging', 'Attempt is not merging.', 'CONFLICT');
      attempt.publicationState = action.publicationState;
      break;
    case 'merged':
      onlyHead();
      requireValue(attempt.phase === 'merging', 'Attempt is not merging.', 'CONFLICT');
      if (action.revision !== undefined) sha(action.revision);
      entries.forEach(entry => { entry.status = 'merged'; entry.mergedRevision = action.revision ?? attempt.revision;
        entry.testedRevision = attempt.revision; delete entry.reason; finish(entry); });
      end('merged');
      break;
    default: requireValue(false, 'Unknown queue action.');
  }
  return state;
}
