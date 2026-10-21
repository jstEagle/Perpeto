import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AccountPool, detectClaudeSignal, detectCodexSignal } from '../src/index.js';

// Fake strings only. Never read a user's login, ccswap store, or Keychain.
const claude = JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-claude-secret', refreshToken: 'fixture-refresh' } });
const codex = JSON.stringify({ tokens: { access_token: 'fixture-codex-secret', refresh_token: 'fixture-refresh' } });
const write = (file, text) => { fs.writeFileSync(file, text, { mode: 0o600 }); fs.chmodSync(file, 0o600); };
const mkdir = directory => { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700); };
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perpeto-accounts-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = Date.parse('2026-10-21T02:00:00Z');
  const nodeDataDir = path.join(root, 'node');
  const pool = new AccountPool({ nodeDataDir, machineId: 'mch_fixture', clock: () => now, ...options });
  let key = 0;
  const next = () => `request-${++key}`;
  const source = provider => {
    const home = path.join(root, `source-${provider}`);
    mkdir(home);
    write(path.join(home, provider === 'codex' ? 'auth.json' : '.credentials.json'), provider === 'codex' ? codex : claude);
    return { kind: 'provider-home', homePath: home };
  };
  const add = (id, provider = 'codex', other = {}) => pool.importAccount({ id, provider, label: id,
    source: other.source ?? source(provider), idempotencyKey: next(), ...other });
  const select = (assignmentId, provider = 'codex') => pool.select({ provider, assignmentId, idempotencyKey: next() });
  const release = assignmentId => pool.release({ assignmentId, idempotencyKey: next() });
  const observe = (accountId, message) => pool.observe({ accountId, message, idempotencyKey: next() });
  return { root, nodeDataDir, pool, next, add, source, select, release, observe, now: () => now, advance: ms => { now += ms; } };
}
const code = expected => error => { assert.equal(error.code, expected); return true; };

test('copy imports isolate homes, preserve sources, and map both T3 driver configs', t => {
  const f = fixture(t);
  for (const provider of ['codex', 'claudeAgent']) {
    const source = f.source(provider);
    const filename = provider === 'codex' ? 'auth.json' : '.credentials.json';
    const before = fs.readFileSync(path.join(source.homePath, filename));
    f.add(`acct_${provider}`, provider, { source });
    const { binding, account } = f.select(`asg_${provider}`, provider);
    assert.equal(account.status, 'active');
    assert.equal(binding.instance.driver, provider);
    assert.equal(binding.mutation.instanceId, binding.providerInstanceId);
    assert.equal(binding.mutation.operation, 'upsert');
    const home = binding.instance.config.homePath;
    assert.ok(home.startsWith(path.join(fs.realpathSync(f.nodeDataDir), 'accounts')));
    assert.equal(Object.values(binding.environment)[0], home);
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(home, filename)).mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(path.join(source.homePath, filename)), before);
    assert.notEqual(fs.statSync(path.join(source.homePath, filename)).ino, fs.statSync(path.join(home, filename)).ino);
    if (provider === 'codex') {
      assert.equal(binding.instance.config.setupMode, 'existing');
      assert.equal(binding.instance.config.shadowHomePath, '');
      assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), 'cli_auth_credentials_store = "file"\n');
    }
  }
});

