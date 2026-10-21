import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RunStore, canonicalJson } from '../src/index.js';
import { Driver, bare, sha, code } from './fixtures.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'perpeto-workflow-'));
  const filename = join(directory, 'runs.sqlite');
  const stores = [];
  const open = () => { const store = new RunStore(filename); stores.push(store); return store; };
  t.after(() => {
    for (const store of stores) { try { store.close(); } catch { /* Already closed. */ } }
    rmSync(directory, { recursive: true, force: true });
  });
  return { open };
}

/** A Driver whose events go through the store, so tests read the same state the hub would. */
function storeDriver(holder) {
  return new Driver((_state, event) => holder.store.apply('run_test1', event));
}

const built = n => ({ outcome: 'success', summary: 'built', branch: `b${n}`, prUrl: `https://git.example/pull/${n}`, headSha: sha(n) });

test('persists a run across restarts mid-run and finishes it', t => {
  const { open } = fixture(t);
  const holder = { store: open() };
  const run = storeDriver(holder);
  run.start();
  run.complete('planner', { outcome: 'success', items: [{ title: 'A' }, { title: 'B' }] });
  run.complete('builder', built(1));

  holder.store.close();
  holder.store = open();
  run.state = holder.store.getState('run_test1');
  assert.equal(run.state.status, 'running');
  assert.equal(holder.store.listAssignments('run_test1', { status: 'queued' }).length, 2);

  run.complete('builder', built(2));
  run.complete('reviewer', { outcome: 'success' });
  run.complete('reviewer', { outcome: 'success' });
  holder.store.close();
  holder.store = open();
  run.state = holder.store.getState('run_test1');
  for (const job of holder.store.listJobs('run_test1', { status: 'queued' })) run.apply('job.completed', { jobId: job.id, status: 'passed' });
  for (const entry of holder.store.listMergeEntries('run_test1', { status: 'queued' })) run.apply('merge.completed', { mergeId: entry.id });

  const summary = holder.store.getRun('run_test1');
  assert.equal(summary.status, 'completed');
  assert.equal(summary.projectId, 'prj_1');
  assert.equal(summary.lastSeq, run.events.length);
  assert.deepEqual(holder.store.listWorkItems('run_test1').map(item => item.status), ['done', 'done', 'done']);
  assert.equal(holder.store.listMergeEntries('run_test1', { status: 'merged' }).length, 2);
  assert.equal(holder.store.getWorkItem(holder.store.listWorkItems('run_test1', { nodeId: 'shipped' })[0].id).nodeId, 'shipped');
  assert.deepEqual(holder.store.listRuns({ projectId: 'prj_1' }).map(r => r.id), ['run_test1']);
  assert.deepEqual(holder.store.verify('run_test1'), { ok: true, events: run.events.length });
  assert.equal(holder.store.listEvents('run_test1', { after: 2, limit: 2 }).map(e => e.seq).join(), '3,4');
});

test('duplicate event ids return the original result; changed content conflicts', t => {
  const { open } = fixture(t);
  const holder = { store: open() };
  const run = storeDriver(holder);
  run.start();
  const assignmentId = run.open('planner')[0].id;
  const event = run.event('assignment.completed', { assignmentId, result: { outcome: 'success', summary: 'ok', items: [{ title: 'A' }] } });
  const first = holder.store.apply('run_test1', event);
  assert.equal(first.duplicate, false);

  const retry = holder.store.apply('run_test1', { ...event, at: '2026-10-21T12:00:00Z' });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.seq, first.seq);
  assert.deepEqual(retry.effects, first.effects);
  assert.equal(holder.store.listWorkItems('run_test1').length, 2, 'no second child created');

  assert.throws(() => holder.store.apply('run_test1', { ...event, data: { ...event.data, result: { outcome: 'failure', summary: 'no' } } }), code('IDEMPOTENCY_CONFLICT'));

  // A new event id carrying the same result is recorded but ignored by the engine.
  const late = holder.store.apply('run_test1', { ...event, id: 'evt_late' });
  assert.equal(late.ignored, 'assignment_closed');
  assert.deepEqual(late.effects, []);
  assert.equal(holder.store.apply('run_test1', { ...event, id: 'evt_late' }).ignored, 'assignment_closed');
  assert.equal(holder.store.verify('run_test1').ok, true);
});

