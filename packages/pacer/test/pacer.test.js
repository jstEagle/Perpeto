import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, allowances, learnBurnRates, pacingSettings, PACING_DEFAULTS } from '../src/index.js';

const NOW = Date.parse('2026-10-22T00:00:00.000Z');
const at = minutes => new Date(NOW + minutes * 60_000).toISOString();
const session = (usedPercent = 0, resetMins) => ({ id: 'five_hour', kind: 'session', label: '5-hour', usedPercent, windowMins: 300, ...(resetMins !== undefined ? { resetsAt: at(resetMins) } : {}) });
const weekly = (usedPercent = 0, resetMins) => ({ id: 'seven_day', kind: 'weekly', label: 'Weekly', usedPercent, windowMins: 10080, ...(resetMins !== undefined ? { resetsAt: at(resetMins) } : {}) });
const account = (n, windows, extra = {}) => ({ accountId: `acct_${n}`, machineId: 'mch_a', provider: 'claudeAgent', label: `Sub ${n}`, status: 'active',
  usage: { checkedAt: at(0), windows }, ...extra });
// 20 % of a session per agent-hour: 4.75 agent-hours fill a session to 95 %. Weekly is generous unless a test says otherwise.
const roomy = { priors: { claudeAgent: { session: 20, weekly: 0.5 } } };
const tight = { priors: { claudeAgent: { session: 20, weekly: 2.5 } } };
const machines = (slots = 10) => [{ machineId: 'mch_a', slots, providers: ['claudeAgent', 'codex'] }];
const view = (result, id) => result.accounts.find(item => item.accountId === id);
const burns = (result, id) => result.timeline.filter(item => item.accountId === id && item.phase === 'burn');
const minutesOf = iso => (Date.parse(iso) - NOW) / 60_000;

/** True when some account burns at every point of the horizon. */
function alwaysBurning(result, horizon = 600) {
  const intervals = result.timeline.filter(item => item.phase === 'burn').map(item => [minutesOf(item.from), minutesOf(item.to)]).sort((a, b) => a[0] - b[0]);
  let covered = 0;
  for (const [from, to] of intervals) { if (from > covered) return false; covered = Math.max(covered, to); }
  return covered >= horizon;
}

test('one subscription with a 5-hour session runs continuously and uses the session up by its reset', () => {
  const result = plan({ now: NOW, settings: roomy, accounts: [account(1, [session()])], machines: machines(), readyWork: { claudeAgent: 10 } });
  const [fleet] = result.providers;
  assert.deepEqual({ ...fleet }, { provider: 'claudeAgent', targetAgents: 1, runningAgents: 0, slots: 10, readyWork: 10, limitedBy: 'session', starved: false, sustainableAgents: 1 });
  const sub = view(result, 'acct_1');
  assert.equal(sub.state, 'burning'); assert.equal(sub.targetAgents, 1);
  assert.equal(sub.windows[0].projectedPercentAtReset, 95); assert.equal(sub.windows[0].onTrack, 'on');
  const [first, second] = burns(result, 'acct_1');
  assert.equal(minutesOf(first.from), 0);
  assert.ok(minutesOf(first.to) >= 280 && minutesOf(first.to) <= 300, 'burns most of the window');
  // Fresh session clock: the window started at the first burn and the next burn begins as it resets.
  assert.equal(minutesOf(second.from), 300);
});

