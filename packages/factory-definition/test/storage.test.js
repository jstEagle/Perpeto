import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactoryStore, FactoryError, validateDefinition, HARNESS_KINDS } from '../src/storage.js';
const agent = (id, harness = 'codex') => ({ id, label: id, type: 'agent', harness, allowSubagents: true, maxSubagents: 8, maxConcurrent: 8 });
const base = () => ({ name: 'Build', nodes: [agent('lead'), agent('worker', 'claudeAgent')], edges: [{ id: 'authority', type: 'delegates-to', source: 'lead', target: 'worker' }] });
const invalid = (input) => assert.throws(() => validateDefinition(input), (error) => error instanceof FactoryError && error.code === 'INVALID_INPUT');

test('persists definitions and immutable history across restart; stale independent editor cannot overwrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perpeto-factory-')); const path = join(dir, 'factory.sqlite');
  let first; let second;
  try {
    first = new FactoryStore(path); const original = first.create({ projectId: 'project', id: 'build', ...base() });
    second = new FactoryStore(path);
    const updated = second.update({ projectId: 'project', id: 'build', expectedVersion: 1, ...base(), name: 'Build updated' });
    assert.equal(updated.version, 2);
    assert.throws(() => first.update({ projectId: 'project', id: 'build', expectedVersion: 1, ...base() }), { code: 'CONFLICT' });
    assert.throws(() => first.create({ projectId: 'project', id: 'build', ...base() }), { code: 'CONFLICT' });
    first.close(); first = new FactoryStore(path);
    assert.deepEqual(first.read({ projectId: 'project', id: 'build' }), updated);
    assert.deepEqual(first.read({ projectId: 'project', id: 'build', version: 1 }), original);
    assert.deepEqual(first.list({ projectId: 'other' }), []);
    assert.throws(() => first.read({ projectId: 'other', id: 'build' }), { code: 'NOT_FOUND' });
    first.create({ projectId: 'other', id: 'build', ...base() });
    assert.equal(first.list({ projectId: 'project' }).length, 1);
  } finally { first?.close(); second?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('rejects invalid graphs while allowing workflow rework loops', () => {
  const graph = base();
  invalid({ ...graph, nodes: [...graph.nodes, agent('lead')] });
  invalid({ ...graph, edges: [...graph.edges, { ...graph.edges[0] }] });
  invalid({ ...graph, edges: [{ ...graph.edges[0], target: 'missing' }] });
  invalid({ ...graph, edges: [...graph.edges, { id: 'back', type: 'delegates-to', source: 'worker', target: 'lead' }] });
  invalid({ ...graph, edges: [{ id: 'self', type: 'delegates-to', source: 'lead', target: 'lead' }] });
  const rework = { ...graph, edges: [...graph.edges, { id: 'review', type: 'workflow', source: 'lead', target: 'worker' }, { id: 'rework', type: 'workflow', source: 'worker', target: 'lead' }] };
  assert.deepEqual(validateDefinition(rework), rework);
});

test('validates all imported harness kinds, node policies and context relationships without executing', () => {
  for (const harness of HARNESS_KINDS) assert.equal(validateDefinition({ name: 'All harnesses', nodes: [agent('worker', harness)], edges: [] }).nodes[0].harness, harness);
  const nodes = [agent('lead'), { id: 'docs', label: 'Docs', type: 'context', references: ['file:///private/not-read', 'docs/vision.md'] }, { id: 'test', label: 'Test', type: 'check', command: ['npm', 'test', ''] }, { id: 'merge', label: 'Merge', type: 'merge-queue', requireChecks: true, requireReview: true, maxConcurrent: 1 }];
  const graph = { name: 'Delivery', nodes, edges: [{ id: 'ctx', type: 'context', source: 'docs', target: 'lead' }] };
  assert.deepEqual(validateDefinition(graph), graph);
  invalid({ ...graph, edges: [{ id: 'ctx', type: 'context', source: 'lead', target: 'docs' }] });
  invalid({ ...graph, edges: [{ id: 'auth', type: 'delegates-to', source: 'lead', target: 'test' }] });
  for (const patch of [{ harness: 'unknown' }, { maxConcurrent: 0 }, { maxSubagents: -1 }, { maxSubagents: 1.1 }, { allowSubagents: false }, { position: { x: Infinity, y: 0 } }, { execute: true }]) invalid({ name: 'Bad', nodes: [{ ...agent('lead'), ...patch }], edges: [] });
  invalid({ name: 'Bad', nodes: [{ ...nodes[2], command: [] }], edges: [] });
  invalid({ name: 'Bad', nodes: [{ ...nodes[3], maxConcurrent: 2 }], edges: [] });
  invalid({ name: 'Bad', nodes: [], edges: [], runtime: true });
});

test('rejects invalid limits, inputs, and definition sizes before writes', () => {
  assert.throws(() => validateDefinition(base(), { maxNodes: 1 }), { code: 'INVALID_INPUT' });
  assert.throws(() => validateDefinition(base(), { maxDefinitionBytes: 20 }), { code: 'INVALID_INPUT' });
  const store = new FactoryStore(':memory:', { limits: { maxFactoriesPerProject: 1 } });
  try {
    store.create({ projectId: 'project', id: 'one', ...base() });
    assert.throws(() => store.create({ projectId: 'project', id: 'two', ...base() }), { code: 'LIMIT_EXCEEDED' });
    assert.throws(() => store.update({ projectId: 'project', id: 'one', expectedVersion: 1, ...base(), nodes: [agent('bad', 'invalid')] }), { code: 'INVALID_INPUT' });
    assert.equal(store.read({ projectId: 'project', id: 'one' }).version, 1);
    assert.throws(() => store.read({ projectId: '..', id: 'one' }), { code: 'INVALID_INPUT' });
  } finally { store.close(); }
});
