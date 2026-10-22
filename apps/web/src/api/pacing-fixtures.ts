import type { Account, OnTrack, Pacing, PacingAccount, PacingAccountState, PacingSegment, PacingSettings, UsageWindowKind } from './types';

/*
 * Demo subscriptions mid-rotation. Five Claude logins share 5-hour session
 * windows: each burns for an hour, starting the moment its own session
 * resets, so the first has reset by the time the fifth finishes. Two Codex
 * logins alternate in 2.5-hour turns; one is short of ready work. Weekly
 * windows sit at varied levels. Every time is relative to `now`, so the
 * screens look the same whenever the demo opens.
 */

const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();

interface WindowSpec {
  kind: UsageWindowKind;
  used: number;
  /** Minutes from now. */
  resetIn: number;
  projected: number;
  track: OnTrack;
}
interface SubSpec {
  id: string;
  machineId: string;
  provider: 'claudeAgent' | 'codex';
  label: string;
  plan: string;
  state: PacingAccountState;
  agents: number;
  target: number;
  burnPerAgentHour?: number;
  idle: number;
  session: WindowSpec;
  weekly: WindowSpec;
}

const WINDOW_MINS: Record<string, number> = { session: 300, weekly: 7 * 24 * 60 };

/** Subscriptions in rotation order per provider. */
export function demoSubscriptions(machines: { studio: string; linux: string }): SubSpec[] {
  const on = (used: number, resetIn: number, projected = used): WindowSpec => ({ kind: 'session', used, resetIn, projected, track: 'on' });
  const week = (used: number, resetIn: number, projected: number, track: OnTrack = 'on'): WindowSpec => ({ kind: 'weekly', used, resetIn, projected, track });
  return [
    { id: 'acct_c1', machineId: machines.linux, provider: 'claudeAgent', label: 'Claude · build', plan: 'Max 20x', state: 'burning', agents: 3, target: 3, burnPerAgentHour: 31.7, idle: 0, session: on(55, 265, 95), weekly: week(62, 76 * 60, 95) },
    { id: 'acct_c2', machineId: machines.studio, provider: 'claudeAgent', label: 'Claude · personal', plan: 'Max 20x', state: 'next', agents: 0, target: 0, idle: 0, session: on(95, 25), weekly: week(81, 30 * 60, 96) },
    { id: 'acct_c3', machineId: machines.studio, provider: 'claudeAgent', label: 'Claude · Lumin 1', plan: 'Max 5x', state: 'resting', agents: 0, target: 0, idle: 0, session: on(94, 85), weekly: week(34, 146 * 60, 93) },
    { id: 'acct_c4', machineId: machines.linux, provider: 'claudeAgent', label: 'Claude · Lumin 2', plan: 'Max 5x', state: 'resting', agents: 0, target: 0, idle: 0, session: on(96, 145), weekly: week(88, 14 * 60, 97) },
    { id: 'acct_c5', machineId: machines.linux, provider: 'claudeAgent', label: 'Claude · Lumin 3', plan: 'Max 5x', state: 'resting', agents: 0, target: 0, idle: 0, session: on(95, 205), weekly: week(47, 107 * 60, 94) },
    { id: 'acct_x1', machineId: machines.studio, provider: 'codex', label: 'ChatGPT · build', plan: 'Pro', state: 'burning', agents: 2, target: 3, burnPerAgentHour: 15.2, idle: 35, session: { kind: 'session', used: 38, resetIn: 240, projected: 78, track: 'under' }, weekly: week(55, 57 * 60, 84, 'under') },
    { id: 'acct_x2', machineId: machines.linux, provider: 'codex', label: 'ChatGPT · Lumin', plan: 'Pro', state: 'resting', agents: 0, target: 0, idle: 0, session: on(93, 90), weekly: week(40, 120 * 60, 92) },
  ];
}

const LABEL: Record<string, string> = { session: 'Session', weekly: 'Weekly' };

export function demoAccounts(subs: SubSpec[], now: number): Account[] {
  return subs.map((s) => ({
    id: s.id,
    machineId: s.machineId,
    provider: s.provider,
    label: s.label,
    plan: s.plan,
    status: 'active',
    lastUsedAt: iso(now - (s.state === 'burning' ? 20_000 : (300 - s.session.resetIn) * MIN)),
    usage: {
      checkedAt: iso(now - 40_000),
      windows: [s.session, s.weekly].map((w) => ({ id: w.kind, kind: w.kind, label: LABEL[w.kind], usedPercent: w.used, resetsAt: iso(now + w.resetIn * MIN), windowMins: WINDOW_MINS[w.kind] })),
    },
  }));
}