test('five subscriptions rotate about an hour each, never idle, and each session ends at the target', () => {
  const accounts = [1, 2, 3, 4, 5].map(n => account(n, [session(), weekly(10, 5 * 1440)]));
  const result = plan({ now: NOW, settings: roomy, accounts, machines: machines(), readyWork: { claudeAgent: 20 } });
  assert.equal(result.providers[0].targetAgents, 5);
  assert.deepEqual(result.accounts.map(item => [item.accountId, item.state, item.targetAgents]),
    [['acct_1', 'burning', 5], ['acct_2', 'next', 0], ['acct_3', 'resting', 0], ['acct_4', 'resting', 0], ['acct_5', 'resting', 0]]);
  // Staggered starts roughly an hour apart, and sub 1 starts again once its own session has reset at 5 h.
  const starts = [1, 2, 3, 4, 5].map(n => minutesOf(burns(result, `acct_${n}`)[0].from));
  for (let index = 1; index < 5; index++) assert.ok(starts[index] - starts[index - 1] >= 40 && starts[index] - starts[index - 1] <= 80, `stagger ${starts}`);
  assert.equal(minutesOf(burns(result, 'acct_1')[1].from), 300);
  assert.ok(alwaysBurning(result), 'no downtime across the horizon');
  for (const item of result.accounts) {
    assert.equal(item.windows[0].projectedPercentAtReset, 95, `${item.accountId} session`);
    assert.equal(item.idleForecastMins, 0);
  }
});

test('the next account starts before the burning one reaches its target', () => {
  // Sub 1 is nearly done: 0.25 agent-hours left at 20 %/agent-hour, one agent for one 15-minute handover period.
  const accounts = [account(1, [session(90, 200)]), account(2, [session()])];
  const result = plan({ now: NOW, settings: roomy, accounts, machines: machines(), readyWork: { claudeAgent: 5 }, running: { acct_1: 2 } });
  assert.equal(result.providers[0].targetAgents, 2);
  assert.equal(view(result, 'acct_1').targetAgents, 1, 'burner keeps what it can absorb over one handover period');
  assert.equal(view(result, 'acct_1').state, 'burning');
  assert.ok(view(result, 'acct_2').targetAgents >= 1, 'next account already started');
  assert.equal(view(result, 'acct_1').targetAgents + view(result, 'acct_2').targetAgents, result.providers[0].targetAgents);
});

test('a binding weekly limit slows the fleet so each week lands at the target at its reset', () => {
  const accounts = [1, 2, 3, 4, 5].map(n => account(n, [session(), weekly(10, 5 * 1440)]));
  const result = plan({ now: NOW, settings: tight, accounts, machines: machines(), readyWork: { claudeAgent: 20 } });
  const [fleet] = result.providers;
  assert.equal(fleet.limitedBy, 'weekly');
  assert.ok(fleet.targetAgents < 5, 'slower than the session-bound rotation');
  assert.ok(alwaysBurning(result), 'still no idle gap while weekly headroom remains');
  for (const item of result.accounts) {
    const week = item.windows.find(window => window.kind === 'weekly');
    assert.ok(Math.abs(week.projectedPercentAtReset - 95) <= 3, `${item.accountId} weekly ${week.projectedPercentAtReset}`);
    assert.equal(week.onTrack, 'on');
  }
});

test('weekly headroom near its reset raises the fleet so it is not wasted', () => {
  // 40 points of weekly left with 10 hours to go: the end-of-week sprint needs more than one agent.
  const accounts = [account(1, [session(), weekly(55, 600)])];
  const relaxed = plan({ now: NOW, settings: tight, accounts: [account(1, [session(), weekly(55, 5000)])], machines: machines(), readyWork: { claudeAgent: 10 } });
  const late = plan({ now: NOW, settings: tight, accounts, machines: machines(), readyWork: { claudeAgent: 10 } });
  assert.ok(late.providers[0].targetAgents > relaxed.providers[0].targetAgents, `${late.providers[0].targetAgents} vs ${relaxed.providers[0].targetAgents}`);
});

