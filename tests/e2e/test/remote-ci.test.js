import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { eventually, startFactory } from './support.js';

const run = promisify(execFile);
// The agent and the test use git directly; only the node's CI checkout goes through the logging shim below.
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const identity = ['-c', 'user.name=Factory Agent', '-c', 'user.email=agent@perpeto.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
const git = async (cwd, ...args) => (await run(realGit, [...identity, ...args], { cwd })).stdout.trim();
const inside = (parent, path) => { const child = relative(parent, path); return !child || (!child.startsWith('..') && !isAbsolute(child)); };

const node = (id, type, config = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const graph = { schema: 'perpeto.workflow/1', nodes: [
  node('input', 'input', { source: 'manual', docs: [] }),
  node('builder', 'agent', { harness: { provider: 'fake', model: 'test' }, prompt: 'Build', concurrency: 1, policy: { maxSubagents: 0, allowedSubagentProviders: [] } }),
  node('ci', 'ci', { steps: [{ name: 'test', run: 'test -f feature.txt && git rev-parse HEAD' }] }),
  node('merge', 'merge-queue', { strategy: 'serial', method: 'squash', requiredChecks: ['ci'] }),
  node('output', 'output'),
], edges: [
  { id: 'a', kind: 'flow', from: { node: 'input' }, to: { node: 'builder' } }, { id: 'b', kind: 'flow', from: { node: 'builder' }, to: { node: 'ci' } },
  { id: 'c', kind: 'flow', from: { node: 'ci', port: 'pass' }, to: { node: 'merge' } }, { id: 'd', kind: 'flow', from: { node: 'ci', port: 'fail' }, to: { node: 'output' } },
  { id: 'e', kind: 'flow', from: { node: 'merge', port: 'pass' }, to: { node: 'output' } },
] };

test('CI and merge-queue jobs run on a machine that shares no paths with the hub, fetching exactly their revision from it', async t => {
  // The project repository lives with the hub. The node gets its own root, its CI steps are sandboxed away from the
  // hub's directories, and every git command its checkout runs is logged.
  const repoRoot = await mkdtemp(join(tmpdir(), 'perpeto-e2e-hubrepo-')); t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const repository = join(repoRoot, 'project.git'); const seed = join(repoRoot, 'seed');
  await git(repoRoot, 'init', '--bare', '--initial-branch=main', repository); await git(repoRoot, 'clone', repository, seed);
  await writeFile(join(seed, 'README.md'), '# Fixture\n'); await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'Initial'); await git(seed, 'push', 'origin', 'HEAD:main');
  const shimRoot = await mkdtemp(join(tmpdir(), 'perpeto-e2e-shim-')); t.after(() => rm(shimRoot, { recursive: true, force: true }));
  const log = join(shimRoot, 'git.log'); await mkdir(join(shimRoot, 'bin'));
  await writeFile(join(shimRoot, 'bin', 'git'), `#!/bin/sh\nprintf '%s\\t%s\\n' "$PWD" "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
  await writeFile(log, '');

  const executor = { kind: 'fixture', canRun: () => true, async run(assignment, ctx) {
    // Stands in for an agent pushing its branch to the project's remote.
    const source = join(ctx.workspace, 'source');
    await git(ctx.workspace, 'clone', assignment.repo.url, source);
    await git(source, 'checkout', '-b', 'feature'); await writeFile(join(source, 'feature.txt'), 'remote ci');
    await git(source, 'add', '.'); await git(source, 'commit', '-m', 'Feature'); await git(source, 'push', 'origin', 'HEAD:feature');
    return { outcome: 'success', summary: 'Feature ready', branch: 'feature', prUrl: 'local:feature', headSha: await git(source, 'rev-parse', 'HEAD') };
  } };
  const factory = await startFactory(t, { executor, separateNode: true,
    node: ({ root }) => ({ jobs: { path: [join(shimRoot, 'bin'), dirname(realGit), '/usr/bin', '/bin'], protectedPaths: [root, repoRoot] } }) });
  assert.ok(!inside(factory.root, factory.nodeDataDir) && !inside(factory.nodeRoot, factory.root), 'hub and node share no directory');

  const project = await factory.request('POST', '/projects', { name: 'Remote CI', repo: { url: repository, defaultBranch: 'main' } });
  const workflow = await factory.request('POST', `/projects/${project.id}/workflows`, { name: 'Build', graph });
  await factory.request('POST', `/workflows/${workflow.id}/activate`, { version: 1 });
  const started = await factory.request('POST', `/workflows/${workflow.id}/runs`, { input: { items: [{ title: 'One feature' }] } });
  const finished = await eventually(async () => { const value = await factory.request('GET', `/runs/${started.id}`); return ['completed', 'failed'].includes(value.status) && value; });
  assert.equal(finished.status, 'completed');
  const [entry] = (await factory.request('GET', `/projects/${project.id}/merge-queue`)).entries;
  assert.equal(entry.status, 'merged'); assert.equal(await git(repoRoot, '--git-dir', repository, 'show', 'main:feature.txt'), 'remote ci');

  const jobs = (await factory.request('GET', `/jobs?runId=${started.id}`)).jobs;
  assert.equal(jobs.length, 2, 'the ci job and the speculative merge job'); assert.ok(jobs.every(job => job.status === 'passed'));
  for (const job of jobs) {
    assert.deepEqual(job.source, { kind: 'hub-bundle', path: `/jobs/${job.id}/bundle` });
    const text = JSON.stringify(job);
    assert.ok(!text.includes(repoRoot) && !text.includes(factory.root), 'a job carries no hub path');
    const output = (await factory.request('GET', `/jobs/${job.id}/log`)).chunks.map(chunk => chunk.chunk).join('');
    assert.ok(output.includes(job.revision), 'the step ran at exactly the job revision');
  }
  const calls = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
  assert.ok(calls.filter(line => / fetch .*\.bundle /.test(line)).length >= 2, `each job fetched a bundle:\n${calls.join('\n')}`);
  assert.deepEqual(calls.filter(line => line.includes(factory.root) || line.includes(repoRoot)), [], 'the node never addressed a hub path');
});
