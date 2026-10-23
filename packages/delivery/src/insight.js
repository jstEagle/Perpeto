import { attemptsOf, frozenAt, policyOf, queuedOrder } from './machine.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const RECENT = 20;

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** Median attempt duration over the most recent finished attempts, the basis for ETAs. */
export function attemptDuration(states) {
  const finished = states.flatMap(state => state.history ?? [])
    .filter(item => ['merged', 'failed', 'rejected'].includes(item.outcome) && Number.isFinite(item.startedAt) && Number.isFinite(item.finishedAt))
    .sort((a, b) => b.finishedAt - a.finishedAt).slice(0, RECENT);
  return { medianMs: median(finished.map(item => item.finishedAt - item.startedAt)), samples: finished.length };
}

/**
 * Visibility metrics over one or more queue snapshots for the window ending at `now`: merged throughput per hour (and
 * hourly buckets), median time from joining the queue to merging, failure rate overall and by cause, batch success.
 */
export function queueMetrics(input, now, { windowMs = DAY } = {}) {
  const states = Array.isArray(input) ? input : [input];
  const from = now - windowMs;
  const finished = states.flatMap(state => state.entries).filter(entry => ['merged', 'rejected'].includes(entry.status) && Number.isFinite(entry.finishedAt) && entry.finishedAt > from && entry.finishedAt <= now);
  const merged = finished.filter(entry => entry.status === 'merged');
  const rejected = finished.filter(entry => entry.status === 'rejected');
  const causes = new Map();
  for (const entry of rejected) causes.set(entry.cause ?? entry.rejectionKind ?? 'other', (causes.get(entry.cause ?? entry.rejectionKind ?? 'other') ?? 0) + 1);
  const attempts = states.flatMap(state => state.history ?? []).filter(item => Number.isFinite(item.finishedAt) && item.finishedAt > from && item.finishedAt <= now);
  const batches = attempts.filter(item => item.entryIds.length > 1 && ['merged', 'failed', 'rejected'].includes(item.outcome));
  const hours = Math.min(48, Math.ceil(windowMs / HOUR));
  const hourly = Array.from({ length: hours }, (_, index) => {
    const end = now - (hours - 1 - index) * HOUR; const start = end - HOUR;
    const inside = entry => entry.finishedAt > start && entry.finishedAt <= end;
    return { start: new Date(start).toISOString(), merged: merged.filter(inside).length, rejected: rejected.filter(inside).length };
  });
  return {
    windowMs, merged: merged.length, rejected: rejected.length,
    throughputPerHour: Math.round((merged.length / (windowMs / HOUR)) * 100) / 100,
    medianTimeInQueueMs: median(merged.filter(entry => Number.isFinite(entry.enqueuedAt)).map(entry => entry.finishedAt - entry.enqueuedAt)),
    failureRate: finished.length ? Math.round((rejected.length / finished.length) * 1000) / 1000 : null,
    failuresByReason: [...causes].map(([cause, count]) => ({ cause, count, rate: Math.round((count / finished.length) * 1000) / 1000 }))
      .sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause)),
    batches: { total: batches.length, succeeded: batches.filter(item => item.outcome === 'merged').length,
      successRate: batches.length ? Math.round((batches.filter(item => item.outcome === 'merged').length / batches.length) * 1000) / 1000 : null },
    flakyRetries: attempts.reduce((sum, item) => sum + (item.retries ?? 0), 0),
    hourly,
  };
}

/**
 * Live view of one queue: entries in service order (attempts in flight, then the waiting order), attempts with their
 * job, the freeze in force, recent outcomes, ETA estimates and metrics. ETAs are estimates from recent attempt
 * durations: each round serves one entry (serial), a batch, or `depth` entries (speculative, tested concurrently).
 */
