import { mergeQueueConfigs, normalizeMergeQueueConfig } from '@perpeto/delivery/queue-config';
import { HubError } from './hub';
import type {
  MergeEntry,
  MergeEntryCommand,
  MergeQueueConfig,
  MergeQueueFreeze,
  MergeQueueSettings,
  MergeQueueSummary,
  MergeQueueView,
  MetricsWindow,
  QueueAttemptView,
  QueueEntryView,
  QueueMetrics,
} from './types';

/*
 * Demo merge queues for one project: a batched "main" queue with lanes, a speculative-free release queue that is
 * frozen, settings versions and a committed repository file that overrides main. Commands change this state so the
 * screen can be exercised without a hub.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (t: number) => new Date(t).toISOString();
const pr = (n: number) => `https://github.com/lumin/perpeto/pull/${n}`;
const sha = (seed: number) => Array.from({ length: 40 }, (_, i) => '0123456789abcdef'[(seed * 7 + i * 13 + ((seed * i) % 11)) % 16]).join('');

const HUB_CONFIG: MergeQueueConfig = {
  version: 1,
  queues: [
    {
      name: 'main', branches: ['main'], strategy: 'batch', maxBatchSize: 4, depth: 3, requiredChecks: ['test', 'lint'], method: 'squash', publication: 'fast-forward-push',
      lanes: [
        { name: 'hotfix', priority: 100, labels: ['hotfix'], branches: ['hotfix/*'] },
        { name: 'normal', priority: 50, labels: [], branches: [] },
        { name: 'dependencies', priority: 10, labels: ['dependencies'], branches: ['deps/*', 'dependabot/**'] },
      ],
      defaultLane: 'normal',
      freeze: { windows: [{ cron: '0 17 * * 5', durationMinutes: 3840, reason: 'Weekend freeze' }] },
      maxInFlight: 8, flakyRetries: 1, bisectOnBatchFailure: true, autoRebaseOnConflict: true, ejectAfterMinutes: 240, requiredApprovals: 1,
    },
    {
      name: 'release', branches: ['release/*'], strategy: 'serial', maxBatchSize: 8, depth: 3, requiredChecks: ['test'], method: 'merge', publication: 'fast-forward-push',
      lanes: [], freeze: { windows: [] }, maxInFlight: null, flakyRetries: 0, bisectOnBatchFailure: true, autoRebaseOnConflict: false, ejectAfterMinutes: null, requiredApprovals: 2,
    },
  ],
};
/** Committed .perpeto/merge-queue.json: the repository keeps main's batches smaller than the hub default. */
const REPO_FILE = { version: 1, queues: [{ name: 'main', maxBatchSize: 3 }] };

interface DemoQueue {
  id: string;
  name: string;
  frozen: MergeQueueFreeze | null;
  attemptMs: number;
  /** Open entries; attempts reference them by id. */
  entries: QueueEntryView[];
  attempts: QueueAttemptView[];
  recent: QueueEntryView[];
  metrics: QueueMetrics;
}

function entry(n: number, fields: Partial<QueueEntryView> & Pick<QueueEntryView, 'status'>): QueueEntryView {
  return { id: `mq_demo_${n}`, prUrl: pr(n), headSha: sha(n), baseBranch: 'main', position: 0, priority: 50, lane: 'normal', ...fields };
}

function hourly(now: number, merged: number[], rejected: number[]): QueueMetrics['hourly'] {
  return merged.map((m, i) => ({ start: iso(now - (merged.length - i) * HOUR), merged: m, rejected: rejected[i] ?? 0 }));
}

