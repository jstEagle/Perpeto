import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHub } from '@perpeto/hub';
import { main } from '../src/cli.js';
import { parseArgs } from '../src/args.js';
import { hubConfig, readSecret } from '../src/config.js';
import { request } from '../src/api.js';

async function temporary(t) {
  const dir = await mkdtemp(resolve(tmpdir(), 'pcli-ci-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const pipelines = { version: 1, pipelines: { default: { jobs: { lint: { steps: [{ name: 'lint', run: 'echo lint' }] },
  test: { needs: ['lint'], matrix: { node: ['22', '24'] }, steps: [{ name: 'test', run: 'echo test' }] } } } } };

test('ci grammar: run and logs take one name, the others none', () => {
  for (const words of [['ci', 'run', 'default'], ['ci', 'run', 'default', '--rev', 'HEAD', '--project', 'Web'], ['ci', 'status'], ['ci', 'logs', 'job_1', '--follow'], ['ci', 'validate', '--file', 'x.json']]) {
    assert.equal(parseArgs(words).help, undefined, words.join(' '));
  }
  for (const words of [['ci', 'run'], ['ci', 'logs'], ['ci', 'logs', '../jobs'], ['ci', 'status', 'extra'], ['ci', 'validate', 'x'], ['ci', 'deploy'], ['ci', 'status', '--follow']]) assert.throws(() => parseArgs(words), words.join(' '));
});

test('ci validate checks .perpeto/ci.json offline and lists every problem with its path', async t => {
  const dir = await temporary(t); const repo = await temporary(t);
  await mkdir(resolve(repo, '.perpeto'));
  await writeFile(resolve(repo, '.perpeto/ci.json'), JSON.stringify(pipelines));
  const output = [];
  const { ci } = await import('../src/ci.js');
  assert.equal(await ci('validate', dir, [], {}, { print: line => output.push(line), cwd: repo }), 0);
  assert.deepEqual(output, ['default: 3 jobs (lint, test (node=22), test (node=24)); triggers manual', `${resolve(repo, '.perpeto/ci.json')} is valid.`]);
  await writeFile(resolve(repo, 'broken.json'), JSON.stringify({ version: 1, pipelines: { default: { jobs: { a: { needs: ['ghost'], steps: [] } } } } }));
  output.length = 0;
  assert.equal(await ci('validate', dir, [], { file: 'broken.json' }, { print: line => output.push(line), cwd: repo }), 1);
  assert.ok(output.includes('$.pipelines.default.jobs.a.steps: steps must be an array of 1 to 50 steps.'));
  assert.match(output.at(-1), /2 problems/);
});

test('ci run, status and logs use the hub pipeline routes', async t => {
  const dir = await temporary(t);
  const config = { ...hubConfig(dir, { port: 0 }), longPollMs: 0 };
  await writeFile(resolve(dir, 'hub.json'), JSON.stringify(config));
  const hub = await createHub({ configPath: resolve(dir, 'hub.json') });
  t.after(() => hub.close());
  const url = await hub.listen();
  config.port = Number(new URL(url).port);
  await writeFile(resolve(dir, 'hub.json'), JSON.stringify(config));
  const token = (await readSecret(resolve(dir, 'hub/owner.secret'))).trim();
  const api = (path, body, method) => method ? fetch(`${url}/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(response => response.json())
    : request(url, path, { token, body });
  const project = await api('/projects', { name: 'Web', repo: { url: 'https://example.invalid/web.git', defaultBranch: 'main' } });
  await api(`/projects/${project.id}/ci-config`, { config: pipelines, idempotencyKey: 'cfg' }, 'PUT');
  const output = [];
  const run = async (...words) => { output.length = 0; return main([...words, '--dir', dir], { print: line => output.push(line) }); };
  assert.equal(await run('ci', 'run', 'default', '--rev', 'a'.repeat(40)), 0);
  assert.match(output[0], /^Started plr_[a-f0-9]+: default at aaaaaaaaaaaa, 3 jobs\.$/);
  assert.equal(await run('ci', 'status', '--project', 'Web'), 0);
  assert.match(output[0], /^plr_\S+ {2}queued +default {2}aaaaaaaaaaaa {2}manual$/);
  assert.ok(output.some(line => /queued +lint {2}job_/.test(line)) && output.some(line => /waiting +test \(node=22\)/.test(line)));
  const [runView] = (await api(`/pipeline-runs?projectId=${project.id}`)).runs;
  const jobId = runView.jobs[0].jobId;
  // A machine streams a log line; the CLI prints it.
  const { code } = await api('/machines/enrollment-codes', { idempotencyKey: 'e' });
  const machine = await request(url, '/nodes/enroll', { body: { code, name: 'm', os: 'linux', arch: 'x64', version: 't' } });
  await request(url, '/nodes/heartbeat', { token: machine.token, body: { status: 'online', capacity: { maxAgents: 0, maxJobs: 1 }, running: { agents: 0, jobs: 0 } } });
  const [job] = (await request(url, '/nodes/lease', { token: machine.token, body: { kinds: ['job'], max: 1 } })).jobs;
  await request(url, `/jobs/${job.id}/events`, { token: machine.token, body: { type: 'log', attempt: job.attempt, data: { chunk: 'hello from the runner\n' } } });
  assert.equal(await run('ci', 'logs', jobId), 0);
  assert.deepEqual(output, ['hello from the runner']);
  await assert.rejects(run('ci', 'run', 'default', '--rev', 'not-a-commit-anywhere', '--project', 'Web'), /Git cannot resolve/);
});