test('ccswap file backups import both providers, retaining disabled metadata', t => {
  const f = fixture(t);
  const store = path.join(f.root, 'ccswap');
  for (const dir of ['credentials', 'configs', 'codex/credentials']) mkdir(path.join(store, dir));
  write(path.join(store, 'sequence.json'), JSON.stringify({ accounts: { '2': { email: 'fixture@example.test', disabled: true } } }));
  write(path.join(store, 'credentials/.creds-2-fixture@example.test.enc'), Buffer.from(claude).toString('base64'));
  write(path.join(store, 'configs/.claude-config-2-fixture@example.test.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'fixture@example.test' }, hasCompletedOnboarding: true, hooks: { unsafe: 'do not import' },
  }));
  write(path.join(store, 'codex/sequence.json'), JSON.stringify({ accounts: { '3': { email: 'fixture@example.test' } } }));
  write(path.join(store, 'codex/credentials/account-3.json'), codex);
  const before = fs.readFileSync(path.join(store, 'sequence.json'));
  const account = f.add('acct_claude', 'claudeAgent', { source: { kind: 'ccswap', storePath: store, slot: 2 } });
  assert.equal(account.status, 'disabled');
  assert.throws(() => f.select('asg_disabled', 'claudeAgent'), code('ACCOUNT_POOL_EXHAUSTED'));
  f.pool.enable({ accountId: account.id, idempotencyKey: f.next() });
  const config = f.pool.bindingFor(account.id).instance.config;
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(config.homePath, '.claude.json'))), {
    oauthAccount: { emailAddress: 'fixture@example.test' }, hasCompletedOnboarding: true,
  });
  f.add('acct_codex', 'codex', { source: { kind: 'ccswap', storePath: store, slot: 3 } });
  assert.deepEqual(fs.readFileSync(path.join(store, 'sequence.json')), before);
});

test('LRU, reservations, idempotency, restart and release', t => {
  const f = fixture(t);
  f.add('acct_a'); f.add('acct_b');
  const input = { provider: 'codex', assignmentId: 'asg_a', idempotencyKey: 'select-once' };
  const first = f.pool.select(input);
  assert.equal(first.account.id, 'acct_a');
  assert.deepEqual(f.pool.select(input), first);
  assert.throws(() => f.pool.select({ ...input, assignmentId: 'asg_changed' }), code('IDEMPOTENCY_CONFLICT'));
  f.advance(1000);
  assert.equal(f.select('asg_b').account.id, 'acct_b');
  assert.throws(() => f.select('asg_c'), code('ACCOUNT_POOL_EXHAUSTED'));
  const reopened = new AccountPool({ nodeDataDir: f.nodeDataDir, machineId: 'mch_fixture', clock: f.now });
  assert.throws(() => reopened.select({ provider: 'codex', assignmentId: 'asg_d', idempotencyKey: 'after-restart' }), code('ACCOUNT_POOL_EXHAUSTED'));
  f.release('asg_a');
  assert.throws(() => f.pool.select(input), code('RESERVATION_ENDED'));
  assert.equal(f.select('asg_c').account.id, 'acct_a');
  f.release('asg_b'); f.release('asg_c');
  assert.equal(f.select('asg_e').account.id, 'acct_b');
});

test('headroom uses sparse windows and stops using expired measurements', t => {
  const f = fixture(t, { selection: 'headroom' });
  f.add('acct_a'); f.add('acct_b');
  f.observe('acct_a', { windows: [{ id: 'primary', usedPercent: 90, resetsAt: new Date(f.now() + 1000).toISOString() }] });
  f.observe('acct_b', { windows: [{ id: 'primary', usedPercent: 40 }] });
  assert.equal(f.select('asg_a').account.id, 'acct_b');
  f.release('asg_a'); f.advance(1001);
  assert.equal(f.select('asg_b').account.id, 'acct_a');
});

test('cooldown expiry chooses a different account and does not extend on retry', t => {
  const f = fixture(t);
  f.add('acct_a'); f.add('acct_b');
  const message = { code: 'rateLimitExceeded', retry_after: 2, message: 'fixture-private-error' };
  const input = { accountId: 'acct_a', message, idempotencyKey: 'limit-once' };
  const result = f.pool.observe(input);
  assert.equal(result.status, 'cooling');
  assert.equal(result.cooldownUntil, new Date(f.now() + 2000).toISOString());
  f.advance(1000);
  assert.deepEqual(f.pool.observe(input), result);
  assert.equal(f.select('asg_new').account.id, 'acct_b');
  f.advance(1000);
  assert.equal(f.pool.snapshot()[0].status, 'active');
  assert.equal(f.select('asg_next').account.id, 'acct_a');
});

