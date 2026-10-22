import { describe, expect, it } from 'vitest';
import { decodeSession, decodeSessionPage, decodeSessionsSummary } from './sessions';
import { decodeAccount, decodePacing } from './pacing';
import { DemoHub } from './demo';

const session = {
  id: 'ses_1',
  machineId: 'mch_1',
  machineName: 'mac-mini',
  threadId: 'thr_1',
  title: 'Fix the flaky test',
  project: { name: 'perpeto', path: '/Users/j/perpeto' },
  branch: 'fix/flake',
  provider: 'claudeAgent',
  providerInstanceId: 'claude-default',
  model: 'claude-opus-5-5',
  status: 'running',
  childCount: 2,
  createdAt: '2026-10-22T10:00:00Z',
  lastActivityAt: '2026-10-22T10:30:00Z',
  turns: 12,
  tokens: { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 100, reasoning: 50 },
};

describe('session decoding', () => {
  it('keeps every field of a well-formed session', () => {
    expect(decodeSession(session)).toEqual(session);
  });

  it('tolerates missing optional fields, string numbers and unknown statuses', () => {
    const s = decodeSession({ id: 'ses_2', machineId: 'm', status: 'compacting', turns: '7', tokens: { input: '12' }, createdAt: '2026-10-22T10:00:00Z' });
    expect(s).toMatchObject({ id: 'ses_2', machineName: 'm', threadId: 'ses_2', provider: 'unknown', status: 'unknown', turns: 7, childCount: 0, lastActivityAt: '2026-10-22T10:00:00Z' });
    expect(s?.tokens).toEqual({ input: 12, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    expect(s?.title).toBeUndefined();
    expect(s?.project).toBeUndefined();
  });

  it('drops entries without an id and reads a numeric cursor', () => {
    const page = decodeSessionPage({ sessions: [session, { title: 'no id' }, null, 'x'], nextCursor: 200 });
    expect(page.sessions.map((s) => s.id)).toEqual(['ses_1']);
    expect(page.nextCursor).toBe('200');
  });

  it('accepts a bare array and a project given as a name', () => {
    const page = decodeSessionPage([{ ...session, project: 'lumin-web' }]);
    expect(page.sessions[0].project).toEqual({ name: 'lumin-web' });
    expect(page.nextCursor).toBeUndefined();
  });
});

describe('summary decoding', () => {
  it('reads machines, totals and token groups', () => {
    const s = decodeSessionsSummary(
      {
        machines: [{ machineId: 'm1', name: 'mac-mini', online: true, observing: true, lastObservedAt: '2026-10-22T10:00:00Z', running: 2, waiting: 1, idle: 3 }],
        totals: { running: 2, waiting: 1, sessionsActive: 3 },
        tokens: {
          byProvider: [{ provider: 'claudeAgent', input: 10, output: 5, cacheRead: 1, cacheWrite: 0 }],
          byModel: [{ model: 'claude-opus-5-5', input: 10, output: 5 }],
          byMachine: [{ machineId: 'm1', input: 10, output: 5 }],
          series: [
            { at: '2026-10-22T11:00:00Z', input: 4, output: 1 },
            { at: '2026-10-22T10:00:00Z', input: 6, output: 4 },
            { at: 'not a time', input: 1, output: 1 },
          ],
        },
      },
      '24h',
    );
    expect(s.machines[0]).toMatchObject({ name: 'mac-mini', online: true, observing: true, running: 2 });
    expect(s.totals).toEqual({ running: 2, waiting: 1, sessionsActive: 3 });
    expect(s.tokens.byProvider[0]).toEqual({ key: 'claudeAgent', input: 10, output: 5, cacheRead: 1, cacheWrite: 0 });
    expect(s.tokens.byModel[0].key).toBe('claude-opus-5-5');
    expect(s.tokens.byMachine[0].key).toBe('m1');
    // Sorted oldest first, malformed points dropped.
    expect(s.tokens.series.map((p) => p.input)).toEqual([6, 4]);
  });

  it('adds up machine counts when totals are missing, and accepts an envelope', () => {
    const s = decodeSessionsSummary({ summary: { machines: [{ machineId: 'a', running: 1, waiting: 2 }, { machineId: 'b', running: '3' }] } }, '1h');
    expect(s.totals).toEqual({ running: 4, waiting: 2, sessionsActive: 6 });
    expect(s.machines[0]).toMatchObject({ name: 'a', online: false, observing: false });
    expect(s.tokens.series).toEqual([]);
  });
});

describe('observe-only accounts and advice pacing', () => {
  it('keeps the account source', () => {
    expect(decodeAccount({ id: 'a', provider: 'codex', label: 'ChatGPT Pro', source: 'observed' }).source).toBe('observed');
    expect(decodeAccount({ id: 'a', provider: 'codex', label: 'x', source: '' }).source).toBeUndefined();
  });

  it('decodes advise mode and headroom; old hubs enforce; unknown modes are advice', () => {
    const advise = decodePacing({ mode: 'advise', accounts: [{ accountId: 'a', windows: [], headroomAgents: '3' }] });
    expect(advise.mode).toBe('advise');
    expect(advise.accounts[0].headroomAgents).toBe(3);
    expect(decodePacing({ enabled: true }).mode).toBe('enforce');
    expect(decodePacing({ mode: 'enforce' }).mode).toBe('enforce');
    expect(decodePacing({ mode: 'suggest' }).mode).toBe('advise');
    expect(decodePacing({ accounts: [{ accountId: 'a', windows: [] }] }).accounts[0].headroomAgents).toBeUndefined();
  });
});

describe('observe-only demo', () => {
  const NOW = Date.parse('2026-10-22T15:00:00Z');

  it('has no projects, two Macs, 13 sessions with 4 running and 1 waiting, and advice pacing', async () => {
    const hub = new DemoHub(NOW, 'observe');
    expect(await hub.listProjects()).toEqual([]);
    expect((await hub.listMachines()).map((m) => m.name)).toEqual(['justus-macbook-pro', 'mac-mini']);
    const page = await hub.listSessions();
    expect(page.sessions).toHaveLength(13);
    expect(page.sessions.filter((s) => s.status === 'running')).toHaveLength(4);
    expect(page.sessions.filter((s) => s.status === 'waiting')).toHaveLength(1);
    expect(page.sessions.filter((s) => s.parentThreadId)).toHaveLength(3);
    const accounts = await hub.listAccounts();
    expect(accounts.map((a) => [a.label, a.source])).toEqual([
      ['Claude Max', 'observed'],
      ['ChatGPT Pro', 'observed'],
    ]);
    const pacing = await hub.pacing();
    expect(pacing.mode).toBe('advise');
    await expect(hub.updatePacing({ enabled: true })).rejects.toThrow(/only observes/);
    const summary = await hub.sessionsSummary('24h');
    expect(summary.totals).toEqual({ running: 4, waiting: 1, sessionsActive: 5 });
    expect(summary.tokens.series).toHaveLength(24);
  });

  it('pages sessions with a cursor and filters them', async () => {
    const hub = new DemoHub(NOW, 'observe');
    const first = await hub.listSessions({ limit: 5 });
    expect(first.sessions).toHaveLength(5);
    const second = await hub.listSessions({ limit: 5, cursor: first.nextCursor });
    expect(second.sessions[0].id).not.toBe(first.sessions[0].id);
    expect((await hub.listSessions({ status: 'error' })).sessions.map((s) => s.id)).toEqual(['ses_obs05']);
  });

  it('keeps the full demo enforcing, with sessions on its own machines', async () => {
    const hub = new DemoHub(NOW);
    expect((await hub.pacing()).mode).toBe('enforce');
    const names = new Set((await hub.listSessions()).sessions.map((s) => s.machineName));
    expect([...names].sort()).toEqual(['build-linux', 'studio-mac']);
  });
});
