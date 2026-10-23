import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGraph } from '../src/index.js';
import { template } from './fixtures.js';

const withCi = config => {
  const graph = structuredClone(template('build'));
  const ci = graph.nodes.find(node => node.type === 'ci'); const { steps, ...rest } = ci.config; void steps;
  ci.config = { ...rest, ...config };
  return graph;
};

test('a ci node runs inline steps or names a repository pipeline, never both or neither', () => {
  assert.equal(validateGraph(withCi({ pipeline: 'default' })).ok, true);
  assert.deepEqual(validateGraph(withCi({ pipeline: 'default' })).warnings, []);
  assert.equal(validateGraph(withCi({ steps: [{ name: 'test', run: 'npm test' }] })).ok, true);
  for (const config of [{}, { pipeline: 'default', steps: [{ name: 'test', run: 'npm test' }] }, { pipeline: 'bad name' }, { pipeline: '' }]) {
    const result = validateGraph(withCi(config));
    assert.equal(result.ok, false, JSON.stringify(config));
  }
});