test('end-of-window sprint finishes a ticking session when weekly slack allows, and not when weekly binds', () => {
  // Sub 1 burns with headroom; sub 2's session resets in 30 min with 55 points unused.
  const accounts = [account(1, [session(10, 280), weekly(0, 9000)]), account(2, [session(40, 30), weekly(0, 9000)])];
  const result = plan({ now: NOW, settings: { priors: { claudeAgent: { session: 20, weekly: 0.1 } } }, accounts, machines: machines(20), readyWork: { claudeAgent: 20 } });
  assert.equal(result.providers[0].targetAgents > 2, true);
  const sprinting = view(result, 'acct_2');
  // 2.75 agent-hours in 0.5 h: six agents, above the steady fleet target of two.
  assert.ok(sprinting.targetAgents >= 6, `sprint target ${sprinting.targetAgents}`);
  assert.equal(sprinting.windows[0].onTrack, 'on');
  const bound = plan({ now: NOW, settings: { priors: { claudeAgent: { session: 20, weekly: 30 } } }, accounts, machines: machines(20), readyWork: { claudeAgent: 20 } });
  assert.ok(view(bound, 'acct_2').targetAgents < 6, 'no sprint without weekly slack');
});

test('never schedules into cooling, disabled, invalid or exhausted accounts', () => {
  const accounts = [
    account(1, [session(20, 100)], { status: 'cooling', cooldownUntil: at(100) }),
    account(2, [session(10, 100)], { status: 'disabled' }),
    account(3, [session(10, 100)], { status: 'invalid' }),
    account(4, [session(99, 100)]),
    account(5, [session(10, 100), weekly(95, 3000)]),
    account(6, [session(100, 100)]),
    account(7, [session()]),
  ];
  const result = plan({ now: NOW, settings: roomy, accounts, machines: machines(), readyWork: { claudeAgent: 10 } });
  assert.deepEqual(result.accounts.map(item => [item.accountId, item.state, item.targetAgents]), [
    ['acct_1', 'cooling', 0], ['acct_2', 'resting', 0], ['acct_3', 'resting', 0], ['acct_4', 'resting', 0],
    ['acct_5', 'exhausted', 0], ['acct_6', 'exhausted', 0], ['acct_7', 'burning', result.providers[0].targetAgents]]);
  assert.equal(view(result, 'acct_2').status, 'disabled');
  assert.ok(!result.timeline.some(item => ['acct_2', 'acct_3'].includes(item.accountId)));
  // The cooling account rejoins after its cooldown ends.
  assert.ok(burns(result, 'acct_1').some(item => minutesOf(item.from) >= 100));
  assert.equal(view(result, 'acct_4').windows[0].onTrack, 'over');
});

test('every account at its target leaves the fleet idle until the next reset, limited by session', () => {
  const result = plan({ now: NOW, settings: roomy, accounts: [account(1, [session(95, 60)])], machines: machines(), readyWork: { claudeAgent: 4 } });
  assert.equal(result.providers[0].targetAgents, 0); assert.equal(result.providers[0].limitedBy, 'session');
  assert.equal(minutesOf(burns(result, 'acct_1')[0].from), 60);
});

test('too little ready work starves the fleet and caps it at the work available', () => {
  const accounts = [1, 2, 3, 4, 5].map(n => account(n, [session()]));
  const result = plan({ now: NOW, settings: roomy, accounts, machines: machines(), readyWork: { claudeAgent: 2 } });
  assert.deepEqual({ targetAgents: result.providers[0].targetAgents, limitedBy: result.providers[0].limitedBy, starved: result.providers[0].starved },
    { targetAgents: 2, limitedBy: 'work', starved: true });
  assert.equal(result.providers[0].sustainableAgents, 5);
  const idle = plan({ now: NOW, settings: roomy, accounts, machines: machines() });
  assert.equal(idle.providers[0].targetAgents, 0); assert.equal(idle.providers[0].starved, true);
});

