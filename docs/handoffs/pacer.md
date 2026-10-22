# Subscription pacer handoff

Status: implemented and covered by local tests on 22 October 2026. **Not verified against real subscriptions**: no live Claude or Codex account has been paced, and the burn-rate priors are uncalibrated guesses. Not committed.

Justus asked for the factory to track how fast each subscription is used and adjust how many agents run so every limit is used up by its reset: one sub runs continuously and finishes its 5-hour session as it resets; five subs rotate, each burned in about an hour, so the first has reset by the time the fifth is done. The weekly limit must pace that rotation so weekly usage lands on target at the weekly reset, with no idle days at the end of the week.

## How it fits together

```text
T3 provider instance ──usageLimits──▶ t3-executor ──observe()──▶ account pool ──snapshot()──▶ node heartbeat
                                                                       ▲                          │ Account.plan, Account.usage
                                                     paced selection   │                          ▼
                     node ◀── heartbeat response: pacing.accounts[].targetAgents ◀── hub: samples, burn rates,
                                                                                      @perpeto/pacer plan, lease caps
```

| Piece | Where | What it does |
| --- | --- | --- |
| Usage feed | `packages/t3-executor/src/executor.js` | Reads the account instance's T3 `usageLimits` (which T3 merges from probes, Claude `rate_limit_event`s and Codex `account/rateLimits/updated`) when the instance is ready, after every root turn and every `usagePollMs` (2 min). Observes the windows and T3's plan label. |
| Pool | `packages/accounts` | Keeps `{ id, kind, label, usedPercent, resetsAt?, windowMins? }` per window, reports `plan` and `usage` in `snapshot()`, adds `paced` selection, `setPacing()` and `update()`. |
| Node | `apps/node/src/node.js`, `integrations/accounts.js` | Sends `plan`/`usage` in heartbeats, maps the response's allowances and owner edits to local account ids, defaults to `paced`. Reports `account.bound` with the public account id. |
| Hub | `apps/hub/src/pacing.js` | Stores fresh usage samples, integrates agent-minutes per account from leases, learns burn rates, runs the pacer, caps leases, publishes allowances, emits events, raises `under-burning`, nudges intake. |
| Pacer | `packages/pacer` | Pure plan function and burn-rate learner. No I/O, no clock. |