export function queueView(state, now, { windowMs = DAY } = {}) {
  const policy = policyOf(state);
  const { medianMs, samples } = attemptDuration([state]);
  const attempts = attemptsOf(state);
  const job = attempt => state.jobs.find(item => item.id === attempt.jobId);
  const headRemaining = state.active && medianMs !== null ? Math.max(0, medianMs - (now - (state.active.startedAt ?? now))) : 0;
  const unit = state.config.strategy === 'batch' ? state.config.batchSize : state.config.strategy === 'speculative' ? policy.depth ?? 3 : 1;
  const view = (entry, extra) => ({
    id: entry.id, prUrl: entry.prUrl, headSha: entry.headSha, baseBranch: entry.baseBranch, status: entry.status,
    ...(entry.workItemId ? { workItemId: entry.workItemId } : {}), ...(entry.runId ? { runId: entry.runId } : {}),
    ...(entry.lane ? { lane: entry.lane } : {}), priority: entry.priority ?? 0, ...(entry.pinned ? { pinned: true } : {}),
    ...(entry.headBranch ? { headBranch: entry.headBranch } : {}), ...(entry.labels ? { labels: entry.labels } : {}),
    ...(Number.isFinite(entry.enqueuedAt) ? { enqueuedAt: new Date(entry.enqueuedAt).toISOString(), waitedMs: Math.max(0, (entry.finishedAt ?? now) - entry.enqueuedAt) } : {}),
    ...(entry.reason ? { reason: entry.reason } : {}), ...(entry.cause ? { cause: entry.cause } : {}),
    ...(entry.jobId ? { jobId: entry.jobId } : {}), ...(entry.retries ? { retries: entry.retries } : {}), ...extra,
  });
  const ordered = [];
  attempts.forEach((attempt, index) => {
    const eta = medianMs === null ? null : now + (index === 0 ? headRemaining : Math.max(headRemaining, medianMs - (now - (attempt.startedAt ?? now))));
    for (const id of attempt.entryIds) {
      const entry = state.entries.find(item => item.id === id);
      if (entry) ordered.push(view(entry, { attemptId: attempt.id, phase: attempt.phase, ...(eta !== null ? { etaAt: new Date(eta).toISOString() } : {}) }));
    }
  });
  queuedOrder(state).forEach((entry, index) => {
    const eta = medianMs === null ? null : now + headRemaining + (Math.floor(index / unit) + 1) * medianMs;
    ordered.push(view(entry, eta !== null ? { etaAt: new Date(eta).toISOString() } : {}));
  });
  ordered.forEach((entry, index) => { entry.position = index + 1; });
  const freeze = frozenAt(state, now);
  return {
    strategy: state.config.strategy, method: state.config.method, publication: state.config.publication, baseBranch: state.config.baseBranch,
    batchSize: state.config.batchSize, ...(state.config.strategy === 'speculative' ? { depth: policy.depth ?? 3 } : {}),
    requiredChecks: state.config.requiredChecks, lanes: policy.lanes ?? [], maxInFlight: policy.maxInFlight ?? null,
    frozen: freeze ? { ...freeze, ...(freeze.since !== undefined ? { since: new Date(freeze.since).toISOString() } : {}), ...(freeze.until !== undefined ? { until: new Date(freeze.until).toISOString() } : {}) } : null,
    entries: ordered,
    attempts: attempts.map((attempt, index) => ({
      id: attempt.id, head: index === 0, phase: attempt.phase, entryIds: attempt.entryIds, size: attempt.entryIds.length,
      ...(Number.isFinite(attempt.startedAt) ? { startedAt: new Date(attempt.startedAt).toISOString() } : {}),
      ...(attempt.jobId ? { jobId: attempt.jobId, jobStatus: job(attempt)?.status } : {}),
      ...(attempt.revision ? { revision: attempt.revision } : {}), ...(attempt.baseSha ? { baseSha: attempt.baseSha } : {}),
      ...(attempt.retries ? { retries: attempt.retries } : {}), ...(attempt.reason ? { reason: attempt.reason } : {}),
    })),
    testing: ordered.filter(entry => entry.status === 'testing').map(entry => entry.id),
    recent: state.entries.filter(entry => ['merged', 'rejected'].includes(entry.status))
      .map((entry, index) => ({ entry, index })).sort((a, b) => (b.entry.finishedAt ?? b.index) - (a.entry.finishedAt ?? a.index)).slice(0, RECENT)
      .map(({ entry }) => view(entry, entry.finishedAt ? { finishedAt: new Date(entry.finishedAt).toISOString() } : {})),
    eta: { attemptMs: medianMs, samples },
    metrics: queueMetrics([state], now, { windowMs }),
  };
}