test('machine slots cap each machine, spilling the rotation to an account on another machine', () => {
  const accounts = [account(1, [session()]), account(2, [session()], { machineId: 'mch_b' })];
  const result = plan({ now: NOW, settings: { priors: { claudeAgent: { session: 10, weekly: 0.1 } } }, accounts,
    machines: [{ machineId: 'mch_a', slots: 3 }, { machineId: 'mch_b', slots: 4 }], readyWork: { claudeAgent: 20 } });
  // Two sessions of 9.5 agent-hours per 5 h sustain about 4 agents; three fit on machine A.
  assert.equal(result.providers[0].slots, 7);
  assert.equal(view(result, 'acct_1').targetAgents, 3); assert.equal(view(result, 'acct_2').targetAgents, 1);
  const offline = plan({ now: NOW, settings: roomy, accounts, machines: [{ machineId: 'mch_a', slots: 3, online: false }, { machineId: 'mch_b', slots: 4 }], readyWork: { claudeAgent: 20 } });
  assert.equal(view(offline, 'acct_1').targetAgents, 0);
});

test('slots shared by two providers on one machine are not double-booked', () => {
  const accounts = [account(1, [session()]), { ...account(2, [session()]), provider: 'codex' }];
  const result = plan({ now: NOW, settings: { priors: { claudeAgent: { session: 2, weekly: 0.1 }, codex: { session: 2, weekly: 0.1 } } }, accounts,
    machines: machines(6), readyWork: { claudeAgent: 20, codex: 20 } });
  assert.equal(result.providers.reduce((sum, item) => sum + item.targetAgents, 0), 6);
});

test('the parallel strategy spreads the fleet across accounts by headroom', () => {
  const accounts = [account(1, [session(0, 200)]), account(2, [session(50, 100)]), account(3, [session(80, 50)])];
  const result = plan({ now: NOW, settings: { ...roomy, strategy: 'parallel', minAgents: 6 }, accounts, machines: machines(), readyWork: { claudeAgent: 6 } });
  assert.equal(result.strategy, 'parallel');
  const targets = accounts.map(item => view(result, item.accountId).targetAgents);
  assert.equal(targets.reduce((a, b) => a + b, 0), 6);
  assert.ok(targets[0] > targets[1] && targets[1] >= targets[2] && targets[2] >= 1, `${targets}`);
});

test('mid-rotation state: the ticking session burns first and a fresh account is next', () => {
  const accounts = [
    account(1, [session(95, 180), weekly(40, 4000)]),
    account(2, [session(50, 280), weekly(30, 4000)]),
    account(3, [session(), weekly(20, 4000)]),
    account(4, [session(), weekly(25, 4000)]),
  ];
  const result = plan({ now: NOW, settings: roomy, accounts, machines: machines(), readyWork: { claudeAgent: 10 }, running: { acct_2: 3 } });
  assert.equal(view(result, 'acct_1').state, 'resting');
  assert.equal(view(result, 'acct_2').state, 'burning');
  assert.equal(view(result, 'acct_2').runningAgents, 3);
  assert.equal(view(result, 'acct_3').state, 'next', 'the account with the most weekly headroom per hour is next');
  assert.equal(result.providers[0].runningAgents, 3);
  assert.deepEqual(allowances(result), Object.fromEntries(result.accounts.map(item => [item.accountId, { targetAgents: item.targetAgents }])));
});

test('providers without usage are not paced, and unknown accounts in a paced provider use the prior', () => {
  const accounts = [{ ...account(1, []), provider: 'codex', usage: undefined }, account(2, [session(95, 60)]), { ...account(3, []), usage: undefined }];
  const result = plan({ now: NOW, settings: roomy, accounts, machines: machines(), readyWork: { claudeAgent: 3, codex: 3 } });
  assert.deepEqual(result.providers.map(item => item.provider), ['claudeAgent']);
  assert.equal(view(result, 'acct_1').state, 'unknown'); assert.equal(view(result, 'acct_1').targetAgents, 0);
  assert.equal(allowances(result).acct_1, undefined);
  assert.equal(view(result, 'acct_3').state, 'burning');
  assert.deepEqual(view(result, 'acct_3').windows, []);
});

