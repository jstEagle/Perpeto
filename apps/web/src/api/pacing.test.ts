import { describe, expect, it } from 'vitest';
import { decodeAccount, decodePacing, looksLikePacing } from './pacing';
import { DemoHub } from './demo';
import { accountTrack, limitedByText, meterWindows, pacingHeadline, projectionText, resetsIn, span, timelineLayout } from '../lib/pacing';
import type { Pacing, PacingAccount } from './types';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const at = (mins: number) => new Date(NOW + mins * 60_000).toISOString();

const hubPacing = {
  enabled: true,
  strategy: 'rotation',
  targetUsePercent: 95,
  updatedAt: at(-1),
  providers: [
    { provider: 'claudeAgent', targetAgents: 3, runningAgents: 3, slots: 8, readyWork: 9, limitedBy: 'session', starved: false },
    { provider: 'codex', targetAgents: 2, runningAgents: 1, slots: 8, readyWork: 0, limitedBy: 'quota-v2', starved: true },
  ],
  accounts: [
    {
      accountId: 'acct_1',
      machineId: 'mch_1',
      provider: 'claudeAgent',
      label: 'Claude · build',
      plan: 'Max 20x',
      state: 'burning',
      targetAgents: 3,
      runningAgents: 3,
      burnPerAgentHour: 31.5,
      windows: [
        { id: 'weekly', kind: 'weekly', label: 'Weekly', usedPercent: 62, resetsAt: at(4000), projectedPercentAtReset: 95, onTrack: 'on' },
        { id: 'session', kind: 'session', label: 'Session', usedPercent: 55, resetsAt: at(265), projectedPercentAtReset: 95, onTrack: 'on' },
      ],
      idleForecastMins: 0,
    },
    { accountId: 'acct_2', machineId: 'mch_1', provider: 'claudeAgent', label: 'Claude · spare', state: 'hibernating', windows: [{ kind: 'fortnightly', usedPercent: 10, onTrack: 'maybe' }] },
    { label: 'no id, dropped' },
  ],
  timeline: [
    { accountId: 'acct_1', from: at(-35), to: at(25), phase: 'burn' },
    { accountId: 'acct_1', from: at(25), to: at(265), phase: 'rest' },
    { accountId: 'acct_2', from: at(25), to: at(85), phase: 'burn' },
    { accountId: 'acct_2', from: at(85), to: at(25), phase: 'burn' },
    { accountId: 'acct_2', from: at(85), to: at(100), phase: 'idle' },
  ],
};

describe('pacing decoding', () => {
  it('reads the contract and keeps unknown values neutral', () => {
    const p = decodePacing(hubPacing);
    expect(p.enabled).toBe(true);
    expect(p.strategy).toBe('rotation');
    expect(p.providers[1]).toMatchObject({ provider: 'codex', limitedBy: 'unknown', starved: true });
    expect(p.accounts).toHaveLength(2);
    expect(p.accounts[1]).toMatchObject({ state: 'unknown', targetAgents: 0, runningAgents: 0, idleForecastMins: 0 });
    expect(p.accounts[1].windows[0]).toMatchObject({ id: 'other', kind: 'other', label: 'Limit', usedPercent: 10, projectedPercentAtReset: 10, onTrack: 'unknown' });
    // Reversed and unknown phases are dropped.
    expect(p.timeline).toHaveLength(3);
  });

  it('tolerates an envelope, missing fields and junk', () => {
    expect(decodePacing({ pacing: { enabled: true, strategy: 'zigzag', targetUsePercent: '90' } })).toMatchObject({ enabled: true, strategy: 'unknown', targetUsePercent: 90, providers: [], accounts: [], timeline: [] });
    expect(decodePacing(null)).toMatchObject({ enabled: false, targetUsePercent: 95, accounts: [] });
    expect(decodePacing({ targetUsePercent: 400 }).targetUsePercent).toBe(100);
    expect(decodePacing({ minAgents: 1, maxAgents: null })).toMatchObject({ minAgents: 1, maxAgents: null });
  });

  it('tells pacing state from an acknowledgement', () => {
    expect(looksLikePacing(hubPacing)).toBe(true);
    expect(looksLikePacing({ pacing: { enabled: false } })).toBe(true);
    expect(looksLikePacing({ ok: true })).toBe(false);
    expect(looksLikePacing(undefined)).toBe(false);
  });

  it('decodes account plan and usage windows, dropping malformed ones', () => {
    const a = decodeAccount({
      id: 'acct_1',
      machineId: 'mch_1',
      provider: 'claudeAgent',
      label: 'Claude · build',
      status: 'active',
      plan: '',
      usage: { checkedAt: 'not a date', windows: [{ id: 'session', kind: 'session', label: 'Session', usedPercent: 55, resetsAt: at(30), windowMins: 300 }, { kind: 'weekly' }, 'junk'] },
    });
    expect(a.plan).toBeUndefined();
    expect(a.usage?.checkedAt).toBeUndefined();
    expect(a.usage?.windows).toEqual([{ id: 'session', kind: 'session', label: 'Session', usedPercent: 55, resetsAt: at(30), windowMins: 300 }]);
    expect(decodeAccount({ id: 'a', label: 'x', usage: 'n/a' }).usage).toBeUndefined();
  });
});