test('effects outbox survives restart until acknowledged', t => {
  const { open } = fixture(t);
  const holder = { store: open() };
  const run = storeDriver(holder);
  run.start();
  const pending = holder.store.pendingEffects();
  assert.deepEqual(pending.map(p => p.effect.type), ['emit-event', 'create-work-item', 'emit-event', 'create-assignment', 'emit-event']);
  assert.equal(holder.store.ackEffects(pending.slice(0, 2).map(p => p.id)), 2);
  assert.equal(holder.store.ackEffects([pending[0].id]), 0);

  holder.store.close();
  holder.store = open();
  const after = holder.store.pendingEffects({ runId: 'run_test1' });
  assert.deepEqual(after.map(p => p.id), pending.slice(2).map(p => p.id));
  assert.equal(after.find(p => p.effect.type === 'create-assignment').effect.assignment.role, 'planner');
});

test('a rejected event leaves no trace', t => {
  const { open } = fixture(t);
  const holder = { store: open() };
  const run = storeDriver(holder);
  run.start();
  const before = holder.store.getRun('run_test1');
  const bad = run.event('assignment.completed', { assignmentId: run.open('planner')[0].id, result: { outcome: 'success', summary: '', headSha: 'xyz' } });
  assert.throws(() => holder.store.apply('run_test1', bad), code('INVALID_EVENT'));
  assert.deepEqual(holder.store.getRun('run_test1'), before);
  assert.equal(holder.store.listEvents('run_test1').length, 1);
  // The id is still free for a corrected event.
  holder.store.apply('run_test1', { ...bad, data: { ...bad.data, result: { outcome: 'success', summary: '', items: [] } } });
  assert.equal(holder.store.getRun('run_test1').lastSeq, 2);
});

test('validates run ids and run.started consistency', t => {
  const { open } = fixture(t);
  const store = open();
  const run = new Driver();
  const started = run.event('run.started', { runId: 'run_other', projectId: 'p', workflowId: 'w', workflowVersion: 1, graph: {} });
  assert.throws(() => store.apply('run_test1', started), code('INVALID_EVENT'));
  assert.throws(() => store.apply('bad id', started), code('INVALID_INPUT'));
  assert.throws(() => store.apply('run_test1', run.event('run.paused')), code('RUN_NOT_FOUND'));
  assert.equal(store.getRun('run_test1'), null);
  assert.equal(store.getState('run_test1'), null);
});

test('verify replays graphs whose warnings depend on key order', t => {
  // The store keeps events with sorted keys, so warnings must not depend on the order keys were written in.
  const { open } = fixture(t);
  const holder = { store: open() };
  const graph = { ...bare('build'), zeta: 1, alpha: 2 };
  const builder = graph.nodes.find(entry => entry.id === 'builder');
  builder.config = { zulu: 1, ...builder.config, alpha: 2 };
  const run = storeDriver(holder);
  run.start({ graph });
  assert.equal(run.state.plan.warnings.length, 3);
  assert.deepEqual(holder.store.verify('run_test1'), { ok: true, events: 1 });
});

test('two stores on one file stay consistent', t => {
  const { open } = fixture(t);
  const a = open(), b = open();
  const holder = { store: a };
  const run = storeDriver(holder);
  run.start();
  run.complete('planner', { outcome: 'success', items: [{ title: 'A' }, { title: 'B' }] });
  holder.store = b;
  run.complete('builder', built(1));
  holder.store = a;
  run.complete('builder', built(2));
  assert.equal(a.listAssignments('run_test1', { nodeId: 'reviewer' }).length, 2);
  assert.deepEqual(b.verify('run_test1'), { ok: true, events: 4 });
});

test('a result state is a private copy as of its event', t => {
  const { open } = fixture(t);
  const store = open();
  const run = new Driver((_state, event) => store.apply('run_test1', event));
  run.start();
  const planned = run.complete('planner', { outcome: 'success', items: [{ title: 'A' }] });
  run.complete('builder', built(1));
  // Read after a later event, the state is still the one this event produced.
  const before = planned.state;
  assert.equal(Object.values(before.assignments).filter(a => a.nodeId === 'reviewer').length, 0);
  assert.equal(before, planned.state);
  run.state.status = 'mutated';
  run.state.workItems = {};
  assert.equal(store.getState('run_test1').status, 'running');
  assert.equal(store.verify('run_test1').ok, true);
  run.complete('reviewer', { outcome: 'success' });
  assert.equal(store.getRun('run_test1').lastSeq, 4);
});

