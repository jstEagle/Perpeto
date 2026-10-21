import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { step, replay, RunStore, validateGraph } from '../src/index.js';
import { Driver, code } from './fixtures.js';

const graph = (source = 'goals') => ({ schema: 'perpeto.workflow/1', nodes: [
  { id: 'in', type: 'input', label: 'Input', position: { x: 0, y: 0 }, config: { source, ...(source === 'schedule' ? { schedule: '0 2 * * *' } : {}) } },
  { id: 'dev', type: 'agent', label: 'Dev', position: { x: 1, y: 0 }, config: { harness: { provider: 'codex', model: 'test' }, prompt: 'Work', concurrency: 4, retry: { maxAttempts: 2, backoffSec: 30 } } },
  { id: 'out', type: 'output', label: 'Done', position: { x: 2, y: 0 }, config: {} },
], edges: [ ['in','dev'], ['dev','out'] ].map(([a,b]) => ({ id: a+b, kind: 'flow', from: { node:a }, to:{ node:b } })) });
const requests = result => result.effects.filter(e => e.type === 'request-input');
const tick = (state, at, id = at) => step(state, { id, type: 'input.tick', at, data: {} });

test('goals refill durably, with only one outstanding request and empty responses back off until a tick', () => {
  const d = new Driver();
  d.start({ graph: graph(), keepOpen: true, inputs: [] });
  const request = requests(d.last)[0];
  assert.equal(request.source, 'goals');
  assert.equal(request.nodeId, 'in');
  assert.equal(d.emitted('input.requested').length, 1);
  d.apply('input.tick');
  assert.equal(requests(d.last).length, 0);
  assert.throws(() => d.apply('input.added', { requestId: 'wrong', items: [] }), code('STALE_INPUT_REQUEST'));
  d.apply('input.added', { requestId: request.requestId, items: [] });
  assert.equal(requests(d.last).length, 0);
  d.apply('input.tick');
  const next = requests(d.last)[0];
  d.apply('input.added', { requestId: next.requestId, items: [{ title: 'Unfinished goal' }] });
  d.complete('dev', { outcome: 'success' });
  assert.equal(requests(d.last).length, 1);
  assert.equal(d.state.status, 'running');
  assert.deepEqual(replay(d.events), d.state);
});

test('manual sources stay open without auto intake; scheduled sources match UTC cron and dedupe minutes', () => {
  const d = new Driver(); d.start({ graph: graph('manual'), keepOpen: true, inputs: [] });
  assert.equal(requests(d.last).length, 0);
  assert.equal(requests(d.apply('input.tick')).length, 0);
  assert.deepEqual(validateGraph(graph('schedule')), { ok: true, errors: [], warnings: [] });
  const s = new Driver(); s.start({ graph: graph('schedule'), keepOpen: true, inputs: [] });
  assert.equal(requests(tick(s.state, '2026-10-22T01:00:00.000Z')).length, 0);
  const due = tick(s.state, '2026-10-22T02:00:00.000Z');
  assert.equal(requests(due).length, 1);
  const filled = step(due.state, { id: 'empty', type: 'input.added', at: '2026-10-22T02:00:01.000Z', data: { requestId: requests(due)[0].requestId, items: [] } });
  assert.equal(requests(tick(filled.state, '2026-10-22T02:00:30.000Z')).length, 0);
  assert.equal(requests(tick(filled.state, '2026-10-23T02:00:00.000Z')).length, 1);
});

test('active and daily item budgets stop intake, dedupe exhaustion, and recover capacity/day', () => {
  const d = new Driver(); d.start({ graph: graph('manual'), keepOpen: true, budget: { maxActiveItems: 1, maxItemsPerDay: 2 }, inputs: [{ title: 'one' }] });
  d.apply('input.added', { items: [{ title: 'two' }] });
  assert.equal(d.items().length, 1);
  assert.equal(d.emitted('budget.exhausted').at(-1).data.limit, 'maxActiveItems');
  d.apply('input.added', { items: [{ title: 'two' }] });
  assert.equal(d.emitted('budget.exhausted').length, 1);
  d.complete('dev', { outcome: 'success' });
  d.apply('input.added', { items: [{ title: 'two' }] });
  d.complete('dev', { outcome: 'success' });
  d.apply('input.added', { items: [{ title: 'three' }] });
  assert.equal(d.items().length, 2);
  assert.equal(d.emitted('budget.exhausted').at(-1).data.limit, 'maxItemsPerDay');
  const next = step(d.state, { id:'tomorrow', type:'input.added', at:'2026-10-22T00:00:00.000Z', data:{ items:[{title:'three'}] } });
  assert.equal(Object.keys(next.state.workItems).length, 3);
  assert.equal(next.state.intake.reason.limit, 'maxActiveItems');
  assert.ok(next.effects.some(e => e.event?.type === 'budget.available'));
});