test('minAgents and maxAgents clamp the fleet target', () => {
  const accounts = [1, 2, 3, 4, 5].map(n => account(n, [session()]));
  const capped = plan({ now: NOW, settings: { ...roomy, maxAgents: 2 }, accounts, machines: machines(), readyWork: { claudeAgent: 20 } });
  assert.equal(capped.providers[0].targetAgents, 2); assert.equal(capped.providers[0].limitedBy, 'slots');
  const floor = plan({ now: NOW, settings: { ...tight, minAgents: 3 }, accounts: accounts.map(item => ({ ...item, usage: { windows: [session(), weekly(10, 5000)] } })),
    machines: machines(), readyWork: { claudeAgent: 20 } });
  assert.equal(floor.providers[0].targetAgents, 3);
});

test('learned rates replace priors and are reported per account', () => {
  const accounts = [account(1, [session()])];
  const result = plan({ now: NOW, settings: roomy, accounts, rates: { acct_1: { five_hour: 47.5 } }, machines: machines(), readyWork: { claudeAgent: 10 } });
  // 95 points at 47.5 per agent-hour: two agent-hours, so the 5-hour session sustains 0.4 agents and rounds down.
  assert.equal(result.providers[0].targetAgents, 0);
  assert.equal(view(result, 'acct_1').burnPerAgentHour, 47.5);
  assert.equal(view(plan({ now: NOW, settings: roomy, accounts, machines: machines() }), 'acct_1').burnPerAgentHour, undefined);
});

test('hysteresis keeps the running count when the sustainable rate sits near a half agent', () => {
  // Two subscriptions with no weekly window sustaining 1.4 agents: started from 1 the fleet stays at 1, from 2 at 2.
  const accounts = [account(1, [{ ...session(), windowMins: 300 }]), account(2, [session()])];
  const settings = { priors: { claudeAgent: { session: 27 } } };
  assert.equal(plan({ now: NOW, settings, accounts, machines: machines(), readyWork: { claudeAgent: 5 }, running: { acct_1: 1 } }).providers[0].targetAgents, 1);
  assert.equal(plan({ now: NOW, settings, accounts, machines: machines(), readyWork: { claudeAgent: 5 }, running: { acct_1: 2 } }).providers[0].targetAgents, 2);
});

test('below one sustainable agent the fleet runs while behind its weekly schedule, spreading idle time across the week', () => {
  const settings = { priors: { claudeAgent: { session: 20, weekly: 2.5 } } };
  // Weekly started 2 days ago (5 days left): the straight line says 27 % by now.
  const behind = [account(1, [session(), weekly(10, 5 * 1440)])];
  const ahead = [account(1, [session(), weekly(40, 5 * 1440)])];
  assert.equal(plan({ now: NOW, settings, accounts: behind, machines: machines(), readyWork: { claudeAgent: 5 } }).providers[0].targetAgents, 1);
  assert.equal(plan({ now: NOW, settings, accounts: ahead, machines: machines(), readyWork: { claudeAgent: 5 } }).providers[0].targetAgents, 0);
  // Slightly ahead while running: keep going within half an agent-hour.
  const edge = [account(1, [session(), weekly(28, 5 * 1440)])];
  assert.equal(plan({ now: NOW, settings, accounts: edge, machines: machines(), readyWork: { claudeAgent: 5 }, running: { acct_1: 1 } }).providers[0].targetAgents, 1);
  assert.equal(plan({ now: NOW, settings, accounts: edge, machines: machines(), readyWork: { claudeAgent: 5 } }).providers[0].targetAgents, 0);
  // Over two days the bursts are spread out, not one block at the end, and the week still lands on target.
  const result = plan({ now: NOW, settings: { ...settings, horizonMins: 2880 }, accounts: behind, machines: machines(), readyWork: { claudeAgent: 5 } });
  const bursts = burns(result, 'acct_1');
  assert.ok(bursts.length >= 4, `${bursts.length} bursts`);
  assert.ok(minutesOf(bursts.at(-1).from) - minutesOf(bursts[0].from) > 1440, 'spread over more than a day');
  const week = view(result, 'acct_1').windows.find(window => window.kind === 'weekly');
  assert.ok(Math.abs(week.projectedPercentAtReset - 95) <= 3, `weekly ${week.projectedPercentAtReset}`);
});

