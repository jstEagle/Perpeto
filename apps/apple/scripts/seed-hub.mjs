#!/usr/bin/env node
// Seeds a local hub with real data for the Apple app, through the public API
// only: a project, the build template as an active workflow, an
// agent-authored draft, two simulated machines with accounts, and a run whose
// work moves through planner, builders and reviewers. The simulated machines
// keep heartbeating and renewing leases until the script is stopped, so the
// run stays live while you look at it.
//
// Usage (from the repo root, Node 24):
//   node apps/apple/scripts/seed-hub.mjs --url http://127.0.0.1:4320 --token-file .perpeto/hub/owner.secret [--minutes 20]
//
// It never calls a model. Agent results, usage and interactions are scripted.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) =>
  value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]]] : pairs, []));
const base = (args.url ?? 'http://127.0.0.1:4320').replace(/\/$/, '');
const owner = (await readFile(args['token-file'] ?? '.perpeto/hub/owner.secret', 'utf8')).trim();
const minutes = Number(args.minutes ?? 20);
const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = seed => (seed.repeat(40) + '0'.repeat(40)).slice(0, 40);

async function call(method, path, body, token = owner) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), ...body }) } : {}),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text}`);
  return json;
}

// Project and workflows.
const project = await call('POST', '/projects', {
  name: 'perpeto-live',
  repo: { url: 'https://github.com/jstEagle/Perpeto', defaultBranch: 'main' },
  docs: [{ id: 'doc_vision', title: 'Vision', path: 'docs/product/vision.md', kind: 'vision' }],
  goals: ['Run the build workflow end to end on two machines', 'Keep review latency under 30 minutes at p90'],
});
const graph = JSON.parse(await readFile(join(root, 'packages/workflow/templates/build.json'), 'utf8'));
const workflow = await call('POST', `/projects/${project.id}/workflows`, {
  name: 'Build', purpose: 'build', graph,
  rationale: 'The build template: plan, build in a review loop, CI, then a serial merge queue.',
});
await call('POST', `/workflows/${workflow.id}/activate`, { version: 1 });

// Machines.
async function enroll(name, os, providers, capacity, accounts) {
  const { code } = await call('POST', '/machines/enrollment-codes', {});
  const node = await call('POST', '/nodes/enroll', { code, name, os, arch: 'arm64', version: '0.3.0', providers, labels: [os] }, null);
  const machine = { ...node, name, providers, capacity, accounts, running: 0 };
  await heartbeat(machine);
  return machine;
}
async function heartbeat(machine) {
  await call('POST', '/nodes/heartbeat', {
    status: 'online', capacity: machine.capacity, running: { agents: machine.running, jobs: 0 }, providers: machine.providers,
    accounts: machine.accounts,
  }, machine.token);
}
// Subscription usage the simulated nodes report, so /pacing has a rich plan: five Claude subs mid-rotation (two
// burned, one burning, two fresh) and two Codex subs. Percentages and reset times only, as real heartbeats carry.
// Pacing is off while the script leases its scripted work and switched on at the end.
const seededAt = Date.now();
const inMinutes = (minutes) => new Date(seededAt + minutes * 60_000).toISOString();
const usageWindow = (id, kind, label, usedPercent, resetMins, windowMins) =>
  ({ id, kind, label, usedPercent, windowMins, ...(resetMins === undefined ? {} : { resetsAt: inMinutes(resetMins) }) });
const claudeUsage = (session, sessionReset, weekly, weeklyReset) => ({ checkedAt: inMinutes(0), windows: [
  usageWindow('five_hour', 'session', '5-hour limit', session, sessionReset, 300), usageWindow('seven_day', 'weekly', 'Weekly limit', weekly, weeklyReset, 10080)] });
const codexUsage = (session, sessionReset, weekly, weeklyReset) => ({ checkedAt: inMinutes(0), windows: [
  usageWindow('primary', 'session', '5-hour limit', session, sessionReset, 300), usageWindow('secondary', 'weekly', 'Weekly limit', weekly, weeklyReset, 10080)] });
const subscription = (id, provider, label, plan, usage, extra = {}) => ({ id, provider, label, plan, status: 'active', usage, ...extra });
await call('PUT', '/pacing/settings', { enabled: false });
const studio = await enroll('studio-m4', 'darwin', ['claudeAgent', 'codex'], { maxAgents: 6, maxJobs: 0 }, [
  subscription('acct_claude_1', 'claudeAgent', 'Claude Max 1', 'Claude Max 20x', claudeUsage(38, 260, 44, 1500), { lastUsedAt: inMinutes(0) }),
  subscription('acct_codex_1', 'codex', 'ChatGPT Pro 1', 'ChatGPT Pro', codexUsage(41, 210, 37, 1700), { lastUsedAt: inMinutes(-5) }),
  subscription('acct_claude_2', 'claudeAgent', 'Claude Max 2', 'Claude Max 20x', claudeUsage(96, 195, 51, 2200), { lastUsedAt: inMinutes(-40) }),
]);
const linux = await enroll('build-linux-01', 'linux', ['claudeAgent', 'codex'], { maxAgents: 2, maxJobs: 2 }, [
  subscription('acct_codex_2', 'codex', 'ChatGPT Pro 2', 'ChatGPT Pro', codexUsage(0, undefined, 18, 2600)),
  subscription('acct_claude_3', 'claudeAgent', 'Claude Max 3', 'Claude Max 20x', claudeUsage(0, undefined, 33, 1900)),
  subscription('acct_claude_4', 'claudeAgent', 'Claude Max 4', 'Claude Max 20x', claudeUsage(0, undefined, 29, 2900)),
  subscription('acct_claude_5', 'claudeAgent', 'Claude Max 5', 'Claude Max 20x', claudeUsage(97, 125, 58, 1100), { status: 'cooling', cooldownUntil: inMinutes(125), lastUsedAt: inMinutes(-170) }),
]);
const machines = [studio, linux];

// Keep machines online and held leases alive from here on, including while
// the rest of the seed runs.
const held = new Map();
const keepAlive = setInterval(async () => {
  for (const machine of machines) await heartbeat(machine).catch(error => console.warn(error.message));
  for (const [id, { machine, assignment }] of held) {
    await call('POST', `/assignments/${assignment.id}/renew`, { attempt: assignment.attempt }, machine.token).catch(error => {
      // The hub can requeue a lease; stop renewing it rather than fail.
      if (error.message.includes('lease_lost')) { held.delete(id); machine.running--; } else console.warn(error.message);
    });
  }
}, 8000);

// Lease helpers. Held leases are renewed until the script stops.
async function lease(machine, nodeId) {
  for (let tries = 0; tries < 20; tries++) {
    const { assignments } = await call('POST', '/nodes/lease', { kinds: ['assignment'], max: 1 }, machine.token);
    const found = assignments[0];
    if (found) {
      held.set(found.id, { machine, assignment: found });
      machine.running++;
      if (nodeId && found.nodeId !== nodeId) console.warn(`expected ${nodeId}, leased ${found.nodeId}`);
      return found;
    }
    await sleep(300);
  }
  return undefined;
}
const post = (machine, assignment, type, data = {}) =>
  call('POST', `/assignments/${assignment.id}/events`, { attempt: assignment.attempt, type, data }, machine.token);
async function finish(machine, assignment, data) {
  await post(machine, assignment, 'completed', data);
  held.delete(assignment.id);
  machine.running--;
}
const usage = (machine, assignment, provider, model, scale = 1, accountId) => post(machine, assignment, 'usage', {
  provider, model, accountId, inputTokens: Math.round(180000 * scale), outputTokens: Math.round(24000 * scale),
  cacheReadTokens: Math.round(520000 * scale), cacheWriteTokens: Math.round(41000 * scale), costUsd: Number((2.4 * scale).toFixed(2)),
});

// An agent-authored proposal: the architect runs on the studio machine.
const architect = await call('POST', `/projects/${project.id}/workflows/drafts`, {
  prompt: 'Review is the bottleneck. Add a second reviewer and let builders message the planner.', baseWorkflowId: workflow.id,
});
const proposed = structuredClone(graph);
proposed.nodes.find(node => node.id === 'reviewer').config.concurrency = 3;
proposed.edges.push({ id: 'builder-planner-messages', from: { node: 'builder' }, to: { node: 'planner' }, kind: 'messages' });
{
  const leased = await lease(studio, 'workflow-architect');
  if (leased?.id === architect.id) {
    await post(studio, leased, 'started');
    await finish(studio, leased, {
      outcome: 'success', summary: 'Drafted version 2.', graph: proposed,
      rationale: 'Reviewers have been saturated while builders wait. Raising reviewer concurrency from 2 to 3 should cut review wait roughly by a third. Builders already message the planner about oversized items, so that edge is now planned instead of unplanned.',
    });
  }
}

// A run with six ideas, split by the planner.
const run = await call('POST', `/workflows/${workflow.id}/runs`, {
  input: { items: [{ title: 'Observability for runs' }], keepOpen: true, source: 'manual', budget: { maxTokensPerDay: 2_000_000, maxActiveItems: 8 } },
});
const planner = await lease(studio, 'planner');
await post(studio, planner, 'started');
await usage(studio, planner, 'claudeAgent', 'claude-opus-5-5', 0.6, 'acct_claude_1');
await finish(studio, planner, {
  outcome: 'success', summary: 'Split into six items.',
  items: [
    { title: 'Run metrics endpoint', body: 'GET /runs/:id/metrics with node, edge and run measurements.' },
    { title: 'Bottleneck rules', body: 'Saturated, queue growing, rework loop.' },
    { title: 'Unplanned interaction tracking', body: 'Flag interactions without a matching edge.' },
    { title: 'Live map in the Apple app', body: 'Route role edges outside the flow band.' },
    { title: 'Project run list', body: 'GET /projects/:id/runs, newest first.' },
    { title: 'Events stream reconnect', body: 'Resume from Last-Event-ID.' },
  ],
});

// Simulate the machines: lease whatever the hub offers and act by node.
// Builders finish their first six items and reviewers pass one and fail one,
// so work queues up at the reviewers (a bottleneck). Everything after that
// stays running so the run is live.
const plan = { builderDone: 6, reviews: ['pass', 'fail'], unplanned: 2 };
let idle = 0;
for (let turn = 0; turn < 40 && idle < 4; turn++) {
  const machine = machines[turn % 2];
  if (machine.running >= machine.capacity.maxAgents) { idle++; continue; }
  const leased = await lease(machine);
  if (!leased) { idle++; continue; }
  idle = 0;
  const account = leased.harness.provider === 'codex'
    ? (machine === studio ? 'acct_codex_1' : 'acct_codex_2')
    : (machine === studio ? 'acct_claude_1' : 'acct_claude_3');
  await post(machine, leased, 'started');
  await usage(machine, leased, leased.harness.provider, leased.harness.model, 0.6 + (turn % 5) * 0.25, account);
  if (leased.nodeId === 'builder') {
    await post(machine, leased, 'agent.delegated', { sourceNodeId: 'builder', targetNodeId: 'helper', from: 'builder', to: 'helper' });
    await post(machine, leased, 'agent.messaged', { sourceNodeId: 'builder', targetNodeId: 'reviewer', from: 'builder', to: 'reviewer', senderRoleId: 'builder', recipientRoleId: 'reviewer' });
    if (plan.builderDone-- > 0) {
      await finish(machine, leased, { outcome: 'success', summary: 'Opened a pull request.', branch: `factory/${leased.workItemId}`, prUrl: `https://github.com/jstEagle/Perpeto/pull/${300 + turn}`, headSha: sha(String(turn % 9 + 1)) });
    }
  } else if (leased.nodeId === 'reviewer') {
    if (plan.unplanned-- > 0) {
      // No messages edge connects reviewers to the planner.
      await post(machine, leased, 'agent.messaged', { sourceNodeId: 'reviewer', targetNodeId: 'planner', from: 'reviewer', to: 'planner', senderRoleId: 'reviewer', recipientRoleId: 'planner' });
    }
    const verdict = plan.reviews.shift();
    if (verdict) await finish(machine, leased, { outcome: 'success', verdict, summary: verdict === 'pass' ? 'Tests cover the change.' : 'Missing a test for an empty window.' });
  }
}