/** The schema 1 layout, which stored the whole state in `runs.state` on every event. */
const SCHEMA_1 = `
  CREATE TABLE runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workflow_id TEXT NOT NULL, workflow_version INTEGER NOT NULL,
    status TEXT NOT NULL, started_at TEXT NOT NULL, stopped_at TEXT, updated_at TEXT NOT NULL, last_seq INTEGER NOT NULL, state TEXT NOT NULL) STRICT;
  CREATE INDEX runs_project ON runs(project_id, status);
  CREATE TABLE run_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL,
    fingerprint TEXT NOT NULL, event TEXT NOT NULL, effects TEXT NOT NULL, ignored TEXT, applied_at TEXT NOT NULL,
    PRIMARY KEY (run_id, seq), UNIQUE (run_id, event_id)) STRICT;
  CREATE TABLE work_items (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL, status TEXT NOT NULL, parent_id TEXT, data TEXT NOT NULL) STRICT;
  CREATE INDEX work_items_run ON work_items(run_id, status);
  CREATE TABLE assignments (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, work_item_id TEXT NOT NULL, node_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL) STRICT;
  CREATE INDEX assignments_run ON assignments(run_id, status);
  CREATE INDEX assignments_status ON assignments(status);
  CREATE TABLE jobs (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, work_item_id TEXT NOT NULL, node_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL) STRICT;
  CREATE INDEX jobs_run ON jobs(run_id, status);
  CREATE TABLE merge_entries (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, work_item_id TEXT NOT NULL, node_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL) STRICT;
  CREATE INDEX merge_entries_run ON merge_entries(run_id, status);
  CREATE TABLE effects (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, seq INTEGER NOT NULL, effect TEXT NOT NULL, acked_at TEXT) STRICT;
  CREATE INDEX effects_pending ON effects(acked_at, id);
  PRAGMA user_version = 1;
`;

test('opens a schema 1 store and carries on with its runs', t => {
  const directory = mkdtempSync(join(tmpdir(), 'perpeto-workflow-'));
  const filename = join(directory, 'runs.sqlite');
  let store;
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  const run = new Driver();
  run.start();
  run.complete('planner', { outcome: 'success', items: [{ title: 'A' }, { title: 'B' }] });
  run.complete('builder', built(1));
  const db = new DatabaseSync(filename);
  db.exec(SCHEMA_1);
  const { state } = run;
  db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)').run(
    state.runId, state.projectId, state.workflowId, state.workflowVersion, state.status, state.startedAt, state.updatedAt, run.events.length, JSON.stringify(state));
  run.events.forEach((event, index) => db.prepare('INSERT INTO run_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)').run(
    state.runId, index + 1, event.id, event.type, event.at, canonicalJson({ type: event.type, data: event.data }), canonicalJson(event), '[]', event.at));
  for (const [key, table] of [['workItems', 'work_items'], ['assignments', 'assignments']]) {
    for (const entity of Object.values(state[key])) {
      db.prepare(`INSERT INTO ${table} (id, run_id, node_id, status, data, ${key === 'workItems' ? 'parent_id' : 'work_item_id'}) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(entity.id, state.runId, entity.nodeId, entity.status, JSON.stringify(entity), (key === 'workItems' ? entity.parentId : entity.workItemId) ?? null);
    }
  }
  db.close();

  store = new RunStore(filename);
  assert.equal(canonicalJson(store.getState('run_test1')), canonicalJson(state));
  assert.deepEqual(store.verify('run_test1'), { ok: true, events: 3 });
  const next = new Driver((_state, event) => store.apply('run_test1', event));
  Object.assign(next, { state, events: [...run.events], minute: run.minute });
  next.complete('builder', built(2));
  assert.equal(store.listAssignments('run_test1', { nodeId: 'reviewer' }).length, 2);
  assert.equal(store.verify('run_test1').ok, true);
});