test('disable and auth failure survive observations, enable and restart', t => {
  const f = fixture(t);
  f.add('acct_a');
  f.observe('acct_a', { api_error_status: 401 });
  assert.equal(f.pool.snapshot()[0].status, 'invalid');
  f.pool.disable({ accountId: 'acct_a', idempotencyKey: f.next() });
  f.observe('acct_a', { code: 'rateLimitExceeded' });
  assert.equal(f.pool.snapshot()[0].status, 'disabled');
  f.pool.enable({ accountId: 'acct_a', idempotencyKey: f.next() });
  assert.equal(f.pool.snapshot()[0].status, 'invalid');
  f.pool.markAuthenticated({ accountId: 'acct_a', idempotencyKey: f.next() });
  assert.equal(f.pool.snapshot()[0].status, 'cooling');
  f.advance(300000);
  assert.equal(f.pool.snapshot()[0].status, 'active');
});

test('concurrent calls and second handles cannot select a disabled account', async t => {
  const f = fixture(t);
  f.add('acct_a'); f.add('acct_b');
  const second = new AccountPool({ nodeDataDir: f.nodeDataDir, machineId: 'mch_fixture', clock: f.now });
  f.pool.disable({ accountId: 'acct_a', idempotencyKey: f.next() });
  const results = await Promise.allSettled([
    Promise.resolve().then(() => f.select('asg_a')),
    Promise.resolve().then(() => second.select({ provider: 'codex', assignmentId: 'asg_b', idempotencyKey: 'second-handle' })),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'fulfilled').value.account.id, 'acct_b');
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'ACCOUNT_POOL_EXHAUSTED');
  f.pool.disable({ accountId: 'acct_b', idempotencyKey: f.next() });
  assert.throws(() => f.pool.bindingFor('acct_b'), code('ACCOUNT_UNAVAILABLE'));
});

test('permissions, symlinks, hardlinks, lock and foreign registry fail closed', t => {
  const f = fixture(t);
  const source = f.source('codex');
  const auth = path.join(source.homePath, 'auth.json');
  fs.chmodSync(auth, 0o644);
  assert.throws(() => f.add('acct_bad', 'codex', { source }), code('UNSAFE_PERMISSIONS'));
  fs.chmodSync(auth, 0o600);
  const external = path.join(f.root, 'external');
  fs.renameSync(auth, external); fs.symlinkSync(external, auth);
  assert.throws(() => f.add('acct_symlink', 'codex', { source }), code('UNSAFE_PERMISSIONS'));
  fs.unlinkSync(auth); fs.linkSync(external, auth);
  assert.throws(() => f.add('acct_hardlink', 'codex', { source }), code('UNSAFE_PERMISSIONS'));
  fs.unlinkSync(auth); fs.renameSync(external, auth);
  f.add('acct_ok', 'codex', { source });
  const home = f.pool.bindingFor('acct_ok').instance.config.homePath;
  fs.chmodSync(path.join(home, 'auth.json'), 0o644);
  assert.throws(() => f.select('asg_bad'), code('ACCOUNT_POOL_EXHAUSTED'));
  assert.equal(f.pool.snapshot()[0].status, 'invalid');
  fs.chmodSync(path.join(home, 'auth.json'), 0o600);
  mkdir(path.join(f.nodeDataDir, 'accounts/.lock'));
  assert.throws(() => f.pool.disable({ accountId: 'acct_ok', idempotencyKey: f.next() }), code('ACCOUNT_POOL_BUSY'));
  fs.rmdirSync(path.join(f.nodeDataDir, 'accounts/.lock'));
  assert.throws(() => new AccountPool({ nodeDataDir: f.nodeDataDir, machineId: 'mch_other' }), code('INVALID_REGISTRY'));
  fs.chmodSync(f.nodeDataDir, 0o755);
  assert.throws(() => new AccountPool({ nodeDataDir: f.nodeDataDir, machineId: 'mch_fixture' }), code('UNSAFE_PERMISSIONS'));
});

