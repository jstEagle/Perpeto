import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGraph, compileGraph, classifyInteraction } from '../src/index.js';
import { template, code } from './fixtures.js';

const codes = result => result.errors.map(error => error.code);
const harness = { provider: 'claudeAgent', model: 'claude-sonnet-5-5' };
const node = (id, type, config = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const flow = (id, from, to, port) => ({ id, kind: 'flow', from: port ? { node: from, port } : { node: from }, to: { node: to } });
const minimal = () => ({
  schema: 'perpeto.workflow/1',
  nodes: [node('in', 'input', { source: 'manual' }), node('dev', 'agent', { harness, prompt: 'Build it.' }), node('out', 'output')],
  edges: [flow('e1', 'in', 'dev'), flow('e2', 'dev', 'out')],
});
const edit = (graph, fn) => { const copy = structuredClone(graph); fn(copy); return copy; };
const find = (graph, id) => graph.nodes.find(candidate => candidate.id === id);

test('templates are valid with no warnings', () => {
  for (const name of ['build', 'improve']) assert.deepEqual(validateGraph(template(name)), { ok: true, errors: [], warnings: [] }, name);
});

test('compiles routing, loops and derived role authority', () => {
  const plan = compileGraph(template('build'));
  assert.equal(plan.plan, 'perpeto.plan/1');
  assert.match(plan.graphHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(plan.inputs, ['ideas']);
  assert.deepEqual(plan.nodes.reviewer.routes, {
    pass: { node: 'ci', edgeId: 'reviewer-pass' }, fail: { node: 'review-loop', edgeId: 'reviewer-fail' },
  });
  assert.deepEqual(plan.nodes.merge.routes.fail, { node: 'delivery-loop', edgeId: 'merge-fail' });
  assert.deepEqual(plan.loops['review-loop'].body, ['builder', 'reviewer']);
  assert.deepEqual(plan.loops['review-loop'].backSources, ['reviewer']);
  assert.deepEqual(plan.loops['delivery-loop'].backSources, ['ci', 'merge']);
  assert.deepEqual(plan.roles.builder.policy, {
    maxSubagents: 2, allowedSubagentProviders: ['claudeAgent'], canMessage: ['helper', 'planner', 'reviewer'], maxTurns: 200,
  });
  assert.deepEqual(plan.roles.builder.delegatesTo, ['helper']);
  assert.equal(plan.roles.helper.delegateOnly, true);
  assert.deepEqual(plan.roles.helper.policy, { maxSubagents: 0, allowedSubagentProviders: [], canMessage: ['builder'] });
  assert.deepEqual(plan.roles.reviewer.requirements, { providers: ['claudeAgent'] });
  assert.equal(plan.roles.planner.concurrency, 1);
  assert.equal(plan.nodes.planner.config.maxItems, 8);
});

test('subagent limit is bounded by delegate concurrency', () => {
  const graph = edit(template('build'), g => { find(g, 'builder').config.policy.maxSubagents = 10; });
  assert.equal(compileGraph(graph).roles.builder.policy.maxSubagents, 2);
});

test('custom role ids drive canMessage and must be unique', () => {
  const graph = edit(template('build'), g => { find(g, 'reviewer').config.role = 'code-reviewer'; });
  assert.deepEqual(compileGraph(graph).roles.builder.policy.canMessage, ['code-reviewer', 'helper', 'planner']);
  const clash = edit(graph, g => { find(g, 'helper').config.role = 'code-reviewer'; });
  assert.ok(codes(validateGraph(clash)).includes('DUPLICATE_ROLE'));
});

test('compileGraph throws INVALID_GRAPH with the validation result', () => {
  assert.throws(() => compileGraph({ schema: 'nope' }), error => code('INVALID_GRAPH')(error) && error.details.errors.length > 0);
});

test('never throws on malformed input', () => {
  for (const input of [null, 7, 'graph', [], { schema: 'perpeto.workflow/1' }, { schema: 'perpeto.workflow/1', nodes: [null, 3], edges: [null] }]) {
    const result = validateGraph(input);
    assert.equal(result.ok, false);
  }
  assert.ok(codes(validateGraph({ ...minimal(), schema: 'perpeto.workflow/2' })).includes('INVALID_SCHEMA'));
});

const cases = [
  ['unknown node type', g => { g.nodes.push(node('x', 'robot')); }, 'UNKNOWN_NODE_TYPE'],
  ['duplicate node id', g => { g.nodes.push(node('dev', 'output')); }, 'DUPLICATE_ID'],
  ['dangling edge', g => { g.edges.push(flow('e3', 'dev', 'ghost')); }, 'DANGLING_EDGE'],
  ['unknown edge kind', g => { g.edges.push({ ...flow('e3', 'dev', 'out'), kind: 'teleports' }); }, 'INVALID_EDGE_KIND'],
  ['missing harness', g => { delete find(g, 'dev').config.harness; }, 'MISSING_CONFIG'],
  ['missing input source', g => { delete find(g, 'in').config.source; }, 'MISSING_CONFIG'],
  ['harness without model', g => { find(g, 'dev').config.harness = { provider: 'codex' }; }, 'INVALID_HARNESS'],
  ['harness with unknown key', g => { find(g, 'dev').config.harness = { ...harness, apiKey: 'x' }; }, 'INVALID_HARNESS'],
  ['harness options of wrong type', g => { find(g, 'dev').config.harness = { ...harness, options: { effort: 3 } }; }, 'INVALID_HARNESS'],
  ['policy with negative subagents', g => { find(g, 'dev').config.policy = { maxSubagents: -1 }; }, 'INVALID_POLICY'],
  ['policy with unknown key', g => { find(g, 'dev').config.policy = { root: true }; }, 'INVALID_POLICY'],
  ['policy not an object', g => { find(g, 'dev').config.policy = 'none'; }, 'INVALID_POLICY'],
  ['bad concurrency', g => { find(g, 'dev').config.concurrency = 0; }, 'INVALID_CONFIG'],
  ['unreachable node', g => { g.nodes.push(node('lost', 'agent', { harness, prompt: 'p' })); g.edges.push(flow('e3', 'lost', 'out')); }, 'UNREACHABLE_NODE'],
  ['no output', g => { g.nodes = g.nodes.filter(n => n.id !== 'out'); g.edges = [g.edges[0]]; }, 'NO_OUTPUT'],
  ['no input', g => { g.nodes = g.nodes.filter(n => n.id !== 'in'); g.edges = [g.edges[1]]; }, 'NO_INPUT'],
  ['agent without flow out', g => { g.edges = [g.edges[0]]; }, 'MISSING_FLOW_OUT'],
  ['two routes from one output', g => { g.nodes.push(node('out2', 'output')); g.edges.push(flow('e3', 'dev', 'out2')); }, 'AMBIGUOUS_ROUTE'],
  ['flow into input', g => { g.edges.push(flow('e3', 'dev', 'in')); }, 'INVALID_FLOW'],
  ['port on agent', g => { g.edges[1].from.port = 'pass'; }, 'INVALID_PORT'],
  ['port on target', g => { g.edges[1].to.port = 'pass'; }, 'INVALID_PORT'],
  ['delegates from input', g => { g.edges.push({ id: 'd', kind: 'delegates', from: { node: 'in' }, to: { node: 'dev' } }); }, 'INVALID_DELEGATION'],
  ['delegates to output', g => { g.edges.push({ id: 'd', kind: 'delegates', from: { node: 'dev' }, to: { node: 'out' } }); }, 'INVALID_DELEGATION'],
  ['messages to output', g => { g.edges.push({ id: 'm', kind: 'messages', from: { node: 'dev' }, to: { node: 'out' } }); }, 'INVALID_MESSAGES_EDGE'],
  ['flow cycle without loop', g => {
    g.nodes.push(node('dev2', 'agent', { harness, prompt: 'p' }));
    g.edges = [flow('e1', 'in', 'dev'), flow('e2', 'dev', 'dev2'), flow('e3', 'dev2', 'dev'), flow('e4', 'dev2', 'out')];
  }, 'FLOW_CYCLE'],
];
for (const [name, mutate, expected] of cases) {
  test(`reports ${expected}: ${name}`, () => {
    const result = validateGraph(edit(minimal(), mutate));
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes(expected), `${expected} not in ${JSON.stringify(result.errors)}`);
  });
}

test('errors point at the node or edge', () => {
  const result = validateGraph(edit(minimal(), g => { g.edges.push(flow('e9', 'dev', 'ghost')); delete find(g, 'dev').config.prompt; }));
  assert.ok(result.errors.some(error => error.code === 'DANGLING_EDGE' && error.edgeId === 'e9'));
  assert.ok(result.errors.some(error => error.code === 'MISSING_CONFIG' && error.nodeId === 'dev'));
});

test('gates need explicit pass and fail wiring', () => {
  const missingFail = edit(template('build'), g => { g.edges = g.edges.filter(e => e.id !== 'reviewer-fail'); });
  assert.ok(validateGraph(missingFail).errors.some(e => e.code === 'GATE_UNWIRED' && e.nodeId === 'reviewer'));
  const unported = edit(template('build'), g => { delete g.edges.find(e => e.id === 'ci-pass').from.port; });
  assert.ok(codes(validateGraph(unported)).includes('INVALID_PORT'));
  const mergeWithoutFail = edit(template('build'), g => { g.edges = g.edges.filter(e => e.id !== 'merge-fail'); });
  assert.equal(validateGraph(mergeWithoutFail).ok, true, 'merge-queue fail port is optional');
});

test('loop bounds and conditions', () => {
  for (const value of [0, 101, 2.5, '3']) {
    const graph = edit(template('build'), g => { find(g, 'review-loop').config.maxIterations = value; });
    assert.ok(codes(validateGraph(graph)).includes('LOOP_BOUNDS'), String(value));
  }
  const expected = edit(template('build'), g => { find(g, 'review-loop').config.expectedIterations = 5; });
  assert.ok(codes(validateGraph(expected)).includes('LOOP_BOUNDS'));
  const wrongUntil = edit(template('build'), g => { find(g, 'review-loop').config.until = 'manual'; });
  assert.ok(validateGraph(wrongUntil).errors.some(e => e.code === 'LOOP_CONDITION_UNMATCHED' && e.nodeId === 'review-loop'));
});

test('a cycle that re-enters a loop from outside its body is rejected', () => {
  const graph = {
    schema: 'perpeto.workflow/1',
    nodes: [
      node('in', 'input', { source: 'manual' }), node('first', 'agent', { harness, prompt: 'p' }),
      node('loop', 'loop', { until: 'review-pass', maxIterations: 3 }), node('second', 'agent', { harness, prompt: 'p' }),
      node('review', 'review', { harness, prompt: 'p' }), node('out', 'output'),
    ],
    edges: [
      flow('e1', 'in', 'first'), flow('e2', 'first', 'loop'), flow('e3', 'loop', 'second'), flow('e4', 'second', 'review'),
      flow('e5', 'review', 'out', 'pass'), flow('e6', 'review', 'first', 'fail'),
    ],
  };
  assert.ok(codes(validateGraph(graph)).includes('LOOP_UNCOUNTED'));
  graph.edges[5] = flow('e6', 'review', 'loop', 'fail');
  assert.equal(validateGraph(graph).ok, true);
});

test('warnings do not fail validation', () => {
  const graph = edit(minimal(), g => {
    find(g, 'dev').config.policy = { maxSubagents: 2, canMessage: ['x'] };
    find(g, 'dev').config.colour = 'red';
  });
  const result = validateGraph(graph);
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings.map(w => w.code).sort(), ['POLICY_CANMESSAGE_DERIVED', 'POLICY_SUBAGENTS_WITHOUT_DELEGATION', 'UNKNOWN_CONFIG_KEY']);
  assert.equal(compileGraph(graph).roles.dev.policy.maxSubagents, 0);
});

test('provider availability is checked when providers are given', () => {
  const result = validateGraph(template('build'), { providers: ['claudeAgent'] });
  assert.ok(result.errors.some(e => e.code === 'UNAVAILABLE_PROVIDER' && e.nodeId === 'builder'));
  assert.equal(validateGraph(template('build'), { providers: ['claudeAgent', 'codex'] }).ok, true);
});

test('classifyInteraction tags planned and unplanned interactions', () => {
  const plan = compileGraph(template('build'));
  assert.deepEqual(classifyInteraction(plan, { kind: 'messages', from: 'reviewer', to: 'builder' }),
    { kind: 'messages', from: 'reviewer', to: 'builder', edgeId: 'builder-reviewer-messages', unplanned: false });
  assert.equal(classifyInteraction(plan, { kind: 'delegates', from: 'builder', to: 'helper' }).edgeId, 'builder-helper');
  assert.deepEqual(classifyInteraction(plan, { kind: 'messages', from: 'helper', to: 'reviewer' }),
    { kind: 'messages', from: 'helper', to: 'reviewer', edgeId: null, unplanned: true });
});