/** Burn turns of `burnMins` handed round `ids` in order, the first starting at `firstStart` minutes from now. */
function rotation(ids: string[], firstStart: number, burnMins: number, now: number, fromMin: number, toMin: number): PacingSegment[] {
  const segments: PacingSegment[] = [];
  const cycle = ids.length * burnMins;
  for (const [i, accountId] of ids.entries()) {
    const burns: [number, number][] = [];
    let t = firstStart + i * burnMins;
    while (t > fromMin) t -= cycle;
    for (; t < toMin; t += cycle) if (t + burnMins > fromMin) burns.push([t, t + burnMins]);
    let cursor = fromMin;
    for (const [a, b] of burns) {
      if (a > cursor) segments.push({ accountId, phase: 'rest', from: iso(now + cursor * MIN), to: iso(now + a * MIN) });
      segments.push({ accountId, phase: 'burn', from: iso(now + Math.max(a, fromMin) * MIN), to: iso(now + Math.min(b, toMin) * MIN) });
      cursor = b;
    }
    if (cursor < toMin) segments.push({ accountId, phase: 'rest', from: iso(now + cursor * MIN), to: iso(now + toMin * MIN) });
  }
  return segments;
}

export interface DemoPacingSettings {
  enabled: boolean;
  strategy: 'rotation' | 'parallel';
  targetUsePercent: number;
  minAgents: number;
  maxAgents: number | null;
}

export const DEFAULT_PACING: DemoPacingSettings = { enabled: true, strategy: 'rotation', targetUsePercent: 95, minAgents: 1, maxAgents: 12 };

export function applyPacingSettings(current: DemoPacingSettings, patch: PacingSettings): DemoPacingSettings {
  return {
    enabled: patch.enabled ?? current.enabled,
    strategy: patch.strategy ?? current.strategy,
    targetUsePercent: patch.targetUsePercent ?? current.targetUsePercent,
    minAgents: patch.minAgents ?? current.minAgents,
    maxAgents: patch.maxAgents !== undefined ? patch.maxAgents : current.maxAgents,
  };
}

/**
 * The plan the demo hub reports for these settings. Rotation burns one
 * login per provider at a time; parallel spreads one agent across each.
 * Projections of on-track windows follow the target.
 */
export function demoPacing(subs: SubSpec[], settings: DemoPacingSettings, now: number, updatedAt: number): Pacing {
  const parallel = settings.strategy === 'parallel';
  const nudge = [0, 1, -1, 1, 0, 0, -1];
  const accounts: PacingAccount[] = subs.map((s, i) => {
    const agents = !settings.enabled ? 0 : parallel ? 1 : s.agents;
    const state: PacingAccountState = !settings.enabled ? 'unknown' : parallel ? 'burning' : s.state;
    const project = (w: WindowSpec) => (w.track === 'on' && w.kind === 'session' && s.state !== 'burning' ? w.projected : w.track === 'on' ? settings.targetUsePercent + nudge[i] : w.projected);
    return {
      accountId: s.id,
      machineId: s.machineId,
      provider: s.provider,
      label: s.label,
      plan: s.plan,
      state,
      targetAgents: !settings.enabled ? 0 : parallel ? 1 : s.target,
      runningAgents: agents,
      ...(s.burnPerAgentHour !== undefined ? { burnPerAgentHour: s.burnPerAgentHour } : {}),
      windows: [s.session, s.weekly].map((w) => ({
        id: w.kind,
        kind: w.kind,
        label: LABEL[w.kind],
        usedPercent: w.used,
        resetsAt: iso(now + w.resetIn * MIN),
        projectedPercentAtReset: Math.min(100, Math.max(w.used, project(w))),
        onTrack: settings.enabled ? w.track : 'unknown',
      })),
      idleForecastMins: settings.enabled ? s.idle : 0,
    };
  });
  const ids = (provider: string) => subs.filter((s) => s.provider === provider).map((s) => s.id);
  const from = -120;
  const to = 11 * 60;
  const timeline: PacingSegment[] = !settings.enabled
    ? []
    : parallel
      ? subs.map((s) => ({ accountId: s.id, phase: 'burn' as const, from: iso(now + from * MIN), to: iso(now + to * MIN) }))
      : [...rotation(ids('claudeAgent'), -35, 60, now, from, to), ...rotation(ids('codex'), -60, 150, now, from, to)];
  const running = (provider: string) => accounts.filter((a) => a.provider === provider).reduce((n, a) => n + a.runningAgents, 0);
  const target = (provider: string) => accounts.filter((a) => a.provider === provider).reduce((n, a) => n + a.targetAgents, 0);
  return {
    enabled: settings.enabled,
    strategy: settings.strategy,
    targetUsePercent: settings.targetUsePercent,
    minAgents: settings.minAgents,
    maxAgents: settings.maxAgents,
    updatedAt: iso(updatedAt),
    providers: [
      { provider: 'claudeAgent', targetAgents: target('claudeAgent'), runningAgents: running('claudeAgent'), slots: 14, readyWork: 9, limitedBy: settings.enabled ? 'session' : 'none', starved: false },
      { provider: 'codex', targetAgents: target('codex'), runningAgents: running('codex'), slots: 14, readyWork: 2, limitedBy: settings.enabled ? 'work' : 'none', starved: settings.enabled },
    ],
    accounts,
    timeline,
  };
}
