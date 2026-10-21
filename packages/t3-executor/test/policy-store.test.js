import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentPolicyStore, AgentPolicyError } from '../src/policy-store.js';

function withStore(run) {
  const directory = mkdtempSync(join(tmpdir(), 't3-executor-policy-'));
  const filename = join(directory, 'policy.sqlite');
  const store = new AgentPolicyStore(filename);
  try { return run(store, filename); } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}
const request = (key, extra = {}) => ({ requestKey: key, callerThreadId: 'root', kind: 'delegated_task', providerInstanceId: 'codex', driver: 'codex', model: 'm', ...extra });

test('ungoverned threads are unrestricted', () => withStore(store => {
  assert.deepEqual(store.authorize(request('a')), { allowed: true, governed: false });
  assert.equal(store.getPolicy('root'), null);
}));

test('policies are immutable once attached and validated', () => withStore(store => {
  assert.equal(store.setPolicy({ threadId: 'root', maxSubagents: 2, allowedSubagentProviders: ['codex', 'codex'] }).created, true);
  assert.deepEqual(store.getPolicy('root').allowedSubagentProviders, ['codex']);
  assert.equal(store.setPolicy({ threadId: 'root', maxSubagents: 2, allowedSubagentProviders: ['codex'] }).created, false);
  assert.throws(() => store.setPolicy({ threadId: 'root', maxSubagents: 3, allowedSubagentProviders: ['codex'] }), { code: 'CONFLICT' });
  assert.throws(() => store.setPolicy({ threadId: 'x', maxSubagents: 1.5, allowedSubagentProviders: [] }), AgentPolicyError);
  assert.throws(() => store.setPolicy({ threadId: 'x', maxSubagents: 1, allowedSubagentProviders: 'codex' }), { code: 'INVALID_INPUT' });
}));

test('budget is shared across the delegation tree and retries are idempotent', () => withStore(store => {
  store.setPolicy({ threadId: 'root', maxSubagents: 2, allowedSubagentProviders: ['codex'] });
  assert.equal(store.authorize(request('a')).allowed, true);
  assert.equal(store.authorize(request('a')).retry, true);
  assert.equal(store.recordCreated({ requestKey: 'a', callerThreadId: 'root', childThreadId: 'child' }), true);
  assert.equal(store.getPolicy('child').threadId, 'root');
  // The child delegates using the shared budget.
  assert.equal(store.authorize(request('b', { callerThreadId: 'child' })).used, 2);
  const refused = store.authorize(request('c', { callerThreadId: 'child' }));
  assert.equal(refused.allowed, false);
  assert.match(refused.reason, /at most 2 subagents \(2 used\)/);
  assert.throws(() => store.setPolicy({ threadId: 'child', maxSubagents: 9, allowedSubagentProviders: ['codex'] }), { code: 'CONFLICT' });
}));

test('lineage root resolves policy for unlinked descendants', () => withStore(store => {
  store.setPolicy({ threadId: 'root', maxSubagents: 0, allowedSubagentProviders: [] });
  const decision = store.authorize(request('a', { callerThreadId: 'grandchild', rootThreadId: 'root' }));
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /not in this agent's allowed subagent providers \(none\)/);
}));

test('provider allowlist matches driver kind or instance id', () => withStore(store => {
  store.setPolicy({ threadId: 'root', maxSubagents: 5, allowedSubagentProviders: ['claudeAgent'] });
  assert.equal(store.authorize(request('a')).allowed, false);
  assert.equal(store.authorize(request('b', { providerInstanceId: 'claude-work', driver: 'claudeAgent' })).allowed, true);
  assert.equal(store.authorize(request('c', { providerInstanceId: 'claudeAgent', driver: null })).allowed, true);
}));

test('release returns failed reservations and the decision log pages', () => withStore((store, filename) => {
  store.setPolicy({ threadId: 'root', maxSubagents: 1, allowedSubagentProviders: ['codex'] });
  store.authorize(request('a'));
  assert.equal(store.release({ requestKey: 'a', callerThreadId: 'root' }), true);
  assert.equal(store.getPolicy('root').used, 0);
  store.authorize(request('b', { kind: 'provider_native', childRef: 'node:1' }));
  store.authorize(request('c'));
  const first = store.decisions({ threadId: 'root', limit: 1 });
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.decisions.map(item => [item.outcome, item.kind]), [['created', 'provider_native']]);
  const second = store.decisions({ threadId: 'root', after: first.nextCursor });
  assert.deepEqual(second.decisions.map(item => item.outcome), ['refused']);
  // A second connection, as the server and executor would use, sees committed state.
  const other = new AgentPolicyStore(filename);
  try { assert.equal(other.getPolicy('root').used, 1); } finally { other.close(); }
}));

test('factory tool settings are immutable, persistent and inherited before child linking', () => withStore((store, filename) => {
  store.setPolicy({ threadId: 'root', maxSubagents: 1, allowedSubagentProviders: ['codex'], t3Tools: 'policy' });
  assert.equal(store.getPolicy('root').t3Tools, 'policy');
  assert.equal(store.getPolicy('unlinked-child', 'root').t3Tools, 'policy');
  assert.throws(() => store.setPolicy({ threadId: 'root', maxSubagents: 1, allowedSubagentProviders: ['codex'], t3Tools: 'full' }), { code: 'CONFLICT' });
  assert.throws(() => store.setPolicy({ threadId: 'bad', maxSubagents: 0, allowedSubagentProviders: [], t3Tools: false }), { code: 'INVALID_INPUT' });
  store.authorize(request('delegate'));
  store.recordCreated({ requestKey: 'delegate', callerThreadId: 'root', childThreadId: 'child' });
  const other = new AgentPolicyStore(filename);
  try { assert.equal(other.getPolicy('child').t3Tools, 'policy'); } finally { other.close(); }
}));

test('schema v1 policies migrate without changing their upstream tools', () => {
  const directory = mkdtempSync(join(tmpdir(), 't3-policy-v1-'));
  const filename = join(directory, 'policy.sqlite');
  const old = new DatabaseSync(filename);
  old.exec(`CREATE TABLE policies(thread_id TEXT PRIMARY KEY, max_subagents INTEGER NOT NULL, allowed_providers TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL) STRICT;
    INSERT INTO policies VALUES ('legacy', 1, '["codex"]', 0, '2026-10-21'); PRAGMA user_version = 1;`);
  old.close();
  const migrated = new AgentPolicyStore(filename);
  try {
    assert.equal(migrated.getPolicy('legacy').t3Tools, 'full');
    assert.equal(migrated.setPolicy({ threadId: 'legacy', maxSubagents: 1, allowedSubagentProviders: ['codex'] }).created, false);
  } finally { migrated.close(); rmSync(directory, { recursive: true, force: true }); }
});
