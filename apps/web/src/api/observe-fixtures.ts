import type { Account, Machine, ObservedMachine, Pacing, Session, SessionStatus, SessionsSummary, SessionsWindow, TokenGroup, UsageWindowKind } from './types';

/*
 * Observed T3 Code sessions and subscriptions on two Macs: this one and a
 * Mac mini. Four sessions run (one with three subagents), one waits for the
 * owner, one failed, the rest are idle. Mirrors the Apple app's demo
 * (`DemoObserve.swift`). Every time is relative to `now`.
 */

const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();

export const OBSERVE_IDS = { mac: 'mch_macbook', mini: 'mch_macmini' } as const;
const MAC_NAME = 'justus-macbook-pro';
const MINI_NAME = 'mac-mini';

export function observeMachines(now: number): Machine[] {
  const base = { os: 'darwin', arch: 'arm64', providers: ['claudeAgent', 'codex'], capacity: { maxAgents: 0, maxJobs: 0 }, status: 'online' as const, version: '0.4.0' };
  return [
    { ...base, id: OBSERVE_IDS.mac, name: MAC_NAME, labels: ['this-mac'], running: { agents: 3, jobs: 0 }, lastHeartbeatAt: iso(now - 6_000) },
    { ...base, id: OBSERVE_IDS.mini, name: MINI_NAME, labels: [], running: { agents: 1, jobs: 0 }, lastHeartbeatAt: iso(now - 11_000) },
  ];
}

interface Spec {
  id: string;
  machine: 0 | 1;
  title?: string;
  project?: string;
  branch?: string;
  provider: 'claudeAgent' | 'codex';
  model: string;
  status: Exclude<SessionStatus, 'unknown'>;
  parent?: string;
  children?: number;
  /** Minutes ago. */
  created: number;
  active: number;
  turns: number;
  /** Thousands of tokens. */
  input: number;
  output: number;
  cache: number;
}

const SPECS: Spec[] = [
  { id: 'ses_obs01', machine: 0, title: 'Observe-only sessions view for the web app', project: 'perpeto', branch: 'feat/observe-sessions', provider: 'claudeAgent', model: 'claude-opus-5-5', status: 'running', children: 3, created: 42, active: 0.2, turns: 31, input: 184, output: 46, cache: 3_120 },
  { id: 'ses_obs01a', machine: 0, title: 'Decode the sessions contract', project: 'perpeto', branch: 'feat/observe-sessions', provider: 'claudeAgent', model: 'claude-sonnet-5-5', status: 'running', parent: 'ses_obs01', created: 11, active: 0.4, turns: 9, input: 38, output: 12, cache: 410 },
  { id: 'ses_obs01b', machine: 0, title: 'Write Swift decoding tests', project: 'perpeto', branch: 'feat/observe-sessions', provider: 'claudeAgent', model: 'claude-sonnet-5-5', status: 'idle', parent: 'ses_obs01', created: 27, active: 14, turns: 7, input: 29, output: 9, cache: 260 },
  { id: 'ses_obs01c', machine: 0, title: 'Check dark mode contrast', project: 'perpeto', branch: 'feat/observe-sessions', provider: 'claudeAgent', model: 'claude-haiku-5-5', status: 'idle', parent: 'ses_obs01', created: 33, active: 21, turns: 4, input: 12, output: 3, cache: 90 },
  { id: 'ses_obs02', machine: 0, title: 'Migrate billing webhooks to Stripe v2', project: 'lumin-web', branch: 'fix/stripe-webhooks', provider: 'claudeAgent', model: 'claude-sonnet-5-5', status: 'waiting', created: 78, active: 3, turns: 22, input: 96, output: 31, cache: 1_480 },
  { id: 'ses_obs03', machine: 0, title: 'Speed up event stream reconnects', project: 'perpeto', branch: 'perf/sse-reconnect', provider: 'codex', model: 'gpt-5.5-codex', status: 'running', created: 18, active: 0.5, turns: 12, input: 61, output: 18, cache: 520 },
  { id: 'ses_obs04', machine: 1, title: 'Nightly dependency upgrades', project: 'lumin-api', branch: 'chore/deps-oct', provider: 'codex', model: 'gpt-5.5-codex', status: 'running', created: 65, active: 1, turns: 27, input: 142, output: 37, cache: 1_960 },
  { id: 'ses_obs05', machine: 1, title: 'Generate iOS simulator screenshots', project: 'perpeto', branch: 'chore/ios-shots', provider: 'codex', model: 'gpt-5.5', status: 'error', created: 54, active: 26, turns: 8, input: 22, output: 6, cache: 140 },
  { id: 'ses_obs06', machine: 1, title: 'Draft onboarding email copy', project: 'lumin-marketing', branch: 'main', provider: 'claudeAgent', model: 'claude-sonnet-5-5', status: 'idle', created: 95, active: 40, turns: 14, input: 41, output: 22, cache: 380 },
  { id: 'ses_obs07', machine: 0, title: 'Fix the flaky merge queue test', project: 'perpeto', branch: 'fix/merge-queue-flake', provider: 'claudeAgent', model: 'claude-opus-5-5', status: 'idle', created: 260, active: 130, turns: 19, input: 88, output: 24, cache: 1_210 },
  { id: 'ses_obs08', machine: 0, title: 'Explain the pacing maths', provider: 'claudeAgent', model: 'claude-opus-5-5', status: 'idle', created: 400, active: 310, turns: 6, input: 17, output: 9, cache: 120 },
  { id: 'ses_obs09', machine: 1, title: 'Refactor auth middleware', project: 'lumin-api', branch: 'refactor/auth-mw', provider: 'claudeAgent', model: 'claude-sonnet-5-5', status: 'idle', created: 520, active: 300, turns: 25, input: 103, output: 29, cache: 1_640 },
  { id: 'ses_obs10', machine: 1, project: 'lumin-web', branch: 'main', provider: 'claudeAgent', model: 'claude-sonnet-5-5', status: 'idle', created: 1_700, active: 1_440, turns: 2, input: 5, output: 1, cache: 30 },
];