// Messages in the run channel: agents use their assignment's message event,
// the owner the messaging route. One delivery is reported, as an executor would.
{
  const holding = nodeId => [...held.values()].find(h => h.assignment.nodeId === nodeId);
  const builder = holding('builder'), reviewer = holding('reviewer');
  const say = async (h, recipientRoleId, body) => (await post(h.machine, h.assignment, 'message', { recipientRoleId, body })
    .catch(error => { console.warn(error.message); return {}; })).message;
  let fix;
  if (builder) fix = await say(builder, 'reviewer', 'Pushed the fix for the empty window; ready for another look.');
  if (reviewer) {
    await say(reviewer, 'owner', 'Two items touch the API contract. Should I hold them for you?');
    await say(reviewer, 'planner', 'Item 4 is really two changes. Can you split it?');
    if (fix) await post(reviewer.machine, reviewer.assignment, 'delivered', { messageIds: [fix.id], via: 'steer' }).catch(error => console.warn(error.message));
  }
  await call('POST', `/messaging/projects/${project.id}/channels/run-${run.id}/messages`, {
    senderRoleId: 'owner', recipientRoleId: 'builder', body: 'Keep the change behind the flag until review passes.',
  }).catch(error => console.warn(error.message));
}

await call('PUT', '/pacing/settings', { enabled: true });
for (const machine of machines) await heartbeat(machine);
const pacing = await call('GET', '/pacing');
console.log(JSON.stringify({ projectId: project.id, workflowId: workflow.id, runId: run.id, held: held.size,
  pacing: pacing.providers.map(p => ({ provider: p.provider, targetAgents: p.targetAgents, limitedBy: p.limitedBy, starved: p.starved })) }));

// Stay alive for the requested time, then let leases lapse.
await sleep(minutes * 60000);
clearInterval(keepAlive);
