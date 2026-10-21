# Live acceptance run 2

21 October 2026, branch `t3/e6092b2d` from main `4be1a64`. Not pushed or merged.

**Result: a mixed Claude and Codex factory run merged two concurrent work items, one of them through a forced escalation and two human decisions.** Claude factory agents ran without the operator's personal setup and committed as Perpeto Agent. Two account-level leaks remained; one is fixed in `3e6e919`, the other (the account email) is reported.

| | Result |
| --- | --- |
| Harness turns | 17 of 25: architect 2, run 13, one direct Claude probe, one executor live check |
| Roles | Architect, planner, builder, senior reviewer: Claude `claude-sonnet-5-5`. Reviewer: Codex `gpt-6.1-sol`, `reasoningEffort: low` |
| Wall clock | Setup 06:11Z, run 06:15:00 to 06:18:44 (**3 min 44 s**, including 38 s of human waits), processes stopped 06:24Z |
| Tokens, run (`/usage?runId`) | 74,944 uncached input, 10,673 output, 588,273 cache read, 92,603 cache write. `costUsd` 0 (subscriptions) |
| Merged code | `main` at `8ae54ce`, fresh clone: `npm ci` and `npm test` pass, 10 of 10 tests |
| Fixes | `3e6e919` executor: claude.ai connectors and auto memory off for Claude factory agents |

## Setup

