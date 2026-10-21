import test from 'node:test';
import assert from 'node:assert/strict';
import { Driver, sha } from './fixtures.js';

// Live acceptance run 1, finding 1: planner refinements must reach every later role.

const built = n => ({ outcome: 'success', summary: `built ${n}`, branch: 'perpeto/wi_1', prUrl: 'local:perpeto/wi_1', headSha: sha(n) });
const contract = 'Contract: strings only; lowercase; runs outside a-z0-9 become one hyphen.\nAcceptance: "Hello, world!" -> "hello-world"; "" -> "".';

test('a planner that keeps the item whole hands its contract to the builder, reviewer and rework builder', () => {
  const run = new Driver();
  run.start({ inputs: [{ title: 'Add slugify(text)', body: 'Export it from src/index.js.' }] });
  run.complete('planner', { outcome: 'success', items: [], summary: contract });
  const [item] = run.items();
  assert.equal(item.nodeId, 'builder');
  assert.deepEqual(item.plan, { from: 'planner', summary: contract });

  const builder = run.open('builder')[0].prompt;
  assert.match(builder, /Work item: Add slugify\(text\)\n\nExport it from src\/index\.js\./);
  assert.ok(builder.includes(`Plan from planner:\n${contract}`), builder);
  run.complete('builder', built(1));
  assert.ok(run.open('reviewer')[0].prompt.includes(`Plan from planner:\n${contract}`));
  run.complete('reviewer', { outcome: 'success', verdict: 'fail', summary: 'Kelvin sign becomes k.' });
  const rework = run.open('builder')[0].prompt;
  assert.ok(rework.includes(`Plan from planner:\n${contract}`));
  assert.match(rework, /Feedback to address \(review from reviewer\):\nKelvin sign becomes k\./);
});

test('planned children keep their parent title, and the planner prompt says where the contract goes', () => {
  const run = new Driver();
  run.start();
  const planner = run.open('planner')[0].prompt;
  assert.match(planner, /keep it whole/i);
  assert.match(planner, /acceptance criteria/i);
  run.complete('planner', { outcome: 'success', items: [{ title: 'Login form', body: 'Fields and validation.' }, { title: 'Session' }], summary: 'Two parts.' });
  const prompts = run.open('builder').map(assignment => assignment.prompt);
  assert.match(prompts[0], /Work item: Login form\n\nFields and validation\.\n\nPart of: Add login/);
  // A split plan is carried by each child's body, so the planner's summary is not repeated.
  for (const prompt of prompts) assert.doesNotMatch(prompt, /Plan from planner/);
});

test('a planner summary without content adds no plan section', () => {
  const run = new Driver();
  run.start();
  run.complete('planner', { outcome: 'success', items: [], summary: '   ' });
  assert.equal(run.items()[0].plan, undefined);
  assert.doesNotMatch(run.open('builder')[0].prompt, /Plan from/);
});
