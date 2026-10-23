/**
 * CI pipelines, pipeline runs, runner pools and CI insights (Hub API v1,
 * docs/architecture/README.md). Types match the hub's JSON; the helpers are
 * pure so the screens' layout and log handling are testable without a hub.
 */

export type PipelineTriggerKind = 'manual' | 'merge-queue' | 'pull-request' | 'schedule';
export interface PipelineTrigger {
  on: PipelineTriggerKind;
  cron?: string;
}
export interface RunsOn {
  /** Absent: the job takes a slot in any pool. */
  pool?: string;
  os?: string;
  labels: string[];
}
export interface PipelineStep {
  name: string;
  run: string;
  timeoutSec?: number;
}
export interface PipelineJobDef {
  key: string;
  name: string;
  needs: string[];
  matrix?: Record<string, string>;
  runsOn: RunsOn;
  timeoutSec: number;
  steps: PipelineStep[];
}
export interface Pipeline {
  name: string;
  triggers: PipelineTrigger[];
  jobs: PipelineJobDef[];
}
export interface PipelineList {
  projectId: string;
  source: 'repo' | 'project' | 'none';
  revision: string | null;
  path: string | null;
  pipelines: Pipeline[];
  error?: { code: string; message: string };
}

export type PipelineRunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'error';
export type PipelineJobStatus = 'waiting' | 'queued' | 'leased' | 'running' | 'passed' | 'failed' | 'cancelled' | 'error' | 'skipped';
export type TriggerKind = 'manual' | 'merge-queue' | 'pull-request' | 'schedule' | 'workflow';

