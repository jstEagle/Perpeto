// Seeds a running hub with a project, two architect-drafted workflow
// versions and a run in progress, so the web app can be checked against
// real hub responses. It talks to the hub only over HTTP: as the owner, and
// as two simulated machines that lease work and report results. Nothing
// calls a model and no Git work happens, so items stop before the merge
// queue. The owner token is read from its file and never printed.
//
// Usage: node apps/web/scripts/seed-web-demo-hub.mjs <hubUrl> <owner.secret> [--hold]
// --hold keeps the machines heartbeating and renewing their open leases
// until interrupted, so running work stays visible.
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const [hubUrl, secretPath, ...flags] = process.argv.slice(2);
if (!hubUrl || !secretPath) {
  console.error('Usage: node apps/web/scripts/seed-web-demo-hub.mjs <hubUrl> <owner.secret> [--hold]');
  process.exit(2);
}
const owner = (await readFile(secretPath, 'utf8')).trim();
const template = JSON.parse(await readFile(new URL('../../../packages/workflow/templates/build.json', import.meta.url), 'utf8'));

async function call(token, method, path, body) {
  const response = await fetch(`${hubUrl}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), ...body }) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${data?.error?.code}: ${data?.error?.message}`);
  return data;
}
const as = (token) => (method, path, body) => call(token, method, path, body);
const hub = as(owner);

const sha = () => randomBytes(20).toString('hex');
const clone = (value) => structuredClone(value);

// Machines.
const specs = [
  { name: 'studio-mac', os: 'darwin', arch: 'arm64', providers: ['claudeAgent', 'codex'], labels: ['mac'], capacity: { maxAgents: 6, maxJobs: 2 } },
  { name: 'build-linux', os: 'linux', arch: 'x64', providers: ['codex', 'claudeAgent'], labels: ['linux'], capacity: { maxAgents: 4, maxJobs: 2 } },
];
const machines = [];
for (const spec of specs) {
  const { code } = await hub('POST', '/machines/enrollment-codes', {});
  const enrolled = await call('', 'POST', '/nodes/enroll', { code, name: spec.name, os: spec.os, arch: spec.arch, version: '0.1.0', labels: spec.labels, providers: spec.providers });
  machines.push({ ...spec, id: enrolled.machineId, api: as(enrolled.token), held: [] });
}
const accounts = {
  'studio-mac': [
    { id: 'acct_studio_claude', provider: 'claudeAgent', label: 'Claude Max · personal', status: 'active' },
    { id: 'acct_studio_codex', provider: 'codex', label: 'ChatGPT Pro', status: 'active' },
  ],
  'build-linux': [{ id: 'acct_linux_codex', provider: 'codex', label: 'ChatGPT Pro · build', status: 'cooling', cooldownUntil: new Date(Date.now() + 30 * 60_000).toISOString() }],
};
async function heartbeat(m) {
  const running = { agents: m.held.filter((w) => w.kind === 'assignment').length, jobs: m.held.filter((w) => w.kind === 'job').length };
  await m.api('POST', '/nodes/heartbeat', { capacity: m.capacity, running, providers: m.providers, accounts: accounts[m.name], status: 'online' });
}
for (const m of machines) await heartbeat(m);

// Project.
const project = await hub('POST', '/projects', {
  name: 'perpeto',
  repo: { url: 'https://github.com/lumin-products/perpeto', defaultBranch: 'main' },
  goals: ['Ship the hub, node and web app as one factory', 'Every change reviewed by a second model and checked by CI'],
  docs: [{ id: 'vision', title: 'Product vision', path: 'docs/product/vision.md', kind: 'vision' }],
});
console.log(`project ${project.id}`);

async function lease(m, kinds = ['assignment', 'job']) {
  const got = await m.api('POST', '/nodes/lease', { kinds, max: 8 });
  const work = [...got.assignments.map((a) => ({ kind: 'assignment', value: a })), ...got.jobs.map((j) => ({ kind: 'job', value: j }))];
  for (const w of work) {
    w.machine = m;
    m.held.push(w);
    await report(w, 'started', {});
  }
  return work;
}
const path = (w) => `/${w.kind === 'job' ? 'jobs' : 'assignments'}/${w.value.id}/events`;
const report = (w, type, data) =>
  w.machine.api('POST', path(w), { type, attempt: w.value.attempt, data }).catch((error) => {
    error.message = `${type}: ${error.message}`;
    throw error;
  });
