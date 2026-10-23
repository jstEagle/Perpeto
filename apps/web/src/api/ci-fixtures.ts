import { HubError } from './hub';
import type {
  CiArtifact,
  CiInsights,
  FlakyJob,
  JobLogPage,
  LogChunk,
  NewPipelineRun,
  Pipeline,
  PipelineJobStatus,
  PipelineList,
  PipelineRun,
  PipelineRunJob,
  PipelineRunQuery,
  RunnersView,
} from './ci';

/**
 * Demo CI for the `prj_perpeto` project: a repository pipeline with a
 * three-stage DAG and a two-way node matrix, a nightly pipeline, three
 * runners (agents only, CI only, both) and a flaky test. The running job's
 * log grows with time so the live viewer has something to follow.
 */

const MIN = 60_000;
const SHA = {
  live: '4c1f9a7e2b0d6c3f8a9e1b2c4d5f6a7b8c9d0e1f',
  flaky: '9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d',
  failed: 'b2a1c3d4e5f60718293a4b5c6d7e8f9012345678',
  nightly: '0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6',
} as const;
export const CI_DEMO_IDS = { live: 'plr_live01', flaky: 'plr_flk02', failed: 'plr_fail03', nightly: 'plr_ngt04', project: 'prj_perpeto' } as const;
const MACHINES = { studio: 'mch_studio', linux: 'mch_linux', air: 'mch_air' } as const;

const iso = (t: number) => new Date(t).toISOString();

const STEPS = {
  lint: [
    { name: 'install', run: 'npm ci' },
    { name: 'lint', run: 'npm run lint' },
  ],
  test: [
    { name: 'install', run: 'npm ci' },
    { name: 'test', run: 'npm test', timeoutSec: 1200 },
  ],
  package: [
    { name: 'build', run: 'npm run build' },
    { name: 'pack', run: 'npm pack --pack-destination dist' },
  ],
};

export function demoPipelines(projectId: string): PipelineList {
  const runsOn = { pool: 'default', labels: [] as string[] };
  const main: Pipeline = {
    name: 'default',
    triggers: [{ on: 'pull-request' }, { on: 'merge-queue' }, { on: 'manual' }],
    jobs: [
      { key: 'lint', name: 'lint', needs: [], runsOn, timeoutSec: 600, steps: STEPS.lint },
      { key: 'test (node=22)', name: 'test', needs: ['lint'], matrix: { node: '22' }, runsOn, timeoutSec: 1800, steps: STEPS.test },
      { key: 'test (node=24)', name: 'test', needs: ['lint'], matrix: { node: '24' }, runsOn, timeoutSec: 1800, steps: STEPS.test },
      { key: 'package', name: 'package', needs: ['test (node=22)', 'test (node=24)'], runsOn, timeoutSec: 900, steps: STEPS.package },
    ],
  };
  const nightly: Pipeline = {
    name: 'nightly',
    triggers: [{ on: 'schedule', cron: '0 3 * * *' }, { on: 'manual' }],
    jobs: [
      { key: 'e2e (os=darwin)', name: 'e2e', needs: [], matrix: { os: 'darwin' }, runsOn: { pool: 'default', os: 'darwin', labels: ['xcode'] }, timeoutSec: 3600, steps: [{ name: 'e2e', run: 'npm run test:e2e' }] },
      { key: 'e2e (os=linux)', name: 'e2e', needs: [], matrix: { os: 'linux' }, runsOn: { pool: 'default', os: 'linux', labels: [] }, timeoutSec: 3600, steps: [{ name: 'e2e', run: 'npm run test:e2e' }] },
    ],
  };
  if (projectId !== CI_DEMO_IDS.project) return { projectId, source: 'none', revision: null, path: null, pipelines: [] };
  return { projectId, source: 'repo', revision: SHA.live, path: '.perpeto/ci.json', pipelines: [main, nightly] };
}

