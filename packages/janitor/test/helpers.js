import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as nodeFs from 'node:fs/promises';
import { defaultExec } from '../src/exec.js';

/** Real filesystem with a fake disk of `freePercent` free, so tests never depend on this machine's disk. */
export const fakeDisk = (freePercent = 50) => ({ ...nodeFs, statfs: async () => ({ blocks: 1_000_000, bsize: 4096, bavail: Math.round(10_000 * freePercent) }) });

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
export const git = (cwd, ...args) => execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A temporary directory, removed after the test. Everything a test scans or deletes lives inside it. */
export async function temp(t, prefix = 'perpeto-janitor-') {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export async function file(path, content = 'x') {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

/** A bare origin and a main clone with one pushed commit and a .gitignore for build output. */
export async function repository(dir) {
  const origin = join(dir, 'origin.git');
  git(dir, 'init', '--bare', '--quiet', origin);
  const main = join(dir, 'main');
  git(dir, 'clone', '--quiet', origin, main);
  await file(join(main, 'README.md'), 'hello\n');
  await file(join(main, '.gitignore'), 'node_modules/\ndist/\n');
  git(main, 'add', '.'); git(main, 'commit', '--quiet', '-m', 'initial'); git(main, 'push', '--quiet', 'origin', 'HEAD:main');
  git(main, 'remote', 'set-head', 'origin', 'main');
  return { origin, main };
}

/** Real git through the default exec; everything else (ps, lsof, xcrun) answered by `fake`. Never touches real processes. */
export function fakeExec(fake = () => ({ code: 1, stdout: '' })) {
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push([command, ...args]);
    if (command === 'git') return defaultExec(command, args, { ...options, env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    return fake(command, args, options);
  };
  exec.calls = calls;
  return exec;
}