const thread = (id: string) => `thr_${id.slice(4)}`;

/** The demo sessions on the given machines (the observe pair by default). */
export function observeSessions(now: number, machines: { id: string; name: string }[] = [
  { id: OBSERVE_IDS.mac, name: MAC_NAME },
  { id: OBSERVE_IDS.mini, name: MINI_NAME },
]): Session[] {
  return SPECS.map((s) => {
    const host = machines[Math.min(s.machine, machines.length - 1)];
    return {
      id: s.id,
      machineId: host.id,
      machineName: host.name,
      threadId: thread(s.id),
      ...(s.title ? { title: s.title } : {}),
      ...(s.project ? { project: { name: s.project, path: `~/Developer/${s.project}` } } : {}),
      ...(s.branch ? { branch: s.branch } : {}),
      provider: s.provider,
      providerInstanceId: s.provider === 'codex' ? 'codex-default' : 'claude-default',
      model: s.model,
      status: s.status,
      ...(s.parent ? { parentThreadId: thread(s.parent) } : {}),
      childCount: s.children ?? 0,
      createdAt: iso(now - s.created * MIN),
      lastActivityAt: iso(now - s.active * MIN),
      turns: s.turns,
      tokens: { input: s.input * 1000, output: s.output * 1000, cacheRead: s.cache * 1000, cacheWrite: s.cache * 60, reasoning: s.output * 300 },
    };
  });
}

/** Quiet overnight, busy in the afternoon; deterministic so screenshots are stable. */
const SHAPE = [0.1, 0.05, 0.04, 0.03, 0.03, 0.05, 0.12, 0.28, 0.46, 0.62, 0.71, 0.58, 0.5, 0.66, 0.84, 0.92, 1.0, 0.88, 0.7, 0.52, 0.44, 0.61, 0.79, 0.9];
function series(now: number, buckets: number, stepMs: number, scale: number) {
  const end = Math.floor(now / stepMs) * stepMs;
  return Array.from({ length: buckets }, (_, i) => {
    const level = SHAPE[(i + SHAPE.length - (buckets % SHAPE.length)) % SHAPE.length];
    const input = Math.floor(scale * level * 1000) * 1000;
    return { at: iso(end - (buckets - 1 - i) * stepMs), input, output: Math.floor(input / 4) };
  });
}

const WINDOWS: Record<SessionsWindow, { factor: number; buckets: number; step: number; scale: number }> = {
  '1h': { factor: 0.11, buckets: 12, step: 5 * MIN, scale: 18 },
  '24h': { factor: 1, buckets: 24, step: 60 * MIN, scale: 62 },
  '7d': { factor: 5.4, buckets: 28, step: 6 * 60 * MIN, scale: 330 },
};

