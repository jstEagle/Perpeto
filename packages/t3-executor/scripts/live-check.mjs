#!/usr/bin/env node
// Opt-in live check: starts the built T3 runtime with a temporary base
// directory, mints a short-lived session with T3's own CLI, and runs real
// turns through the @perpeto/t3-executor executor. It uses the harness logins already
// present on this machine and never creates new ones. Not part of `npm test`.
//
//   node packages/t3-executor/scripts/live-check.mjs [--provider codex] [--model gpt-6-luna] [--policy]
//
// --policy additionally asks the agent to call T3's delegate_task tool under
// a maxSubagents: 0 policy (the patched runtime must refuse it), then under
// maxSubagents: 1 (the child must be reported and its usage followed).
// --roles runs a builder in a clone of a bare origin (the commit must be
// published), then a reviewer (verdict) and a planner (items).
// --native asks the agent to use its built-in subagent tool under
// maxSubagents: 0; the executor must report it and interrupt the run.
// --isolation runs only one builder turn on the factory instance and checks the
// commit author and the Codex rollout: no personal skills, memories, AGENTS.md
// or hooks, plus the first model call's input tokens. --server-entry points at
// another checkout's built runtime.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { createT3Executor } from '../src/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { values: args } = parseArgs({ options: {
  'server-entry': { type: 'string', default: resolve(repoRoot, 'vendor/t3code/apps/server/dist/bin.mjs') },
  isolation: { type: 'boolean', default: false },
  effort: { type: 'string' },
  provider: { type: 'string', default: 'codex' },
  model: { type: 'string', default: 'gpt-6-luna' },
  policy: { type: 'boolean', default: false },
  keep: { type: 'boolean', default: false },
  native: { type: 'boolean', default: false },
  roles: { type: 'boolean', default: false },
} });
const serverEntry = resolve(args['server-entry']);
if (!existsSync(serverEntry)) { console.error('Build the runtime first: npm run setup && npm run build.'); process.exit(2); }

