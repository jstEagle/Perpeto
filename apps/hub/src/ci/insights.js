import { nonblank, requireValue } from '../errors.js';

const WINDOWS = { '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 };
const average = values => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};

/**
 * CI visibility from measured pipeline runs: per pipeline pass rate and duration trend, per job duration and queue
 * wait, fleet queue wait, and runner utilisation. Numbers only; nothing is estimated.
 */
export function insights(pipelines, query) {
  const window = query.get('window') ?? '7d';
  requireValue(Object.hasOwn(WINDOWS, window), 'window must be 24h, 7d or 30d.');
  const projectId = query.get('projectId'); if (projectId !== null) nonblank(projectId, 'projectId', 200);
  const time = pipelines.hub.clock(); const from = new Date(time - WINDOWS[window]).toISOString();
  const runs = (projectId ? pipelines.store.forProject('pipeline-run', projectId) : pipelines.store.list('pipeline-run'))
    .filter(run => run.createdAt >= from).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const byPipeline = new Map();
  for (const run of runs) { if (!byPipeline.has(run.pipeline)) byPipeline.set(run.pipeline, []); byPipeline.get(run.pipeline).push(run); }
  const waits = [];
  const result = [...byPipeline].map(([name, list]) => {
    const finished = list.filter(run => ['passed', 'failed'].includes(run.status));
    const durations = finished.map(run => run.durationMs).filter(Number.isFinite);
    const jobs = new Map();
    for (const run of list) for (const job of run.jobs) {
      const entry = jobs.get(job.name) ?? { name: job.name, durations: [], waits: [], runs: 0, failures: 0, flaky: 0 };
      entry.runs++;
      if (Number.isFinite(job.durationMs) && ['passed', 'failed'].includes(job.status)) entry.durations.push(job.durationMs);
      if (Number.isFinite(job.queueWaitMs)) { entry.waits.push(job.queueWaitMs); waits.push(job.queueWaitMs); }
      if (job.status === 'failed') entry.failures++;
      if (job.flaky) entry.flaky++;
      jobs.set(job.name, entry);
    }
    return {
      name, runs: list.length, passed: list.filter(run => run.status === 'passed').length, failed: list.filter(run => run.status === 'failed').length,
      passRate: finished.length ? finished.filter(run => run.status === 'passed').length / finished.length : null,
      avgDurationMs: average(durations), p90DurationMs: percentile(durations, 0.9),
      trend: finished.slice(-30).map(run => ({ runId: run.id, at: run.createdAt, durationMs: run.durationMs, status: run.status })),
      jobs: [...jobs.values()].map(entry => ({ name: entry.name, runs: entry.runs, failures: entry.failures, flaky: entry.flaky,
        avgDurationMs: average(entry.durations), p90DurationMs: percentile(entry.durations, 0.9), avgQueueWaitMs: average(entry.waits),
        trend: entry.durations.slice(-30) })),
    };
  });
  const runners = pipelines.runners.view().runners;
  return { window, from, pipelines: result, queueWait: { avgMs: average(waits), p90Ms: percentile(waits, 0.9), samples: waits.length },
    utilisation: runners.filter(runner => runner.maxJobs > 0).map(runner => ({ machineId: runner.machineId, name: runner.name, utilisation: runner.utilisation })) };
}