test('snapshot and registry never retain imported secrets, raw errors or home descriptors', t => {
  const f = fixture(t);
  f.add('acct_a');
  f.observe('acct_a', { code: 'rateLimitExceeded', message: 'fixture-private-error', accessToken: 'fixture-extra-secret' });
  const snapshot = f.pool.snapshot();
  assert.deepEqual(Object.keys(snapshot[0]).sort(), ['id', 'machineId', 'provider', 'label', 'status', 'cooldownUntil'].sort());
  const state = fs.readFileSync(path.join(f.nodeDataDir, 'accounts/registry.json'), 'utf8');
  for (const text of [state, JSON.stringify(snapshot)]) {
    assert.doesNotMatch(text, /fixture-(?:codex-secret|refresh|private-error|extra-secret)/);
    assert.doesNotMatch(text, /access_token|refresh_token/);
  }
  assert.doesNotMatch(JSON.stringify(snapshot), /homePath|environment|credentials|windows|source/);
  snapshot[0].status = 'active';
  assert.equal(f.pool.snapshot()[0].status, 'cooling');
});

test('malformed credentials produce safe errors, without writing a home', t => {
  const f = fixture(t);
  const source = f.source('codex');
  write(path.join(source.homePath, 'auth.json'), '{ fixture-secret-parser-excerpt');
  assert.throws(() => f.add('acct_bad', 'codex', { source }), error => {
    assert.equal(error.code, 'INVALID_CREDENTIAL_FILE');
    assert.doesNotMatch(String(error), /fixture-secret/);
    return true;
  });
  assert.deepEqual(f.pool.snapshot(), []);
});

test('Claude signals distinguish rejection, warnings, overage, overload and auth failures', () => {
  const now = Date.parse('2026-10-21T02:00:00Z');
  assert.equal(detectClaudeSignal({ api_error_status: 529 }), null);
  assert.deepEqual(detectClaudeSignal({ error: 'authentication_failed' }), { kind: 'auth-failure' });
  assert.deepEqual(detectClaudeSignal({ api_error_status: 429 }), { kind: 'rate-limit' });
  const event = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', utilization: 1, rateLimitType: 'five_hour', resetsAt: (now + 10000) / 1000 } };
  assert.equal(detectClaudeSignal(event, { now }).cooldownUntil, new Date(now + 10000).toISOString());
  assert.equal(detectClaudeSignal({ ...event, rate_limit_info: { ...event.rate_limit_info, status: 'allowed_warning' } }, { now }), null);
  assert.equal(detectClaudeSignal({ ...event, rate_limit_info: { ...event.rate_limit_info, overageStatus: 'allowed' } }, { now }), null);
  assert.equal(detectClaudeSignal('API Error: 503 [proxy] [429]: {"type":"error","error":{"type":"rate_limit_error"}} (reset after 1h 2m 3s)', { now }).cooldownUntil,
    new Date(now + 3723000).toISOString());
});

test('Codex native and normalized usage windows wait for the latest exhausted reset', () => {
  const now = Date.parse('2026-10-21T02:00:00Z');
  const message = { method: 'account/rateLimits/updated', params: { rateLimits: {
    primary: { usedPercent: 100, resetsAt: (now + 2000) / 1000 },
    secondary: { usedPercent: 100, resetsAt: (now + 5000) / 1000 },
  } } };
  assert.equal(detectCodexSignal(message, { now }).cooldownUntil, new Date(now + 5000).toISOString());
  assert.equal(detectCodexSignal({ rateLimits: { limitId: 'codex-spark', primary: { usedPercent: 100 } } }), null);
  assert.deepEqual(detectCodexSignal({ failure: { class: 'usage_limit', resetAt: new Date(now + 2000).toISOString() } }, { now }), {
    kind: 'rate-limit', cooldownUntil: new Date(now + 2000).toISOString(),
  });
  assert.deepEqual(detectCodexSignal({ error: { code: 'usageLimitExceeded' } }), { kind: 'rate-limit' });
});

test('Claude permitted overage never cools an account through usage merging', t => {
  const f = fixture(t);
  f.add('acct_a', 'claudeAgent');
  f.observe('acct_a', { type: 'rate_limit_event', rate_limit_info: {
    status: 'rejected', utilization: 1, rateLimitType: 'five_hour', overageStatus: 'allowed',
  } });
  assert.equal(f.pool.snapshot()[0].status, 'active');
});