const release = (w) => (w.machine.held = w.machine.held.filter((x) => x !== w));

/** Act as the workflow architect for one draft request. */
async function architect(prompt, graph, rationale, { baseWorkflowId, invalidFirst } = {}) {
  let assignment = await hub('POST', `/projects/${project.id}/workflows/drafts`, { prompt, ...(baseWorkflowId ? { baseWorkflowId } : {}) });
  for (let attempt = 1; ; attempt++) {
    const [w] = (await lease(machines[0], ['assignment'])).filter((x) => x.value.id === assignment.id);
    if (!w) throw new Error('The architect assignment was not leased.');
    await report(w, 'progress', { summary: 'Reading project docs, goals and machines' });
    const bad = invalidFirst && attempt === 1;
    const reply = bad ? { ...clone(graph), nodes: graph.nodes.filter((n) => n.type !== 'output') } : graph;
    await report(w, 'completed', { outcome: 'success', summary: bad ? 'Drafted a graph.' : 'Drafted the workflow.', graph: reply, rationale });
    release(w);
    assignment = await hub('GET', `/assignments/${assignment.id}`);
    if (assignment.draftWorkflowId) return assignment;
    if (!assignment.retryAssignmentId) throw new Error(`Architect failed: ${JSON.stringify(assignment.architectErrors)}`);
    assignment = await hub('GET', `/assignments/${assignment.retryAssignmentId}`);
  }
}

const v1 = await architect(
  'Plan from the goals, build in parallel, review every change with a second model, run CI, then merge.',
  template,
  'Builders run in parallel on Codex while Claude plans and reviews, so every change gets a second model family. A review loop sends feedback back to the builder at most three times before a senior reviewer decides. CI runs at the reviewed head, and a serial merge queue lands one change at a time.',
  { invalidFirst: true },
);
await hub('POST', `/workflows/${v1.draftWorkflowId}/activate`, { version: v1.draftVersion });
console.log(`workflow ${v1.draftWorkflowId} v${v1.draftVersion} active`);

// A proposal: the architect answers the reviewer bottleneck with more review capacity.
const proposed = clone(template);
const reviewer = proposed.nodes.find((n) => n.id === 'reviewer');
reviewer.config.concurrency = 4;
proposed.nodes.find((n) => n.id === 'builder').config.harness.model = 'gpt-6-astra-mini';
const v2 = await architect(
  'Review is the bottleneck. Add review capacity without lowering quality.',
  proposed,
  'Reviewer utilization is at its limit while builders wait. This version doubles reviewer concurrency and moves builders to a smaller model, which kept review pass rates in earlier runs. The running workflow keeps version 1 until you activate this one.',
  { baseWorkflowId: v1.draftWorkflowId },
);
console.log(`proposal v${v2.draftVersion} saved`);

// Run.
const run = await hub('POST', `/workflows/${v1.draftWorkflowId}/runs`, {
  input: { items: [{ title: 'Web: connect to a real hub', body: 'Use the hub response shapes and follow assignments.' }, { title: 'Hub: session cookie for the web app' }, { title: 'Node: drain mode' }] },
});
console.log(`run ${run.id}`);

const usage = (w, model, provider) =>
  report(w, 'usage', { provider, model, inputTokens: 40_000 + Math.floor(Math.random() * 60_000), outputTokens: 6_000 + Math.floor(Math.random() * 9_000), cacheReadTokens: 20_000 });
const reviewed = new Map();
let messagedUnplanned = 0;

