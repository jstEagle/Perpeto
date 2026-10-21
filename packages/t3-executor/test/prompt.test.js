import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPrompt, parseRoleResult } from '../src/index.js';

// Live acceptance run 1, findings 4 and 5: role prompts carried instructions that contradicted the
// answer format, asked builders on local repositories for pull requests, and the planner's narration
// reached later roles as its "contract".

const policy = { maxSubagents: 0, allowedSubagentProviders: [], canMessage: [] };
const prompt = 'Review the change against the work item.\n\nWork item: Add slugify(text)';

test('only work roles are asked for a branch and pull request summary', () => {
  const finish = /reply with a short summary of what you did, the branch you used/;
  assert.match(buildPrompt({ prompt, policy, nodeType: 'agent' }, { kind: 'work' }), finish);
  for (const kind of ['review', 'planner', 'architect']) assert.doesNotMatch(buildPrompt({ prompt, policy }, { kind }), finish, kind);
});

test('work on a local repository is told there is no pull request to open', () => {
  const local = buildPrompt({ prompt, policy }, { kind: 'work', delivery: 'local' });
  assert.match(local, /no pull request to open or register/);
  assert.doesNotMatch(local, /pull request URL/);
  assert.match(buildPrompt({ prompt, policy }, { kind: 'work', delivery: 'forge' }), /pull request URL/);
});

test('a planner summary comes from its json block, not the narration around it', () => {
  const text = "I'm using the messaging skill and will keep this planning-only.\n\nAlready small enough.\n\n" +
    '```json\n{"items": [], "summary": "Contract: strings only. Acceptance: \\"a b\\" -> \\"a-b\\"."}\n```';
  const parsed = parseRoleResult('planner', text);
  assert.deepEqual(parsed.fields, { items: [] });
  assert.equal(parsed.summary, 'Contract: strings only. Acceptance: "a b" -> "a-b".');
  // Older replies without a summary field keep the prose.
  assert.equal(parseRoleResult('planner', 'Small.\n```json\n{"items": []}\n```').summary, 'Small.');
  assert.match(buildPrompt({ prompt, policy }, { kind: 'planner', extra: [] }), /Factory context/);
});