function demoQueues(projectId: string, now: number): DemoQueue[] {
  const lanes = { hotfix: 100, normal: 50, dependencies: 10 } as Record<string, number>;
  const open = (n: number, lane: string, status: QueueEntryView['status'], ago: number, extra: Partial<QueueEntryView> = {}) =>
    entry(n, { status, lane, priority: lanes[lane] ?? 0, enqueuedAt: iso(now - ago * MIN), waitedMs: ago * MIN, ...extra });
  const head: QueueAttemptView = { id: 'mq_attempt_demo_1', head: true, phase: 'testing', entryIds: ['mq_demo_251', 'mq_demo_247', 'mq_demo_248'], size: 3,
    startedAt: iso(now - 14 * MIN), jobId: 'job_mq_attempt_demo_1', jobStatus: 'running', revision: sha(900) };
  const main: DemoQueue = {
    id: `mqn_demo_main_${projectId}`, name: 'main', frozen: null, attemptMs: 22 * MIN,
    entries: [
      open(251, 'hotfix', 'testing', 19, { headBranch: 'hotfix/login-redirect', attemptId: head.id, phase: 'testing', jobId: head.jobId }),
      open(247, 'normal', 'testing', 41, { headBranch: 'perpeto/run-7q4m2x/merge-queue-lanes', attemptId: head.id, phase: 'testing', jobId: head.jobId }),
      open(248, 'normal', 'testing', 36, { headBranch: 'perpeto/run-7q4m2x/freeze-windows', attemptId: head.id, phase: 'testing', jobId: head.jobId }),
      open(249, 'normal', 'queued', 27, { headBranch: 'perpeto/run-7q4m2x/queue-metrics' }),
      open(253, 'normal', 'queued', 9, { headBranch: 'perpeto/run-8f2k4t/cli-queue-command' }),
      open(244, 'dependencies', 'queued', 118, { headBranch: 'deps/vite-8.3', labels: ['dependencies'] }),
      open(246, 'dependencies', 'queued', 92, { headBranch: 'dependabot/npm/react-19.3', labels: ['dependencies'] }),
    ],
    attempts: [head],
    recent: [
      entry(243, { status: 'merged', finishedAt: iso(now - 26 * MIN), waitedMs: 34 * MIN, headBranch: 'perpeto/run-7q4m2x/hub-routes' }),
      entry(242, { status: 'merged', finishedAt: iso(now - 26 * MIN), waitedMs: 41 * MIN, headBranch: 'perpeto/run-7q4m2x/delivery-lanes' }),
      entry(239, { status: 'rejected', cause: 'timeout', reason: 'Waited longer than 240 minutes; ejected.', finishedAt: iso(now - 70 * MIN), waitedMs: 240 * MIN, lane: 'dependencies', priority: 10, headBranch: 'deps/typescript-7.1' }),
      entry(241, { status: 'merged', finishedAt: iso(now - 95 * MIN), waitedMs: 29 * MIN, lane: 'hotfix', priority: 100, headBranch: 'hotfix/token-refresh' }),
      entry(238, { status: 'rejected', cause: 'ci', reason: 'Speculative CI failed after 2 runs.', finishedAt: iso(now - 130 * MIN), waitedMs: 52 * MIN, headBranch: 'perpeto/run-7q4m2x/retry-policy', retries: 1 }),
      entry(240, { status: 'merged', finishedAt: iso(now - 150 * MIN), waitedMs: 47 * MIN, headBranch: 'perpeto/run-7q4m2x/batch-bisect' }),
    ],
    metrics: {
      windowMs: 24 * HOUR, merged: 31, rejected: 4, throughputPerHour: 1.29, medianTimeInQueueMs: 38 * MIN, failureRate: 0.114,
      failuresByReason: [{ cause: 'ci', count: 2, rate: 0.057 }, { cause: 'timeout', count: 1, rate: 0.029 }, { cause: 'conflict', count: 1, rate: 0.029 }],
      batches: { total: 11, succeeded: 9, successRate: 0.818 }, flakyRetries: 3,
      hourly: hourly(now, [0, 0, 1, 0, 0, 0, 0, 2, 3, 2, 1, 3, 2, 4, 2, 1, 2, 3, 1, 0, 2, 1, 1, 2], [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0]),
    },
  };
  const release: DemoQueue = {
    id: `mqn_demo_release_${projectId}`, name: 'release', frozen: { kind: 'manual', reason: 'Release 2026.10 is being cut', since: iso(now - 40 * MIN), by: 'owner' }, attemptMs: 31 * MIN,
    entries: [entry(250, { status: 'queued', baseBranch: 'release/2026.10', lane: undefined, priority: 0, enqueuedAt: iso(now - 33 * MIN), waitedMs: 33 * MIN, headBranch: 'perpeto/backport-login-fix' })],
    attempts: [], recent: [entry(236, { status: 'merged', baseBranch: 'release/2026.10', lane: undefined, priority: 0, finishedAt: iso(now - 6 * HOUR), waitedMs: 52 * MIN })],
    metrics: { windowMs: 24 * HOUR, merged: 1, rejected: 0, throughputPerHour: 0.04, medianTimeInQueueMs: 52 * MIN, failureRate: 0, failuresByReason: [], batches: { total: 0, succeeded: 0, successRate: null }, flakyRetries: 0,
      hourly: hourly(now, Array.from({ length: 24 }, (_, i) => (i === 17 ? 1 : 0)), []) },
  };
  return [main, release];
}