describe('pacing formatting', () => {
  it('says spans the way people do', () => {
    expect(span(20_000)).toBe('under a minute');
    expect(span(38 * 60_000)).toBe('38 min');
    expect(span((2 * 60 + 14) * 60_000)).toBe('2 h 14 m');
    expect(span(3 * 3_600_000)).toBe('3 h');
    expect(span((3 * 24 + 4) * 3_600_000)).toBe('3 d 4 h');
    expect(resetsIn(at(134), NOW)).toBe('resets in 2 h 14 m');
    expect(resetsIn(at(-5), NOW)).toBe('reset due');
    expect(resetsIn(undefined, NOW)).toBeNull();
  });

  it('writes the headline from what pacing reports', () => {
    const p = decodePacing(hubPacing);
    expect(pacingHeadline(p).lead).toBe('4 agents running');
    expect(pacingHeadline(p).detail).toBe('on track to use 95% of every subscription by its reset');
    const under = structuredClone(p);
    under.accounts[1].windows[0].onTrack = 'under';
    expect(pacingHeadline(under).detail).toBe('1 of 2 subscriptions on track for 95% by their reset');
    const over = structuredClone(p);
    over.accounts[0].windows[1].onTrack = 'over';
    expect(pacingHeadline(over).detail).toBe('1 subscription will run out before its reset');
    expect(pacingHeadline({ ...p, enabled: false }).detail).toMatch(/pacing is off/);
    expect(pacingHeadline({ ...p, accounts: [] }).detail).toMatch(/no subscription/);
  });

  it('judges a subscription by its binding window', () => {
    const acct = (tracks: string[]) => ({ windows: tracks.map((onTrack) => ({ onTrack })) }) as unknown as PacingAccount;
    expect(accountTrack(acct(['on', 'under']))).toBe('on');
    expect(accountTrack(acct(['under', 'under']))).toBe('under');
    expect(accountTrack(acct(['on', 'over']))).toBe('over');
    expect(accountTrack(acct([]))).toBe('unknown');
  });

  it('names what limits the pace', () => {
    const p = decodePacing(hubPacing);
    expect(limitedByText(p.providers[0])).toBe('Paced by session limits');
    expect(limitedByText({ ...p.providers[0], limitedBy: 'work', starved: true })).toBe('Not enough ready work');
    expect(limitedByText({ ...p.providers[0], limitedBy: 'slots', starved: true })).toBe('Not enough ready work, capped by machine slots');
  });

  it('merges heartbeat windows with the projection, session first', () => {
    const p = decodePacing(hubPacing);
    const account = decodeAccount({ id: 'acct_1', label: 'x', usage: { windows: [{ id: 'weekly', kind: 'weekly', usedPercent: 61 }, { id: 'session', kind: 'session', usedPercent: 54 }] } });
    const windows = meterWindows(account, p.accounts[0]);
    expect(windows.map((w) => [w.id, w.usedPercent, w.projectedPercentAtReset])).toEqual([
      ['session', 54, 95],
      ['weekly', 61, 95],
    ]);
    expect(projectionText(windows[0])).toBe('95% at reset');
    expect(projectionText({ ...windows[0], onTrack: 'over' })).toBe('runs out before reset');
    expect(projectionText({ id: 'x', label: 'x', usedPercent: 3 })).toBeNull();
    // Pacing windows the heartbeat has not carried yet still show.
    expect(meterWindows(decodeAccount({ id: 'acct_1', label: 'x' }), p.accounts[0]).map((w) => w.id)).toEqual(['session', 'weekly']);
  });
});