export function observeSummary(now: number, window: SessionsWindow, sessions: Session[], machines: Machine[]): SessionsSummary {
  const w = WINDOWS[window];
  const n = (machineId: string, status: SessionStatus) => sessions.filter((s) => s.machineId === machineId && s.status === status).length;
  const observed: ObservedMachine[] = machines.map((m) => ({
    machineId: m.id,
    name: m.name,
    online: m.status === 'online',
    observing: true,
    lastObservedAt: m.lastHeartbeatAt,
    running: n(m.id, 'running'),
    waiting: n(m.id, 'waiting'),
    idle: n(m.id, 'idle'),
  }));
  const groups = (key: (s: Session) => string): TokenGroup[] => {
    const map = new Map<string, TokenGroup>();
    for (const s of sessions) {
      const k = key(s);
      const g = map.get(k) ?? { key: k, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      g.input += Math.round(s.tokens.input * w.factor);
      g.output += Math.round(s.tokens.output * w.factor);
      g.cacheRead += Math.round(s.tokens.cacheRead * w.factor);
      g.cacheWrite += Math.round(s.tokens.cacheWrite * w.factor);
      map.set(k, g);
    }
    return [...map.values()].sort((a, b) => b.input + b.output - (a.input + a.output));
  };
  const running = sessions.filter((s) => s.status === 'running').length;
  const waiting = sessions.filter((s) => s.status === 'waiting').length;
  return {
    window,
    machines: observed,
    totals: { running, waiting, sessionsActive: running + waiting },
    tokens: {
      byProvider: groups((s) => s.provider),
      byModel: groups((s) => s.model ?? 'unknown'),
      byMachine: groups((s) => s.machineId),
      series: series(now, w.buckets, w.step, w.scale),
    },
  };
}

function usageWindow(now: number, kind: UsageWindowKind, used: number, resetInMins: number) {
  return { id: kind, kind, label: kind === 'session' ? 'Session' : 'Weekly', usedPercent: used, resetsAt: iso(now + resetInMins * MIN), windowMins: kind === 'session' ? 300 : 7 * 24 * 60 };
}

/** Claude Max on this Mac and ChatGPT Pro on the Mac mini, as T3 Code reports them. */
export function observeAccounts(now: number): Account[] {
  return [
    {
      id: 'acct_obs_claude',
      machineId: OBSERVE_IDS.mac,
      provider: 'claudeAgent',
      label: 'Claude Max',
      plan: 'Max 20x',
      status: 'active',
      lastUsedAt: iso(now - 12_000),
      source: 'observed',
      usage: { checkedAt: iso(now - 45_000), windows: [usageWindow(now, 'session', 46, 130), usageWindow(now, 'weekly', 58, 4_560)] },
    },
    {
      id: 'acct_obs_chatgpt',
      machineId: OBSERVE_IDS.mini,
      provider: 'codex',
      label: 'ChatGPT Pro',
      plan: 'Pro',
      status: 'active',
      lastUsedAt: iso(now - 60_000),
      source: 'observed',
      usage: { checkedAt: iso(now - 70_000), windows: [usageWindow(now, 'session', 22, 220), usageWindow(now, 'weekly', 41, 5_880)] },
    },
  ];
}

/** Advice only: projections at the current pace and how many more agents each could take. */
export function observePacing(now: number): Pacing {
  const w = (kind: UsageWindowKind, used: number, resetIn: number, projected: number) => ({ ...usageWindow(now, kind, used, resetIn), projectedPercentAtReset: projected, onTrack: 'under' as const });
  return {
    mode: 'advise',
    enabled: false,
    strategy: 'unknown',
    targetUsePercent: 95,
    updatedAt: iso(now - 60_000),
    providers: [
      { provider: 'claudeAgent', targetAgents: 0, runningAgents: 2, slots: 0, readyWork: 0, limitedBy: 'unknown', starved: false },
      { provider: 'codex', targetAgents: 0, runningAgents: 2, slots: 0, readyWork: 0, limitedBy: 'unknown', starved: false },
    ],
    accounts: [
      { accountId: 'acct_obs_claude', machineId: OBSERVE_IDS.mac, provider: 'claudeAgent', label: 'Claude Max', plan: 'Max 20x', state: 'unknown', targetAgents: 0, runningAgents: 2, burnPerAgentHour: 6.2, windows: [w('session', 46, 130, 71), w('weekly', 58, 4_560, 82)], idleForecastMins: 0, headroomAgents: 3 },
      { accountId: 'acct_obs_chatgpt', machineId: OBSERVE_IDS.mini, provider: 'codex', label: 'ChatGPT Pro', plan: 'Pro', state: 'unknown', targetAgents: 0, runningAgents: 2, burnPerAgentHour: 4.1, windows: [w('session', 22, 220, 48), w('weekly', 41, 5_880, 61)], idleForecastMins: 0, headroomAgents: 2 },
    ],
    timeline: [],
  };
}
