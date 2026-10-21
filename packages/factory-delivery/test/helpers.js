import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LocalGitAdapter, MergeQueueStore, MergeQueue } from '../src/index.js';

const exec = promisify(execFile);
export const git = async (cwd, ...args) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd })).stdout.trim();
export const ci = { steps: [{ name: 'test', run: 'node --test verification.test.js', timeoutSec: 30 }], requirements: { os: process.platform } };

/** All repositories and commands in integration tests are temporary local fixtures. */
export async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'perpeto-delivery-test-'));
  const seed = join(root, 'seed'); const repository = join(root, 'repo.git');
  await mkdir(seed);
  await git(root, 'init', '--bare', '--initial-branch=main', repository);
  await git(seed, 'init', '--initial-branch=main');
  await git(seed, 'config', 'user.name', 'Fixture'); await git(seed, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(seed, 'shared.txt'), 'base\n');
  await writeFile(join(seed, 'verification.test.js'), `const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
test('no failure marker', () => assert.equal(existsSync('fail.txt'), false));
`);
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'Initial fixture');
  await git(seed, 'remote', 'add', 'origin', repository); await git(seed, 'push', 'origin', 'main');
  const adapter = new LocalGitAdapter({ repository });
  const config = { projectId: 'prj_test', repo: { url: repository, defaultBranch: 'main' }, baseBranch: 'main',
    strategy: 'serial', method: 'merge', requiredChecks: ['test'], ci, ...overrides };
  const filename = join(root, 'queue.sqlite');
  let store = new MergeQueueStore(filename);
  let queue = new MergeQueue({ store, queueId: 'mq_test', config, adapter });
  let sequence = 0;
  const f = {
    root, seed, repository, adapter, config, filename,
    get queue() { return queue; }, get store() { return store; },
    async branch(name, changes, from = 'main') {
      await git(seed, 'checkout', '-B', name, from);
      for (const [file, contents] of Object.entries(changes)) await writeFile(join(seed, file), contents);
      await git(seed, 'add', '.'); await git(seed, 'commit', '--allow-empty', '-m', `Update ${name}`);
      await git(seed, 'push', '--force', 'origin', name);
      return { id: `mq_${name}`, projectId: config.projectId, prUrl: `local:${name}`,
        headSha: await adapter.getBase(name), baseBranch: 'main', workItemId: `wi_${name}`, runId: 'run_test' };
    },
    enqueue(entry, idempotencyKey = `enqueue:${entry.id}`) { return queue.enqueue(entry, { idempotencyKey }); },
    step() { return queue.step({ idempotencyKey: `step:${++sequence}` }); },
    result(result) { return queue.recordJobResult(result, { idempotencyKey: `result:${result.id}` }); },
    restart(nextAdapter = adapter) {
      store.close(); store = new MergeQueueStore(filename);
      queue = new MergeQueue({ store, queueId: 'mq_test', config, adapter: nextAdapter });
    },
    async runCI(job = queue.state.jobs.at(-1)) {
      const workspace = join(root, `ci-${++sequence}`);
      await git(repository, 'worktree', 'add', '--detach', workspace, job.revision);
      let status = 'passed';
      // Do not inherit node:test's private child-runner context into this independent CI.
      const { NODE_TEST_CONTEXT: inheritedTestContext, ...env } = process.env;
      try { await exec(process.execPath, ['--test', 'verification.test.js'], { cwd: workspace, env }); }
      catch (error) { if (typeof error.code !== 'number') throw error; status = 'failed'; }
      finally { await git(repository, 'worktree', 'remove', '--force', workspace); }
      const result = { id: job.id, revision: job.revision, configHash: job.configHash, status, artifacts: [] };
      f.result(result); return result;
    },
    async drain(max = 60) {
      for (let i = 0; i < max; i++) {
        const state = queue.state;
        if (!state.active && !state.entries.some(entry => entry.status === 'queued')) return state;
        if (state.active?.phase === 'testing' && state.jobs.find(job => job.id === state.active.jobId).status === 'queued') await f.runCI();
        else await f.step();
      }
      throw new Error('Fixture queue did not drain.');
    },
  };
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return f;
}
