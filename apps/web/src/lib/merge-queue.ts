import type { ConfigProblem, FreezeWindow, MergeQueueFreeze, MergeQueueView, QueueAttemptView, QueueConfig } from '../api/types';
import { clock, dateTime, duration, plural } from './format';

/** Why entries left a queue without merging, in words. */
export const CAUSE_LABEL: Record<string, string> = {
  ci: 'CI failed',
  conflict: 'Merge conflict',
  'head-changed': 'Head changed',
  timeout: 'Timed out',
  manual: 'Ejected',
  approvals: 'Missing approvals',
  other: 'Other',
};
export const causeLabel = (cause: string | undefined) => (cause ? CAUSE_LABEL[cause] ?? cause : 'Other');

export function strategyLabel(view: Pick<MergeQueueView, 'strategy' | 'config'>): string {
  const config = view.config;
  if (view.strategy === 'batch') return config ? `Batches of up to ${config.maxBatchSize}` : 'Batches';
  if (view.strategy === 'speculative') return config ? `Speculative, ${config.depth} deep` : 'Speculative';
  return 'One at a time';
}

/** "Batch of 3", "Speculative on the change ahead", with the phase in words. */
export function attemptLabel(attempt: QueueAttemptView, strategy: string): string {
  const what = !attempt.head ? 'Speculative, on the change ahead' : attempt.size > 1 ? `Batch of ${attempt.size}` : strategy === 'speculative' ? 'Head of the queue' : 'Next to merge';
  const phase =
    attempt.phase === 'preparing' ? 'preparing the candidate'
    : attempt.phase === 'testing' ? attempt.jobStatus === 'passed' ? 'CI passed' : attempt.jobStatus === 'failed' || attempt.jobStatus === 'error' ? 'CI failed' : 'CI running'
    : attempt.phase === 'merging' ? 'publishing'
    : attempt.phase === 'blocked' ? 'waits for the head'
    : attempt.phase;
  return `${what} · ${phase}${attempt.retries ? `, retry ${attempt.retries}` : ''}`;
}

export function freezeText(frozen: MergeQueueFreeze, now = Date.now()): string {
  const parts: string[] = [];
  if (frozen.since) parts.push(`since ${new Date(frozen.since).getTime() > now - 86_400_000 ? clock(frozen.since) : dateTime(frozen.since)}`);
  if (frozen.until) parts.push(`until ${dateTime(frozen.until)}`);
  else if (frozen.kind !== 'window') parts.push('until someone unfreezes it');
  return parts.join(', ');
}

export const minutes = (ms: number | null | undefined) => (ms === null || ms === undefined ? '—' : duration(ms / 1000));
export const openCount = (view: MergeQueueView) => view.entries.length;
export const waitingSummary = (view: MergeQueueView) => {
  const testing = view.entries.filter((e) => e.status === 'testing' || e.status === 'merging').length;
  const waiting = view.entries.filter((e) => e.status === 'queued').length;
  return [testing ? `${testing} in flight` : null, waiting ? `${plural(waiting, 'waiting', 'waiting')}` : null].filter(Boolean).join(' · ') || 'Nothing queued';
};

/*
 * Settings editor drafts. Text fields stay strings while editing; fromDraft turns them into the configuration the
 * hub validates, leaving anything unparseable as written so the shared validator names the problem at its path.
 */
export interface DraftLane {
  name: string;
  priority: string;
  labels: string;
  branches: string;
}
export interface DraftWindow {
  kind: 'cron' | 'range';
  cron: string;
  durationMinutes: string;
  start: string;
  end: string;
  reason: string;
}
export interface DraftQueue {
  name: string;
  branches: string;
  strategy: QueueConfig['strategy'];
  maxBatchSize: string;
  depth: string;
  requiredChecks: string;
  method: QueueConfig['method'];
  publication: QueueConfig['publication'];
  lanes: DraftLane[];
  defaultLane: string;
  windows: DraftWindow[];
  maxInFlight: string;
  flakyRetries: string;
  bisectOnBatchFailure: boolean;
  autoRebaseOnConflict: boolean;
  ejectAfterMinutes: string;
  requiredApprovals: string;
}

export const listText = (list: string[] | undefined) => (list ?? []).join(', ');
export const parseList = (text: string) => text.split(',').map((item) => item.trim()).filter(Boolean);
const numberText = (value: number | null | undefined) => (value === null || value === undefined ? '' : String(value));
function parseNumber(text: string, empty: null | undefined): number | string | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return empty;
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

