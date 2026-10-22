import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { observeConfig } from '../src/config.js';

test('observe config: defaults, ~ paths, loopback-only url and bounded settings', () => {
  assert.equal(observeConfig(undefined), undefined);
  assert.deepEqual(observeConfig({ enabled: true }), { enabled: true, t3BaseDir: resolve(homedir(), '.t3/userdata'), pollMs: 5000, includeTitles: true });
  assert.deepEqual(observeConfig({ enabled: true, t3BaseDir: '~/other/userdata', url: 'http://127.0.0.1:3773/', includeTitles: false, tokenTtl: '7d', backfillHours: 24 }, '/root'),
    { enabled: true, t3BaseDir: resolve(homedir(), 'other/userdata'), url: 'http://127.0.0.1:3773', pollMs: 5000, includeTitles: false, tokenTtl: '7d', backfillHours: 24 });
  assert.equal(observeConfig({ enabled: true, credentialFile: 'secrets/t3' }, '/root').credentialFile, '/root/secrets/t3');
  for (const bad of [{ enabled: 'yes' }, { url: 'http://10.0.0.2:3773' }, { pollMs: 10 }, { tokenTtl: 'forever' }, { token: 'x' }, []]) assert.throws(() => observeConfig(bad));
});
