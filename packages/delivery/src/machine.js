import { checksPass, normalizeCI } from './jobs.js';
import { requireValue, sha, stableHash, string } from './common.js';

/** Private durable fields extend MergeEntry without changing its public contract. */
export function createQueueState(config) {
  requireValue(config && typeof config === 'object', 'Queue configuration is required.');
  string(config.projectId, 'projectId'); string(config.baseBranch, 'baseBranch');
  requireValue(['serial', 'batch'].includes(config.strategy), 'Unknown merge strategy.');
  requireValue(['merge', 'squash', 'rebase'].includes(config.method), 'Unknown merge method.');
  requireValue(Array.isArray(config.requiredChecks) && config.requiredChecks.every(name => typeof name === 'string' && name.trim()), 'requiredChecks must be an array of names.');
  requireValue(config.repo && typeof config.repo.url === 'string', 'repo.url is required.');
  const publication = config.publication ?? 'fast-forward-push';
  requireValue(['fast-forward-push', 'github-merge-queue'].includes(publication), 'Unknown publication strategy.');
  requireValue(publication !== 'github-merge-queue' || config.strategy === 'serial', 'Native GitHub publication requires a serial queue.');
  const batchSize = config.batchSize ?? 8;
  requireValue(Number.isSafeInteger(batchSize) && batchSize > 0 && batchSize <= 100, 'batchSize must be between 1 and 100.');
  return {
    schema: 1,
    config: { projectId: config.projectId, repo: structuredClone(config.repo), baseBranch: config.baseBranch,
      strategy: config.strategy, method: config.method, publication, requiredChecks: [...new Set(config.requiredChecks)],
      ci: normalizeCI(config.ci), batchSize },
    entries: [], jobs: [], groups: [], active: null,
  };
}

/** Select FIFO work, preserving bisection groups until they have been tried separately. */
export function selectEntries(state) {
  const queued = state.entries.filter(entry => entry.status === 'queued');
  const group = state.groups.map(ids => ids.filter(id => queued.some(entry => entry.id === id))).find(ids => ids.length);
  const ids = group ?? queued.slice(0, state.config.strategy === 'serial' ? 1 : state.config.batchSize).map(entry => entry.id);
  return ids.map(id => queued.find(entry => entry.id === id));
}

