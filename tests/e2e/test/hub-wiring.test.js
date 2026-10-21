import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { GitHubAdapter } from '@perpeto/delivery';
import { githubRepository } from '@perpeto/hub/delivery/github';
import { bareRepository, eventually, git, packageBin, startFactory } from './support.js';

function graph({ publication, delivery = true } = {}) {
  const node = (id, type, config = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
  const ids = delivery ? ['input', 'builder', 'ci', 'merge', 'output'] : ['input', 'builder', 'output'];
  return { schema: 'perpeto.workflow/1', nodes: [
    node('input', 'input', { source: 'manual', docs: [] }),
    node('builder', 'agent', { harness: { provider: 'fake', model: 'test' }, prompt: 'Build', concurrency: 1,
      policy: { maxSubagents: 0, allowedSubagentProviders: [] }, retry: { maxAttempts: 3, backoffSec: 0 } }),
    ...(delivery ? [node('ci', 'ci', { steps: [{ name: 'test', run: 'test -f feature.txt && git rev-parse HEAD' }] }),
      node('merge', 'merge-queue', { strategy: 'serial', method: 'squash', requiredChecks: ['ci'], ...(publication ? { publication } : {}) })] : []),
    node('output', 'output'),
  ], edges: [...(delivery ? [{ id: 'ci-fail', kind: 'flow', from: { node: 'ci', port: 'fail' }, to: { node: 'output' } }] : []), ...ids.slice(1).map((id, i) => ({ id: `${ids[i]}-${id}`, kind: 'flow', from: { node: ids[i], ...(['ci', 'merge'].includes(ids[i]) ? { port: 'pass' } : {}) }, to: { node: id } }))] };
}

async function startRun(request, repo, options = {}) {
  const project = await request('POST', '/projects', { name: 'Wiring fixture', repo });
  const workflow = await request('POST', `/projects/${project.id}/workflows`, { name: 'Build', graph: graph(options) });
  await request('POST', `/workflows/${workflow.id}/activate`, { version: 1 });
  const run = await request('POST', `/workflows/${workflow.id}/runs`, { input: { items: [{ title: 'One feature' }] } });
  return { project, run };
}

async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), 'perpeto-wiring-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** gh is always a PATH-injected executable; every git operation targets a local bare repo. */
async function fakeGitHub(t, root, repository, { blockClose = false, native = false } = {}) {
  const bin = join(root, 'bin'); await mkdir(bin);
  const stateFile = join(root, 'forge.json');
  const barrier = join(root, 'close-barrier'); const release = join(root, 'close-release');
  await writeFile(stateFile, JSON.stringify({ calls: [], prs: [] }));
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const stateFile = ${JSON.stringify(stateFile)}, repository = ${JSON.stringify(repository)};
const args = process.argv.slice(2), state = JSON.parse(fs.readFileSync(stateFile));
state.calls.push(args);
const opt = key => args[args.indexOf(key) + 1];
const git = (...a) => execFileSync('git', a, { cwd: repository, encoding: 'utf8' }).trim();
let result;
if (args[0] === 'pr' && args[1] === 'list') result = state.prs.filter(pr => pr.branch === opt('--head') && pr.state === 'OPEN');
else if (args[0] === 'pr' && args[1] === 'create') {
  const body = fs.readFileSync(0, 'utf8');
  const pr = { number: state.prs.length + 1, branch: opt('--head'), baseRefName: opt('--base'), state: 'OPEN', body };
  pr.url = 'https://github.com/example/fixture/pull/' + pr.number;
  pr.headRefOid = git('rev-parse', pr.branch); state.prs.push(pr); result = pr.url;
} else if (args[0] === 'pr' && args[1] === 'view') result = state.prs.find(pr => pr.number === Number(args[2]));
else if (args[0] === 'pr' && args[1] === 'close') { state.prs.find(pr => pr.number === Number(args[2])).state = 'CLOSED'; result = ''; }
else if (args[0] === 'pr' && args[1] === 'merge' && ${native}) {
  const pr = state.prs.find(pr => pr.number === Number(args[2])); pr.queued = true; result = '';
} else if (args[0] === 'api' && args[1] === 'graphql' && ${native}) {
  const pr = state.prs[0];
  if (pr.queued && pr.observed) { git('update-ref', 'refs/heads/main', pr.headRefOid); pr.state = 'MERGED'; pr.mergeCommit = { oid: pr.headRefOid }; }
  if (pr.queued) pr.observed = true;
  result = { data: { repository: { pullRequest: { ...pr, mergeQueue: { id: 'queue' }, mergeQueueEntry: pr.queued ? { id: 'entry' } : null } } } };
} else if (args[0] === 'api' && args[1] === 'repos/example/fixture/commits/main' && ${native}) result = git('rev-parse', 'main');
else { console.error('Unexpected stub command'); process.exit(97); }
fs.writeFileSync(stateFile, JSON.stringify(state));
if (args[1] === 'close' && ${blockClose} && !fs.existsSync(${JSON.stringify(release)})) {
  fs.writeFileSync(${JSON.stringify(barrier)}, 'closed after push');
  const until = Date.now() + 15000;
  while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result));
