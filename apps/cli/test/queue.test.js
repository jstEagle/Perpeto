import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHub } from '@perpeto/hub';
import { main } from '../src/cli.js';
import { parseArgs } from '../src/args.js';
import { hubConfig, readSecret } from '../src/config.js';
import { request } from '../src/api.js';

async function temporary(t) {
  const dir = await mkdtemp(resolve(tmpdir(), 'pcli-queue-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('queue command grammar', () => {
  assert.deepEqual(parseArgs(['queue']).positionals, []);
  assert.equal(parseArgs(['queue']).action, 'list');
  assert.deepEqual(parseArgs(['queue', 'prj_1']).positionals, ['prj_1']);
  assert.equal(parseArgs(['queue', 'freeze', 'mqn_1', '--reason', 'Incident']).flags.reason, 'Incident');
  assert.equal(parseArgs(['queue', 'unfreeze', 'mqn_1']).action, 'unfreeze');
  assert.equal(parseArgs(['queue', 'config', 'validate', 'queues.json']).action, 'validate');
  for (const words of [['queue', 'freeze'], ['queue', 'freeze', '../x'], ['queue', 'unfreeze', 'a', '--reason', 'x'], ['queue', 'config', 'check', 'f'],
    ['queue', 'config', 'validate'], ['queue', 'prj_1', 'extra'], ['queue', '--labels', 'x']]) assert.throws(() => parseArgs(words), undefined, words.join(' '));
});

test('queue config validate reports JSON paths and exits 1 on problems', async t => {
  const dir = await temporary(t);
  const lines = [];
  const print = line => lines.push(line);
  await writeFile(resolve(dir, 'good.json'), JSON.stringify({ version: 1, queues: [{ name: 'main', strategy: 'speculative', depth: 3 }, { name: 'release', branches: ['release/*'] }] }));
  assert.equal(await main(['queue', 'config', 'validate', resolve(dir, 'good.json')], { print }), 0);
  assert.match(lines.at(-1), /Valid: 2 queues \(main: speculative on main; release: serial on release\/\*\)/);
  await writeFile(resolve(dir, 'bad.json'), JSON.stringify({ version: 1, queues: [{ name: 'main', flakyRetries: 9, freeze: { windows: [{ cron: 'never', durationMinutes: 10 }] } }] }));
  lines.length = 0;
  assert.equal(await main(['queue', 'config', 'validate', resolve(dir, 'bad.json')], { print }), 1);
  assert.deepEqual(lines, ['$.queues[0].flakyRetries must be an integer from 0 to 5.', '$.queues[0].freeze.windows[0].cron must be a five-field UTC cron expression.', '2 problems.']);
  await writeFile(resolve(dir, 'broken.json'), '{');
  lines.length = 0;
  assert.equal(await main(['queue', 'config', 'validate', resolve(dir, 'broken.json')], { print }), 1);
  assert.match(lines[0], /Not valid JSON/);
});

test('queue lists live queues and freezes and unfreezes them through the hub', async t => {
  const dir = await temporary(t);
  const config = { ...hubConfig(dir, { port: 0 }), longPollMs: 0 };
  await writeFile(resolve(dir, 'hub.json'), JSON.stringify(config));
  const hub = await createHub({ configPath: resolve(dir, 'hub.json') });
  t.after(() => hub.close());
  const url = await hub.listen();
  config.port = Number(new URL(url).port);
  await writeFile(resolve(dir, 'hub.json'), JSON.stringify(config));
  const token = (await readSecret(resolve(dir, 'hub/owner.secret'))).trim();
  const project = await request(url, '/projects', { token, body: { name: 'CLI queues', repo: { url: '/tmp/unused.git', defaultBranch: 'main' } } });
  const saved = await hub.hub.request({ method: 'PUT', path: `/projects/${project.id}/merge-queues`, authorization: `Bearer ${token}`,
    body: { config: { version: 1, queues: [{ name: 'main', strategy: 'batch', maxBatchSize: 4 }] }, idempotencyKey: 'cli-save' } });
  const queueId = saved.body.queues[0].id;
  const run = async (...words) => {
    const lines = [];
    assert.equal(await main([...words, '--dir', dir], { print: line => lines.push(line) }), 0);
    assert.ok(!lines.join('\n').includes(token));
    return lines.join('\n');
  };
  const listed = await run('queue', project.id);
  assert.match(listed, /CLI queues \(settings v1\)/);
  assert.match(listed, new RegExp(`main \\[${queueId}\\] batch, main: 0 queued, 0 testing, 0 merging`));
  assert.match(listed, /0\/h merged, median n\/a in queue, failure n\/a, batches n\/a/);
  assert.match(await run('queue', 'freeze', queueId, '--reason', 'Release cut'), /Frozen main: Release cut/);
  assert.match(await run('queue'), /FROZEN: Release cut/);
  assert.match(await run('queue', 'unfreeze', queueId), /Unfrozen main/);
  assert.doesNotMatch(await run('queue', project.id), /FROZEN/);
  await assert.rejects(main(['queue', 'freeze', 'mqn_missing', '--dir', dir], { print() {} }), /404/);
});