type JobSpec = Partial<PipelineRunJob> & Pick<PipelineRunJob, 'key' | 'name' | 'needs' | 'status'>;
function job(spec: JobSpec): PipelineRunJob {
  return { runsOn: { pool: 'default', labels: [] }, attempt: 1, maxAttempts: 2, attempts: [], ...spec };
}
/** A finished or running attempt at [start, end) on a machine, queued `wait` before it started. */
function timed(jobId: string, status: PipelineJobStatus, machineId: string, start: number, end: number | null, wait: number) {
  return {
    jobId,
    machineId,
    queuedAt: iso(start - wait),
    startedAt: iso(start),
    ...(end !== null ? { finishedAt: iso(end), durationMs: end - start } : {}),
    queueWaitMs: wait,
    attempts: [{ jobId, status, machineId, queuedAt: iso(start - wait), startedAt: iso(start), ...(end !== null ? { finishedAt: iso(end) } : {}) }],
  };
}

const LOGS: Record<string, string[]> = {
  job_lint1: ['> perpeto@0.0.1 lint', '> eslint . --max-warnings 0', '', 'Checked 412 files in 6.1 s. No problems found.'],
  job_t22a: ['> perpeto@0.0.1 test', '> node scripts/test.mjs', '✔ hub (238 tests)', '✔ node (61 tests)', '✔ delivery (60 tests)', 'ℹ tests 359, pass 359, fail 0'],
  job_t24a: [
    '> perpeto@0.0.1 test',
    '> node scripts/test.mjs',
    '▶ apps/hub',
    '  ✔ HTTP authentication boundaries, CORS, input caps (42 ms)',
    '  ✔ idempotent mutations survive restart (61 ms)',
    '  ✔ leases respect requirements and capacity (18 ms)',
    '  ✔ pipeline runs fan out a DAG to runners (204 ms)',
    '▶ apps/node',
    '  ✔ CI checks out the exact revision (1.2 s)',
    '  ✔ dependency cache restores node_modules (880 ms)',
    '  ✔ artifacts are collected and size capped (310 ms)',
    '▶ packages/delivery',
    '  ✔ serial queue merges in order (75 ms)',
    '  ✔ failed batch bisects (140 ms)',
    '  ✔ native queue tracks the published revision (98 ms)',
    '▶ packages/workflow',
    '  ✔ ci nodes reference pipelines by name (12 ms)',
  ],
  job_f24a: ['> perpeto@0.0.1 test', '✔ hub (238 tests)', '✖ node: lease renewal outlives a slow hub (timed out after 5000 ms)', 'ℹ tests 359, pass 358, fail 1'],
  job_f24b: ['> perpeto@0.0.1 test', '✔ hub (238 tests)', '✔ node (61 tests)', 'ℹ tests 359, pass 359, fail 0'],
  job_fpkg: ['> perpeto@0.0.1 build', 'vite v8.3.4 building for production...', '✓ 412 modules transformed.', '> npm pack --pack-destination dist', 'perpeto-0.0.1.tgz  1.8 MB'],
  job_xlint: ['> perpeto@0.0.1 lint', 'apps/hub/src/pipelines.js', '  41:7  error  "unused" is assigned a value but never used  no-unused-vars', '', '1 problem (1 error, 0 warnings)'],
};

export class DemoCi {
  #runs: PipelineRun[];
  #created: number;
  #flaky: FlakyJob[];