Contract changes are in the [architecture document](../architecture/README.md#subscription-pacing).

## Algorithm

Units: a burn rate `b` is percentage points of one window per agent-hour on that account. Agent-hours left in a window are `(target − used) / b`, with `target = targetUsePercent` (default 95, leaving margin for agents already running when an account reaches it).

**Burn-rate learning.** On each heartbeat the hub adds `running agents × elapsed time` to the account's agent-minutes (counting leases whose assignment reported `account.bound`, capped at ten minutes per step so hub downtime is not credited). When a fresh reading arrives (its `checkedAt` moves), `learnBurnRates` compares it with the window's anchor reading: at least 1 point and 3 agent-minutes gives an observation `Δused / Δagent-hours`; a full agent-hour with no visible change observes the small rate it implies; a rise with no agent time is someone else's use and re-anchors; a drop or a moved reset is a new window and re-anchors. Observations are clamped to 0.05–500 and smoothed with an EWMA (α 0.3, first observation taken as is). Until an account window has a learned rate the provider prior from `pacing.priors` applies.

**Fleet target per provider.** For each enabled account, a weekly-sustainable rate `L = min over long windows of agent-hours left / hours to reset` (an unstarted window uses its full length) and a session-sustainable rate `S = (target / b) / session hours`. The fleet target is `N = round(Σ min(L, S))`, raised to `minAgents`, then capped by `maxAgents`, machine slots (machines that own the provider's accounts) and ready work. `limitedBy` names the smallest term; `session` also covers the case where every account is at target or cooling right now. Two refinements:

- Hysteresis: a running count is kept while the sustainable rate stays within 0.75 of it, so a plan near a half agent does not flip on every recompute.
- Below one agent with the week binding, the fleet runs one agent while it is behind a straight line from each weekly window's start to the target at its reset, and stops half an agent-hour ahead of it. Idle time spreads across the week as short bursts instead of collecting at its start.

**Rotation (default).** Eligible accounts (active, not at target in any window, not cooling) are ordered: sessions already ticking first, soonest reset first, because their headroom expires; then fresh accounts by weekly urgency (most weekly agent-hours left per hour to reset), least recently used on ties; then accounts that have reported no usage. Agents fill that order, each account taking what it can absorb over one handover period (`handoverMins`, 15) and at least one. While the burner has plenty left it takes all `N`; as it nears the target it keeps fewer and the next account starts, so there is no gap. Machine slots are shared across providers and accounts.

**Parallel.** `N` is split in proportion to each account's agent-hours left, rounded down, and the leftovers go in rotation order, which keeps a small fleet on the same accounts.

**End-of-window sprint.** A ticking session that resets within `sprintMins` (90) and would reset with headroom gets enough agents to finish it, if its weekly window has the agent-hours and the fleet's weekly-sustainable rate has rounded slack above `N`.

**Safety.** Cooling, disabled and invalid accounts get nothing. An account at target in any window gets nothing until that window resets; a long window at target, or any window at 100 %, shows as `exhausted`. A window observed at 100 % still cools the account through the existing signal path. Leases cap each machine's agents per paced provider at the sum of its accounts' targets; nothing raises a workflow or machine limit.

**Projection.** The pacer replays its own plan in 5-minute steps over the larger of the 10-hour horizon and the latest known reset (up to 8 days), starting sessions on first use and resetting windows when they expire. That gives `projectedPercentAtReset` (windows still open at the end are extended at their simulated pace), `onTrack` (within 3 points of the target is `on`), `idleForecastMins` and the 10-hour burn/rest timeline.

## Worked examples

All numbers come from running `plan()` with these inputs; the unit tests assert the same behaviour. Session rate 20 %/agent-hour, so one 5-hour session holds 4.75 agent-hours to 95 %.

**One subscription, weekly not binding.** `S = 4.75 / 5 = 0.95`, so `N = 1`. The plan burns 0:00–4:45, reaches 95 %, rests 15 minutes, and starts again at 5:00 when the session resets: always running, session used up at each reset.

**One subscription, weekly binding** (weekly 2.5 %/agent-hour, so the week holds 34 agent-hours from 10 % used). `L ≈ 0.2`, under one agent. The weekly window just started with 10 % already used, so the fleet is ahead of its straight line; it waits about 18 hours, then runs one agent for about 40 minutes every 3 hours. Weekly usage projects to 95 % at the reset. Sessions are not used up, which is correct: the week is the scarce limit.

**Five subscriptions, weekly not binding** (weekly 0.5 %/agent-hour). `Σ S = 4.75`, so `N = 5`, all on sub 1. Sub 1 burns 0:00–1:20 (fewer agents from 0:45 as it nears 95 %), sub 2 0:45–2:20, sub 3 1:40–3:15, sub 4 2:40–4:10, sub 5 3:35–5:10, and sub 1, reset at 5:00, starts again at 5:00. Something burns throughout the 10-hour horizon and every session projects to 95 %. Weekly windows project to 67 %, because five full sessions a day per sub cannot spend them before their reset in five days.

**Five subscriptions, weekly binding** (weekly 2.5 %/agent-hour, 10 % used, five days to reset). `Σ L ≈ 1.13`, so `N = 1`, `limitedBy: weekly`. The rotation stretches: one agent burns sub 1 for 4:45, then sub 2, and so on. Every weekly window projects to 93.5–95 % at its reset.

## Verification

Node 24.22.0, `source ~/.nvm/nvm.sh && nvm use 24`:

- `node --test packages/pacer/test/pacer.test.js`: 21 tests, covering the examples above, handover, weekly pacing and end-of-week ramp, sprint with and without weekly slack, safety states, starvation, per-machine and shared slots, parallel split, mid-rotation state, unpaced providers, min/max, learned rates, hysteresis, the weekly schedule rule, determinism, and burn-rate learning.
- `packages/accounts` (usage windows, plan, `update`, `paced` selection), `packages/t3-executor` (usage snapshot fed after a turn with a fake T3, 100 % window cools the account), `apps/node` (heartbeat usage, allowances drive selection, relayed edits), `apps/hub/test/pacing.test.js` (validation, samples, plan, heartbeat allowances, lease caps, settings idempotency and restart, `PATCH /accounts`, account binding and learning with an injected clock, `under-burning` and the intake nudge).
- Both seed scripts ran against throwaway hubs: the web seed's plan burns three Claude and two Codex agents (`limitedBy: weekly`); the Apple seed's is starved by work and shows `under` projections.

## Limits and open questions

- **Nothing live.** Real T3 usage snapshots, real rate-limit updates, real subscription burn rates and real rotations are unverified. The executor reads `usageLimits` from `server.getConfig`; whether T3 refreshes that snapshot often enough for pooled factory instances has not been observed.
- **Priors are guesses.** `claudeAgent` 20 %/agent-hour per session and 2.5 per week, `codex` 15 and 2. With these the weekly limit binds a five-sub Claude fleet to about one agent. Calibrate from the first real samples, or set `pacing.priors` per provider.
- **Learning is coarse.** Percentages are often whole numbers and refresh only after turns, so rates settle over several turns. Subagents, other T3 sessions or a person using the same subscription look like burn from our agents unless no agent time was recorded. Agents running on one account share one rate; model mix is not separated.
- **Agents are not stopped.** Lowering a target only stops new leases on that account; running assignments finish. The 95 % target and the 15-minute handover are the margin for that. Long assignments can overshoot.
- **Allowances can race.** The node's `paced` selection falls back to headroom when no account has free allowance, so a lease that beats a heartbeat can start a resting account's session early. Leases are capped per machine, which makes this rare.
- **Ready work is a count.** It does not know which work will appear next or how long items take. When starved, the hub raises `under-burning` and gives idle scheduled keep-open runs one improvement pass per `nudgeIntervalMs`; goal-sourced runs already ask for work whenever idle.
- **Provider terms.** Rotating consumer subscriptions may be restricted by provider terms (see the [accounts README](../../packages/accounts/README.md)). The pacer schedules work within observed limits; it does not bypass them.
- **Open question for Justus:** below one sustainable agent, the pacer spreads short bursts along a straight weekly line. Front-loading (run now, risk an idle end of week if estimates are high) and back-loading (wait, risk unused headroom if work dries up) are the alternatives. The straight line was chosen because it keeps the error small either way.
