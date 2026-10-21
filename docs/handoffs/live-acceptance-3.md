# Live acceptance run 3

21 October 2026, branch `t3/7eafead4` from main `eb317eb`. Not pushed or merged.

**Result: conflict recovery, touches serialization and the goal-intake budget worked live on the first attempt; the mid-turn message wake-up did not, until a one-line executor fix.** Every agent turn was Codex. A Claude role reports `blocked` without spending a turn. Two integration bugs were fixed with tests in separate commits; three smaller findings are reported.

| | Result |
| --- | --- |
| Harness turns | **11 Codex turns** of 25: builder 5, rebase 1, reviewer 5. All `gpt-6.1-sol`, `reasoningEffort: low`. One Claude assignment `blocked` with no turn |
| Wall clock | Setup 07:05:22Z, last run completed 07:41:16, processes stopped 07:41:53 (**about 37 min**) |
| Tokens, three Codex runs (`/usage?runId&groupBy=role`) | 273,798 uncached input, 8,526 output, 472,064 cache read, 0 cache write. `costUsd` 0 (subscription) |
| Merged code | `main` at `de46bfa` (five squash merges on `d111e18`), fresh clone: `npm ci` and `npm test` pass, **17 of 17** |
| Fixes | `23ab4d1` concurrent Codex home link race, `2b743e3` mid-turn steer rejected by T3 |

## Setup

