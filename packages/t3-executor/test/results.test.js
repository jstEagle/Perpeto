import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPrompt, outputInstructions, outputKind, parseRoleResult } from '../src/index.js';

const fenced = value => `Done.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const plan = touches => parseRoleResult('planner', fenced({ items: [{ title: 'Login form', touches }] }));

test('planner items keep normalised repository-relative touches', () => {
  assert.deepEqual(plan(['./src/auth/', 'src/auth', 'package.json', 'src//auth/login.js']).fields.items,
    [{ title: 'Login form', touches: ['src/auth', 'package.json', 'src/auth/login.js'] }]);
  // Globs widen to the directory they start in, so the declared scope never shrinks.
  assert.deepEqual(plan(['src/lib/**/*.js', 'docs/*.md', 'src/lib/util.js']).fields.items[0].touches, ['src/lib', 'docs', 'src/lib/util.js']);
  assert.deepEqual(plan(['**/*.test.js']).fields.items[0].touches, ['.']);
  // Empty or omitted declarations keep the engine's legacy concurrency.
  assert.deepEqual(plan([]).fields.items, [{ title: 'Login form' }]);
  assert.deepEqual(plan(undefined).fields.items, [{ title: 'Login form' }]);
});

test('planner touches outside the repository or malformed fail the attempt', () => {
  for (const touches of ['src', ['/etc/passwd'], ['../other'], ['src/../../x'], ['C:/repo'], ['src\\win'], ['a\u0000b'], [''], ['  '], [42], ['x'.repeat(4097)],
    Array.from({ length: 101 }, (_, index) => `file-${index}.js`)]) {
    const parsed = plan(touches);
    assert.ok(parsed.error, `rejects ${JSON.stringify(touches).slice(0, 60)}`);
    assert.match(parsed.error, /touches/);
  }
  // More than 100 entries are fine when they collapse to at most 100 distinct scopes.
  assert.equal(plan(Array.from({ length: 150 }, () => 'src')).fields.items[0].touches.length, 1);
});

test('the planner answer format asks for touches', () => {
  assert.match(outputInstructions('planner'), /"touches": \[/);
  assert.match(outputInstructions('planner'), /repository-relative/);
});

const graph = { schema: 'perpeto.workflow/1', nodes: [], edges: [] };

test('the architect keeps templateId and additional workflows', () => {
  const answer = { rationale: 'Two loops.', graph, templateId: 'build',
    additionalWorkflows: [{ name: 'Nightly audit', rationale: 'Keep deps fresh.', graph, templateId: 'dependency-upgrade' }, { name: 'Docs', rationale: 'Docs loop.', graph }] };
  const parsed = parseRoleResult('architect', fenced(answer));
  assert.deepEqual(parsed.fields, { graph, rationale: 'Two loops.', templateId: 'build', additionalWorkflows: answer.additionalWorkflows });
  assert.equal(parsed.summary, 'Two loops.');
  assert.deepEqual(parseRoleResult('architect', fenced({ rationale: 'One.', graph })).fields, { graph, rationale: 'One.' });
});

test('invalid architect extras go back whole, so the hub parser reports them', () => {
  for (const extra of [{ templateId: '' }, { templateId: 7 }, { additionalWorkflows: {} },
    { additionalWorkflows: [1, 2, 3, 4].map(n => ({ name: `w${n}`, rationale: 'r', graph })) },
    { additionalWorkflows: [{ name: 'x', rationale: 'r' }] }, { additionalWorkflows: [{ name: '', rationale: 'r', graph }] },
    { additionalWorkflows: [{ name: 'x', rationale: 'r', graph, templateId: 3 }] }]) {
    const text = fenced({ rationale: 'Main.', graph, ...extra });
    const parsed = parseRoleResult('architect', text);
    assert.deepEqual(parsed.fields, {}, JSON.stringify(extra));
    assert.equal(parsed.summary, text);
  }
});

test('rebase steps are their own kind and never trust the model about scope', () => {
  const rebase = { step: 'rebase', rebaseOf: 'mq_1', nodeType: 'agent', role: 'builder', prompt: 'Rebase onto the new base (main).' };
  assert.equal(outputKind(rebase), 'rebase');
  assert.equal(outputKind({ ...rebase, step: undefined }), 'work');
  assert.deepEqual(parseRoleResult('rebase', fenced({ rebaseTouchedBeyondConflicts: false })).fields, {});
  const prompt = buildPrompt({ ...rebase, policy: { maxSubagents: 0 } }, { kind: 'rebase' });
  assert.match(prompt, /how you resolved the conflicts/);
  assert.doesNotMatch(prompt, /pull request URL/);
});
