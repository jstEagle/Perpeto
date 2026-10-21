import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { createT3Executor, T3Client } from '../src/index.js';
import { startFakeT3, build } from './fake-t3.js';
import { verifyRebase } from '../src/rebase.js';

// Conflict recovery (docs/handoffs/factory-workflow.md): a `step: 'rebase'` assignment rebases the existing work
// branch onto the latest base, and the executor works out rebaseTouchedBeyondConflicts from Git itself.

const identity = ['-c', 'user.email=t@example.com', '-c', 'user.name=t'];
const git = (cwd, ...args) => execFileSync('git', [...identity, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } }).trim();
const tryGit = (cwd, ...args) => { try { git(cwd, ...args); return true; } catch { return false; } };
const lines = (...values) => `${values.join('\n')}\n`;
const original = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const BRANCH = 'perpeto/wi_7';

async function setup(t) {
  const fake = await startFakeT3();
  const root = await mkdtemp(join(tmpdir(), 't3-executor-rebase-'));
  const executor = createT3Executor({ config: { url: fake.url, settleMs: 30, pollMs: 10, interruptGraceMs: 300, accountReadyTimeoutMs: 500, agentHomesDir: fake.homes },
    createClient: settings => new T3Client({ baseUrl: settings.url, token: 'test-token', pingMs: 0 }) });
  const events = [];
  let workspaces = 0;
  const ctx = () => { const workspace = join(root, `ws-${++workspaces}`); execFileSync('mkdir', ['-p', workspace]); return { signal: new AbortController().signal, workspace, report: async event => { events.push(event); } }; };
  t.after(async () => { await executor.close(); await fake.close(); await rm(root, { recursive: true, force: true }); });

  // origin/main and a published, reviewed work branch, then main moves on and conflicts with it on line three.
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = join(root, 'seed');
  execFileSync('git', ['clone', '-q', origin, seed]);
  await writeFile(join(seed, 'app.txt'), lines(...original));
  git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'init'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
  git(seed, 'checkout', '-q', '-b', BRANCH);
  await writeFile(join(seed, 'app.txt'), lines('one', 'two', 'three (work)', 'four', 'five', 'six', 'seven', 'eight'));
  await writeFile(join(seed, 'feature.txt'), 'feature\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'work'); git(seed, 'push', '-q', 'origin', `HEAD:${BRANCH}`);
  const reviewedHead = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'checkout', '-q', 'main');
  await writeFile(join(seed, 'app.txt'), lines('one', 'two', 'three (main)', 'four', 'five', 'six', 'seven', 'eight'));
  git(seed, 'commit', '-q', '-am', 'main moves'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
  const mainHead = git(seed, 'rev-parse', 'HEAD');
  return { fake, executor, ctx, events, root, origin, seed, reviewedHead, mainHead, repo: { url: origin, defaultBranch: 'main' } };
}

const rebaseAssignment = (repo, extra) => ({ id: `asg_${Math.random().toString(36).slice(2)}`, runId: 'run_1', workItemId: 'wi_7', role: 'builder', nodeType: 'agent',
  step: 'rebase', rebaseOf: 'mq_1', attempt: 1, repo,
  prompt: 'Rebase onto the new base (main). Fetch the latest base, resolve conflicts and keep behavior.',
  harness: { provider: 'codex', model: 'gpt-test' }, policy: { maxSubagents: 0, allowedSubagentProviders: [], canMessage: [] }, ...extra });

/** The scripted agent: run the real rebase in the thread's checkout, then `resolve` the conflicted checkout. */
function agent(fake, { text, resolve, rebase = true }) {
  fake.state.onLaunch = async launch => {
    const threadId = launch.threadId;
    fake.emit(threadId, 'run.updated', build.run(threadId, 1, 'running'));
    const checkout = fake.state.projects.find(project => project.id === launch.projectId).workspaceRoot;
    agent.checkout = checkout;
    if (rebase) {
      git(checkout, 'fetch', '-q', 'origin');
      assert.equal(tryGit(checkout, 'rebase', '-q', 'origin/main'), false, 'the rebase really conflicts');
    }
    await resolve?.(checkout);
    fake.emit(threadId, 'turn-item.updated', build.assistant(threadId, 1, text));
    fake.emit(threadId, 'run.updated', build.run(threadId, 1, 'completed'));
  };
}
const finishRebase = checkout => { git(checkout, 'add', 'app.txt'); git(checkout, 'rebase', '--continue'); };
const launchPrompt = fake => fake.state.commands.findLast(item => item.tag === 'orchestration.launchThread').payload.initialMessage.text;

test('a conflict-only rebase publishes the same branch with a lease and reports false, whatever the model claims', async t => {
  const { fake, executor, ctx, events, origin, reviewedHead, mainHead, repo } = await setup(t);
  agent(fake, {
    text: 'Resolved line three, tests pass.\n```json\n{"rebaseTouchedBeyondConflicts": true}\n```',
    resolve: async checkout => {
      assert.match(await readFile(join(checkout, 'app.txt'), 'utf8'), /^<<<<<<< /m);
      await writeFile(join(checkout, 'app.txt'), lines('one', 'two', 'three (main + work)', 'four', 'five', 'six', 'seven', 'eight'));
      finishRebase(checkout);
    },
  });
  const result = await executor.run(rebaseAssignment(repo), ctx());
  assert.equal(result.outcome, 'success', result.summary);
  assert.equal(result.rebaseTouchedBeyondConflicts, false, 'computed from git, not taken from the reply');
  assert.equal(result.branch, BRANCH);
  assert.equal(result.prUrl, `local:${BRANCH}`);
  assert.notEqual(result.headSha, reviewedHead);
  assert.equal(git(origin, 'rev-parse', `refs/heads/${BRANCH}`), result.headSha, 'the same work branch now points at the rebased head');
  assert.ok(tryGit(origin, 'merge-base', '--is-ancestor', mainHead, result.headSha), 'the new head contains the latest base');
  assert.equal(git(origin, 'show', `${result.headSha}:feature.txt`), 'feature');

  const prompt = launchPrompt(fake);
  assert.match(prompt, /Rebase step/);
  assert.match(prompt, /origin\/main/);
  assert.match(prompt, /tests/);
  assert.match(prompt, new RegExp(`lease on ${reviewedHead}`));
  const verified = events.find(event => event.data?.interaction === 'rebase.verified');
  assert.deepEqual({ ...verified.data, at: undefined }, { interaction: 'rebase.verified', rebaseOf: 'mq_1', branch: BRANCH, base: mainHead, previousHead: reviewedHead,
    headSha: result.headSha, conflicted: ['app.txt'], touchedBeyondConflicts: false, beyondConflicts: [], at: undefined });
  const published = events.find(event => event.data?.interaction === 'branch.published');
  assert.equal(published.data.published, true);
  assert.equal(published.data.leaseHead, reviewedHead);
});

test('edits outside the conflict hunks report true, whatever the model claims', async t => {
  const { fake, executor, ctx, events, origin, repo } = await setup(t);
  agent(fake, {
    text: 'Only resolved the conflict.\n```json\n{"rebaseTouchedBeyondConflicts": false}\n```',
    resolve: async checkout => {
      await writeFile(join(checkout, 'app.txt'), lines('one', 'two', 'three (main + work)', 'four', 'five', 'six', 'seven', 'eight (also changed)'));
      finishRebase(checkout);
    },
  });
  const result = await executor.run(rebaseAssignment(repo), ctx());
  assert.equal(result.outcome, 'success', result.summary);
  assert.equal(result.rebaseTouchedBeyondConflicts, true);
  assert.equal(git(origin, 'rev-parse', `refs/heads/${BRANCH}`), result.headSha);
  assert.deepEqual(events.find(event => event.data?.interaction === 'rebase.verified').data.beyondConflicts, ['app.txt']);

  // A new file is also beyond the conflicts.
  const second = await setup(t);
  agent(second.fake, {
    text: 'Resolved.',
    resolve: async checkout => {
      await writeFile(join(checkout, 'app.txt'), lines('one', 'two', 'three (main + work)', 'four', 'five', 'six', 'seven', 'eight'));
      await writeFile(join(checkout, 'extra.txt'), 'extra\n');
      git(checkout, 'add', 'extra.txt');
      finishRebase(checkout);
    },
  });
  const added = await second.executor.run(rebaseAssignment(second.repo), second.ctx());
  assert.equal(added.rebaseTouchedBeyondConflicts, true);
  assert.deepEqual(second.events.find(event => event.data?.interaction === 'rebase.verified').data.beyondConflicts, ['extra.txt']);
});

test('a work branch that moved during the rebase is not overwritten', async t => {
  const { fake, executor, ctx, root, origin, repo } = await setup(t);
  const other = join(root, 'other');
  let moved;
  agent(fake, {
    text: 'Resolved.',
    resolve: async checkout => {
      await writeFile(join(checkout, 'app.txt'), lines('one', 'two', 'three (main + work)', 'four', 'five', 'six', 'seven', 'eight'));
      finishRebase(checkout);
      // Someone else pushes to the work branch while the agent works.
      execFileSync('git', ['clone', '-q', '-b', BRANCH, origin, other]);
      await writeFile(join(other, 'late.txt'), 'late\n');
      git(other, 'add', '.'); git(other, 'commit', '-q', '-m', 'late'); git(other, 'push', '-q', 'origin', `HEAD:${BRANCH}`);
      moved = git(other, 'rev-parse', 'HEAD');
    },
  });
  const result = await executor.run(rebaseAssignment(repo), ctx());
  assert.equal(result.outcome, 'failure');
  assert.match(result.summary, /moved/);
  assert.equal(git(origin, 'rev-parse', `refs/heads/${BRANCH}`), moved, 'the other push survives');
});

test('a rebase that is unfinished or misses the base fails without publishing', async t => {
  const { fake, executor, ctx, origin, reviewedHead, repo } = await setup(t);
  agent(fake, { text: 'I gave up halfway.' }); // conflict left in progress
  const unfinished = await executor.run(rebaseAssignment(repo), ctx());
  assert.equal(unfinished.outcome, 'failure');
  assert.match(unfinished.summary, /still in progress/);
  assert.equal(unfinished.rebaseTouchedBeyondConflicts, undefined);
  assert.equal(git(origin, 'rev-parse', `refs/heads/${BRANCH}`), reviewedHead);

  agent(fake, { text: 'Nothing to do.', rebase: false });
  const skipped = await executor.run(rebaseAssignment(repo, { attempt: 2 }), ctx());
  assert.equal(skipped.outcome, 'failure');
  assert.match(skipped.summary, /does not contain origin\/main/);
  assert.equal(git(origin, 'rev-parse', `refs/heads/${BRANCH}`), reviewedHead);
});

test('a rebase needs a published work branch', async t => {
  const { fake, executor, ctx, repo } = await setup(t);
  agent(fake, { text: 'unused', rebase: false });
  const result = await executor.run(rebaseAssignment(repo, { workItemId: 'wi_unpublished' }), ctx());
  assert.equal(result.outcome, 'blocked');
  assert.match(result.summary, /no published work branch/);
  assert.equal(fake.state.commands.some(item => item.tag === 'orchestration.launchThread'), false);
});

test('verifyRebase allows any resolution inside each of several hunks, and refuses committed conflict markers', async t => {
  const root = await mkdtemp(join(tmpdir(), 't3-executor-hunks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
  const variant = (tag, ...extra) => base.map((line, index) => index === 1 || index === 9 ? `${line} (${tag})` : line).concat(extra);
  git(root, 'init', '-q', '-b', 'main');
  await writeFile(join(root, 'app.txt'), lines(...base));
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'init');
  git(root, 'checkout', '-q', '-b', 'work');
  await writeFile(join(root, 'app.txt'), lines(...variant('work')));
  git(root, 'commit', '-q', '-am', 'work');
  const previousHead = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', 'main');
  await writeFile(join(root, 'app.txt'), lines(...variant('main')));
  git(root, 'commit', '-q', '-am', 'main');
  const baseHead = git(root, 'rev-parse', 'HEAD');

  async function rebaseWith(content) {
    git(root, 'checkout', '-q', '-B', 'attempt', previousHead);
    assert.equal(tryGit(root, 'rebase', '-q', 'main'), false);
    if (content !== null) await writeFile(join(root, 'app.txt'), content);
    git(root, 'add', 'app.txt'); git(root, '-c', 'core.hooksPath=/dev/null', 'rebase', '--continue');
    return verifyRebase(root, { baseRef: 'main', baseHead, previousHead, headSha: git(root, 'rev-parse', 'HEAD') });
  }
  const resolved = variant('main + work').map((line, index) => index === 1 ? 'line 2 resolved\nwith an extra line' : line);
  const clean = await rebaseWith(lines(...resolved));
  assert.equal(clean.ok, true);
  assert.equal(clean.touchedBeyondConflicts, false);
  assert.deepEqual(clean.conflicted, ['app.txt']);
  const touched = await rebaseWith(lines(...resolved.map((line, index) => index === 5 ? 'line 6 (changed)' : line)));
  assert.equal(touched.touchedBeyondConflicts, true);
  const markers = await rebaseWith(null);
  assert.equal(markers.ok, false);
  assert.match(markers.reason, /conflict markers in app.txt/);
});