test('cross-process assignment races reserve each account at most once', async t => {
  const f = fixture(t);
  f.add('acct_a'); f.add('acct_b');
  f.pool.disable({ accountId: 'acct_a', idempotencyKey: f.next() });
  const modulePath = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const run = id => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { AccountPool } from ${JSON.stringify(modulePath)};
      try { const pool = new AccountPool({nodeDataDir:${JSON.stringify(f.nodeDataDir)},machineId:'mch_fixture',clock:()=>${f.now()}}); console.log(JSON.stringify(pool.select({provider:'codex', assignmentId:${JSON.stringify(id)},idempotencyKey:${JSON.stringify(id)}}).account.id)); }
      catch (error) { console.log(JSON.stringify(error.code)); }
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', status => status === 0 ? resolve(JSON.parse(output.trim())) : reject(new Error(error)));
  });
  const results = await Promise.all([run('asg_process_a'), run('asg_process_b')]);
  assert.equal(results.filter(result => result === 'acct_b').length, 1);
  assert.ok(results.every(result => ['acct_b', 'ACCOUNT_POOL_EXHAUSTED', 'ACCOUNT_POOL_BUSY'].includes(result)));
});

test('native Codex error notifications and completed-turn error unions are recognized', () => {
  assert.deepEqual(detectCodexSignal({ method: 'error', params: {
    error: { codexErrorInfo: 'usageLimitExceeded', message: 'private fixture' }, willRetry: false,
  } }), { kind: 'rate-limit' });
  assert.deepEqual(detectCodexSignal({ method: 'turn/completed', params: {
    turn: { error: { codexErrorInfo: { rateLimitExceeded: {} } } },
  } }), { kind: 'rate-limit' });
});

test('sparse exhausted windows preserve the latest cooldown and disable blocks replay', t => {
  const f = fixture(t);
  f.add('acct_a');
  const reset = new Date(f.now() + 10000).toISOString();
  f.observe('acct_a', { windows: [{ id: 'secondary', usedPercent: 100, resetsAt: reset }] });
  f.observe('acct_a', { windows: [{ id: 'primary', usedPercent: 100, resetsAt: new Date(f.now() + 1000).toISOString() }] });
  assert.equal(f.pool.snapshot()[0].cooldownUntil, reset);
  f.advance(10000);
  const input = { provider: 'codex', assignmentId: 'asg_reserved', idempotencyKey: 'reserve' };
  f.pool.select(input);
  f.pool.disable({ accountId: 'acct_a', idempotencyKey: f.next() });
  assert.throws(() => f.pool.select(input), code('ACCOUNT_UNAVAILABLE'));
});

test('an exhausted window without reset uses the fallback alongside known resets', t => {
  const f = fixture(t, { defaultCooldownMs: 10000 });
  f.add('acct_a');
  f.observe('acct_a', { windows: [
    { id: 'primary', usedPercent: 100, resetsAt: new Date(f.now() + 1000).toISOString() },
    { id: 'secondary', usedPercent: 100 },
  ] });
  assert.equal(f.pool.snapshot()[0].cooldownUntil, new Date(f.now() + 10000).toISOString());
});

test('normalized auth failure is invalid while permission failures stay separate', () => {
  assert.deepEqual(detectClaudeSignal({ failure: { code: 'api_error_401' } }), { kind: 'auth-failure' });
  assert.equal(detectClaudeSignal({ error: 'authentication_failed', api_error_status: 403 }), null);
  assert.equal(detectClaudeSignal({ failure: { class: 'permission_error', message: 'Not logged in' } }), null);
});