export function toDraft(queue: QueueConfig): DraftQueue {
  return {
    name: queue.name,
    branches: listText(queue.branches),
    strategy: queue.strategy,
    maxBatchSize: numberText(queue.maxBatchSize),
    depth: numberText(queue.depth),
    requiredChecks: listText(queue.requiredChecks),
    method: queue.method,
    publication: queue.publication,
    lanes: queue.lanes.map((lane) => ({ name: lane.name, priority: String(lane.priority), labels: listText(lane.labels), branches: listText(lane.branches) })),
    defaultLane: queue.defaultLane ?? '',
    windows: queue.freeze.windows.map((window) =>
      'cron' in window
        ? { kind: 'cron', cron: window.cron, durationMinutes: String(window.durationMinutes), start: '', end: '', reason: window.reason ?? '' }
        : { kind: 'range', cron: '', durationMinutes: '', start: window.start, end: window.end, reason: window.reason ?? '' },
    ),
    maxInFlight: numberText(queue.maxInFlight),
    flakyRetries: numberText(queue.flakyRetries),
    bisectOnBatchFailure: queue.bisectOnBatchFailure,
    autoRebaseOnConflict: queue.autoRebaseOnConflict,
    ejectAfterMinutes: numberText(queue.ejectAfterMinutes),
    requiredApprovals: numberText(queue.requiredApprovals),
  };
}

export function newDraftQueue(name: string): DraftQueue {
  return {
    name, branches: name, strategy: 'serial', maxBatchSize: '8', depth: '3', requiredChecks: '', method: 'squash', publication: 'fast-forward-push',
    lanes: [], defaultLane: '', windows: [], maxInFlight: '', flakyRetries: '0', bisectOnBatchFailure: true, autoRebaseOnConflict: true, ejectAfterMinutes: '', requiredApprovals: '0',
  };
}
export const newLane = (): DraftLane => ({ name: '', priority: '50', labels: '', branches: '' });
export const newWindow = (kind: DraftWindow['kind']): DraftWindow =>
  kind === 'cron' ? { kind, cron: '0 17 * * 5', durationMinutes: '3840', start: '', end: '', reason: 'Weekend freeze' } : { kind, cron: '', durationMinutes: '', start: '', end: '', reason: '' };

/** The raw queue configuration a draft stands for. Omitted fields take the defaults. */
export function fromDraft(draft: DraftQueue): Record<string, unknown> {
  const windows: (FreezeWindow | Record<string, unknown>)[] = draft.windows.map((window) => ({
    ...(window.kind === 'cron' ? { cron: window.cron, durationMinutes: parseNumber(window.durationMinutes, undefined) } : { start: window.start, end: window.end }),
    ...(window.reason.trim() ? { reason: window.reason.trim() } : {}),
  }));
  const value: Record<string, unknown> = {
    name: draft.name.trim(),
    ...(parseList(draft.branches).length ? { branches: parseList(draft.branches) } : {}),
    strategy: draft.strategy,
    maxBatchSize: parseNumber(draft.maxBatchSize, undefined),
    depth: parseNumber(draft.depth, undefined),
    requiredChecks: parseList(draft.requiredChecks),
    method: draft.method,
    publication: draft.publication,
    ...(draft.lanes.length
      ? {
          lanes: draft.lanes.map((lane) => ({ name: lane.name.trim(), priority: parseNumber(lane.priority, undefined), labels: parseList(lane.labels), branches: parseList(lane.branches) })),
          ...(draft.defaultLane ? { defaultLane: draft.defaultLane } : {}),
        }
      : {}),
    freeze: { windows },
    maxInFlight: parseNumber(draft.maxInFlight, null),
    flakyRetries: parseNumber(draft.flakyRetries, undefined),
    bisectOnBatchFailure: draft.bisectOnBatchFailure,
    autoRebaseOnConflict: draft.autoRebaseOnConflict,
    ejectAfterMinutes: parseNumber(draft.ejectAfterMinutes, null),
    requiredApprovals: parseNumber(draft.requiredApprovals, undefined),
  };
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  return value;
}

export const configFromDrafts = (drafts: DraftQueue[]) => ({ version: 1, queues: drafts.map(fromDraft) });

/** The problem at a queue field, a lane field or a freeze window field, by JSON path. */
export function problemAt(problems: ConfigProblem[], path: string): string | null {
  const found = problems.find((problem) => problem.path === path || problem.path.startsWith(`${path}.`) || problem.path.startsWith(`${path}[`));
  return found ? found.message : null;
}
export const queuePath = (index: number, field?: string) => `$.queues[${index}]${field ? `.${field}` : ''}`;

/** Problems the editor has no field for (top level, or a queue-level key it does not show). */
export function unplacedProblems(problems: ConfigProblem[], shown: string[]): ConfigProblem[] {
  return problems.filter((problem) => !shown.some((path) => problem.path === path || problem.path.startsWith(`${path}.`) || problem.path.startsWith(`${path}[`)));
}