describe('pacing timeline', () => {
  it('places segments between an hour ago and ten hours ahead, ordered by next turn', () => {
    const p = decodePacing(hubPacing);
    const layout = timelineLayout(p, NOW, 10, 1);
    expect(layout.now).toBeCloseTo((60 / 660) * 100);
    const lanes = layout.groups[0].lanes;
    expect(lanes.map((l) => l.account.accountId)).toEqual(['acct_1', 'acct_2']);
    const burn = lanes[0].segments[0];
    expect(burn.left).toBeCloseTo((25 / 660) * 100);
    expect(burn.left + burn.width).toBeCloseTo((85 / 660) * 100);
    expect(layout.ticks.every((t) => t.at >= 0 && t.at <= 97)).toBe(true);
  });

  it('clips segments that run past the window', () => {
    const p: Pacing = { ...decodePacing(hubPacing), timeline: [{ accountId: 'acct_1', from: at(-300), to: at(900), phase: 'rest' }] };
    const seg = timelineLayout(p, NOW).groups[0].lanes[0].segments[0];
    expect(seg.left).toBe(0);
    expect(seg.width).toBe(100);
  });
});

describe('demo pacing', () => {
  it('rotates five Claude subscriptions with one burning and one next', async () => {
    const hub = new DemoHub(NOW);
    const p = await hub.pacing();
    const claude = p.accounts.filter((a) => a.provider === 'claudeAgent');
    expect(claude).toHaveLength(5);
    expect(claude.filter((a) => a.state === 'burning')).toHaveLength(1);
    expect(claude.filter((a) => a.state === 'next')).toHaveLength(1);
    expect(p.accounts.filter((a) => a.provider === 'codex')).toHaveLength(2);
    // Each Claude burn turn starts as the one before it ends.
    const burns = p.timeline.filter((s) => s.phase === 'burn' && p.accounts.find((a) => a.accountId === s.accountId)?.provider === 'claudeAgent').sort((a, b) => a.from.localeCompare(b.from));
    for (let i = 1; i < burns.length; i++) expect(burns[i].from).toBe(burns[i - 1].to);
    expect(pacingHeadline(p).lead).toBe('5 agents running');
  });

  it('applies settings and labels edited on the accounts screen', async () => {
    const hub = new DemoHub(NOW);
    const parallel = await hub.updatePacing({ strategy: 'parallel', targetUsePercent: 90 });
    expect(parallel.strategy).toBe('parallel');
    expect(parallel.accounts.every((a) => a.state === 'burning')).toBe(true);
    const off = await hub.updatePacing({ enabled: false });
    expect(off.timeline).toEqual([]);
    await expect(hub.updatePacing({ targetUsePercent: 20 })).rejects.toThrow(/between/);
    await hub.updateAccount('acct_c1', { label: 'Claude · main', plan: 'Max 5x' });
    const p = await hub.pacing();
    expect(p.accounts.find((a) => a.accountId === 'acct_c1')).toMatchObject({ label: 'Claude · main', plan: 'Max 5x' });
    await expect(hub.updateAccount('acct_c1', { label: ' ' })).rejects.toThrow(/label/);
  });
});