test('receipt retention bounds churn, preserves recent retries and expires old receipts', t => {
  const f = fixture(t, { maxReceipts: 8, receiptRetentionMs: 1000 });
  f.add('acct_a');
  for (let i = 0; i < 40; i++) {
    f.select(`asg_${i}`);
    f.release(`asg_${i}`);
  }
  const input = { accountId: 'acct_a', idempotencyKey: 'recent-disable' };
  const original = f.pool.disable(input);
  const registry = () => JSON.parse(fs.readFileSync(path.join(f.nodeDataDir, 'accounts/registry.json')));
  assert.ok(Object.keys(registry().receipts).length <= 8);
  assert.deepEqual(f.pool.disable(input), original);
  assert.throws(() => f.pool.enable(input), code('IDEMPOTENCY_CONFLICT'));
  f.advance(1000);
  f.pool.enable({ accountId: 'acct_a', idempotencyKey: f.next() });
  assert.equal(Object.keys(registry().receipts).length, 1);
  assert.equal(f.pool.snapshot()[0].status, 'active');
});

test('startup compacts legacy receipts even after the old registry read limit', t => {
  const f = fixture(t);
  f.add('acct_a');
  const file = path.join(f.nodeDataDir, 'accounts/registry.json');
  const state = JSON.parse(fs.readFileSync(file));
  for (let i = 0; i < 6000; i++) state.receipts[`legacy-${i}`] = {
    signature: 'a'.repeat(64), result: { fixture: 'x'.repeat(700) },
  };
  write(file, JSON.stringify(state));
  assert.ok(fs.statSync(file).size > 4 * 1024 * 1024);
  const reopened = new AccountPool({ nodeDataDir: f.nodeDataDir, machineId: 'mch_fixture', clock: f.now });
  assert.equal(reopened.snapshot().length, 1);
  assert.ok(fs.statSync(file).size < 1024 * 1024);
});

test('pooled exhaustion is explicit while an unenrolled provider remains distinguishable', t => {
  const f = fixture(t);
  assert.throws(() => f.select('asg_none'), code('NO_ELIGIBLE_ACCOUNT'));
  f.add('acct_a');
  f.select('asg_held');
  assert.throws(() => f.select('asg_exhausted'), code('ACCOUNT_POOL_EXHAUSTED'));
  f.release('asg_held');
  f.pool.disable({ accountId: 'acct_a', idempotencyKey: f.next() });
  assert.throws(() => f.select('asg_disabled'), code('ACCOUNT_POOL_EXHAUSTED'));
});

test('reservation expiry recovers crash leaks and fences stale select, release and renew', t => {
  const f = fixture(t, { reservationLeaseMs: 1000 });
  f.add('acct_a');
  const input = { provider: 'codex', assignmentId: 'asg_a', idempotencyKey: 'first-selection' };
  const first = f.pool.select(input);
  assert.equal(first.reservation.expiresAt, new Date(f.now() + 1000).toISOString());
  const reopened = new AccountPool({ nodeDataDir: f.nodeDataDir, machineId: 'mch_fixture', clock: f.now, reservationLeaseMs: 1000 });
  assert.deepEqual(reopened.reservations(), [first.reservation]);
  f.advance(1000);
  assert.throws(() => reopened.select(input), code('RESERVATION_ENDED'));
  const second = f.select('asg_a');
  assert.notEqual(first.reservation.id, second.reservation.id);
  assert.throws(() => f.pool.select(input), code('RESERVATION_ENDED'));
  assert.throws(() => f.pool.release({ assignmentId: 'asg_a', reservationId: first.reservation.id, idempotencyKey: f.next() }), code('RESERVATION_ENDED'));
  assert.throws(() => f.pool.renewReservation({ assignmentId: 'asg_a', reservationId: first.reservation.id, idempotencyKey: f.next() }), code('RESERVATION_ENDED'));
  assert.deepEqual(f.pool.reservations(), [second.reservation]);
  assert.throws(() => f.pool.bindingFor('acct_a', { reservationId: first.reservation.id }), code('RESERVATION_ENDED'));
  f.advance(1000);
  assert.deepEqual(f.pool.reservations(), []);
  assert.throws(() => f.pool.bindingFor('acct_a', { reservationId: second.reservation.id }), code('RESERVATION_ENDED'));
});