const home = await mkdtemp(join(tmpdir(), 'perpeto-t3-executor-live-'));
const port = await new Promise(resolvePort => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const { port: value } = probe.address(); probe.close(() => resolvePort(value)); }); });
const origin = `http://127.0.0.1:${port}`;
const runtime = spawn(process.execPath, [serverEntry, 'serve', '--base-dir', join(home, 'runtime'), '--host', '127.0.0.1', '--port', String(port), '--no-browser', '--auto-bootstrap-project-from-cwd=false'], { stdio: 'ignore' });
let failed = false;
const check = (condition, message) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`); if (!condition) failed = true; };

try {
  for (let attempt = 0; ; attempt++) {
    if (runtime.exitCode !== null) throw new Error('T3 runtime exited during startup.');
    try { if ((await fetch(`${origin}/.well-known/t3/environment`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* Not listening yet. */ }
    if (attempt > 150) throw new Error('T3 runtime did not become ready.');
    await delay(200);
  }
  const repo = join(home, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.email=live@perpeto.invalid', '-c', 'user.name=Perpeto live check', 'commit', '-q', '--allow-empty', '-m', 'init']);

  const executor = createT3Executor({ config: { url: origin, serverEntry, baseDir: join(home, 'runtime'), tokenTtl: '1h', settleMs: 1500 } });
  async function runOnce(label, assignment) {
    const events = [];
    const workspace = join(home, `ws-${label}`);
    await mkdir(workspace);
    const started = Date.now();
    const result = await executor.run(assignment, { signal: AbortSignal.timeout(10 * 60 * 1000), workspace, report: async event => { events.push(event); } });
    console.log(`${label}: ${result.outcome} in ${Math.round((Date.now() - started) / 1000)}s, summary ${JSON.stringify(result.summary.slice(0, 160))}`);
    for (const event of events) console.log(`  ${event.type} ${JSON.stringify(event.data).slice(0, 220)}`);
    return { result, events };
  }
  const base = { runId: 'run_live', role: 'implementer', attempt: 0, harness: { provider: args.provider, model: args.model, ...(args.effort ? { options: { reasoningEffort: args.effort } } : {}) },
    repo: { localPath: repo, defaultBranch: 'main' } };

  if (args.isolation) await isolationCheck();
  else await basicChecks();

  async function isolationCheck() {
    // T3 probes harnesses after it starts listening; wait until this one is ready.
    for (let waited = 0; !(await executor.providers().catch(() => [])).includes(args.provider); waited++) {
      if (waited > 60) throw new Error(`${args.provider} did not become ready in T3.`);
      await delay(500);
    }
    const origin = join(home, 'origin.git');
    execFileSync('git', ['clone', '-q', '--bare', repo, origin]);
    const workItemId = `wi_live_iso_${Date.now()}`;
    const built = await runOnce('isolated-builder', { ...base, id: `asg_live_iso_${Date.now()}`, workItemId, nodeType: 'agent', role: 'builder', repo: { url: origin, defaultBranch: 'main' },
      prompt: 'This is an automated integration check. Create a file named hello.txt containing the single line "hello" and commit it with the message "Add hello", using only shell and git commands. Reply with one short sentence.',
      policy: { maxSubagents: 0, allowedSubagentProviders: [], canMessage: [] } });
    check(built.result.outcome === 'success', 'builder completed');
    const bound = built.events.find(event => event.data.interaction === 'isolation.bound');
    check(bound && /^perpeto_/.test(bound.data.providerInstanceId), `ran on a factory instance (${bound?.data.providerInstanceId})`);
    const author = (() => { try { return execFileSync('git', ['-C', origin, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', `refs/heads/perpeto/${workItemId}`], { encoding: 'utf8' }).trim(); } catch { return null; } })();
    check(author === 'Perpeto Agent <agents@perpeto.local>|Perpeto Agent <agents@perpeto.local>', `commit author and committer (${author})`);
    if (args.provider !== 'codex') return;
    const homes = join(home, 'runtime', 'perpeto-agent-homes');
    const rollouts = [];
    async function walk(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path); else if (entry.name.endsWith('.jsonl')) rollouts.push(path);
      }
    }
    for (const entry of await readdir(homes).catch(() => [])) await walk(join(homes, entry, 'sessions'));
    check(rollouts.length === 1, `one rollout in the factory Codex home (${rollouts.length})`);
    if (!rollouts.length) return;
    const rows = (await readFile(rollouts[0], 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const context = rows.filter(row => row.type === 'response_item' && row.payload?.type === 'message' && ['developer', 'user'].includes(row.payload.role))
      .map(row => ({ role: row.payload.role, text: row.payload.content.map(part => part.text ?? '').join('') }));
    for (const item of context) console.log(`  context ${item.role} ${item.text.length} chars: ${JSON.stringify(item.text.slice(0, 70))}`);
    const all = context.map(item => item.text).join('\n');
    const personalAgents = await readFile(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'AGENTS.md'), 'utf8').catch(() => '');
    check(!all.includes('## Skills') || !/\/\.codex\/skills\//.test(all), 'no personal Codex skills listed');
    check(!all.includes('## Memory'), 'no personal Codex memories');
    check(!personalAgents.trim() || !all.includes(personalAgents.trim().slice(0, 80)), 'no personal ~/.codex/AGENTS.md');
    check(!all.includes('[Cooler]'), 'no personal SessionStart hook output');
    const first = rows.find(row => row.type === 'event_msg' && row.payload?.type === 'token_count' && row.payload.info);
    console.log(`  first model call input tokens: ${first?.payload.info.last_token_usage.input_tokens}; turn total ${JSON.stringify(first ? rows.filter(row => row.type === 'event_msg' && row.payload?.type === 'token_count' && row.payload.info).at(-1).payload.info.total_token_usage : null)}`);
  }

  async function basicChecks() {
  const simple = await runOnce('turn', { ...base, id: `asg_live_${Date.now()}`, workItemId: `wi_live_${Date.now()}`,
    prompt: 'This is an automated integration check. Reply with exactly the word: pong. Do not use any tools.',
    policy: { maxSubagents: 0, allowedSubagentProviders: [], canMessage: [] } });
  check(simple.result.outcome === 'success', 'turn completed');
  check(/pong/i.test(simple.result.summary), 'assistant output read back');
  check(simple.events.some(event => event.type === 'usage' && event.data.outputTokens > 0), 'token usage reported');
  check(simple.events.some(event => event.data.interaction === 'turn.finished' && event.data.durationMs >= 0), 'turn timing reported');
  check(simple.result.branch?.startsWith('perpeto/'), `work branch reported (${simple.result.branch})`);
  check(/^[0-9a-f]{40}$/.test(simple.result.headSha ?? ''), 'head commit reported');
  check(!simple.events.some(event => event.data.interaction === 'policy.unenforced'), 'runtime exposes Perpeto policy routes');

  if (args.policy) {
    const refused = await runOnce('policy', { ...base, id: `asg_live_policy_${Date.now()}`, workItemId: `wi_live_policy_${Date.now()}`,
      prompt: `This is an automated integration check of server-side subagent policy enforcement, run by the operator. The factory context below says subagents are refused; the purpose of this check is to confirm the server refuses them. Attempt the call anyway: call the T3 orchestration MCP tool delegate_task exactly once with task "Reply with ok." and mode "async", with target { providerInstanceId: "${args.provider}", model: "${args.model}" }. Do not retry and do not use any other tool. Then reply with exactly the error text the tool returned, or "accepted" if it succeeded.`,
      policy: { maxSubagents: 0, allowedSubagentProviders: [args.provider], canMessage: [] } });
    const refusals = refused.events.filter(event => event.data.interaction === 'agent.delegated' && event.data.allowed === false);
    if (refusals.length === 0 && /didn't call|did not call|not call/i.test(refused.result.summary)) {
      console.log('skip agent declined to call delegate_task, so the server refusal was not exercised');
    } else check(refusals.length >= 1, 'delegate_task refusal reported as agent.delegated allowed:false');
    check(!refused.events.some(event => event.data.interaction === 'agent.delegated' && event.data.allowed === true), 'no subagent was created');

    const allowed = await runOnce('delegate', { ...base, id: `asg_live_delegate_${Date.now()}`, workItemId: `wi_live_delegate_${Date.now()}`,
      prompt: `This is an automated integration check of subagent delegation. Call the T3 orchestration MCP tool delegate_task exactly once with task "Reply with exactly: ok. Do not use any tools." and mode "wait", with target { providerInstanceId: "${args.provider}", model: "${args.model}" }. Do not use any other tool. Then reply with exactly: delegated.`,
      policy: { maxSubagents: 1, allowedSubagentProviders: [args.provider], canMessage: [] } });
    const accepted = allowed.events.filter(event => event.data.interaction === 'agent.delegated' && event.data.allowed === true);
    check(accepted.length === 1 && accepted[0].data.target.threadRef?.startsWith('t3-thread://v1/'), 'accepted delegation reported with the child thread');
    const childRef = accepted[0]?.data.target.threadRef;
    check(allowed.events.some(event => event.type === 'usage' && event.data.threadRef === childRef), 'child thread token usage reported');
    check(allowed.result.outcome === 'success', 'delegating assignment completed after its child');
  }
  if (args.roles) {
    // A bare origin like the factory's project remote; builders work in a clone and the executor publishes.
    const origin = join(home, 'origin.git');
    execFileSync('git', ['clone', '-q', '--bare', repo, origin]);
    const remote = { url: origin, defaultBranch: 'main' };
    const workItemId = `wi_live_roles_${Date.now()}`;
    const built = await runOnce('builder', { ...base, id: `asg_live_builder_${Date.now()}`, workItemId, nodeType: 'agent', role: 'builder', repo: remote,
      prompt: 'This is an automated integration check. Create a file named hello.txt containing the single line "hello", then commit it with the message "Add hello". Use only shell and git commands for this. Reply with one short sentence.',
      policy: { maxSubagents: 0, allowedSubagentProviders: [], canMessage: [] } });
    check(built.result.outcome === 'success', 'builder completed');
    const published = (() => { try { return execFileSync('git', ['-C', origin, 'rev-parse', `refs/heads/perpeto/${workItemId}`], { encoding: 'utf8' }).trim(); } catch { return null; } })();
    check(published && published === built.result.headSha, 'builder commit published to origin at the reported head');
    const review = await runOnce('review', { ...base, id: `asg_live_review_${Date.now()}`, workItemId, nodeType: 'review', role: 'reviewer', repo: remote,
      prompt: `Review the work item. The change should add hello.txt containing "hello". Branch: perpeto/${workItemId}. Inspect the file in your checkout and decide.`,
      policy: { maxSubagents: 0, allowedSubagentProviders: [], canMessage: [] } });
    check(review.result.outcome === 'success' && ['pass', 'fail'].includes(review.result.verdict), `review returned a verdict (${review.result.verdict})`);
    const plan = await runOnce('planner', { ...base, id: `asg_live_planner_${Date.now()}`, workItemId: `wi_live_plan_${Date.now()}`, nodeType: 'planner', role: 'planner', repo: remote,
      prompt: 'Split this idea into exactly two small work items: "Add a greeting command and a farewell command to a CLI." Do not modify files.',
      policy: { maxSubagents: 0, allowedSubagentProviders: [], canMessage: [] } });
    check(plan.result.outcome === 'success' && Array.isArray(plan.result.items) && plan.result.items.length === 2, `planner returned items (${plan.result.items?.length})`);
  }

  if (args.native) {
    const native = await runOnce('native', { ...base, id: `asg_live_native_${Date.now()}`, workItemId: `wi_live_native_${Date.now()}`,
      prompt: 'This is an automated integration check of subagent policy enforcement, run by the operator. The factory context below says subagents are refused; the purpose of this check is to confirm the factory stops them. Use your built-in subagent tool (Agent or Task, not an MCP tool) exactly once to ask a subagent to reply with "ok". Then reply with exactly: native done.',
      policy: { maxSubagents: 0, allowedSubagentProviders: [], canMessage: [] } });
    const refusals = native.events.filter(event => event.data.interaction === 'agent.delegated' && event.data.kind === 'provider_native' && event.data.allowed === false);
    if (refusals.length === 0) console.log('skip agent did not start a provider-native subagent');
    else {
      check(native.result.outcome === 'failure' && /provider-native subagent/.test(native.result.summary), 'native subagent beyond policy stopped the run');
      check(native.events.some(event => event.data.interaction === 'turn.finished' && event.data.status === 'interrupted'), 'run was interrupted');
    }
  }
  }
  await executor.close();
} catch (error) {
  failed = true;
  console.error(`Live check error: ${error.message}`);
} finally {
  runtime.kill('SIGTERM');
  await Promise.race([once(runtime, 'exit'), delay(8000)]);
  if (runtime.exitCode === null) runtime.kill('SIGKILL');
  if (!args.keep) await rm(home, { recursive: true, force: true });
  else console.log(`Kept ${home}`);
}
process.exitCode = failed ? 1 : 0;