Same shape as [run 2](live-acceptance-2.md#setup), under `/tmp/perpeto-live3` on ports 4610 (T3) and 4620 (hub). `~/.perpeto`, `~/.claude`, the normal T3 state and the account pool were untouched; no logins were created, switched or imported. Codex used this Mac's existing ChatGPT Pro login through the factory `CODEX_HOME`. Claude was left without a factory login (no pool account, no `claudeLogin`).

```sh
source ~/.nvm/nvm.sh && nvm use 24          # Node v24.22.0
npm run setup && npm run build              # about 1 min, exit 0
R=/tmp/perpeto-live3
PATH="$PATH:$HOME/.nvm/versions/node/v22.15.0/bin" \
  node vendor/t3code/apps/server/dist/bin.mjs serve --base-dir $R/t3 --host 127.0.0.1 \
  --port 4610 --no-browser --auto-bootstrap-project-from-cwd=false
chmod 700 $R/cli
node apps/cli/bin/perpeto.js --dir $R/cli hub init --port 4620
#   hub.json: architectHarness {"provider":"codex","model":"gpt-6.1-sol","options":{"reasoningEffort":"low"}} (unused)
node apps/cli/bin/perpeto.js --dir $R/cli hub start
node apps/cli/bin/perpeto.js --dir $R/cli hub enroll-code
node apps/cli/bin/perpeto.js --dir $R/cli node join http://127.0.0.1:4620 --code-file $R/cli/enr_….secret --name live3-mac
#   node.json: capacity {"maxAgents":2,"maxJobs":1}, timing.renewMs 5000 (default 20000),
#   runtime.url "http://127.0.0.1:4610", runtime.t3 {"baseDir":"/tmp/perpeto-live3/t3"}, providers ["codex","claudeAgent"]
node apps/cli/bin/perpeto.js --dir $R/cli node start
```

`tiny-text` was re-cloned bare from run 1's seed at `d111e18`. Owner API calls used run 2's file-reading helper (`api.mjs`, `watch-run.mjs`) with the ports changed; the owner secret was never printed.

To save turns, the architect was skipped. Two user workflows were posted directly with `POST /projects/:id/workflows` and activated at version 1; both validated (`NO_RETRY` warning on the probe only).

```text
codex-build:  ideas → delivery-loop (ci-pass ≤2) → review-loop (review-pass ≤2) → builder (×2) → reviewer (×2)
              reviewer pass → ci (npm ci, npm test) → merge (serial squash, requires ci,
              onConflict: rebase, rebaseReview: changed) → shipped; exhaustion and onBlocked → triage (human)
claude-probe: ideas → builder (claudeAgent claude-sonnet-5-5) → shipped
```

There is no planner, so the conflict pair carries no `touches` at all, and the serialization pair declares them on its inputs (`input.added` items accept `touches`). The project has three active goals, each adding one helper to `src/index.js`.

## Claude role without a factory login

`POST /workflows/<probe>/runs` with one item, 07:06:26. The builder was leased, started and failed in the same second with `outcome: blocked`:

> Factory Claude agents need their own login. Enroll a Claude account in the pool, run CLAUDE_CONFIG_DIR="/tmp/perpeto-live3/t3/perpeto-agent-homes/claude-3728778eb068" claude auth login, or set runtime.t3.claudeLogin to "copy-once" to copy the current login into … once.

The item went `workitem.blocked` and waited in place (no `onBlocked`); the run was then stopped. The dedicated Claude home stayed empty, no Claude process ran and `~/.claude/projects` gained no directory for this run.

## Conflict recovery and the goal budget (one run)

`POST /workflows/<codex-build>/runs {"input":{"keepOpen":true,"source":"goals","budget":{"maxItemsPerDay":2}}}` at 07:06:58. Both admitted items edit `src/index.js`, `README.md` and a test, with no declared touches, so they built concurrently.

| Time (UTC) | `_1` slugify | `_2` truncate |
| --- | --- | --- |
| 07:06:58 | `input.requested` source goals, `limit: 2`; two items created, then **`budget.exhausted`** `maxItemsPerDay (2/2)`, third goal (wordCount) `requested: 1` | |
| 07:06:58 | Builder failed at once: "Executor failed." (fixed in `23ab4d1`, below); retry with 30 s backoff | Builder `abc7912` |
| 07:07:28 to 07:08:12 | Builder retry `deb210c`, reviewer `pass` | Reviewer `pass`, CI, merged as `2e9949d` at 07:08:12 |
| 07:08:32 | CI passed; merge entry **rejected, `rejectionKind: conflict`**: "Merge conflict with the speculative base." | |
| 07:08:32 to 07:09:04 | `workitem.moved` merge → builder with `step: 'rebase'`, `edgeId: null`; rebase assignment with `rebaseOf` the rejected entry. New head `a4a81a9` on the **same branch**, **`rebaseTouchedBeyondConflicts: false`** (executor-computed) | |
| 07:09:04 to 07:09:06 | `step: 'rebase'` moves builder → ci → merge, **no reviewer visit**; CI passed, merged as `73060e6` | |

Both items shipped 2 min 8 s after the run started. Afterwards the run stayed `running` with `intake.paused: true`, `reason {limit: maxItemsPerDay, used: 2, maximum: 2}` and `budgetUsage.tokens` 140,349 (input plus output, cache excluded). The third goal was never admitted. The run was stopped at cleanup. Hub events: 17 `workitem.moved`, 10 `gate.result`, 8 `merge-entry.updated`, 4 `loop.iteration`, 1 `input.requested`, 1 `budget.exhausted`, 1 `workitem.retried`. Lines in [run-goals-events.txt](live-acceptance-3/run-goals-events.txt).

The budget paused intake at admission, before any work ran, because the request's `limit` already used the full allowance. That matches the documented behaviour: an intake guard, not a cap on in-flight spend.

## Touches serialization

07:36:17, a finite manual run with two inputs, "Add reverseWords(text)" and "Add isPalindrome(text)", each with `touches: ["src/index.js","test","README.md"]`, builder concurrency 2.

| Time (UTC) | `_1` reverseWords | `_2` isPalindrome |
| --- | --- | --- |
| 07:36:17 | Builder leased; item `touchesClaimed: true` | `queued` at builder, not leased (capacity was free) |
| 07:36:55 to 07:37:14 | Reviewer `pass`, CI, merged as `7293cbb` | |
| 07:37:14 | | Builder leased in the same second, from the new base |
| 07:38:25 | | Reviewer `pass`, CI, merged as `64900f9` with **no conflict**. Run `completed` |

Lines in [run-touches-events.txt](live-acceptance-3/run-touches-events.txt).

## Messaging wake-up

**First attempt: not steered.** At 07:36:35, while `_1`'s builder turn ran (07:36:18 to 07:36:55), the owner sent:

```text
POST /api/v1/messaging/projects/<project>/channels/run-<run>/messages
{"senderRoleId":"owner","recipientRoleId":"builder","body":"Owner here, mid-turn: please acknowledge this message, reply to me (owner) in one sentence, and add the JSDoc line \"Requested by the owner mid-turn.\" to the function you are adding."}
```

It stayed `stored` for the rest of that turn and reached `_2`'s builder at 07:37:14 in its first prompt (`deliveredVia: prompt`). That agent acked at 07:37:36 and replied, and the JSDoc line is in `isPalindrome`. My first send had also failed with `400 Idempotency keys disagree`, because my helper sends a random `idempotency-key` header and the body carried a different key; the hub's error is correct.

**Root cause:** T3's `message.dispatch` schema requires `createdBy` and `creationSource`. The executor's inbox dispatch sent neither, the real runtime rejected every steer, and `deliverInbox` swallowed the error with `catch { return false; }`, so the hub re-offered the message on each renewal and nothing showed. The fake T3 in the wake-up test does not validate command schemas. Fixed in `2b743e3`; failed dispatches now also report an `inbox.dispatch_failed` progress event.

**Re-check after the fix**, node restarted, one item "Add countVowels(text)":

| Time (UTC) | Event |
| --- | --- |
| 07:40:06 | Builder `turn.started` |
| 07:40:17 | Owner message sent, receipt **`stored`**; `agent.messaged` |
| 07:40:21 | **`message.delivered`, `deliveredVia: steer`**, into the running turn |
| 07:40:42 | Agent acked (**`acked`**, note "Acknowledged; adding the requested JSDoc line.") and replied in the thread with its own credential: "I will add the requested JSDoc line to countVowels and complete the tests and commit on the assigned branch." |
| 07:40:54 | Builder turn finished; `countVowels` carries the JSDoc line |
| 07:41:16 | Reviewer `pass`, CI, merged as `de46bfa`. Run `completed` |

Delivery took 4 s with `renewMs: 5000`; at the default 20 s it waits up to one renewal. The agent's reply to the owner stays `stored` until the owner acks it, which is expected. Lines in [run-steer-events.txt](live-acceptance-3/run-steer-events.txt).

## Final Git state of `tiny-text.git`

```text
refs/heads/main                                           de46bfa  Perpeto merge mq_7adc…_1   (countVowels)
                                                          64900f9  Perpeto merge mq_e119…_2   (isPalindrome)
                                                          7293cbb  Perpeto merge mq_e119…_1   (reverseWords)
                                                          73060e6  Perpeto merge mq_5963…_3   (slugify, after rebase)
                                                          2e9949d  Perpeto merge mq_5963…_1   (truncate)
refs/heads/perpeto/wi_5963…_1   a4a81a9  Add slugify text helper with tests and documentation  (rebased, force-with-lease)
refs/heads/perpeto/wi_5963…_2   abc7912  Add truncate text helper with tests and documentation
refs/heads/perpeto/wi_e119…_1   f9de9c6  Add reverseWords text helper
refs/heads/perpeto/wi_e119…_2   f363156  Add isPalindrome text helper
refs/heads/perpeto/wi_7adc…_1   6634475  Add countVowels text helper
refs/perpeto/candidates/…       five candidates, one per merge
```

Agent commits are by `Perpeto Agent <agents@perpeto.local>`, merges by the delivery identity. Spot checks on a fresh clone: `slugify("Hello, World!")` → `hello-world`, `truncate("Hello world", 8)` → `Hello w…`, `reverseWords("a b c")` → `c b a`, `countVowels("Perpeto")` → `3`.

## Token usage per role

Fresh is uncached input plus output, as in runs 1 and 2. Run 3 figures come from `assignment.usage` events per assignment and agree with `/usage?groupBy=role`, which now works (run 2 got a 400).

| Role | Turns, run 3 | Fresh per turn, run 1 (Codex) | Fresh per turn, run 2 | Fresh per turn, run 3 (Codex) | Cache read per turn, run 3 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Builder | 5 | 31,173 | 13,845 (Claude) | 32,770 (18,220 to 39,458) | 51,226 |
| Builder, rebase step | 1 | not run | not run | 38,719 | 62,336 |
| Reviewer | 5 | 39,738 | 15,081 (Codex) | 15,951 (10,428 to 17,913) | 30,720 |

The Codex reviewer matches run 2, 60% below run 1. The Codex builder's fresh tokens did not fall against run 1, but its cache reads did, from about 170,000 per turn to 51,000, so total input per builder turn fell from about 201,000 to 84,000. Run 1's isolation fix halved the first call; the rest of a builder turn is the agent reading and running the code. A rebase costs about one build. This is low effort throughout; the tasks were not identical across runs.

## Fixed during the run

| Commit | Problem | Fix and evidence |
| --- | --- | --- |
| `23ab4d1` | Two assignments leased together on a fresh node both found no `auth.json` link in the factory Codex home; the second `symlink` threw `EEXIST` and the turn ended "Executor failed." | Accept an existing link to the same target. New test runs four concurrent first uses; it failed with `EEXIST` before the fix |
| `2b743e3` | Mid-turn messages were never steered (above) | Send `createdBy: 'system'`, `creationSource: 'server'`; report `inbox.dispatch_failed`. The wake-up test asserts both fields and failed before the fix. Live re-check steered in 4 s |

Checks on Node v24.22.0: `npm test -w @perpeto/t3-executor` 71 of 71 after each fix; repository `npm test` **558 of 558**, no failures or skips.

## Findings

1. **The fake T3 does not validate commands.** That is how the steer bug passed `wakeup.test.js`. Other executor commands built by hand (`run.interrupt`, decisions) could carry the same gap. Validating fake commands against `@t3tools/contracts` schemas, or one live smoke per command type, would catch it.
2. **The node hides executor exceptions.** `apps/node/src/node.js` turns any throw into "Executor failed." and writes nothing to `node.log`, which stayed empty. The `EEXIST` cause had to be found by reading code. Logging the error's code and a redacted message would have shown it at once. Not changed, since secrets can appear in executor errors and redaction needs a decision.
3. **Builder summaries are narration, not outcomes.** Every builder result summary was the agent's opening sentence ("I'll check the library's conventions…"), from `prose(body)` in `packages/t3-executor/src/results.js`. Reviewers' summaries are fine because their json block wins. The builder answer format could ask for a closing summary.
4. **Budget exhaustion is announced before any work runs.** Correct per the contract, but an operator sees `budget.exhausted` at the first second of a run. The event's `requested: 1` and the paused intake make it readable.

## Not verified

Claude factory roles (blocked by design), a rebase whose resolution touches more than the conflict (`true` path), CI failure after a rebase, budget recovery after UTC midnight (`budget.available`), `maxTokensPerDay` and `maxActiveItems`, steering at the default 20 s renewal, more than one machine, GitHub delivery, and web or Apple screens for these runs.

## Cleanup

The goals run and the probe run were stopped; the node, hub and T3 runtime were stopped. Ports 4610 and 4620 have no listeners and no `perpeto-live3` processes remain. `/tmp/perpeto-live3` holds only throwaway state and is left for inspection. Nothing was written under `~/.claude/projects` for this run.