test('reservation renewal is durable and retry-safe; reconciliation preserves only live tokens', t => {
  const f = fixture(t, { reservationLeaseMs: 1000 });
  f.add('acct_a'); f.add('acct_b');
  const first = f.select('asg_a');
  const second = f.select('asg_b');
  f.advance(500);
  const input = { assignmentId: 'asg_a', reservationId: first.reservation.id, idempotencyKey: 'renew-once' };
  const renewed = f.pool.renewReservation(input);
  assert.equal(renewed.expiresAt, new Date(f.now() + 1000).toISOString());
  f.advance(400);
  assert.deepEqual(f.pool.renewReservation(input), renewed);
  const reconciled = f.pool.reconcileReservations({ activeReservationIds: [renewed.id], idempotencyKey: f.next() });
  assert.deepEqual(reconciled.released, [second.reservation.id]);
  assert.deepEqual(reconciled.reservations, [renewed]);
  const reopened = new AccountPool({ nodeDataDir: f.nodeDataDir, machineId: 'mch_fixture', clock: f.now });
  assert.deepEqual(reopened.reservations(), [renewed]);
  assert.equal(f.select('asg_c').account.id, 'acct_b');
  f.advance(600);
  assert.throws(() => f.pool.renewReservation(input), code('RESERVATION_ENDED'));
  assert.equal(f.select('asg_d').account.id, 'acct_a');
});

test('legacy reservations receive a finite lease once during migration', t => {
  const f = fixture(t, { reservationLeaseMs: 1000 });
  f.add('acct_a');
  const file = path.join(f.nodeDataDir, 'accounts/registry.json');
  const state = JSON.parse(fs.readFileSync(file));
  state.reservations.asg_legacy = 'acct_a';
  write(file, JSON.stringify(state));
  const reopen = () => new AccountPool({ nodeDataDir: f.nodeDataDir, machineId: 'mch_fixture', clock: f.now, reservationLeaseMs: 1000 });
  const migrated = reopen().reservations()[0];
  assert.equal(migrated.assignmentId, 'asg_legacy');
  f.advance(500);
  assert.deepEqual(reopen().reservations(), [migrated]);
  f.advance(500);
  assert.deepEqual(reopen().reservations(), []);
  assert.equal(f.select('asg_recovered').account.id, 'acct_a');
});

test('unhealthy homes are quarantined without blocking healthy provider accounts', t => {
  const f = fixture(t);
  const source = f.source('claudeAgent');
  const metadata = path.join(f.root, 'claude-identity.json');
  write(metadata, JSON.stringify({ hasCompletedOnboarding: true }));
  f.add('acct_bad', 'claudeAgent', { source: { ...source, accountConfigPath: metadata } });
  f.add('acct_good', 'claudeAgent');
  const home = f.pool.bindingFor('acct_bad').instance.config.homePath;
  fs.chmodSync(path.join(home, '.claude.json'), 0o644);
  assert.equal(f.select('asg_healthy', 'claudeAgent').account.id, 'acct_good');
  assert.equal(f.pool.snapshot().find(account => account.id === 'acct_bad').status, 'invalid');
  f.release('asg_healthy');
  assert.equal(f.select('asg_healthy_again', 'claudeAgent').account.id, 'acct_good');
  fs.chmodSync(path.join(home, '.claude.json'), 0o600);
  f.pool.markAuthenticated({ accountId: 'acct_bad', idempotencyKey: f.next() });
  assert.equal(f.select('asg_repaired', 'claudeAgent').account.id, 'acct_bad');
});

test('an entirely unhealthy pool persists quarantine and throws exhaustion, including missing homes', t => {
  const f = fixture(t);
  f.add('acct_missing');
  const home = f.pool.bindingFor('acct_missing').instance.config.homePath;
  fs.rmSync(home, { recursive: true });
  assert.throws(() => f.select('asg_missing'), code('ACCOUNT_POOL_EXHAUSTED'));
  const reopened = new AccountPool({ nodeDataDir: f.nodeDataDir, machineId: 'mch_fixture', clock: f.now });
  assert.equal(reopened.snapshot()[0].status, 'invalid');
  assert.deepEqual(reopened.reservations(), []);
});