/** Pure deterministic transition. All IDs and external observations arrive in the action. */
export function reduceQueue(previous, action) {
  const state = structuredClone(previous);
  if (action.rejectionKind !== undefined) requireValue(['conflict', 'ci', 'other'].includes(action.rejectionKind), 'Invalid rejection kind.');
  if (action.type === 'enqueue') {
    const entry = structuredClone(action.entry);
    requireValue(entry && typeof entry === 'object', 'Merge entry is required.');
    for (const key of ['id', 'projectId', 'prUrl', 'baseBranch']) string(entry[key], key);
    for (const key of ['workItemId', 'runId']) if (entry[key] !== undefined) string(entry[key], key);
    sha(entry.headSha);
    requireValue(entry.projectId === state.config.projectId && entry.baseBranch === state.config.baseBranch, 'Entry belongs to a different queue.');
    requireValue(!state.entries.some(item => item.id === entry.id), 'Entry id already exists.', 'CONFLICT');
    requireValue(!state.entries.some(item => item.prUrl === entry.prUrl && !['merged', 'rejected'].includes(item.status)), 'PR already has active queue work.', 'CONFLICT');
    // Caller cannot inject status, a job reference, or a prior merge receipt.
    state.entries.push({ id: entry.id, projectId: entry.projectId, prUrl: entry.prUrl, headSha: entry.headSha,
      baseBranch: entry.baseBranch, status: 'queued', ...(entry.workItemId ? { workItemId: entry.workItemId } : {}),
      ...(entry.runId ? { runId: entry.runId } : {}) });
    return state;
  }
  if (action.type === 'start') {
    requireValue(!state.active, 'A queue attempt is already active.', 'CONFLICT');
    const selected = selectEntries(state).map(entry => entry.id);
    requireValue(selected.length > 0 && JSON.stringify(selected) === JSON.stringify(action.entryIds), 'Queue selection changed.', 'CONFLICT');
    sha(action.baseSha); string(action.attemptId, 'attemptId');
    state.groups = state.groups.map(ids => ids.filter(id => !selected.includes(id))).filter(ids => ids.length);
    state.active = { id: action.attemptId, entryIds: selected, baseSha: action.baseSha, phase: 'preparing' };
    for (const entry of state.entries.filter(entry => selected.includes(entry.id))) {
      entry.status = 'testing'; delete entry.reason; delete entry.jobId; delete entry.rejectionKind;
    }
    return state;
  }
  if (['withdraw', 'reject-entry'].includes(action.type)) {
    const entry = state.entries.find(item => item.id === action.entryId);
    requireValue(entry, 'Merge entry not found.', 'NOT_FOUND');
    requireValue(!['merged', 'rejected'].includes(entry.status), 'Merge entry is already terminal.', 'CONFLICT');
    string(action.reason, 'reason');
    if (state.active?.entryIds.includes(entry.id)) {
      return reduceQueue(state, { type: 'reject', attemptId: state.active.id, entryId: entry.id, reason: action.reason, rejectionKind: action.rejectionKind ?? 'other' });
    }
    entry.status = 'rejected'; entry.reason = action.reason; entry.rejectionKind = action.rejectionKind ?? 'other'; delete entry.jobId;
    state.groups = state.groups.map(ids => ids.filter(id => id !== entry.id)).filter(ids => ids.length);
    return state;
  }
  const active = state.active;
  requireValue(active && active.id === action.attemptId, 'Queue attempt is no longer current.', 'STALE_ATTEMPT');
  const entries = state.entries.filter(entry => active.entryIds.includes(entry.id));
  const release = () => {
    const job = state.jobs.find(job => job.id === active.jobId);
    if (job && ['queued', 'leased', 'running'].includes(job.status)) job.status = 'cancelled';
    state.active = null;
  };
  switch (action.type) {
    case 'prepared':
      requireValue(active.phase === 'preparing', 'Attempt is not preparing.', 'CONFLICT');
      sha(action.job.revision);
      requireValue(action.job.configHash === stableHash(state.config.ci) &&
        stableHash({ steps: action.job.steps, requirements: action.job.requirements }) === action.job.configHash &&
        action.job.projectId === state.config.projectId && action.job.queueAttemptId === active.id &&
        action.job.status === 'queued' && !state.jobs.some(job => job.id === action.job.id), 'Prepared job differs from queue CI configuration.');
      active.phase = 'testing'; active.revision = action.job.revision; active.jobId = action.job.id;
      state.jobs.push(structuredClone(action.job));
      entries.forEach(entry => { entry.jobId = action.job.id; });
      break;
    case 'result': {
      requireValue(active.phase === 'testing', 'Attempt is not awaiting CI.', 'STALE_ATTEMPT');
      const job = state.jobs.find(job => job.id === active.jobId);
      const result = action.result;
      if (result.checks !== undefined) requireValue(Array.isArray(result.checks) && result.checks.every(check =>
        check && typeof check.name === 'string' && ['passed', 'failed', 'pending'].includes(check.status)), 'Checks must be named status records.');
      requireValue(result.id === job.id && result.revision === job.revision && result.configHash === job.configHash, 'Result identity does not match the speculative job.', 'STALE_EVIDENCE');
      requireValue(['passed', 'failed', 'error', 'cancelled'].includes(result.status), 'A terminal job status is required.');
      requireValue(job.status === 'queued', 'Job already has a result.', 'CONFLICT');
      job.status = result.status;
      for (const key of ['logRef', 'artifacts', 'checks']) if (result[key] !== undefined) job[key] = structuredClone(result[key]);
      break;
    }
    case 'requeue':
      entries.forEach(entry => { entry.status = 'queued'; entry.reason = action.reason; delete entry.jobId; });
      state.groups.unshift(active.entryIds);
      release();
      break;
    case 'reject': {
      const rejected = action.entryId ? entries.filter(entry => entry.id === action.entryId) : entries;
      requireValue(rejected.length > 0, 'Rejected entry is not in this attempt.');
      for (const entry of entries) {
        entry.status = rejected.includes(entry) ? 'rejected' : 'queued';
        if (entry.status === 'rejected') { entry.reason = action.reason; entry.rejectionKind = action.rejectionKind ?? 'other'; }
        else delete entry.jobId;
      }
      const remaining = active.entryIds.filter(id => !rejected.some(entry => entry.id === id));
      if (remaining.length) state.groups.unshift(remaining);
      release();
      break;
    }
    case 'ci-failed':
      if (entries.length === 1) { entries[0].status = 'rejected'; entries[0].reason = action.reason; entries[0].rejectionKind = action.rejectionKind ?? 'ci'; }
      else {
        entries.forEach(entry => { entry.status = 'queued'; entry.reason = 'Batch failed; testing a smaller group.'; delete entry.jobId; });
        const middle = Math.ceil(active.entryIds.length / 2);
        state.groups.unshift(active.entryIds.slice(0, middle), active.entryIds.slice(middle));
      }
      release();
      break;
    case 'approve':
      requireValue(active.phase === 'testing', 'Attempt is not testing.', 'CONFLICT');
      requireValue(checksPass(state.jobs.find(job => job.id === active.jobId), state.config.requiredChecks), 'CI has not passed all required checks.', 'STALE_EVIDENCE');
      active.phase = 'merging'; entries.forEach(entry => { entry.status = 'merging'; });
      break;
    case 'publication-pending':
      requireValue(active.phase === 'merging', 'Attempt is not merging.', 'CONFLICT');
      active.publicationState = action.publicationState;
      break;
    case 'merged':
      requireValue(active.phase === 'merging', 'Attempt is not merging.', 'CONFLICT');
      if (action.revision !== undefined) sha(action.revision);
      entries.forEach(entry => { entry.status = 'merged'; entry.mergedRevision = action.revision ?? active.revision;
        entry.testedRevision = active.revision; delete entry.reason; });
      release();
      break;
    default: requireValue(false, 'Unknown queue action.');
  }
  return state;
}