Same shape as [run 1](live-acceptance-1.md#setup), under `/tmp/perpeto-live2` on ports 4510 (T3) and 4520 (hub). `~/.perpeto`, the normal T3 state and the account pool were untouched; no logins were created, switched or imported. T3 reported this Mac's existing Codex (ChatGPT Pro) and Claude Max logins `ready`.

```sh
source ~/.nvm/nvm.sh && nvm use 24          # Node v24.22.0
npm run setup && npm run build              # 21 s
R=/tmp/perpeto-live2
PATH="$PATH:$HOME/.nvm/versions/node/v22.15.0/bin" \
  node vendor/t3code/apps/server/dist/bin.mjs serve --base-dir $R/t3 --host 127.0.0.1 \
  --port 4510 --no-browser --auto-bootstrap-project-from-cwd=false
chmod 700 $R/cli
node apps/cli/bin/perpeto.js --dir $R/cli hub init --port 4520
#   hub.json: architectHarness {"provider":"claudeAgent","model":"claude-sonnet-5-5"}
node apps/cli/bin/perpeto.js --dir $R/cli hub start
node apps/cli/bin/perpeto.js --dir $R/cli hub enroll-code
node apps/cli/bin/perpeto.js --dir $R/cli node join http://127.0.0.1:4520 --code-file $R/cli/enr_….secret --name live2-mac
#   node.json: capacity {"maxAgents":2,"maxJobs":1}, runtime.url "http://127.0.0.1:4510",
#   runtime.t3 {"baseDir":"/tmp/perpeto-live2/t3"}, providers ["codex","claudeAgent"]
node apps/cli/bin/perpeto.js --dir $R/cli node start
```

Isolation used the defaults (`agentIsolation: factory`, identity `Perpeto Agent <agents@perpeto.local>`). The throwaway `tiny-text` repository was re-cloned bare from run 1's seed at `d111e18`. Owner API calls used run 1's file-reading helper scripts with the ports changed.

## The architect's workflow

The request named the harness per role, the escalation shape and two verbatim rubrics: the reviewer must fail any item that adds `truncate`, and so must the senior reviewer, so a person decides at triage.

| Attempt | Time | Outcome |
| --- | --- | --- |
| 1 | 06:13:38 to 06:14:11 | `workflow.architect.invalid`: `FLOW_CYCLE` "ci → triage → ci does not pass through a loop node." **My request caused it**: triage pass went to CI while CI exhausted to triage |
| 2 | 06:14:11 to 06:14:46 | Valid. The hub retried with the validation error; the architect dropped CI's `onExhausted` and kept everything else |

Version 1 was activated unedited. It applied the new defaults: retry 3 attempts with 30 s backoff on every agent node, 2 on CI, `onBlocked: triage` on both reviewers, `maxSubagents: 0` everywhere, and builder prompts that say there is no pull request to open on a local origin.

```text
ideas → planner (maxItems 2) → delivery-loop (ci-pass ≤2, exhausted → triage)
  → review-loop (review-pass ≤2, exhausted → senior-reviewer) → builder (×2) → reviewer (×2)
reviewer pass → ci → merge (serial squash, requires ci) → shipped
senior-reviewer pass → ci, fail → triage; triage pass → ci, fail unwired
```

## The run

One input item, "Add slugify and truncate helpers". The planner split it into `_2` slugify and `_3` truncate.

| Time (UTC) | `_2` slugify | `_3` truncate |
| --- | --- | --- |
| 06:15:00 to 06:15:19 | Planner (Claude): two items | |
| 06:15:19 to 06:15:37 | **Builder** `404b1ad` | **Builder** `df46697`, concurrently |
| 06:15:36 to 06:15:58 | Reviewer (Codex) `pass` | Reviewer `fail` (forced), concurrently |
| 06:15:58 to 06:16:00 | CI passed; merged as `d7dc849` | |
| 06:15:55 to 06:16:20 | | Builder rework (no change needed), reviewer `fail` again |
| 06:16:20 | | `workitem.escalated` review-loop → senior-reviewer, `loop_limit` 2 of 2 |
| 06:16:37 | | Senior reviewer `fail` → triage, `human.requested` `hd_…_1` |
| 06:17:07 | | `perpeto hub decide wi_…_3 pass --note …` → `{"accepted":true}` |
| 06:17:07 to 06:17:08 | | CI passed at `df46697`; merge queue **rejected: "Merge conflict with the speculative base."** |
| 06:17:08 to 06:18:34 | | Delivery loop 2: builder merged main (`8bc6d29`), two forced review failures, escalation, senior `fail`, `hd_…_2` |
| 06:18:42 to 06:18:44 | | Second `hub decide … pass`; CI at `8bc6d29`; speculative job on `8ae54ce`; merged. Run `completed` |

The hub recorded 15 `gate.result`, 31 `workitem.moved`, 10 `loop.iteration`, 2 `workitem.escalated`, 2 `human.requested`, 2 `work-item.decision` and 8 `merge-entry.updated` events. Event lines are in [run-events.txt](live-acceptance-2/run-events.txt).

### Final Git state of `tiny-text.git`

```text
refs/heads/main                                           8ae54ce  Perpeto merge mq_…_3
refs/heads/perpeto/wi_278051bfb3cd4f8e804b0256635049b8_2  404b1ad  Add slugify helper with tests and README docs
refs/heads/perpeto/wi_278051bfb3cd4f8e804b0256635049b8_3  8bc6d29  Merge main into truncate branch
refs/perpeto/candidates/0b155183…                         d7dc849
refs/perpeto/candidates/857a0d46…                         8ae54ce
```

`main` is `d111e18` plus two squash merges by the delivery identity `Perpeto <factory@perpeto.invalid>`. Every agent commit (`404b1ad`, `df46697`, `8bc6d29`) has author and committer `Perpeto Agent <agents@perpeto.local>`. Spot checks: `slugify("Hello, world!")` → `hello-world`, `truncate("Hello world", 8)` → `"Hello w…"`, `truncate("hi", 8)` → `"hi"`.

## Claude-side isolation

Every Claude assignment reported `isolation.bound` on `perpeto_claudeAgent_75d49f6b52d8` with the Perpeto Agent identity. Claude Code writes its transcripts to `~/.claude/projects/<workspace path>/`, so all ten were inspected: 2 architect, 1 planner, 5 builder, 2 senior reviewer.

| Personal setup on this Mac | In factory transcripts |
| --- | --- |
| `~/.claude/CLAUDE.md` (messaging, todo list, name corrections) | Absent: no `Justus`, `Lumin`, `TODO.md` |
| `~/.claude/skills` (`messaging`, `clerk-*`) and 5 plugins (Figma, Sentry, Wyatt, …) | Absent. Skill list holds only the 14 bundled Claude Code skills |
| 5 user hooks, including a SessionStart hook that injects a Cooler identity | 0 hook attachments, no `Cooler` |
| User-scope MCP servers in `~/.claude.json` (posthog, railway, looksee, wyatt, cooler) | Absent. This was an open question after run 1 |
| T3 MCP tools and orchestration notes | Absent (zero-subagent roles) |
| **claude.ai account connector "Claude Docs"** with ~1,900 characters of instructions | **Present**, and in its pending list. Fixed in `3e6e919` |
| **Auto memory**: a `# Memory` system section, and an empty `memory/` dir created per workspace | **Present**, one dir per workspace. Fixed in `3e6e919` |
| **Account email** in Claude's `session_context` | **Present** in all ten. Not fixed |

`--setting-sources=project,local` does what run 1 assumed, including `~/.claude.json` MCP servers. The connector and auto memory come from the account, not from settings files. A direct probe (`claude -p` with Haiku in `$R/claude-probe`) showed that `ENABLE_CLAUDEAI_MCP_SERVERS=false` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` remove both. The executor now sets them on Claude factory instances. Afterwards `live-check.mjs --isolation --provider claudeAgent --model claude-haiku-5-5` passed: commit by Perpeto Agent, no `mcp__claude_ai` tools, no `# Memory` section, no memory dir.

The Codex reviewer's five rollouts in the factory `CODEX_HOME` held only Codex's built-in instructions: no personal skills, memories or `AGENTS.md`. Their first model calls used 14,006 to 14,085 input tokens.

## Token usage per role

Run 1 used Codex `gpt-6.1-sol` low for every role and reported uncached input plus output. Claude reports new prompt text as cache writes, so "fresh" below is uncached input plus cache write plus output. Per-role figures come from `assignment.usage` events, because `/usage` rejects `groupBy=role`.

| Role | Turns | Fresh tokens per turn, run 1 | Fresh tokens per turn, run 2 | Cache read per turn, run 2 | First-call input, run 2 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Architect (Claude) | 2 | not split out | 17,067 | 12,702 | 24,603 to 24,813 |
| Planner (Claude) | 1 | 37,399 | 10,930 | 53,906 | 19,496 |
| Builder (Claude) | 5 | 31,173 | 13,845 | 82,887 | 19,918 to 20,225 |
| Reviewer (Codex) | 5 | 39,738 | 15,081 | 10,778 | 14,006 to 14,085 |
| Senior reviewer (Claude) | 2 | not run | 11,329 | 33,023 | 20,294 to 20,352 |

Fresh tokens per turn fell by 55 to 71% against run 1. That covers run 1's isolation and context fixes. It is not a like-for-like model comparison, since four of the five roles changed harness. Claude's ~20,000-token first call is mostly its own system prompt and tools; a builder turn makes 3 to 15 model calls, which is why its cache reads dominate. Run 1's second run read 849,408 cached tokens over 5 turns; this run read 588,273 over 13.

## Findings

1. **Account-level Claude context.** Fixed in `3e6e919` for the connector and auto memory, as above. Two gaps remain. The account email reaches every Claude prompt, and no setting is known to stop it. Claude also writes transcripts for every factory workspace into the operator's `~/.claude/projects`: 12 directories from this session, left in place as evidence. Closing both probably needs a per-factory `CLAUDE_CONFIG_DIR` with a linked credential, like the Codex home. That is too large for this pass.
2. **Concurrent items that edit the same files conflict at the merge queue, and the rework repeats the whole review loop.** The planner gave both items `src/index.js` and README edits. Slugify merged first, so truncate was rejected and went back through builder, review and escalation. With forced rejections that cost 5 extra turns and a second human decision; normally it would cost a builder and a reviewer turn. Options: planner guidance to note files touched and keep overlapping items serial, or a merge-conflict route that sends the item to the builder to rebase without resetting review. `packages/workflow` is being edited by others, so this is reported, not changed.
3. **A human pass does not carry past a later rework.** After the conflict the item needed the person again. That fits the current semantics, since the code changed. The forced rubric exaggerated it.
4. **Architect validation retry works.** My invalid request was repaired on the second attempt without intervention. The architect silently dropped one requested edge to do it; the rationale did not mention the change.
5. **Small hub gaps.** `/usage?groupBy=role` returns 400 "Invalid usage groupBy", so per-role cost needs event scraping. `GET /runs/:id` for a completed run has no end timestamp (`stoppedAt` only). `apps/hub` belongs to another worker.
6. **Native tools stay attached.** Claude factory agents still see Claude Code's own `Agent`, `Workflow`, `ScheduleWakeup` and `advisor` tools under `maxSubagents: 0`. None was used. The executor detects native subagents only after they start, as recorded in the [executor handoff](factory-t3.md#not-verified-or-not-done).

## Checks

`npm test -w @perpeto/t3-executor`: 48 of 48 after the fix, including the new test for the Claude environment. The repository-wide `npm test` was not run.

## Not verified

The senior reviewer's pass path and triage's fail path (both forced away here), real subscription account pools, more than one machine, GitHub delivery, cancellation and restarts during a live turn, and web or Apple screens for this run.

## Cleanup

The node, hub and T3 runtime were stopped; ports 4510 and 4520 have no listeners, and no `perpeto-live2` or live-check processes remain. `/tmp/perpeto-live2` holds only throwaway state and is left for inspection. The Claude transcript directories named `-private-tmp-perpeto-live2-*` and `-private-var-folders-…-perpeto-t3-executor-live-*` under `~/.claude/projects` are this run's and can be deleted.