test('usage pauses intake but lets existing work finish, with UTC reset and validation', () => {
  const d = new Driver(); d.start({ graph:graph('manual'), keepOpen:true, budget:{ maxTokensPerDay:10 }, inputs:[{title:'one'}] });
  d.apply('usage.recorded', { inputTokens:6, outputTokens:4 });
  assert.equal(d.state.intake.paused, true);
  d.complete('dev', {outcome:'success'});
  d.apply('input.added', {items:[{title:'two'}]});
  assert.equal(d.items().length, 1);
  for (const budget of [{maxActiveItems:0},{maxTokensPerDay:-1},{maxItemsPerDay:1.2},{typo:10},null]) {
    assert.throws(() => new Driver().start({graph:graph(),budget}), code('INVALID_EVENT'));
  }
  assert.throws(() => d.apply('usage.recorded', {inputTokens:-1,outputTokens:0}),code('INVALID_EVENT'));
});

test('continuous request and budget survive store restart, duplicate events and replay', () => {
  const dir = mkdtempSync(join(tmpdir(),'perpeto-continuous-'));
  const path = join(dir,'runs.sqlite');
  let store = new RunStore(path);
  try {
    const d = new Driver((_, event) => store.apply('run_test1',event));
    d.start({graph:graph(),keepOpen:true,budget:{maxItemsPerDay:1},inputs:[]});
    const request = requests(d.last)[0];
    const before = store.getState('run_test1');
    store.close(); store = new RunStore(path);
    assert.deepEqual(store.getState('run_test1'),before);
    const added = d.apply('input.added',{requestId:request.requestId,items:[{title:'goal'}]});
    assert.equal(store.apply('run_test1',d.events.at(-1)).duplicate,true);
    assert.equal(Object.keys(added.state.workItems).length,1);
    assert.equal(store.verify('run_test1').ok,true);
    assert.ok(store.pendingEffects({limit:100}).some(row=>row.effect.type==='request-input'));
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('planner expansion defers every item beyond active and daily budgets without losing proposals', () => {
  const g = graph('manual');
  g.nodes.splice(1, 0, { id:'plan', type:'planner', label:'Plan', position:{x:0,y:0}, config:{harness:{provider:'codex',model:'test'},prompt:'Plan',maxItems:5,retry:{maxAttempts:2,backoffSec:30}} });
  g.edges[0].to.node = 'plan';
  g.edges.push({id:'plan-dev',kind:'flow',from:{node:'plan'},to:{node:'dev'}});
  const d = new Driver(); d.start({graph:g,keepOpen:true,budget:{maxActiveItems:1,maxItemsPerDay:3},inputs:[{title:'goal'}]});
  d.complete('plan',{outcome:'success',items:[{title:'a'},{title:'b'},{title:'c'}]});
  assert.equal(d.open('dev').length,1);
  const parent = d.items(i=>!i.parentId)[0];
  assert.equal(parent.pendingPlan.length,2);
  assert.equal(d.items().length,2);
  d.complete('dev',{outcome:'success'});
  assert.equal(d.open('dev').length,1);
  assert.equal(d.items().length,3);
  d.complete('dev',{outcome:'success'});
  assert.equal(d.open('dev').length,0);
  assert.equal(d.state.workItems[parent.id].status,'active');
  const tomorrow = tick(d.state,'2026-10-22T00:00:00.000Z');
  const assignments = Object.values(tomorrow.state.assignments).filter(a=>a.status==='queued');
  assert.equal(assignments.length,1);
  const done = step(tomorrow.state,{id:'done',type:'assignment.completed',at:'2026-10-22T00:01:00.000Z',data:{assignmentId:assignments[0].id,result:{outcome:'success',summary:'done'}}});
  assert.equal(done.state.workItems[parent.id].status,'done');
  assert.equal(Object.keys(done.state.workItems).length,4);
  assert.deepEqual(replay([...d.events,{id:'2026-10-22T00:00:00.000Z',type:'input.tick',at:'2026-10-22T00:00:00.000Z',data:{}},{id:'done',type:'assignment.completed',at:'2026-10-22T00:01:00.000Z',data:{assignmentId:assignments[0].id,result:{outcome:'success',summary:'done'}}}]),done.state);
});

test('explicit empty auditor output ends a pass; other planners keep whole-item semantics', () => {
  const g = graph(); g.nodes[1].type='planner';g.nodes[1].config.emptyResult='complete';
  const d = new Driver(); d.start({graph:g,keepOpen:true,inputs:[{title:'audit'}]});
  assert.match(d.open('dev')[0].prompt, /empty items array completes this pass/);
  assert.doesNotMatch(d.open('dev')[0].prompt, /keep it whole/);
  d.complete('dev',{outcome:'success',items:[]});
  assert.equal(d.items()[0].status,'done');
  assert.equal(d.items()[0].nodeId,'dev');
  assert.equal(requests(d.last).length,0);
  assert.equal(requests(d.apply('input.tick')).length,1);
});

test('paused/stopped runs cannot request intake, and budget events preserve frozen previous state', () => {
  const d = new Driver();d.start({graph:graph(),keepOpen:true,inputs:[],budget:{maxTokensPerDay:5}});
  d.apply('run.paused');
  assert.equal(d.apply('input.tick').ignored,'run_not_running');
  const previous = d.state;
  const frozen = structuredClone(previous);
  const freeze = value => { if (value && typeof value==='object') { Object.freeze(value);Object.values(value).forEach(freeze); } };
  freeze(d.state);
  d.apply('usage.recorded',{inputTokens:5,outputTokens:0});
  assert.deepEqual(previous,frozen);
  assert.equal(d.state.intake.paused,true);
  d.apply('run.stopped');
  assert.equal(requests(d.apply('input.tick')).length,0);
});

test('schedule validation rejects malformed and missing expressions; cron handles ranges, steps and day OR', () => {
  for (const schedule of [undefined,'* * *','60 * * * *','*/0 * * * *','* 24 * * *','* * * * 7','* * * * *; bad']) {
    const g = graph('schedule');g.nodes[0].config.schedule=schedule;
    if (schedule===undefined) delete g.nodes[0].config.schedule;
    assert.equal(validateGraph(g).ok,false,String(schedule));
  }
  const g = graph('schedule');g.nodes[0].config.schedule='*/15 1-3 1 * 4';
  const d = new Driver();d.start({graph:g,keepOpen:true,inputs:[]});
  assert.equal(requests(tick(d.state,'2026-10-22T02:15:00.000Z')).length,1); // Thursday, not the 1st.
  assert.equal(requests(tick(d.state,'2026-11-01T02:15:00.000Z')).length,1); // 1st, not Thursday.
  assert.equal(requests(tick(d.state,'2026-10-23T02:15:00.000Z')).length,0);
});

test('run-level source/schedule overrides persist and old timestamps cannot reset a daily allowance', () => {
  const d = new Driver();d.start({graph:graph('manual'),source:'schedule',schedule:'30 1 * * *',keepOpen:true,inputs:[],budget:{maxTokensPerDay:10}});
  assert.equal(requests(tick(d.state,'2026-10-22T01:30:00.000Z')).length,1);
  const spent = step(d.state,{id:'usage',type:'usage.recorded',at:'2026-10-22T01:00:00.000Z',data:{inputTokens:10,outputTokens:0}});
  const earlier = tick(spent.state,'2026-10-21T01:30:00.000Z');
  assert.equal(requests(earlier).length,0);
  assert.equal(earlier.state.budgetUsage.day,'2026-10-22');
  assert.equal(earlier.state.intake.reason.limit,'maxTokensPerDay');
  const reset = tick(earlier.state,'2026-10-23T01:30:00.000Z');
  assert.equal(requests(reset).length,1);
});

test('persisted deferred planner children resume after restart and usage deltas are idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(),'perpeto-deferred-'));
  const path = join(dir,'runs.sqlite');let store = new RunStore(path);
  try {
    const g = graph('manual');g.nodes[1].type='planner';g.nodes[1].config.maxItems=3;
    const d = new Driver((_,event)=>store.apply('run_test1',event));
    d.start({graph:g,keepOpen:true,inputs:[{title:'audit'}],budget:{maxItemsPerDay:1,maxTokensPerDay:100}});
    d.complete('dev',{outcome:'success',items:[{title:'one'},{title:'two'}]});
    assert.equal(d.items()[0].pendingPlan.length,2);
    const usage = d.event('usage.recorded',{inputTokens:30,outputTokens:20});
    store.apply('run_test1',usage);store.apply('run_test1',usage);
    assert.equal(store.getState('run_test1').budgetUsage.tokens,50);
    store.close();store = new RunStore(path);
    store.apply('run_test1',{id:'nextday',type:'input.tick',at:'2026-10-22T00:00:00.000Z',data:{}});
    const state = store.getState('run_test1');
    assert.equal(state.budgetUsage.items,1);
    assert.equal(state.workItems.wi_test1_1.pendingPlan.length,1);
    assert.equal(store.verify('run_test1').ok,true);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