test('plans are deterministic, do not mutate input, and expired windows count as reset', () => {
  const accounts = [account(1, [session(90, -10), weekly(20, 3000)]), account(2, [session(30, 120)])];
  const input = { now: at(0), settings: roomy, accounts, machines: machines(), readyWork: { claudeAgent: 6 } };
  const before = structuredClone(input);
  const first = plan(input); const second = plan(structuredClone(input));
  assert.deepEqual(first, second); assert.deepEqual(input, before);
  const expired = view(first, 'acct_1');
  assert.equal(expired.windows[0].usedPercent, 90); assert.equal(expired.windows[0].resetsAt, undefined);
  assert.notEqual(expired.state, 'resting');
  for (const item of first.timeline) assert.ok(item.from < item.to && minutesOf(item.to) <= 600);
  assert.throws(() => plan({ ...input, now: 'nope' }));
  assert.throws(() => plan({ ...input, settings: { strategy: 'greedy' } }));
});

test('settings merge priors per provider over the defaults', () => {
  const settings = pacingSettings({ targetUsePercent: 90, priors: { codex: { session: 9 } } });
  assert.equal(settings.targetUsePercent, 90); assert.equal(settings.priors.codex.session, 9);
  assert.equal(settings.priors.codex.weekly, PACING_DEFAULTS.priors.codex.weekly);
  assert.equal(settings.priors.claudeAgent.session, PACING_DEFAULTS.priors.claudeAgent.session);
});

test('burn-rate learning: accumulates sparse samples, ignores resets and outside usage, then smooths', () => {
  let state = learnBurnRates(null, { at: 0, agentMinutes: 0, windows: [{ id: 's', usedPercent: 10, resetsAt: at(300) }] });
  assert.deepEqual(state.rates, {});
  // No change yet and little agent time: keep the anchor.
  state = learnBurnRates(state, { at: 1, agentMinutes: 2, windows: [{ id: 's', usedPercent: 10, resetsAt: at(300) }] });
  assert.equal(state.anchors.s.agentMinutes, 0);
  // 10 points over 30 agent-minutes: 20 per agent-hour.
  state = learnBurnRates(state, { at: 2, agentMinutes: 30, windows: [{ id: 's', usedPercent: 20, resetsAt: at(300) }] });
  assert.deepEqual(state.rates.s, { perAgentHour: 20, samples: 1 });
  // 10 points over 15 agent-minutes observes 40; EWMA with alpha 0.3 moves to 26.
  state = learnBurnRates(state, { at: 3, agentMinutes: 45, windows: [{ id: 's', usedPercent: 30, resetsAt: at(300) }] });
  assert.equal(Math.round(state.rates.s.perAgentHour * 100) / 100, 26); assert.equal(state.rates.s.samples, 2);
  // A reset re-anchors without learning.
  state = learnBurnRates(state, { at: 4, agentMinutes: 60, windows: [{ id: 's', usedPercent: 0, resetsAt: at(600) }] });
  assert.equal(state.rates.s.samples, 2); assert.equal(state.anchors.s.usedPercent, 0);
  // Usage with no agent time on this account (someone else used it) re-anchors without learning.
  state = learnBurnRates(state, { at: 5, agentMinutes: 60, windows: [{ id: 's', usedPercent: 8, resetsAt: at(600) }] });
  assert.equal(state.rates.s.samples, 2); assert.equal(state.anchors.s.usedPercent, 8);
  // A full agent-hour without a visible change lowers the rate toward the floor.
  state = learnBurnRates(state, { at: 6, agentMinutes: 120, windows: [{ id: 's', usedPercent: 8.5, resetsAt: at(600) }] });
  assert.equal(state.rates.s.samples, 3); assert.ok(state.rates.s.perAgentHour < 26);
});
