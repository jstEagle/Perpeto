import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHub } from '../src/index.js';

const harness = { provider: 'codex', model: 'test' };
const node = (id, type, config = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const flow = (from, to) => ({ id: `${from}-${to}`, kind: 'flow', from: { node: from }, to: { node: to } });

async function fixture(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'perpeto-hub-goals-'));
  const configPath = join(directory, 'hub.json');
  await writeFile(configPath, JSON.stringify({ port: 0, longPollMs: 0, maintenanceIntervalMs: 60000, ...config }));
  let handle = await createHub({ configPath }); let url = await handle.listen();
  t.after(async () => { await handle.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = (await readFile(join(directory, 'owner.secret'), 'utf8')).trim();
  const request = async (method, path, body, token = owner) => {
    const response = await fetch(`${url}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const machine = async () => {
    const code = (await request('POST', '/machines/enrollment-codes', {})).body.code;
    const enrolled = (await request('POST', '/nodes/enroll', { code, name: 'm', os: 'linux', arch: 'x64', providers: ['codex'], version: 't' })).body;
    await request('POST', '/nodes/heartbeat', { status: 'online', capacity: { maxAgents: 1, maxJobs: 0 }, running: { agents: 0, jobs: 0 }, providers: ['codex'] }, enrolled.token);
    return {
      lease: async () => (await request('POST', '/nodes/lease', { kinds: ['assignment'] }, enrolled.token)).body.assignments[0],
      finish: (work, data) => request('POST', `/assignments/${work.id}/events`, { attempt: work.attempt, type: 'completed', data }, enrolled.token),
      token: enrolled.token,
    };
  };
  return { directory, request, machine, async restart() { await handle.close(); handle = await createHub({ configPath }); url = await handle.listen(); } };
}
async function start(f, project, graph, input) {
  const workflow = (await f.request('POST', `/projects/${project.id}/workflows`, { name: 'Flow', graph })).body;
  await f.request('POST', `/workflows/${workflow.id}/activate`, { version: 1 });
  return f.request('POST', `/workflows/${workflow.id}/runs`, { input });
}
const progress = goals => goals.map(goal => [goal.title, goal.done, goal.total]);

test('goals are objects with progress from the work items linked to them; string goals still read', async t => {
  const f = await fixture(t);
  const project = (await f.request('POST', '/projects', { name: 'Goals', repo: { url: '/tmp/goals.git', defaultBranch: 'main' }, goals: ['Ship Hub API v1', 'Run 100 agents'] })).body;
  assert.equal(project.goals.length, 2);
  for (const goal of project.goals) {
    assert.match(goal.id, /^goal_[a-f0-9]{12}$/); assert.equal(goal.status, 'active');
    assert.deepEqual([goal.workItemIds, goal.done, goal.total], [[], 0, 0]);
  }
  const [api, agents] = project.goals;
  // Editing keeps existing ids, gives new goals one, and accepts a status.
  const edited = (await f.request('PATCH', `/projects/${project.id}`, { goals: [{ id: api.id, title: api.title }, agents.title, { title: 'Clients follow Mono', status: 'dropped' }] })).body;
  assert.deepEqual(edited.goals.slice(0, 2).map(goal => goal.id), [api.id, agents.id]);
  assert.match(edited.goals[2].id, /^goal_/); assert.equal(edited.goals[2].status, 'dropped');
  assert.equal((await f.request('PATCH', `/projects/${project.id}`, { goals: [{ title: '' }] })).status, 400);
  assert.equal((await f.request('PATCH', `/projects/${project.id}`, { goals: [{ id: api.id, title: 'A' }, { id: api.id, title: 'B' }] })).status, 400);

  // Input items name the goal they serve; their work items link to it.
  const graph = { schema: 'perpeto.workflow/1', nodes: [node('ideas', 'input', { source: 'goals' }), node('builder', 'agent', { harness, prompt: 'Build.' }), node('done', 'output')],
    edges: [flow('ideas', 'builder'), flow('builder', 'done')] };
  assert.equal((await start(f, project, graph, { items: [{ title: 'Nope', goalId: 'goal_unknown' }] })).status, 400, 'an unknown goal is refused');
  const run = (await start(f, project, graph, { items: [{ title: 'Leases', goalId: api.id }, { title: 'Events', goalId: api.id }, { title: 'Untracked' }] })).body;
  assert.equal((await f.request('POST', `/runs/${run.id}/inputs`, { items: [{ title: 'Scale test', goalId: agents.id }] })).status, 202);
  assert.equal((await f.request('POST', `/runs/${run.id}/inputs`, { items: [{ title: 'Bad', goalId: 'goal_missing' }] })).status, 400);
  let goals = (await f.request('GET', `/projects/${project.id}`)).body.goals;
  assert.deepEqual(progress(goals), [['Ship Hub API v1', 0, 2], ['Run 100 agents', 0, 1], ['Clients follow Mono', 0, 0]]);
  const items = (await f.request('GET', `/runs/${run.id}/work-items`)).body.workItems;
  assert.deepEqual(goals[0].workItemIds, items.filter(item => ['Leases', 'Events'].includes(item.title)).map(item => item.id));

  // Finishing a linked item advances its goal.
  const worker = await f.machine();
  const first = await worker.lease();
  assert.equal((await worker.finish(first, { outcome: 'success', summary: 'Done.' })).status, 200);
  goals = (await f.request('GET', `/projects/${project.id}`)).body.goals;
  assert.deepEqual(progress(goals).slice(0, 1), [['Ship Hub API v1', 1, 2]]);
  const overview = (await f.request('GET', `/overview?projectId=${project.id}`)).body;
  assert.deepEqual(progress(overview.goals), progress(goals));
  assert.ok((await f.request('GET', '/overview')).body.goals.every(goal => goal.projectId === project.id));

  // Projects stored before goals were objects still read, with stable ids.
  await f.restart();
  const db = new DatabaseSync(join(f.directory, 'hub.sqlite'));
  const stored = JSON.parse(db.prepare("SELECT data FROM entities WHERE kind='project' AND id=?").get(project.id).data);
  db.prepare("UPDATE entities SET data=? WHERE kind='project' AND id=?").run(JSON.stringify({ ...stored, goals: ['Ship Hub API v1', 'Run 100 agents'] }), project.id);
  db.close();
  const legacy = (await f.request('GET', `/projects/${project.id}`)).body.goals;
  assert.deepEqual(legacy.map(goal => goal.id), [api.id, agents.id]); assert.deepEqual(progress(legacy), [['Ship Hub API v1', 1, 2], ['Run 100 agents', 0, 1]]);
});

test('planned work inherits its goal, and progress counts the planned items rather than the plan', async t => {
  const f = await fixture(t);
  const project = (await f.request('POST', '/projects', { name: 'Plans', repo: { url: '/tmp/plans.git', defaultBranch: 'main' }, goals: [{ title: 'Web and native clients follow Mono' }] })).body;
  const [goal] = project.goals;
  const graph = { schema: 'perpeto.workflow/1', nodes: [node('ideas', 'input', { source: 'goals' }), node('planner', 'planner', { harness, prompt: 'Plan.', maxItems: 5 }),
    node('builder', 'agent', { harness, prompt: 'Build.' }), node('done', 'output')], edges: [flow('ideas', 'planner'), flow('planner', 'builder'), flow('builder', 'done')] };
  const run = (await start(f, project, graph, { items: [{ title: 'Restyle the clients', goalId: goal.id }] })).body;
  const worker = await f.machine();
  const plan = await worker.lease(); assert.equal(plan.nodeId, 'planner');
  await worker.finish(plan, { outcome: 'success', summary: 'Three parts.', items: [{ title: 'Web' }, { title: 'Mac' }, { title: 'iPhone' }] });
  let [current] = (await f.request('GET', `/projects/${project.id}`)).body.goals;
  assert.deepEqual([current.done, current.total], [0, 3]);
  const children = (await f.request('GET', `/runs/${run.id}/work-items`)).body.workItems.filter(item => item.parentId);
  assert.deepEqual(current.workItemIds.sort(), children.map(item => item.id).sort());
  const build = await worker.lease(); await worker.finish(build, { outcome: 'success', summary: 'Done.' });
  [current] = (await f.request('GET', `/projects/${project.id}`)).body.goals;
  assert.deepEqual([current.done, current.total], [1, 3]);
});

test('the owner has a display name and initials from config, editable with PATCH /owner, on /session and /overview', async t => {
  const f = await fixture(t, { ownerName: 'Justus Hu' });
  assert.deepEqual((await f.request('GET', '/session')).body.owner, { name: 'Justus Hu', initials: 'JH' });
  assert.deepEqual((await f.request('GET', '/overview')).body.owner, { name: 'Justus Hu', initials: 'JH' });
  const updated = await f.request('PATCH', '/owner', { name: 'Justus', initials: 'JH' });
  assert.equal(updated.status, 200); assert.deepEqual(updated.body, { name: 'Justus', initials: 'JH' });
  assert.deepEqual((await f.request('PATCH', '/owner', { name: 'Ada Lovelace' })).body, { name: 'Ada Lovelace', initials: 'JH' }, 'set initials are kept');
  assert.deepEqual((await f.request('PATCH', '/owner', { initials: null })).body, { name: 'Ada Lovelace', initials: 'AL' }, 'cleared initials derive from the name');
  await f.restart();
  assert.deepEqual((await f.request('GET', '/owner')).body, { name: 'Ada Lovelace', initials: 'AL' });
  assert.deepEqual((await f.request('GET', '/session')).body.owner, { name: 'Ada Lovelace', initials: 'AL' });
  assert.deepEqual((await f.request('PATCH', '/owner', { name: null })).body, { name: 'Justus Hu', initials: 'JH' }, 'clearing the name falls back to config');
  for (const body of [{ initials: 'ABCD' }, { initials: '' }, { name: '' }, { name: 'x'.repeat(81) }, { other: 'x' }]) assert.equal((await f.request('PATCH', '/owner', body)).status, 400, JSON.stringify(body));
  const worker = await f.machine();
  assert.equal((await f.request('PATCH', '/owner', { name: 'Machine' }, worker.token)).status, 403);
});

test('without an owner name the profile is empty', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('GET', '/session')).body.owner, { name: null, initials: null });
});

test('a project git identity is validated and copied onto every assignment, including architect assignments', async t => {
  const f = await fixture(t);
  const identity = { name: 'Perpeto Agents', email: 'agents@lumin.example' };
  for (const gitIdentity of [{ name: 'A' }, { name: 'A\nB', email: 'a@b' }, { name: 'A <x>', email: 'a@b' }, { name: ' A', email: 'a@b' }, { name: 'A', email: 'nope' }, { name: 'A', email: 'a@b', extra: 1 }, 'A <a@b>']) {
    assert.equal((await f.request('POST', '/projects', { name: 'Bad', repo: { url: '/tmp/bad.git', defaultBranch: 'main' }, gitIdentity })).status, 400, JSON.stringify(gitIdentity));
  }
  const project = (await f.request('POST', '/projects', { name: 'Identity', repo: { url: '/tmp/identity.git', defaultBranch: 'main' }, gitIdentity: identity })).body;
  assert.deepEqual(project.gitIdentity, identity);
  const graph = { schema: 'perpeto.workflow/1', nodes: [node('ideas', 'input', { source: 'manual' }), node('builder', 'agent', { harness, prompt: 'Build.', concurrency: 3 }), node('done', 'output')],
    edges: [flow('ideas', 'builder'), flow('builder', 'done')] };
  const run = (await start(f, project, graph, { items: [{ title: 'First' }] })).body;
  const worker = await f.machine();
  assert.deepEqual((await worker.lease()).gitIdentity, identity, 'run assignments carry the project identity');
  const draft = (await f.request('POST', `/projects/${project.id}/workflows/drafts`, { prompt: 'Propose a workflow.' })).body;
  assert.deepEqual(draft.gitIdentity, identity, 'architect assignments carry it too');
  // Changes apply to assignments created afterwards; clearing it leaves the node's own identity to apply.
  const renamed = { name: 'Release Bot', email: 'release@lumin.example' };
  assert.deepEqual((await f.request('PATCH', `/projects/${project.id}`, { gitIdentity: renamed })).body.gitIdentity, renamed);
  await f.request('POST', `/runs/${run.id}/inputs`, { items: [{ title: 'Second' }] });
  const assignments = (await f.request('GET', `/runs/${run.id}/assignments`)).body.assignments;
  assert.deepEqual(assignments.map(value => value.gitIdentity), [identity, renamed]);
  const cleared = (await f.request('PATCH', `/projects/${project.id}`, { gitIdentity: null })).body;
  assert.equal(Object.hasOwn(cleared, 'gitIdentity'), false);
  await f.request('POST', `/runs/${run.id}/inputs`, { items: [{ title: 'Third' }] });
  assert.deepEqual((await f.request('GET', `/runs/${run.id}/assignments`)).body.assignments.map(value => value.gitIdentity), [identity, renamed, undefined]);
  assert.equal((await f.request('PATCH', `/projects/${project.id}`, { gitIdentity: { name: 'X' } })).status, 400);
});
