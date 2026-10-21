import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffGraphs, buildArchitectPrompt, parseArchitectResult, evaluateArchitectResult, describeGraphSchema,
  GRAPH_JSON_SCHEMA, NODE_TYPES, validateGraph,
} from '../src/index.js';
import { performance } from 'node:perf_hooks';
import { template, code } from './fixtures.js';

test('identical graphs have an empty diff', () => {
  const diff = diffGraphs(template('build'), template('build'));
  assert.equal(diff.identical, true);
  assert.deepEqual(diff.summary, { nodesAdded: 0, nodesRemoved: 0, nodesChanged: 0, edgesAdded: 0, edgesRemoved: 0, edgesChanged: 0 });
});

test('lists added, removed and config-level changes', () => {
  const before = template('build');
  const after = structuredClone(before);
  const builder = after.nodes.find(node => node.id === 'builder');
  builder.config.harness.model = 'gpt-6';
  builder.config.concurrency = 6;
  delete builder.config.policy.maxTurns;
  after.nodes.find(node => node.id === 'ci').position = { x: 5, y: 5 };
  after.nodes = after.nodes.filter(node => node.id !== 'helper');
  after.edges = after.edges.filter(edge => !edge.id.includes('helper'));
  after.nodes.push({ id: 'security', type: 'review', label: 'Security review', position: { x: 0, y: 0 }, config: { harness: builder.config.harness, prompt: 'Check security.' } });
  after.edges.find(edge => edge.id === 'reviewer-pass').to.node = 'security';
  after.edges.push(
    { id: 'security-pass', kind: 'flow', from: { node: 'security', port: 'pass' }, to: { node: 'ci' } },
    { id: 'security-fail', kind: 'flow', from: { node: 'security', port: 'fail' }, to: { node: 'review-loop' } },
  );

  const diff = diffGraphs(before, after);
  assert.equal(diff.identical, false);
  assert.deepEqual(diff.nodes.added.map(node => node.id), ['security']);
  assert.deepEqual(diff.nodes.removed.map(node => node.id), ['helper']);
  const changedBuilder = diff.nodes.changed.find(change => change.id === 'builder');
  assert.deepEqual(changedBuilder.changes, [
    { path: 'config.concurrency', before: 4, after: 6 },
    { path: 'config.harness.model', before: 'gpt-6-astra', after: 'gpt-6' },
    { path: 'config.policy.maxTurns', before: 200 },
  ]);
  assert.equal(changedBuilder.layoutOnly, false);
  const ci = diff.nodes.changed.find(change => change.id === 'ci');
  assert.equal(ci.layoutOnly, true);
  assert.deepEqual(ci.changes, [{ path: 'position', before: { x: 1080, y: 160 }, after: { x: 5, y: 5 } }]);
  assert.deepEqual(diff.edges.added.map(edge => edge.id), ['security-pass', 'security-fail']);
  assert.deepEqual(diff.edges.removed.map(edge => edge.id), ['builder-helper', 'builder-helper-messages']);
  assert.deepEqual(diff.edges.changed, [{ id: 'reviewer-pass', kind: 'flow', changes: [{ path: 'to.node', before: 'ci', after: 'security' }], layoutOnly: false }]);
});

test('diff against no active version adds everything', () => {
  const diff = diffGraphs(null, template('improve'));
  assert.equal(diff.schemaChanged, true);
  assert.equal(diff.summary.nodesAdded, template('improve').nodes.length);
});

test('graph JSON schema and description cover every node type', () => {
  assert.deepEqual(GRAPH_JSON_SCHEMA.properties.nodes.items.properties.type.enum, NODE_TYPES);
  assert.equal(GRAPH_JSON_SCHEMA.properties.nodes.items.allOf.length, NODE_TYPES.length);
  for (const type of NODE_TYPES) assert.match(describeGraphSchema(), new RegExp(`\\| ${type} \\|`));
  assert.doesNotThrow(() => JSON.stringify(GRAPH_JSON_SCHEMA));
});

const context = {
  project: { name: 'Shop', repo: { url: 'git@example.com:shop.git', defaultBranch: 'main' } },
  docs: [{ title: 'Requirements', kind: 'requirements', path: 'docs/req.md', excerpt: 'Customers can pay by card.' }],
  goals: ['Ship checkout by December'],
  machines: [{ name: 'studio', os: 'darwin', arch: 'arm64', labels: ['gpu'], providers: ['claudeAgent', 'codex'], capacity: { maxAgents: 8, maxJobs: 2 }, status: 'online' }],
  providers: [{ provider: 'claudeAgent', models: ['claude-opus-5-5'] }, 'codex'],
  userPrompt: 'Build features fast but always review security-sensitive code twice.',
};