/** Queued entries in service order, then positions and ETAs from the recent attempt duration. */
function ordered(queue: DemoQueue, unit: number, now: number): QueueEntryView[] {
  const inFlight = queue.attempts.flatMap((attempt) => attempt.entryIds.map((id) => queue.entries.find((e) => e.id === id)).filter((e): e is QueueEntryView => !!e));
  const waiting = queue.entries.filter((e) => e.status === 'queued').sort((a, b) => b.priority - a.priority || (a.enqueuedAt ?? '').localeCompare(b.enqueuedAt ?? ''));
  const head = queue.attempts[0];
  const remaining = head?.startedAt ? Math.max(0, queue.attemptMs - (now - Date.parse(head.startedAt))) : 0;
  return [
    ...inFlight.map((e) => ({ ...e, etaAt: queue.frozen ? undefined : iso(now + remaining) })),
    ...waiting.map((e, i) => ({ ...e, etaAt: queue.frozen ? undefined : iso(now + remaining + (Math.floor(i / unit) + 1) * queue.attemptMs) })),
  ].map((e, i) => ({ ...e, position: i + 1 }));
}

export class DemoMergeQueues {
  #projectId: string;
  #version = 3;
  #config: MergeQueueConfig = structuredClone(HUB_CONFIG);
  #updatedAt: number;
  #queues: DemoQueue[];
  #now: () => number;

  constructor(projectId: string, created: number, now: () => number = Date.now) {
    this.#projectId = projectId;
    this.#now = now;
    this.#updatedAt = created - 2 * HOUR;
    this.#queues = demoQueues(projectId, now());
  }