/** Finish work leased in an earlier round, as each role would. */
async function finish(w) {
  const v = w.value;
  if (w.kind === 'job') {
    await report(w, 'log', { chunk: `$ npm test\n${v.steps?.length ?? 1} steps at ${v.revision.slice(0, 7)}\n` });
    const pass = Math.random() < 0.6;
    await report(w, 'completed', { status: pass ? 'passed' : 'failed', revision: v.revision, configHash: v.configHash, steps: [{ name: 'test', status: pass ? 'passed' : 'failed', exitCode: pass ? 0 : 1 }] });
    return release(w);
  }
  await usage(w, v.harness?.model ?? 'unknown', v.harness?.provider ?? 'codex');
  if (v.nodeId === 'planner') {
    await report(w, 'agent.messaged', { sourceNodeId: 'planner', targetNodeId: 'builder', summary: 'Planner shared acceptance criteria with Builder' });
    await report(w, 'completed', {
      outcome: 'success',
      summary: 'Split into independent items.',
      items: ['Hub: metrics endpoint', 'Hub: usage by machine', 'Web: live map routing', 'Web: session storage warning', 'Node: job runner worktrees', 'CLI: install script', 'Delivery: merge queue batching'].map((title) => ({ title })),
    });
  } else if (v.nodeId === 'builder') {
    await report(w, 'agent.delegated', { sourceNodeId: 'builder', targetNodeId: 'helper', summary: 'Builder handed test fixtures to a helper' });
    await report(w, 'agent.messaged', { sourceNodeId: 'builder', targetNodeId: 'helper' });
    await report(w, 'agent.messaged', { sourceNodeId: 'builder', targetNodeId: 'reviewer' });
    const n = String(Math.floor(Math.random() * 400) + 100);
    await report(w, 'completed', { outcome: 'success', summary: 'Implemented with tests.', branch: `perpeto/${v.workItemId}`, prUrl: `https://github.com/lumin-products/perpeto/pull/${n}`, headSha: sha() });
  } else if (v.nodeId === 'reviewer' || v.nodeId === 'senior-reviewer') {
    const seen = reviewed.get(v.workItemId) ?? 0;
    reviewed.set(v.workItemId, seen + 1);
    if (messagedUnplanned++ < 3) await report(w, 'agent.messaged', { sourceNodeId: 'reviewer', targetNodeId: 'planner', summary: 'Reviewer asked Planner which goal this item serves' });
    const verdict = seen === 0 && Math.random() < 0.7 ? 'fail' : 'pass';
    await report(w, 'completed', { outcome: 'success', verdict, summary: verdict === 'fail' ? 'Missing tests for the error path.' : 'Meets the acceptance criteria.' });
  } else {
    await report(w, 'completed', { outcome: 'success', summary: 'Done.' });
  }
  release(w);
}

// Rounds: each machine leases what it can, then finishes most of what it
// held from earlier rounds. The last round's work stays open.
for (let round = 0; round < 9; round++) {
  for (const m of machines) await heartbeat(m);
  const earlier = machines.flatMap((m) => m.held);
  for (const m of machines) await lease(m);
  for (const w of earlier)
    if (Math.random() < 0.85 || round < 2)
      await finish(w).catch((error) => {
        // The hub may have reassigned work this script held (for example after an escalation); drop it and carry on.
        if (!String(error.message).includes('lease_lost')) throw error;
        console.log(`dropped ${w.kind} ${w.value.id} (${w.value.nodeId ?? 'job'}): ${error.message}`);
        release(w);
      });
  await sleep(150);
}

const metrics = await hub('GET', `/runs/${run.id}/metrics?window=24h`);
console.log(`metrics: ${metrics.nodes.length} nodes, ${metrics.edges.filter((e) => e.count).length} edges with traffic, ${metrics.bottlenecks.length} bottlenecks`);
console.log(`open work: ${machines.map((m) => `${m.name} ${m.held.length}`).join(', ')}`);

if (flags.includes('--hold')) {
  console.log('holding leases; Ctrl-C to stop');
  for (let tick = 0; ; tick++) {
    for (const m of machines) await heartbeat(m).catch(() => undefined);
    if (tick % 4 === 0)
      for (const w of machines.flatMap((m) => m.held))
        await w.machine.api('POST', `/${w.kind === 'job' ? 'jobs' : 'assignments'}/${w.value.id}/renew`, { attempt: w.value.attempt }).catch(() => release(w));
    await sleep(5000);
  }
}
