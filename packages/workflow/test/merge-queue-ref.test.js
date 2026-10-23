import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGraph, compileGraph } from '../src/index.js';

const harness = { provider: 'claudeAgent', model: 'claude-sonnet-5-5' };
const node = (id, type, config = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const flow = (id, from, to, port) => ({ id, kind: 'flow', from: port ? { node: from, port } : { node: from }, to: { node: to } });
const graph = merge => ({
  schema: 'perpeto.workflow/1',
  nodes: [node('in', 'input', { source: 'manual' }), node('dev', 'agent', { harness, prompt: 'Build it.', retry: { maxAttempts: 2, backoffSec: 30 } }), node('merge', 'merge-queue', merge), node('out', 'output')],
  edges: [flow('e1', 'in', 'dev'), flow('e2', 'dev', 'merge'), flow('e3', 'merge', 'out', 'pass')],
});

test('a merge-queue node may name a project queue instead of inline strategy and method', () => {
  assert.deepEqual(validateGraph(graph({ queue: 'main' })), { ok: true, errors: [], warnings: [] });
  assert.equal(compileGraph(graph({ queue: 'release-2026.10' })).nodes.merge.config.queue, 'release-2026.10');
  // Inline configuration keeps working unchanged.
  assert.equal(validateGraph(graph({ strategy: 'batch', method: 'squash' })).ok, true);
});

test('a merge-queue node needs inline strategy and method, or a valid queue name', () => {
  const missing = validateGraph(graph({ method: 'squash' }));
  assert.equal(missing.ok, false);
  assert.match(missing.errors.find(error => error.code === 'MISSING_CONFIG').message, /config.strategy, or config.queue/);
  const bad = validateGraph(graph({ queue: '../main' }));
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0].message, /must name a project merge queue/);
});
