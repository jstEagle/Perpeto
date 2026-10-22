import type { Account, Pacing, PacingAccount, Session, SessionStatus, SessionsSummary } from '../api/types';
import type { Tone } from '../components/status';
import { providerLabel } from '../workflow/registry';
import { plural } from './format';
import { span } from './pacing';

/*
 * Presentation rules for observed T3 Code sessions and advice-mode pacing.
 * Pure, so the wording is testable without a browser.
 */

const FAMILIES: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };

/**
 * A model id as people say it: "claude-opus-5-5" → "Claude Opus 5.5",
 * "claude-sonnet-4-5-20250929" → "Claude Sonnet 4.5", "gpt-5.5-codex" →
 * "GPT-5.5 Codex". Anything else is shown as sent.
 */
export function modelName(id: string | undefined): string {
  if (!id) return 'Model not reported';
  const m = id.trim().toLowerCase();
  const claude = /^claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/.exec(m);
  if (claude) return `Claude ${FAMILIES[claude[1]]} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  // Older Claude ids put the family last: claude-3-5-sonnet-20241022.
  const legacy = /^claude-(\d+)(?:-(\d))?-(opus|sonnet|haiku)(?:-\d{8})?$/.exec(m);
  if (legacy) return `Claude ${FAMILIES[legacy[3]]} ${legacy[1]}${legacy[2] ? `.${legacy[2]}` : ''}`;
  const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-(codex|mini|nano|pro))?(?:-(mini|max))?$/.exec(m);
  if (gpt) return ['GPT-' + gpt[1], ...[gpt[2], gpt[3]].filter(Boolean).map((w) => w!.charAt(0).toUpperCase() + w!.slice(1))].join(' ');
  return id;
}

/** Input plus output, the same total the Usage screen counts; cache is shown apart. */
export const sessionTokens = (s: Session) => s.tokens.input + s.tokens.output;

export const SESSION_STATUS: Record<SessionStatus, [Tone, string]> = {
  running: ['live', 'Running'],
  waiting: ['approval', 'Waiting for you'],
  idle: ['quiet', 'Idle'],
  error: ['failed', 'Error'],
  unknown: ['quiet', 'Status not reported'],
};

/** Waiting first (a person must act), then running, errors, idle. */
const RANK: Record<SessionStatus, number> = { waiting: 0, running: 1, error: 2, idle: 3, unknown: 4 };
export function sessionOrder(a: Session, b: Session): number {
  return RANK[a.status] - RANK[b.status] || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
}

export interface SessionNode {
  session: Session;
  children: Session[];
}

/**
 * Subagents nest under the session that spawned them (by thread id on the
 * same machine). A child whose parent isn't in the list stays top level.
 */
export function nestSessions(list: Session[]): SessionNode[] {
  const key = (machineId: string, thread: string) => `${machineId}|${thread}`;
  const byThread = new Map(list.map((s) => [key(s.machineId, s.threadId), s]));
  const children = new Map<string, Session[]>();
  const top: Session[] = [];
  for (const s of list) {
    const parent = s.parentThreadId ? byThread.get(key(s.machineId, s.parentThreadId)) : undefined;
    if (parent && parent !== s) children.set(parent.id, [...(children.get(parent.id) ?? []), s]);
    else top.push(s);
  }
  return top.sort(sessionOrder).map((session) => ({ session, children: (children.get(session.id) ?? []).sort(sessionOrder) }));
}

/** Running: how long since it started. Waiting: how long it has waited. Otherwise when it was last active. */
export function sessionTime(s: Session, now = Date.now()): string {
  if (s.status === 'running') return `for ${span(now - Date.parse(s.createdAt))}`;
  if (s.status === 'waiting') return `waiting ${span(now - Date.parse(s.lastActivityAt))}`;
  const since = now - Date.parse(s.lastActivityAt);
  return since < 60_000 ? 'active just now' : `active ${span(since)} ago`;
}

export type StatusFilter = 'all' | 'running' | 'waiting' | 'idle' | 'error';
export function matchesFilter(s: Session, f: StatusFilter): boolean {
  return f === 'all' || s.status === f || (f === 'idle' && s.status === 'unknown');
}

/** The highest projection across a provider's subscriptions, or whether any runs out. */
function providerProjection(accounts: PacingAccount[]): { over: boolean; percent?: number } {
  const windows = accounts.flatMap((a) => a.windows);
  if (windows.some((w) => w.onTrack === 'over' || w.projectedPercentAtReset > 100)) return { over: true };
  if (!windows.length) return { over: false };
  return { over: false, percent: Math.round(Math.max(...windows.map((w) => w.projectedPercentAtReset))) };
}

/** Sum of `headroomAgents` across subscriptions, or undefined when none reports it. */
export function headroom(p: Pacing): number | undefined {
  const known = p.accounts.filter((a) => a.headroomAgents !== undefined);
  return known.length ? known.reduce((s, a) => s + (a.headroomAgents ?? 0), 0) : undefined;
}

export function headroomText(n: number | undefined): string | null {
  if (n === undefined) return null;
  return n === 0 ? 'no room for more agents' : `room for about ${plural(n, 'more agent')}`;
}

/**
 * Advice instead of a plan: "7 sessions running · Claude on track for 82% by
 * reset, Codex for 61% · room for about 3 more agents". `running` comes from
 * the sessions summary when the hub has one.
 */
export function adviceHeadline(p: Pacing, running?: number): string[] {
  const n = running ?? p.providers.reduce((s, x) => s + x.runningAgents, 0);
  const parts = [`${plural(n, 'session')} running`];
  const order = [...new Set([...p.providers.map((x) => x.provider), ...p.accounts.map((a) => a.provider)])];
  const tracks = order
    .map((provider) => ({ provider, ...providerProjection(p.accounts.filter((a) => a.provider === provider)) }))
    .filter((t) => t.over || t.percent !== undefined);
  const over = tracks.filter((t) => t.over).map((t) => `${providerLabel(t.provider)} runs out before reset`);
  const on = tracks.filter((t) => !t.over).map((t, i) => (i === 0 ? `${providerLabel(t.provider)} on track for ${t.percent}% by reset` : `${providerLabel(t.provider)} for ${t.percent}%`));
  if (over.length || on.length) parts.push([...over, ...on].join(', '));
  const room = headroomText(headroom(p));
  if (room) parts.push(room);
  return parts;
}

/** Subscriptions seen in T3 Code rather than enrolled in a machine's pool. */
export const isObserved = (a: Account) => a.source === 'observed';

/** Advice mode: nothing is enforced. */
export const isAdvice = (p: Pacing | null | undefined) => p?.mode === 'advise';

/** Tokens in a summary, input plus output. */
export function summaryTokens(s: SessionsSummary | null | undefined): number | undefined {
  if (!s) return undefined;
  const fromProviders = s.tokens.byProvider.reduce((sum, g) => sum + g.input + g.output, 0);
  return fromProviders || s.tokens.series.reduce((sum, p) => sum + p.input + p.output, 0);
}

/** Whether a machine is the one this browser runs on, as far as the page can tell. */
export function isThisMac(machine: { name: string; labels?: string[] }): boolean {
  return !!machine.labels?.includes('this-mac');
}
