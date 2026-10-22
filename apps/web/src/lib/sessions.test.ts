import { describe, expect, it } from 'vitest';
import type { Pacing, Session } from '../api/types';
import { adviceHeadline, headroom, headroomText, matchesFilter, modelName, nestSessions, sessionTime } from './sessions';

const NOW = Date.parse('2026-10-22T15:00:00Z');
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
const s = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  machineId: 'm1',
  machineName: 'mac-mini',
  threadId: `thr_${id}`,
  provider: 'claudeAgent',
  status: 'idle',
  childCount: 0,
  createdAt: at(60),
  lastActivityAt: at(10),
  turns: 1,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  ...over,
});

describe('model names', () => {
  it.each([
    ['claude-opus-5-5', 'Claude Opus 5.5'],
    ['claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5'],
    ['claude-haiku-5-5', 'Claude Haiku 5.5'],
    ['claude-opus-4-1', 'Claude Opus 4.1'],
    ['claude-sonnet-4', 'Claude Sonnet 4'],
    ['claude-3-5-sonnet-20241022', 'Claude Sonnet 3.5'],
    ['gpt-5.5-codex', 'GPT-5.5 Codex'],
    ['gpt-5.5', 'GPT-5.5'],
    ['gpt-5-mini', 'GPT-5 Mini'],
    ['grok-5', 'grok-5'],
  ])('%s reads as %s', (id, name) => {
    expect(modelName(id)).toBe(name);
  });

  it('says so when no model is reported', () => {
    expect(modelName(undefined)).toBe('Model not reported');
  });
});

describe('session lists', () => {
  it('nests subagents under their parent on the same machine and orders waiting first', () => {
    const list = [
      s('a', { status: 'idle' }),
      s('b', { status: 'running', childCount: 2 }),
      s('b1', { status: 'idle', parentThreadId: 'thr_b' }),
      s('b2', { status: 'running', parentThreadId: 'thr_b' }),
      s('c', { status: 'waiting' }),
      // Same thread id on another machine is a different session.
      s('x', { machineId: 'm2', parentThreadId: 'thr_b' }),
    ];
    const nodes = nestSessions(list);
    expect(nodes.map((n) => n.session.id)).toEqual(['c', 'b', 'a', 'x']);
    expect(nodes[1].children.map((c) => c.id)).toEqual(['b2', 'b1']);
  });

  it('counts unknown statuses as idle when filtering', () => {
    expect(matchesFilter(s('u', { status: 'unknown' }), 'idle')).toBe(true);
    expect(matchesFilter(s('r', { status: 'running' }), 'idle')).toBe(false);
    expect(matchesFilter(s('r', { status: 'error' }), 'all')).toBe(true);
  });

  it('says how long a session has run, waited or been idle', () => {
    expect(sessionTime(s('r', { status: 'running', createdAt: at(42) }), NOW)).toBe('for 42 min');
    expect(sessionTime(s('w', { status: 'waiting', lastActivityAt: at(3) }), NOW)).toBe('waiting 3 min');
    expect(sessionTime(s('i', { lastActivityAt: at(130) }), NOW)).toBe('active 2 h 10 m ago');
    expect(sessionTime(s('j', { lastActivityAt: at(0.2) }), NOW)).toBe('active just now');
  });
});

const pacing = (accounts: Pacing['accounts']): Pacing => ({
  mode: 'advise',
  enabled: false,
  strategy: 'unknown',
  targetUsePercent: 95,
  providers: [],
  accounts,
  timeline: [],
});
const account = (provider: string, projected: number[], room?: number, over = false): Pacing['accounts'][number] => ({
  accountId: `${provider}-${projected.join('-')}`,
  machineId: 'm',
  provider,
  label: provider,
  state: 'unknown',
  targetAgents: 0,
  runningAgents: 1,
  windows: projected.map((p, i) => ({ id: `w${i}`, kind: i ? 'weekly' : 'session', label: i ? 'Weekly' : 'Session', usedPercent: 10, projectedPercentAtReset: p, onTrack: over ? 'over' : 'under' })),
  idleForecastMins: 0,
  ...(room !== undefined ? { headroomAgents: room } : {}),
});

describe('advice headline', () => {
  it('reads as advice: sessions, where each provider lands, and the room left', () => {
    const p = pacing([account('claudeAgent', [71, 82], 3), account('codex', [48, 61], 2)]);
    expect(adviceHeadline(p, 7).join(' · ')).toBe('7 sessions running · Claude on track for 82% by reset, Codex for 61% · room for about 5 more agents');
  });

  it('warns about a provider that runs out and leaves out unknown room', () => {
    const p = pacing([account('claudeAgent', [101], undefined, true)]);
    expect(adviceHeadline(p, 1)).toEqual(['1 session running', 'Claude runs out before reset']);
    expect(headroom(p)).toBeUndefined();
  });

  it('words headroom', () => {
    expect(headroomText(0)).toBe('no room for more agents');
    expect(headroomText(1)).toBe('room for about 1 more agent');
    expect(headroomText(undefined)).toBeNull();
  });
});
