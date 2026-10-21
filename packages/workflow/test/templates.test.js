import test from 'node:test';
import assert from 'node:assert/strict';
import { listTemplates, getTemplate, validateGraph, compileGraph } from '../src/index.js';

const ids = ['build', 'improve', 'bugfix', 'docs', 'security-audit', 'dependency-upgrade'];
test('template library exposes isolated, described, validated graphs with bounded roles', () => {
  assert.deepEqual(listTemplates().map(t => t.id), ids);
  for (const entry of listTemplates()) {
    assert.ok(entry.description.length > 30);
    const graph = getTemplate(entry.id);
    assert.deepEqual(validateGraph(graph), { ok: true, errors: [], warnings: [] }, entry.id);
    const plan = compileGraph(graph);
    for (const role of Object.values(plan.roles)) {
      assert.ok(role.concurrency >= 1 && role.concurrency <= 4);
      if (!role.delegateOnly) assert.ok(plan.nodes[role.nodeId].config.retry.maxAttempts >= 2);
    }
    for (const loop of Object.values(plan.loops)) assert.ok(loop.maxIterations <= 4);
    if (['bugfix', 'security-audit', 'dependency-upgrade'].includes(entry.id)) {
      assert.deepEqual(plan.nodes.ci.config.steps.map(step => step.run), ['npm ci', 'npm test']);
    }
  }
  const graph = getTemplate('bugfix');
  graph.nodes.length = 0;
  assert.ok(getTemplate('bugfix').nodes.length > 0);
  assert.throws(() => getTemplate('missing'), { code: 'UNKNOWN_TEMPLATE' });
});
test('specialist templates preserve their required order and model tiers', () => {
  for (const [id, roles] of [
    ['bugfix', ['triager', 'reproducer', 'fixer', 'reviewer', 'ci', 'merge']],
    ['docs', ['doc-writer', 'doc-reviewer', 'merge']],
    ['security-audit', ['auditor', 'finding-verifier', 'fixer', 'reviewer', 'ci', 'merge']],
    ['dependency-upgrade', ['dependency-planner', 'upgrader', 'reviewer', 'ci', 'merge']],
  ]) {
    const plan = compileGraph(getTemplate(id));
    let cursor = plan.inputs[0];
    const visited = [];
    while (cursor && !visited.includes(cursor)) {
      visited.push(cursor);
      cursor = (plan.nodes[cursor].routes.next ?? plan.nodes[cursor].routes.pass)?.node;
    }
    assert.deepEqual(visited.filter(n => roles.includes(n)), roles);
    assert.ok(new Set(Object.values(plan.roles).map(r => r.harness.model)).size >= 2);
  }
  assert.match(getTemplate('improve').nodes.find(n => n.id === 'auditor').config.prompt, /metrics|measur/i);
  assert.match(getTemplate('improve').nodes.find(n => n.id === 'auditor').config.prompt, /duplicate|already/i);
});