  constructor(now = Date.now()) {
    this.#created = now;
    const t = now;
    const runsOn = (os?: string, labels: string[] = []) => ({ pool: 'default', ...(os ? { os } : {}), labels });
    const live: PipelineRun = {
      id: CI_DEMO_IDS.live,
      projectId: CI_DEMO_IDS.project,
      pipeline: 'default',
      revision: SHA.live,
      ref: 'perpeto/wi_7q4m2x_12',
      trigger: { kind: 'pull-request', workItemId: 'wi_7q4m2x_12' },
      status: 'running',
      configSource: 'repo',
      configHash: 'a1b2c3d4',
      createdAt: iso(t - 6 * MIN),
      startedAt: iso(t - 6 * MIN + 4_000),
      jobs: [
        job({ key: 'lint', name: 'lint', needs: [], status: 'passed', cache: [{ key: 'node-modules-6f3a91', hit: true }], ...timed('job_lint1', 'passed', MACHINES.linux, t - 6 * MIN + 4_000, t - 5 * MIN, 4_000) }),
        job({ key: 'test (node=22)', name: 'test', matrix: { node: '22' }, needs: ['lint'], status: 'passed', cache: [{ key: 'node-modules-6f3a91', hit: true }], ...timed('job_t22a', 'passed', MACHINES.linux, t - 5 * MIN + 3_000, t - 2 * MIN, 3_000) }),
        job({ key: 'test (node=24)', name: 'test', matrix: { node: '24' }, needs: ['lint'], status: 'running', cache: [{ key: 'node-modules-6f3a91', hit: false }], ...timed('job_t24a', 'running', MACHINES.studio, t - 5 * MIN + 9_000, null, 9_000) }),
        job({ key: 'package', name: 'package', needs: ['test (node=22)', 'test (node=24)'], status: 'waiting' }),
      ],
    };
    const flakyStart = t - 3 * 60 * MIN;
    const flakyTest = job({
      key: 'test (node=24)',
      name: 'test',
      matrix: { node: '24' },
      needs: ['lint'],
      status: 'passed',
      flaky: true,
      attempt: 2,
      cache: [{ key: 'node-modules-6f3a91', hit: true }],
      ...timed('job_f24b', 'passed', MACHINES.studio, flakyStart + 7 * MIN, flakyStart + 10 * MIN, 6_000),
    });
    flakyTest.attempts = [
      { jobId: 'job_f24a', status: 'failed', machineId: MACHINES.linux, queuedAt: iso(flakyStart + 60_000), startedAt: iso(flakyStart + 64_000), finishedAt: iso(flakyStart + 7 * MIN - 6_000) },
      ...flakyTest.attempts,
    ];
    const flaky: PipelineRun = {
      id: CI_DEMO_IDS.flaky,
      projectId: CI_DEMO_IDS.project,
      pipeline: 'default',
      revision: SHA.flaky,
      trigger: { kind: 'merge-queue', jobId: 'job_mq381' },
      status: 'passed',
      configSource: 'repo',
      configHash: 'a1b2c3d4',
      createdAt: iso(flakyStart),
      startedAt: iso(flakyStart + 2_000),
      finishedAt: iso(flakyStart + 13 * MIN),
      durationMs: 13 * MIN - 2_000,
      jobs: [
        job({ key: 'lint', name: 'lint', needs: [], status: 'passed', cache: [{ key: 'node-modules-6f3a91', hit: true }], ...timed('job_flint', 'passed', MACHINES.linux, flakyStart + 2_000, flakyStart + 60_000, 2_000) }),
        job({ key: 'test (node=22)', name: 'test', matrix: { node: '22' }, needs: ['lint'], status: 'passed', cache: [{ key: 'node-modules-6f3a91', hit: true }], ...timed('job_f22a', 'passed', MACHINES.linux, flakyStart + 62_000, flakyStart + 4 * MIN, 2_000) }),
        flakyTest,
        job({
          key: 'package',
          name: 'package',
          needs: ['test (node=22)', 'test (node=24)'],
          status: 'passed',
          artifacts: [{ id: 'art_tgz01', name: 'package', path: 'dist/perpeto-0.0.1.tgz', size: 1_843_200, sha256: 'e3b0c44298fc1c149afbf4c8996fb924', complete: true }],
          ...timed('job_fpkg', 'passed', MACHINES.linux, flakyStart + 10 * MIN + 4_000, flakyStart + 13 * MIN, 4_000),
        }),
      ],
    };
    const failedStart = t - 26 * 60 * MIN;
    const failed: PipelineRun = {
      id: CI_DEMO_IDS.failed,
      projectId: CI_DEMO_IDS.project,
      pipeline: 'default',
      revision: SHA.failed,
      ref: 'perpeto/wi_7q4m2x_9',
      trigger: { kind: 'pull-request', workItemId: 'wi_7q4m2x_9' },
      status: 'failed',
      configSource: 'repo',
      configHash: 'a1b2c3d4',
      createdAt: iso(failedStart),
      startedAt: iso(failedStart + 3_000),
      finishedAt: iso(failedStart + 50_000),
      durationMs: 47_000,
      reason: 'lint failed',
      jobs: [
        job({ key: 'lint', name: 'lint', needs: [], status: 'failed', attempt: 1, maxAttempts: 1, ...timed('job_xlint', 'failed', MACHINES.linux, failedStart + 3_000, failedStart + 50_000, 3_000) }),
        job({ key: 'test (node=22)', name: 'test', matrix: { node: '22' }, needs: ['lint'], status: 'skipped' }),
        job({ key: 'test (node=24)', name: 'test', matrix: { node: '24' }, needs: ['lint'], status: 'skipped' }),
        job({ key: 'package', name: 'package', needs: ['test (node=22)', 'test (node=24)'], status: 'skipped' }),
      ],
    };
    const nightStart = t - 14 * 60 * MIN;
    const nightly: PipelineRun = {
      id: CI_DEMO_IDS.nightly,
      projectId: CI_DEMO_IDS.project,
      pipeline: 'nightly',
      revision: SHA.nightly,
      ref: 'main',
      trigger: { kind: 'schedule' },
      status: 'passed',
      configSource: 'repo',
      configHash: 'f9e8d7c6',
      createdAt: iso(nightStart),
      startedAt: iso(nightStart + 5_000),
      finishedAt: iso(nightStart + 24 * MIN),
      durationMs: 24 * MIN - 5_000,
      jobs: [
        job({ key: 'e2e (os=darwin)', name: 'e2e', matrix: { os: 'darwin' }, needs: [], runsOn: runsOn('darwin', ['xcode']), status: 'passed', ...timed('job_ne2d', 'passed', MACHINES.studio, nightStart + 5_000, nightStart + 24 * MIN, 5_000) }),
        job({ key: 'e2e (os=linux)', name: 'e2e', matrix: { os: 'linux' }, needs: [], runsOn: runsOn('linux'), status: 'passed', ...timed('job_ne2l', 'passed', MACHINES.linux, nightStart + 4_000, nightStart + 17 * MIN, 4_000) }),
      ],
    };
    this.#runs = [live, flaky, nightly, failed];
    this.#flaky = [
      { id: 'flk_1', projectId: CI_DEMO_IDS.project, pipeline: 'default', job: 'test (node=24)', occurrences: 3, lastRevision: SHA.flaky, lastRunId: CI_DEMO_IDS.flaky, lastSeenAt: iso(flakyStart + 10 * MIN) },
      { id: 'flk_2', projectId: CI_DEMO_IDS.project, pipeline: 'nightly', job: 'e2e (os=darwin)', occurrences: 1, lastRevision: SHA.nightly, lastRunId: CI_DEMO_IDS.nightly, lastSeenAt: iso(t - 4 * 24 * 60 * MIN) },
    ];
  }

  #run(id: string): PipelineRun {
    const run = this.#runs.find((r) => r.id === id);
    if (!run) throw new HubError(404, 'NOT_FOUND', 'Pipeline run was not found.');
    return run;
  }

  pipelines(projectId: string): PipelineList {
    return demoPipelines(projectId);
  }

  runs(query: PipelineRunQuery): PipelineRun[] {
    return structuredClone(
      this.#runs
        .filter((r) => (!query.projectId || r.projectId === query.projectId) && (!query.pipeline || r.pipeline === query.pipeline) && (!query.status || r.status === query.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, query.limit ?? 50),
    );
  }

  run(id: string): PipelineRun {
    return structuredClone(this.#run(id));
  }

  /** A manual run: the first stage queues, the rest wait. */
  start(input: NewPipelineRun, now = Date.now()): PipelineRun {
    const list = demoPipelines(input.projectId);
    const pipeline = list.pipelines.find((p) => p.name === input.pipeline);
    if (!pipeline) throw new HubError(404, 'PIPELINE_NOT_FOUND', `No pipeline named ${input.pipeline}.`);
    const run: PipelineRun = {
      id: `plr_${Math.random().toString(36).slice(2, 8)}`,
      projectId: input.projectId,
      pipeline: pipeline.name,
      revision: input.revision ?? list.revision ?? SHA.live,
      ...(input.ref ? { ref: input.ref } : {}),
      trigger: { kind: 'manual' },
      status: 'queued',
      configSource: 'repo',
      configHash: 'a1b2c3d4',
      createdAt: iso(now),
      jobs: pipeline.jobs.map((j) =>
        job({ key: j.key, name: j.name, needs: j.needs, matrix: j.matrix, runsOn: j.runsOn, status: j.needs.length ? 'waiting' : 'queued', ...(j.needs.length ? {} : { queuedAt: iso(now) }) }),
      ),
    };
    this.#runs.unshift(run);
    return structuredClone(run);
  }

  cancel(id: string, now = Date.now()): PipelineRun {
    const run = this.#run(id);
    if (run.status === 'queued' || run.status === 'running') {
      run.status = 'cancelled';
      run.finishedAt = iso(now);
      for (const j of run.jobs) if (!['passed', 'failed', 'error'].includes(j.status)) j.status = 'cancelled';
    }
    return structuredClone(run);
  }

  retry(id: string, key?: string, now = Date.now()): PipelineRun {
    const run = this.#run(id);
    const failed = run.jobs.filter((j) => (key ? j.key === key : ['failed', 'error', 'cancelled'].includes(j.status)));
    if (!failed.length) throw new HubError(409, 'NOTHING_TO_RETRY', 'No failed jobs to retry.');
    for (const j of failed) {
      j.status = 'queued';
      j.attempt += 1;
      j.queuedAt = iso(now);
      delete j.startedAt;
      delete j.finishedAt;
      delete j.durationMs;
    }
    // Downstream jobs that were skipped wait again.
    for (const j of run.jobs) if (j.status === 'skipped') j.status = 'waiting';
    run.status = 'running';
    delete run.finishedAt;
    delete run.durationMs;
    return structuredClone(run);
  }

  /** The running job's log grows by a line every 1.5 s after the demo starts. */
  log(jobId: string, after = 0, limit = 500, now = Date.now()): JobLogPage {
    const lines = LOGS[jobId] ?? [];
    const running = this.#runs.some((r) => r.jobs.some((j) => j.jobId === jobId && j.status === 'running'));
    const visible = running ? Math.min(lines.length, 9 + Math.floor((now - this.#created) / 1500)) : lines.length;
    const all: LogChunk[] = lines.slice(0, visible).map((line, i) => ({ seq: i + 1, id: `log_${jobId}_${i}`, jobId, chunk: `${line}\n`, at: iso(this.#created - (visible - i) * 1000), step: 1, stream: 'stdout' }));
    const chunks = all.filter((c) => c.seq > after).slice(0, limit);
    const bytes = all.reduce((n, c) => n + c.chunk.length, 0);
    return { jobId, chunks, nextCursor: chunks.length ? chunks[chunks.length - 1].seq : after, hasMore: all.some((c) => c.seq > (chunks.at(-1)?.seq ?? after)), truncated: false, bytes };
  }

  artifacts(jobId: string): CiArtifact[] {
    for (const run of this.#runs)
      for (const j of run.jobs)
        if (j.jobId === jobId)
          return (j.artifacts ?? []).map((a) => ({ id: a.id, name: a.name, path: a.path, size: a.size, sha256: a.sha256 ?? '', complete: a.complete ?? true, createdAt: a.createdAt ?? j.finishedAt ?? run.createdAt }));
    return [];
  }

  artifact(jobId: string, artifactId: string): Blob {
    const found = this.artifacts(jobId).find((a) => a.id === artifactId);
    if (!found) throw new HubError(404, 'NOT_FOUND', 'Artifact was not found.');
    return new Blob([`Demo artifact ${found.path}\n`], { type: 'application/octet-stream' });
  }

  runners(): RunnersView {
    const live = this.#runs.flatMap((r) => r.jobs).filter((j) => j.status === 'running' || j.status === 'leased');
    const busy = (machineId: string) => live.filter((j) => j.machineId === machineId).length;
    const runners: RunnersView['runners'] = [
      {
        machineId: MACHINES.studio,
        name: 'studio-mac',
        os: 'darwin',
        arch: 'arm64',
        status: 'online',
        labels: ['macos', 'xcode'],
        pools: [{ name: 'default', maxJobs: 2, busy: busy(MACHINES.studio) }],
        maxJobs: 2,
        busy: busy(MACHINES.studio),
        maxAgents: 6,
        agents: 2,
        mode: 'both',
        cache: { sizeBytes: 3_900_000_000, maxBytes: 10_000_000_000, entries: 7 },
        utilisation: 0.42,
      },
      {
        machineId: MACHINES.linux,
        name: 'build-linux',
        os: 'linux',
        arch: 'x64',
        status: 'online',
        labels: ['linux', 'docker'],
        pools: [
          { name: 'default', maxJobs: 4, busy: busy(MACHINES.linux) },
          { name: 'heavy', maxJobs: 1, busy: 0 },
        ],
        maxJobs: 5,
        busy: busy(MACHINES.linux),
        maxAgents: 0,
        agents: 0,
        mode: 'ci',
        cache: { sizeBytes: 8_700_000_000, maxBytes: 20_000_000_000, entries: 23 },
        utilisation: 0.67,
      },
      {
        machineId: MACHINES.air,
        name: 'air-laptop',
        os: 'darwin',
        arch: 'arm64',
        status: 'online',
        labels: ['macos'],
        pools: [],
        maxJobs: 0,
        busy: 0,
        maxAgents: 2,
        agents: 1,
        mode: 'agents',
        cache: null,
        utilisation: 0,
      },
    ];
    const queued = this.#runs.flatMap((r) => r.jobs).filter((j) => j.status === 'queued').length;
    return {
      runners,
      pools: [
        { name: 'default', machines: 2, slots: 6, busy: live.length, queued },
        { name: 'heavy', machines: 1, slots: 1, busy: 0, queued: 0 },
      ],
    };
  }

  flaky(projectId: string): FlakyJob[] {
    return structuredClone(this.#flaky.filter((f) => f.projectId === projectId));
  }

  /** Fourteen days of default-pipeline durations, drifting up, with two failures. */
  insights(projectId: string, window = '7d'): CiInsights {
    if (projectId !== CI_DEMO_IDS.project) return { window, pipelines: [], queueWait: { avgMs: 0, p90Ms: 0, samples: 0 }, utilisation: [] };
    const trend = Array.from({ length: 14 }, (_, i) => {
      const at = this.#created - (14 - i) * 9 * 60 * MIN;
      const durationMs = Math.round((9.5 + i * 0.25 + (i % 3) * 0.6) * MIN);
      return { runId: `plr_hist${i}`, at: iso(at), durationMs, status: (i === 4 || i === 11 ? 'failed' : 'passed') as 'failed' | 'passed' };
    });
    const nightlyTrend = Array.from({ length: 7 }, (_, i) => ({
      runId: `plr_night${i}`,
      at: iso(this.#created - (7 - i) * 24 * 60 * MIN),
      durationMs: Math.round((22 + (i % 2) * 2.5) * MIN),
      status: 'passed' as const,
    }));
    return {
      window,
      pipelines: [
        {
          name: 'default',
          runs: 14,
          passed: 12,
          failed: 2,
          passRate: 12 / 14,
          avgDurationMs: 11.6 * MIN,
          p90DurationMs: 14.1 * MIN,
          trend,
          jobs: [
            { name: 'lint', runs: 14, avgDurationMs: 52_000, p90DurationMs: 61_000, avgQueueWaitMs: 3_400 },
            { name: 'test', runs: 28, avgDurationMs: 3.4 * MIN, p90DurationMs: 5.9 * MIN, avgQueueWaitMs: 8_100 },
            { name: 'package', runs: 12, avgDurationMs: 2.9 * MIN, p90DurationMs: 3.2 * MIN, avgQueueWaitMs: 4_000 },
          ],
        },
        {
          name: 'nightly',
          runs: 7,
          passed: 7,
          failed: 0,
          passRate: 1,
          avgDurationMs: 23.1 * MIN,
          p90DurationMs: 24.5 * MIN,
          trend: nightlyTrend,
          jobs: [{ name: 'e2e', runs: 14, avgDurationMs: 18.4 * MIN, p90DurationMs: 23.6 * MIN, avgQueueWaitMs: 4_600 }],
        },
      ],
      queueWait: { avgMs: 5_600, p90Ms: 12_400, samples: 61 },
      utilisation: [
        { machineId: MACHINES.studio, name: 'studio-mac', utilisation: 0.42 },
        { machineId: MACHINES.linux, name: 'build-linux', utilisation: 0.67 },
      ],
    };
  }
}
