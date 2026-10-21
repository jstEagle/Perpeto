import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGraph, buildArchitectPrompt } from '../src/index.js';
import { template } from './fixtures.js';

// Live acceptance run 1, finding 5: the architect's drafts must survive unattended runs.

const harness = { provider: 'codex', model: 'gpt-test' };
const node = (id, type, config = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const flow = (id, from, to, port) => ({ id, kind: 'flow', from: port ? { node: from, port } : { node: from }, to: { node: to } });

const lean = config => ({
  schema: 'perpeto.workflow/1',
  nodes: [
    node('in', 'input', { source: 'manual' }),
    node('loop', 'loop', { until: 'review-pass', maxIterations: config.loop ?? 3 }),
    node('dev', 'agent', { harness, prompt: 'Build.', ...(config.dev ?? {}) }),
    node('rev', 'review', { harness, prompt: 'Review.', retry: { maxAttempts: 3, backoffSec: 30 } }),
    node('out', 'output'),
  ],
  edges: [flow('a', 'in', 'loop'), flow('b', 'loop', 'dev'), flow('c', 'dev', 'rev'), flow('d', 'rev', 'out', 'pass'), flow('e', 'rev', 'loop', 'fail')],
});
const warningsOf = graph => validateGraph(graph).warnings.map(w => `${w.code}:${w.nodeId}`);

test('validation warns about unsafe retry and loop limits without blocking the draft', () => {
  const single = validateGraph(lean({ dev: { retry: { maxAttempts: 1 } } }));
  assert.equal(single.ok, true);
  assert.deepEqual(single.warnings.map(w => `${w.code}:${w.nodeId}`), ['NO_RETRY:dev']);
  assert.match(single.warnings[0].message, /one transient/);
  // Omitting retry is the same single attempt.
  assert.deepEqual(warningsOf(lean({})), ['NO_RETRY:dev']);
  // An escalation target catches exhausted attempts, so one attempt is a choice, not a hazard.
  const escalated = lean({ dev: { retry: { maxAttempts: 1 }, onExhausted: 'help' } });
  escalated.nodes.push(node('help', 'human', { prompt: 'Help?' }));
  escalated.edges.push(flow('f', 'help', 'out', 'pass'));
  assert.deepEqual(warningsOf(escalated), []);
  assert.deepEqual(warningsOf(lean({ dev: { retry: { maxAttempts: 3 } } })), ['RETRY_WITHOUT_BACKOFF:dev']);
  assert.deepEqual(warningsOf(lean({ dev: { retry: { maxAttempts: 3, backoffSec: 30 } }, loop: 25 })), ['LOOP_LIMIT_HIGH:loop']);
  assert.deepEqual(warningsOf(lean({ dev: { retry: { maxAttempts: 3, backoffSec: 30 } } })), []);
  for (const name of ['build', 'improve']) assert.deepEqual(validateGraph(template(name)).warnings, [], name);
});

const architectInput = repo => ({
  project: { name: 'tiny-text', repo }, goals: [], docs: [],
  machines: [{ name: 'live-mac', os: 'darwin', providers: ['codex'], capacity: { maxAgents: 1, maxJobs: 1 }, status: 'online' }],
  providers: [{ provider: 'codex', models: ['gpt-test'] }], userPrompt: 'Lean workflow.',
});

test('the architect prompt gives safe defaults for retries, loops, concurrency and models', () => {
  const prompt = buildArchitectPrompt(architectInput({ url: 'git@example.com:tiny.git', defaultBranch: 'main' }));
  for (const expected of [
    '"retry": { "maxAttempts": 3, "backoffSec": 30 }', 'CI', '"maxAttempts": 2', 'maxIterations 3',
    'Never set retry.maxAttempts to 1', 'concurrency', 'machines\' capacity', 'cheaper', 'strongest',
  ]) assert.ok(prompt.includes(expected), expected);
  assert.doesNotMatch(prompt, /There are no pull requests/);
});

test('the architect prompt explains local delivery when the repository is a local path', () => {
  const prompt = buildArchitectPrompt(architectInput({ localPath: '/tmp/tiny-text.git', defaultBranch: 'main' }));
  assert.match(prompt, /local repository/);
  assert.match(prompt, /do not ask agents to open, register or merge pull requests/i);
});