export interface ArtifactRef {
  id: string;
  name: string;
  path: string;
  size: number;
  sha256?: string;
  complete?: boolean;
  createdAt?: string;
}
export interface JobAttempt {
  jobId: string;
  status: PipelineJobStatus;
  machineId?: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
}
export interface PipelineRunJob {
  key: string;
  name: string;
  matrix?: Record<string, string>;
  needs: string[];
  runsOn: RunsOn;
  status: PipelineJobStatus;
  jobId?: string;
  machineId?: string;
  attempt: number;
  maxAttempts: number;
  attempts: JobAttempt[];
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  queueWaitMs?: number;
  flaky?: boolean;
  cache?: { key: string; hit: boolean }[];
  artifacts?: ArtifactRef[];
}
export interface PipelineRun {
  id: string;
  projectId: string;
  pipeline: string;
  revision: string;
  ref?: string;
  trigger: { kind: TriggerKind; runId?: string; workItemId?: string; jobId?: string };
  status: PipelineRunStatus;
  configSource: 'repo' | 'project';
  configHash: string;
  jobs: PipelineRunJob[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  supersededBy?: string;
  reason?: string;
}
export interface PipelineRunQuery {
  projectId?: string;
  pipeline?: string;
  status?: PipelineRunStatus;
  limit?: number;
}
export interface NewPipelineRun {
  projectId: string;
  pipeline: string;
  revision?: string;
  ref?: string;
}

export interface LogChunk {
  seq: number;
  id: string;
  jobId: string;
  chunk: string;
  at: string;
  step?: number;
  stream?: 'stdout' | 'stderr';
}
export interface JobLogPage {
  jobId: string;
  chunks: LogChunk[];
  nextCursor: number;
  hasMore: boolean;
  truncated: boolean;
  bytes: number;
}
export interface CiArtifact {
  id: string;
  name: string;
  path: string;
  size: number;
  sha256: string;
  complete: boolean;
  createdAt: string;
}

export type RunnerMode = 'agents' | 'ci' | 'both' | 'observe';
export interface Runner {
  machineId: string;
  name: string;
  os: string;
  arch: string;
  status: 'online' | 'offline' | 'draining';
  labels: string[];
  pools: { name: string; maxJobs: number; busy: number }[];
  maxJobs: number;
  busy: number;
  maxAgents: number;
  agents: number;
  mode: RunnerMode;
  cache: { sizeBytes: number; maxBytes: number; entries: number } | null;
  utilisation: number;
}
export interface RunnerPool {
  name: string;
  machines: number;
  slots: number;
  busy: number;
  queued: number;
}
export interface RunnersView {
  runners: Runner[];
  pools: RunnerPool[];
}
export interface FlakyJob {
  id: string;
  projectId: string;
  pipeline: string;
  job: string;
  occurrences: number;
  lastRevision: string;
  lastRunId: string;
  lastSeenAt: string;
}
export interface PipelineInsight {
  name: string;
  runs: number;
  passed: number;
  failed: number;
  passRate: number;
  avgDurationMs: number;
  p90DurationMs: number;
  trend: { runId: string; at: string; durationMs: number; status: PipelineRunStatus }[];
  jobs: { name: string; runs: number; avgDurationMs: number; p90DurationMs: number; avgQueueWaitMs: number }[];
}
export interface CiInsights {
  window: string;
  pipelines: PipelineInsight[];
  queueWait: { avgMs: number; p90Ms: number; samples: number };
  utilisation: { machineId: string; name: string; utilisation: number }[];
}

/* ---------------------------------------------------------------- helpers */

export const ACTIVE_RUN: PipelineRunStatus[] = ['queued', 'running'];
export const ACTIVE_JOB: PipelineJobStatus[] = ['queued', 'leased', 'running'];
export const isRunActive = (run: Pick<PipelineRun, 'status'>) => ACTIVE_RUN.includes(run.status);
export const isJobActive = (job: Pick<PipelineRunJob, 'status'>) => ACTIVE_JOB.includes(job.status);

/**
 * Columns for a job DAG: a job sits one column right of its deepest need.
 * Unknown needs are ignored and cycles are broken, so a malformed run still
 * renders. Jobs keep their run order inside a column.
 */
export function dagColumns<T extends { key: string; needs: string[] }>(jobs: T[]): T[][] {
  const byKey = new Map(jobs.map((j) => [j.key, j]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (key: string): number => {
    const known = depth.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) return 0;
    visiting.add(key);
    const job = byKey.get(key);
    const needs = (job?.needs ?? []).filter((n) => byKey.has(n) && n !== key);
    const d = needs.length ? Math.max(...needs.map(depthOf)) + 1 : 0;
    visiting.delete(key);
    depth.set(key, d);
    return d;
  };
  const columns: T[][] = [];
  for (const job of jobs) {
    const d = depthOf(job.key);
    (columns[d] ??= []).push(job);
  }
  return columns.filter(Boolean);
}

/**
 * Append a new log page to what is shown. Chunks are keyed by `seq`, so a
 * page re-fetched after a retry never duplicates lines.
 */
export function mergeLogChunks(current: LogChunk[], page: LogChunk[]): LogChunk[] {
  if (!page.length) return current;
  const last = current.length ? current[current.length - 1].seq : -Infinity;
  const fresh = page.filter((c) => c.seq > last);
  return fresh.length ? [...current, ...fresh] : current;
}

/** Milliseconds as "820 ms", "42 s", "3 min 05 s", "1 h 12 min". */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ${String(sec % 60).padStart(2, '0')} s`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

/** Bytes as "512 B", "3.4 MB", "1.2 GB" (decimal units). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  return `${i === 0 ? Math.round(value) : value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

/** "node 22, os linux" for a matrix cell; empty without a matrix. */
export function matrixLabel(matrix: Record<string, string> | undefined): string {
  if (!matrix) return '';
  return Object.entries(matrix)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
}

/** How long a job has run or ran: its recorded duration, else since it started. */
export function jobElapsedMs(job: Pick<PipelineRunJob, 'durationMs' | 'startedAt' | 'finishedAt'>, now = Date.now()): number | undefined {
  if (job.durationMs !== undefined) return job.durationMs;
  if (!job.startedAt) return undefined;
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
  return Math.max(0, end - Date.parse(job.startedAt));
}

/** A run's duration, or its elapsed time while it is still going. */
export function runElapsedMs(run: Pick<PipelineRun, 'durationMs' | 'startedAt' | 'createdAt' | 'finishedAt'>, now = Date.now()): number {
  if (run.durationMs !== undefined) return run.durationMs;
  const start = Date.parse(run.startedAt ?? run.createdAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  return Math.max(0, end - start);
}

/** Counts by outcome, for a run's one-line summary. */
export function jobCounts(jobs: PipelineRunJob[]) {
  const counts = { passed: 0, failed: 0, active: 0, waiting: 0, skipped: 0, total: jobs.length };
  for (const j of jobs) {
    if (j.status === 'passed') counts.passed++;
    else if (j.status === 'failed' || j.status === 'error') counts.failed++;
    else if (isJobActive(j)) counts.active++;
    else if (j.status === 'skipped' || j.status === 'cancelled') counts.skipped++;
    else counts.waiting++;
  }
  return counts;
}

export const TRIGGER_LABEL: Record<TriggerKind, string> = {
  manual: 'Manual',
  'merge-queue': 'Merge queue',
  'pull-request': 'Pull request',
  schedule: 'Schedule',
  workflow: 'Workflow',
};
