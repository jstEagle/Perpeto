import type { Account, OnTrack, Pacing, PacingAccount, PacingAccountState, PacingLimit, PacingProvider, PacingWindow, UsageWindow } from '../api/types';
import type { Tone } from '../components/status';
import { clock, plural } from './format';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A span as people say it: "38 min", "2 h 14 m", "3 d 4 h". */
export function span(ms: number): string {
  if (!Number.isFinite(ms) || ms < MIN) return 'under a minute';
  const mins = Math.round(ms / MIN);
  if (mins < 60) return `${mins} min`;
  if (mins < 48 * 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h} h ${m} m` : `${h} h`;
  }
  const d = Math.floor(mins / 1440);
  const h = Math.round((mins % 1440) / 60);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** "resets in 2 h 14 m"; a reset time already passed reads as due. */
export function resetsIn(iso: string | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return at <= now ? 'reset due' : `resets in ${span(at - now)}`;
}

export const STATE: Record<PacingAccountState, [Tone, string]> = {
  burning: ['live', 'Burning'],
  next: ['next', 'Up next'],
  resting: ['waiting', 'Resting'],
  cooling: ['waiting', 'Cooling down'],
  exhausted: ['stopped', 'Used up'],
  unknown: ['quiet', 'Not paced'],
};

const LIMIT: Record<PacingLimit, string> = {
  weekly: 'Held back by weekly limits',
  session: 'Paced by session limits',
  slots: 'Capped by machine slots',
  work: 'Not enough ready work',
  none: 'Running at target',
  unknown: 'Limit not reported',
};

/** What sets one provider's pace, in words. */
export function limitedByText(p: PacingProvider): string {
  if (p.starved && p.limitedBy !== 'work') return `${LIMIT.work}, ${LIMIT[p.limitedBy].toLowerCase()}`;
  return LIMIT[p.limitedBy];
}

/** Whether a subscription will end its windows at the target: over if any window overruns, under if none reaches it. */
export function accountTrack(a: PacingAccount): OnTrack {
  const known = a.windows.filter((w) => w.onTrack !== 'unknown');
  if (!known.length) return 'unknown';
  if (known.some((w) => w.onTrack === 'over')) return 'over';
  if (known.every((w) => w.onTrack === 'under')) return 'under';
  return 'on';
}

export function runningAgents(p: Pacing): number {
  return p.providers.length ? p.providers.reduce((s, x) => s + x.runningAgents, 0) : p.accounts.reduce((s, x) => s + x.runningAgents, 0);
}

/**
 * The one sentence at the top of the pacing view: how many agents run now
 * and whether every subscription is on course for the target by its reset.
 */
export function pacingHeadline(p: Pacing): { lead: string; detail: string } {
  const lead = `${plural(runningAgents(p), 'agent')} running`;
  if (!p.enabled) return { lead, detail: 'pacing is off, so each machine fills its own slots' };
  const tracked = p.accounts.map(accountTrack).filter((t) => t !== 'unknown');
  if (!tracked.length) return { lead, detail: 'no subscription has reported its limits yet' };
  const over = tracked.filter((t) => t === 'over').length;
  const under = tracked.filter((t) => t === 'under').length;
  const target = `${p.targetUsePercent}%`;
  if (over) return { lead, detail: `${plural(over, 'subscription')} will run out before ${over === 1 ? 'its' : 'their'} reset` };
  if (under) return { lead, detail: `${tracked.length - under} of ${plural(tracked.length, 'subscription')} on track for ${target} by their reset` };
  return { lead, detail: `on track to use ${target} of every subscription by its reset` };
}

/** Session first, then weekly, monthly and the rest. */
const ORDER = { session: 0, weekly: 1, monthly: 2, other: 3 } as const;
export function orderedWindows<T extends UsageWindow | PacingWindow>(windows: T[]): T[] {
  return [...windows].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
}

/** Usage windows for an account with the hub's projection, where pacing has one. */
export interface MeterWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt?: string;
  projectedPercentAtReset?: number;
  onTrack?: OnTrack;
}
export function meterWindows(account: Account, paced?: PacingAccount): MeterWindow[] {
  const own = orderedWindows(account.usage?.windows ?? []);
  const projected = new Map((paced?.windows ?? []).map((w) => [w.id, w]));
  const merged: MeterWindow[] = own.map((w) => {
    const p = projected.get(w.id);
    return { ...w, ...(p ? { projectedPercentAtReset: p.projectedPercentAtReset, onTrack: p.onTrack } : {}) };
  });
  // Pacing may know windows the heartbeat did not carry yet.
  for (const p of orderedWindows(paced?.windows ?? [])) if (!own.some((w) => w.id === p.id)) merged.push(p);
  return merged;
}

/** "Projected 96% at reset", or a plain warning when it overruns or falls short. */
export function projectionText(w: MeterWindow): string | null {
  if (w.projectedPercentAtReset === undefined) return null;
  const at = `${Math.round(w.projectedPercentAtReset)}%`;
  if (w.onTrack === 'over') return `runs out before reset`;
  return `${at} at reset`;
}

export interface TimelineLane {
  account: PacingAccount;
  segments: { phase: 'burn' | 'rest'; left: number; width: number; from: string; to: string }[];
}
export interface TimelineLayout {
  start: number;
  end: number;
  /** Position of now, 0 to 100. */
  now: number;
  groups: { provider: string; lanes: TimelineLane[] }[];
  ticks: { label: string; at: number }[];
}

/**
 * Lays the timeline out from an hour before now to `hoursAhead` after.
 * Lanes are grouped by provider and ordered by their next burn, so a
 * rotation reads as a staircase.
 */
export function timelineLayout(p: Pacing, now = Date.now(), hoursAhead = 10, hoursBefore = 1): TimelineLayout {
  const start = now - hoursBefore * HOUR;
  const end = now + hoursAhead * HOUR;
  const pos = (t: number) => ((Math.min(end, Math.max(start, t)) - start) / (end - start)) * 100;
  const lanes: TimelineLane[] = p.accounts.map((account) => ({
    account,
    segments: p.timeline
      .filter((s) => s.accountId === account.accountId && Date.parse(s.to) > start && Date.parse(s.from) < end)
      .sort((a, b) => Date.parse(a.from) - Date.parse(b.from))
      .map((s) => ({ phase: s.phase, from: s.from, to: s.to, left: pos(Date.parse(s.from)), width: pos(Date.parse(s.to)) - pos(Date.parse(s.from)) })),
  }));
  const nextBurn = (l: TimelineLane) => {
    const s = l.segments.find((x) => x.phase === 'burn' && Date.parse(x.to) > now);
    return s ? Date.parse(s.from) : Number.POSITIVE_INFINITY;
  };
  const order = [...new Set([...p.providers.map((x) => x.provider), ...p.accounts.map((a) => a.provider)])];
  const groups = order
    .map((provider) => ({
      provider,
      lanes: lanes.filter((l) => l.account.provider === provider).sort((a, b) => nextBurn(a) - nextBurn(b) || a.account.label.localeCompare(b.account.label)),
    }))
    .filter((g) => g.lanes.length);
  const ticks: TimelineLayout['ticks'] = [];
  const step = 2 * HOUR;
  for (let t = Math.ceil(start / step) * step; t <= end; t += step) {
    // Leave room around the now label.
    if (Math.abs(t - now) < 0.6 * HOUR || pos(t) > 97) continue;
    ticks.push({ label: clock(new Date(t).toISOString()), at: pos(t) });
  }
  return { start, end, now: pos(now), groups, ticks };
}