`;
  await writeFile(join(bin, 'gh'), source, { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  return { state: async () => JSON.parse(await readFile(stateFile, 'utf8')), barrier, release };
}

for (const publication of [undefined, 'github-merge-queue']) {
  test(`hub publishes GitHub PRs through ${publication ?? 'default fast-forward-push'} with real local origin and stub gh`, async t => {
    const root = await temp(t); const repository = await bareRepository(root);
    const initial = await git(repository, 'rev-parse', 'main');
    const repoUrl = publication ? repository : 'https://github.com/example/fixture.git';
    if (!publication) {
      // Exercise the public GitHub project URL without permitting a network Git remote.
      const gitConfig = join(root, 'gitconfig');
      await writeFile(gitConfig, `[url ${JSON.stringify(repository)}]\n  insteadOf = ${repoUrl}\n`);
      const previous = process.env.GIT_CONFIG_GLOBAL; process.env.GIT_CONFIG_GLOBAL = gitConfig;
      t.after(() => { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; });
    }
    const forge = await fakeGitHub(t, root, repository, { native: !!publication });
    const adapter = new GitHubAdapter({ repository: 'example/fixture' });
    const calls = [];
    const executor = { kind: 'fixture', canRun: () => true, async run(assignment, ctx) {
      calls.push(assignment);
      const source = join(ctx.workspace, 'source');
      await git(ctx.workspace, 'clone', assignment.repo.url, source);
      await git(source, 'checkout', '-b', 'feature'); await writeFile(join(source, 'feature.txt'), 'ready');
      await git(source, 'add', '.'); await git(source, 'commit', '-m', 'Feature'); await git(source, 'push', 'origin', 'HEAD:feature');
      return { outcome: 'success', summary: 'Feature ready', branch: 'feature', ...await adapter.createPullRequest({ branch: 'feature', baseBranch: 'main', title: 'Feature', body: 'Fixture PR\nLocal only.' }) };
    } };
    const factory = await startFactory(t, { executor, subprocess: true });
    const { project, run } = await startRun(factory.request, { url: repoUrl, defaultBranch: 'main' }, { publication });
    const finished = await eventually(async () => { const value = await factory.request('GET', `/runs/${run.id}`); return ['completed', 'failed'].includes(value.status) && value; });
    assert.equal(finished.status, 'completed'); assert.deepEqual(calls[0].repo, project.repo);
    const { entries } = await factory.request('GET', `/projects/${project.id}/merge-queue`);
    assert.equal(entries.length, 1); const entry = entries[0]; assert.equal(entry.status, 'merged'); assert.equal(entry.deliveryError, undefined);
    const jobs = (await factory.request('GET', `/jobs?runId=${run.id}`)).jobs;
    const candidate = jobs.find(job => job.delivery);
    assert.equal(candidate.status, 'passed'); assert.equal(candidate.revision, entry.testedRevision);
    const published = await git(repository, 'rev-parse', 'main'); assert.notEqual(published, initial); assert.equal(published, entry.mergedRevision);
    assert.equal(await git(repository, 'show', 'main:feature.txt'), 'ready');
    const state = await forge.state();
    assert.equal(state.calls.filter(call => call[1] === 'create').length, 1);
    if (publication) {
      assert.notEqual(entry.mergedRevision, entry.testedRevision);
      const merges = state.calls.filter(call => call[1] === 'merge'); assert.equal(merges.length, 1);
      assert.ok(merges[0].includes('--auto')); assert.ok(!merges[0].includes('--admin'));
    } else {
      assert.equal(entry.mergedRevision, entry.testedRevision); assert.equal(state.prs[0].state, 'CLOSED');
      const close = state.calls.find(call => call[1] === 'close'); assert.ok(close.includes('--comment')); assert.ok(close.at(-1).includes(candidate.revision));
    }
    t.diagnostic(`candidate CI ${candidate.revision}; published ${published}`);
  });
}

for (const phase of ['publication', 'hub projection']) test(`SIGKILL during ${phase} recovers the published candidate and closes the PR once`, async t => {
  let factory;
  let release;
  try {
    const root = await temp(t); const repository = await bareRepository(root);
    const forge = await fakeGitHub(t, root, repository, { blockClose: phase === 'publication' });
    const barrier = phase === 'publication' ? forge.barrier : join(root, 'sync-barrier');
    release = phase === 'publication' ? forge.release : join(root, 'sync-release');
    const adapter = new GitHubAdapter({ repository: 'example/fixture' });
    const executor = { kind: 'fixture', canRun: () => true, async run(assignment, ctx) {
      const source = join(ctx.workspace, 'source'); await git(ctx.workspace, 'clone', assignment.repo.url, source);
      await git(source, 'checkout', '-b', 'feature'); await writeFile(join(source, 'feature.txt'), 'recovered');
      await git(source, 'add', '.'); await git(source, 'commit', '-m', 'Feature'); await git(source, 'push', 'origin', 'HEAD:feature');
      return { outcome: 'success', summary: 'Ready', ...await adapter.createPullRequest({ branch: 'feature', baseBranch: 'main', title: 'Recovery', body: 'Fixture only' }) };
    } };
    factory = await startFactory(t, { executor, subprocess: phase === 'publication' ? true : { pauseBeforeMergedSync: { barrier, release } }, hub: { deliveryLeaseDurationMs: 3000 } });
    const { project, run } = await startRun(factory.request, { url: repository, defaultBranch: 'main' });
    await eventually(() => access(barrier).then(() => true, () => false));
    const published = await git(repository, 'rev-parse', 'main');
    await factory.hub.kill(); await writeFile(release, 'continue'); await factory.hub.restart();
    const finished = await eventually(async () => { const value = await factory.request('GET', `/runs/${run.id}`); return ['completed', 'failed'].includes(value.status) && value; });
    assert.equal(finished.status, 'completed');
    const { entries } = await factory.request('GET', `/projects/${project.id}/merge-queue`);
    assert.equal(entries[0].mergedRevision, published); assert.equal(entries[0].status, 'merged');
    assert.equal(await git(repository, 'rev-parse', 'main'), published);
    const jobs = (await factory.request('GET', `/jobs?runId=${run.id}`)).jobs.filter(job => job.delivery);
    assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'passed'); assert.equal(jobs[0].revision, published);
    const state = await forge.state(); assert.equal(state.calls.filter(call => call[1] === 'close').length, 1);
    const events = (await factory.events()).filter(event => event.runId === run.id);
    assert.equal(events.filter(event => event.type === 'gate.result' && event.data.gate === 'merge-queue').length, 1);
    assert.equal(factory.node.error, undefined);
    if (phase === 'hub projection') {
      // Teardown can remove the release marker before a final maintenance pump.
      // Once released, the injected fault must never arm again in the restarted process.
      await rm(release);
      await sleep(100);
      assert.equal((await factory.request('GET', `/runs/${run.id}`)).status, 'completed');
    }
  } finally {
    // Stop the hub before temp() removes files still used by the fault injector.
    if (factory) {
      if (phase === 'hub projection') await writeFile(release, 'cleanup');
      await factory.node.stop({ drain: false });
      await factory.hub.close();
    }
  }
});

test('SIGKILL across lease expiry fences stale results and retries with the same live node daemon', async t => {
  let first, aborted = false;
  const calls = [];
  const executor = { kind: 'fixture', canRun: () => true, async run(assignment, ctx) {
    calls.push(assignment);
    if (!first) {
      first = assignment;
      await new Promise(resolve => ctx.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      return { outcome: 'success', summary: 'Stale result must never win.' };
    }
    return { outcome: 'success', summary: 'Retry completed.' };
  } };
  const factory = await startFactory(t, { executor, subprocess: true, hub: { leaseDurationMs: 1200 },
    node: { timing: { heartbeatMs: 200, renewMs: 100, requestMs: 500, pollIdleMs: 20, backoffMinMs: 20, backoffMaxMs: 100 } } });
  const machineId = factory.node.status.machineId;
  const { project, run } = await startRun(factory.request, { url: '/unused.git', defaultBranch: 'main' }, { delivery: false });
  await eventually(() => first);
  await factory.hub.kill(); await sleep(1500); assert.equal(aborted, true);
  await factory.hub.restart();
  const finished = await eventually(async () => { const value = await factory.request('GET', `/runs/${run.id}`); return ['completed', 'failed'].includes(value.status) && value; });
  assert.equal(finished.status, 'completed'); assert.equal(calls.length, 2); assert.deepEqual(calls[1].repo, project.repo);
  assert.equal(calls[1].attempt, 2); assert.equal(calls[1].retryOf, first.id);
  const { assignments } = await factory.request('GET', `/runs/${run.id}/assignments`);
  assert.equal(assignments.find(a => a.id === first.id).status, 'failed');
  assert.ok(assignments.every(a => a.machineId === machineId));
  const credentials = JSON.parse(await readFile(join(factory.nodeDataDir, 'machine.json'), 'utf8'));
  const response = await fetch(`${factory.url}/api/v1/assignments/${first.id}/events`, { method: 'POST', headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'completed', attempt: first.attempt, idempotencyKey: 'stale-after-restart', data: { outcome: 'success', summary: 'Old result' } }) });
  assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'lease_lost');
  const events = (await factory.events()).filter(event => event.runId === run.id);
  assert.equal(events.filter(e => e.type === 'assignment.expired').length, 1);
  assert.equal(events.filter(e => e.type === 'workitem.retried').length, 1);
  assert.equal(factory.node.status.machineId, machineId); assert.equal(factory.node.status.state, 'running'); assert.equal(factory.node.error, undefined);
});

test('agent MCP messaging targets the hub and emits one run interaction for an idempotent send', async t => {
  const factory = await startFactory(t, { executor: { kind: 'unused', canRun: () => true, run: async () => ({ outcome: 'success', summary: 'Done' }) } });
  const { project, run } = await startRun(factory.request, { url: '/unused.git', defaultBranch: 'main' }, { delivery: false });
  const configPath = join(factory.root, 'client.json');
  await writeFile(configPath, JSON.stringify({ baseUrl: factory.url, projectId: project.id, channelId: `run-${run.id}`, roleId: 'builder', credentialFile: './hub/owner.secret' }));
  const send = { name: 'factory_send', arguments: { body: 'Ready for review', recipientRoleId: 'reviewer', idempotencyKey: 'mcp-send' } };
  const input = [{ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { id: 2, method: 'tools/call', params: send }, { id: 3, method: 'tools/call', params: send }].map(value => JSON.stringify({ jsonrpc: '2.0', ...value })).join('\n') + '\n';
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [packageBin('@perpeto/sdk', 'perpeto-messages'), '--config', configPath, 'mcp']);
    let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`MCP exited ${code}`))); child.stdin.end(input);
  });
  const replies = output.trim().split('\n').map(JSON.parse);
  assert.ok(replies.every(reply => reply.result && !reply.result.isError));
  const sent = JSON.parse(replies[1].result.content[0].text).message;
  assert.equal(JSON.parse(replies[2].result.content[0].text).message.id, sent.id);
  const events = (await factory.events()).filter(event => event.type === 'agent.messaged' && event.runId === run.id);
  assert.equal(events.length, 1); assert.equal(events[0].data.messageId, sent.id); assert.equal(events[0].data.sourceNodeId, 'builder');
  assert.equal(events[0].data.targetNodeId, 'reviewer'); assert.equal(events[0].data.unplanned, true);
});

test('GitHub clone URL parsing selects only supported public GitHub identities', () => {
  for (const url of ['https://github.com/example/fixture.git', 'https://github.com/example/fixture', 'git@github.com:example/fixture.git', 'ssh://git@github.com/example/fixture.git']) assert.equal(githubRepository(url), 'example/fixture');
  for (const url of ['/tmp/fixture.git', 'https://github.com.evil/example/fixture', 'https://secret@github.com/example/fixture']) assert.equal(githubRepository(url), null);
});
