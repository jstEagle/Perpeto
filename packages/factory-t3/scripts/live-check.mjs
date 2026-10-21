#!/usr/bin/env node
// Opt-in live check: starts the built T3 runtime with a temporary base
// directory, mints a short-lived session with T3's own CLI, and runs real
// turns through the factory-t3 executor. It uses the harness logins already
// present on this machine and never creates new ones. Not part of `npm test`.
//
//   node packages/factory-t3/scripts/live-check.mjs [--provider codex] [--model gpt-6-luna] [--policy]
//
// --policy additionally asks the agent to call T3's delegate_task tool under
// a maxSubagents: 0 policy (the patched runtime must refuse it), then under
// maxSubagents: 1 (the child must be reported and its usage followed).
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { createT3Executor } from '../src/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const serverEntry = resolve(repoRoot, 'vendor/t3code/apps/server/dist/bin.mjs');
const { values: args } = parseArgs({ options: {
  provider: { type: 'string', default: 'codex' },
  model: { type: 'string', default: 'gpt-6-luna' },
  policy: { type: 'boolean', default: false },
  keep: { type: 'boolean', default: false },
} });
if (!existsSync(serverEntry)) { console.error('Build the runtime first: npm run setup && npm run build.'); process.exit(2); }

const home = await mkdtemp(join(tmpdir(), 'perpeto-factory-t3-live-'));
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
  const base = { runId: 'run_live', role: 'implementer', attempt: 0, harness: { provider: args.provider, model: args.model }, repo: { localPath: repo, defaultBranch: 'main' } };

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
