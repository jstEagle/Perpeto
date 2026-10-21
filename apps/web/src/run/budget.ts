import type { BudgetLimit, Run, RunIntake, WorkItem } from '../api/types';
import { clock, tokens } from '../lib/format';
import { describeSchedule, fromCron } from './schedule';

export interface BudgetRow {
  limit: BudgetLimit;
  used: number;
  max: number;
  text: string;
}

const hasBudget = (run: Run) => !!run.budget && Object.values(run.budget).some((n) => n !== undefined);

/**
 * Today's use against each limit the run has. Active items come from the
 * caller's work items, or from the pause reason when that is the limit hit;
 * without either the row is left out rather than guessed.
 */
export function budgetRows(run: Run, activeItems?: number): BudgetRow[] {
  if (!hasBudget(run)) return [];
  const b = run.budget!;
  const usage = run.budgetUsage;
  const rows: BudgetRow[] = [];
  if (b.maxTokensPerDay !== undefined && usage) rows.push({ limit: 'maxTokensPerDay', used: usage.tokens, max: b.maxTokensPerDay, text: `${tokens(usage.tokens)} of ${tokens(b.maxTokensPerDay)} tokens` });
  if (b.maxItemsPerDay !== undefined && usage) rows.push({ limit: 'maxItemsPerDay', used: usage.items, max: b.maxItemsPerDay, text: `${usage.items} of ${b.maxItemsPerDay} items` });
  const active = activeItems ?? (run.intake?.reason?.limit === 'maxActiveItems' ? run.intake.reason.used : undefined);
  if (b.maxActiveItems !== undefined && active !== undefined) rows.push({ limit: 'maxActiveItems', used: active, max: b.maxActiveItems, text: `${active} of ${b.maxActiveItems} active` });
  return rows;
}

/** The fullest limit decides the line, so one glance says how close intake is to pausing. */
export function budgetFill(rows: BudgetRow[]): number {
  return rows.reduce((most, r) => Math.max(most, r.max ? Math.min(1, r.used / r.max) : 0), 0);
}

/** Daily allowances reset at midnight UTC. */
export function nextUtcMidnight(now = new Date()): Date {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next;
}

export const PAUSE_TITLE: Record<BudgetLimit, string> = {
  maxTokensPerDay: 'Today’s token budget is used',
  maxItemsPerDay: 'Today’s item budget is used',
  maxActiveItems: 'The active item limit is reached',
};

/** When intake picks up again, in the reader's time. */
export function resumeText(intake: RunIntake | undefined, now = new Date()): string {
  const limit = intake?.reason?.limit;
  if (!limit) return '';
  if (limit === 'maxActiveItems') return 'Resumes when an active item finishes';
  const at = nextUtcMidnight(now);
  const sameDay = at.toDateString() === now.toDateString();
  return `Resumes ${sameDay ? 'today' : 'tomorrow'} at ${clock(at.toISOString())}`;
}

/** What the reason's numbers mean, as a sentence. */
export function pauseDetail(intake: RunIntake | undefined): string {
  const r = intake?.reason;
  if (!r) return '';
  const used = r.limit === 'maxTokensPerDay' ? `${tokens(r.used)} of ${tokens(r.maximum)} tokens used today` : r.limit === 'maxItemsPerDay' ? `${r.used} of ${r.maximum} items started today` : `${r.used} of ${r.maximum} items in progress`;
  return `${used}. Work already started keeps going; no new work is taken in.`;
}

export const SOURCE_TEXT: Record<NonNullable<Run['source']>, string> = {
  goals: 'New work from the project goals',
  schedule: 'New work on a schedule',
  manual: 'Work you add',
};

/** "Keeps running · New work from the project goals". */
export function intakeSummary(run: Run): string {
  return `${run.keepOpen ? 'Keeps running' : 'Finishes when the work is done'} · ${sourceText(run)}`;
}

function sourceText(run: Run): string {
  if (run.source !== 'schedule' || !run.schedule) return SOURCE_TEXT[run.source ?? 'manual'];
  const spec = fromCron(run.schedule);
  if (spec.repeat === 'custom') return `New work on schedule ${run.schedule} (UTC)`;
  const text = describeSchedule(run.schedule);
  return `New work ${spec.repeat === 'weekly' ? `on ${text}` : text.charAt(0).toLowerCase() + text.slice(1)}`;
}

/** Unfinished items that are not waiting on unfinished children. */
export function countActive(items: WorkItem[]): number {
  const open = items.filter((w) => w.status !== 'done' && w.status !== 'failed');
  const parents = new Set(open.map((w) => w.parentId).filter(Boolean));
  return open.filter((w) => !parents.has(w.id)).length;
}