test('architect prompt carries the context, schema, errors and answer format', () => {
  const prompt = buildArchitectPrompt({
    ...context,
    existingWorkflow: { name: 'Build', version: 3, graph: template('build') },
    previousErrors: [{ code: 'GATE_UNWIRED', message: 'review gate "sec" needs a flow edge on port "fail".', nodeId: 'sec' }],
  });
  for (const expected of [
    'workflow-architect', 'Build features fast', 'git@example.com:shop.git, default branch main', '- Ship checkout by December',
    'Requirements (requirements): docs/req.md', 'Customers can pay by card.', 'studio: darwin/arm64; online; labels gpu; providers claudeAgent, codex; capacity 8 agents, 2 CI jobs',
    'claudeAgent: models claude-opus-5-5', '- codex', 'Current workflow (Build, version 3)', 'GATE_UNWIRED at node sec', '| merge-queue |',
    'exactly one fenced json block', 'Use only the providers listed above.',
  ]) assert.ok(prompt.includes(expected), expected);
  assert.equal(prompt, buildArchitectPrompt({
    ...context,
    existingWorkflow: { name: 'Build', version: 3, graph: template('build') },
    previousErrors: [{ code: 'GATE_UNWIRED', message: 'review gate "sec" needs a flow edge on port "fail".', nodeId: 'sec' }],
  }), 'deterministic');
  assert.throws(() => buildArchitectPrompt({ ...context, userPrompt: ' ' }), code('INVALID_INPUT'));
  assert.throws(() => buildArchitectPrompt({ ...context, project: {} }), code('INVALID_INPUT'));
});

test('parses fenced architect replies', () => {
  const graph = template('improve');
  const wrapped = `Here is my proposal.\n\n\`\`\`json\n${JSON.stringify({ rationale: 'Small, reviewed steps.', graph }, null, 2)}\n\`\`\`\n`;
  assert.deepEqual(parseArchitectResult(wrapped), { graph, rationale: 'Small, reviewed steps.' });

  const bare = `Two reviewers keep risk low.\n\n\`\`\`json\n${JSON.stringify(graph)}\n\`\`\``;
  assert.deepEqual(parseArchitectResult(bare), { graph, rationale: 'Two reviewers keep risk low.' });

  const draftThenFinal = `\`\`\`json\n{ "draft": true }\n\`\`\`\nFinal:\n\`\`\`\n${JSON.stringify({ rationale: 'Final.', graph })}\n\`\`\``;
  assert.equal(parseArchitectResult(draftThenFinal).rationale, 'Final.');
  assert.equal(parseArchitectResult(JSON.stringify({ rationale: 'Raw.', graph })).rationale, 'Raw.');
  assert.equal(parseArchitectResult({ graph, rationale: 'Object.' }).rationale, 'Object.');

  for (const bad of ['', 'no json here', '```json\n{ not json }\n```', '```json\n{ "graph": {} }\n```', '```json\n{ "rationale": "x" }\n```']) {
    assert.throws(() => parseArchitectResult(bad), code('ARCHITECT_PARSE_ERROR'), bad);
  }
});

test('evaluates architect replies for the retry loop', () => {
  const good = evaluateArchitectResult(`\`\`\`json\n${JSON.stringify({ rationale: 'ok', graph: template('build') })}\n\`\`\``);
  assert.equal(good.ok, true);
  assert.equal(good.rationale, 'ok');
  const broken = template('build');
  broken.edges = broken.edges.filter(edge => edge.id !== 'reviewer-fail');
  const invalid = evaluateArchitectResult({ rationale: 'oops', graph: broken });
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.errors.map(error => error.code), validateGraph(broken).errors.map(error => error.code));
  const missingProvider = evaluateArchitectResult({ rationale: 'x', graph: template('build') }, { providers: ['claudeAgent'] });
  assert.ok(missingProvider.errors.some(error => error.code === 'UNAVAILABLE_PROVIDER'));
  assert.deepEqual(evaluateArchitectResult('nothing').errors.map(error => error.code), ['ARCHITECT_PARSE_ERROR']);
});

test('L5: an unclosed fence with a long run of spaces parses in linear time', () => {
  const text = `\`\`\`${' \t'.repeat(32 * 1024)}`;
  const started = performance.now();
  assert.throws(() => parseArchitectResult(text), code('ARCHITECT_PARSE_ERROR'));
  assert.ok(performance.now() - started < 200, `took ${Math.round(performance.now() - started)} ms`);
  assert.equal(parseArchitectResult('```json  \n{"rationale":"r","graph":{"schema":"x"}}\n```').rationale, 'r');
});