  #effective() {
    return mergeQueueConfigs(this.#config, REPO_FILE);
  }
  #queue(id: string) {
    const queue = this.#queues.find((q) => q.id === id);
    if (!queue) throw new HubError(404, 'NOT_FOUND', 'merge-queue not found.');
    return queue;
  }

  settings(projectId: string): MergeQueueSettings {
    if (projectId !== this.#projectId) {
      return { projectId, version: 0, updatedAt: null, config: { version: 1, queues: [] }, history: [], repo: { path: '.perpeto/merge-queue.json', found: false, applied: false }, effective: { version: 1, queues: [] }, queues: [] };
    }
    const { config, sources } = this.#effective();
    const queues: MergeQueueSummary[] = config.queues.map((q) => {
      const demo = this.#queues.find((d) => d.name === q.name);
      const count = (s: string) => demo?.entries.filter((e) => e.status === s).length ?? 0;
      return { id: demo?.id ?? `mqn_demo_${q.name}`, kind: 'project', name: q.name, projectId, branches: q.branches, strategy: q.strategy, source: sources[q.name] ?? 'hub',
        frozen: demo?.frozen ?? null, counts: { queued: count('queued'), testing: count('testing'), merging: count('merging') } };
    });
    return {
      projectId, version: this.#version, updatedAt: iso(this.#updatedAt), config: structuredClone(this.#config),
      history: [{ version: 1, updatedAt: iso(this.#updatedAt - 9 * 24 * HOUR) }, { version: 2, updatedAt: iso(this.#updatedAt - 3 * 24 * HOUR) }].slice(0, this.#version - 1),
      repo: { path: '.perpeto/merge-queue.json', found: true, revision: sha(77), applied: true }, effective: config, queues,
    };
  }

  save(projectId: string, config: MergeQueueConfig, baseVersion: number): MergeQueueSettings {
    if (projectId !== this.#projectId) throw new HubError(409, 'DEMO', 'The demo keeps merge queue settings for the perpeto project only.');
    const check = normalizeMergeQueueConfig(config);
    if (!check.ok) throw new HubError(400, 'INVALID_MERGE_QUEUE_CONFIG', `Merge queue configuration is invalid: ${check.errors[0].path} ${check.errors[0].message}`, check.errors);
    if (baseVersion !== this.#version) throw new HubError(409, 'VERSION_CONFLICT', `Merge queue settings changed (now version ${this.#version}); reload and apply your change again.`);
    this.#config = { version: 1, queues: structuredClone(config.queues) };
    this.#version += 1;
    this.#updatedAt = this.#now();
    for (const q of this.#effective().config.queues) {
      if (!this.#queues.some((d) => d.name === q.name)) {
        this.#queues.push({ id: `mqn_demo_${q.name}_${projectId}`, name: q.name, frozen: null, attemptMs: 20 * MIN, entries: [], attempts: [], recent: [],
          metrics: { windowMs: 24 * HOUR, merged: 0, rejected: 0, throughputPerHour: 0, medianTimeInQueueMs: null, failureRate: null, failuresByReason: [], batches: { total: 0, succeeded: 0, successRate: null }, flakyRetries: 0, hourly: hourly(this.#now(), Array(24).fill(0), []) } });
      }
    }
    return this.settings(projectId);
  }

  view(id: string, window: MetricsWindow = '24h'): MergeQueueView {
    const queue = this.#queue(id);
    const { config, sources } = this.#effective();
    const queueConfig = config.queues.find((q) => q.name === queue.name);
    const now = this.#now();
    const unit = queueConfig?.strategy === 'batch' ? queueConfig.maxBatchSize : queueConfig?.strategy === 'speculative' ? queueConfig.depth : 1;
    const entries = ordered(queue, unit, now);
    const scale = window === '1h' ? 1 / 24 : window === '7d' ? 7 : 1;
    const metrics: QueueMetrics = { ...queue.metrics, windowMs: queue.metrics.windowMs * scale, merged: Math.round(queue.metrics.merged * scale), rejected: Math.round(queue.metrics.rejected * scale) };
    return {
      id, kind: 'project', projectId: this.#projectId, name: queue.name, source: sources[queue.name] ?? 'removed', ...(queueConfig ? { config: queueConfig } : {}),
      branches: queueConfig?.branches ?? [], strategy: queueConfig?.strategy ?? 'serial', frozen: queue.frozen, entries,
      attempts: structuredClone(queue.attempts), testing: entries.filter((e) => e.status === 'testing').map((e) => e.id),
      recent: structuredClone(queue.recent), eta: { attemptMs: queue.attemptMs, samples: 12 }, metrics, window, generatedAt: iso(now),
    };
  }

  freeze(id: string, reason?: string): MergeQueueView {
    this.#queue(id).frozen = { kind: 'manual', reason: reason ?? 'Frozen by the owner.', since: iso(this.#now()), by: 'owner' };
    return this.view(id);
  }
  unfreeze(id: string): MergeQueueView {
    this.#queue(id).frozen = null;
    return this.view(id);
  }

  command(entryId: string, command: MergeEntryCommand): MergeEntry {
    const queue = this.#queues.find((q) => q.entries.some((e) => e.id === entryId));
    if (!queue) throw new HubError(409, 'CONFLICT', 'Merge entry is already terminal.');
    const item = queue.entries.find((e) => e.id === entryId)!;
    const lanes = this.#effective().config.queues.find((q) => q.name === queue.name)?.lanes ?? [];
    if (command.action === 'priority') {
      const lane = lanes.find((l) => l.name === command.lane);
      if (command.lane !== undefined && !lane) throw new HubError(400, 'INVALID_INPUT', 'Unknown lane for this queue.');
      if (lane) Object.assign(item, { lane: lane.name, priority: lane.priority, pinned: true });
      if (command.priority !== undefined) Object.assign(item, { priority: command.priority, pinned: true });
    } else if (command.action === 'requeue') {
      this.#leave(queue, item);
      Object.assign(item, { status: 'queued', enqueuedAt: iso(this.#now()), waitedMs: 0, reason: command.reason ?? 'Requeued by the owner.', attemptId: undefined, phase: undefined, jobId: undefined });
    } else {
      this.#leave(queue, item);
      queue.entries = queue.entries.filter((e) => e.id !== entryId);
      Object.assign(item, { status: 'rejected', cause: 'manual', reason: command.reason ?? 'Ejected by the owner.', finishedAt: iso(this.#now()), attemptId: undefined, phase: undefined });
      queue.recent.unshift(item);
      queue.metrics = { ...queue.metrics, rejected: queue.metrics.rejected + 1 };
    }
    return { id: item.id, projectId: this.#projectId, prUrl: item.prUrl, headSha: item.headSha, baseBranch: item.baseBranch, status: item.status,
      ...(item.lane ? { lane: item.lane } : {}), priority: item.priority, ...(item.reason ? { reason: item.reason } : {}), ...(item.cause ? { cause: item.cause } : {}) };
  }

  /** Leaving an attempt returns the rest of a batch to the queue, as the hub does. */
  #leave(queue: DemoQueue, item: QueueEntryView) {
    const attempt = queue.attempts.find((a) => a.entryIds.includes(item.id));
    if (!attempt) return;
    queue.attempts = queue.attempts.filter((a) => a !== attempt);
    for (const id of attempt.entryIds) {
      const other = queue.entries.find((e) => e.id === id);
      if (other && other !== item) Object.assign(other, { status: 'queued', attemptId: undefined, phase: undefined, jobId: undefined, reason: 'The batch changed; testing again.' });
    }
  }
}
