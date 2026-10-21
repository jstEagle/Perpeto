import { execFile } from 'node:child_process';
import { realpath, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };

/** Run git without a shell; resolves stdout or rejects with a redacted error. */
export function git(cwd, args, { signal, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, signal, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024, env: { ...process.env, ...GIT_ENV } },
      (error, stdout) => error ? reject(Object.assign(new Error(`git ${args[0]} failed.`), { code: 'GIT_FAILED' })) : resolve(stdout.trim()));
  });
}

async function isDirectory(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

export function branchName(value) {
  const name = String(value).replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/\/{2,}/g, '/').replace(/^[-/.]+|[-/.]+$/g, '').replace(/\.\.+/g, '.');
  return name.slice(0, 200) || 'perpeto-work';
}

function repositoryUrl(url) {
  const parsed = (() => { try { return new URL(url); } catch { return null; } })();
  if (parsed) {
    if (!['https:', 'ssh:', 'file:', 'git:'].includes(parsed.protocol)) throw new Error('Unsupported repository URL scheme.');
    if (parsed.password || parsed.search || parsed.hash || (parsed.username && parsed.protocol !== 'ssh:')) throw new Error('Repository credentials must use local credential helpers.');
    return url;
  }
  if (/^[\w.-]+@[\w.-]+:[\w./-]+$/.test(url)) return url; // scp-like SSH
  throw new Error('Unsupported repository URL.');
}

async function hasBranch(root, branch, signal) {
  try { await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { signal }); return true; }
  catch { return false; }
}

async function worktreeFor(root, branch, signal) {
  const listing = await git(root, ['worktree', 'list', '--porcelain'], { signal });
  let path = null;
  for (const line of listing.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}` && path && path !== root) return realpath(path).catch(() => null);
  }
  return null;
}

/**
 * Choose where the T3 thread works:
 * - a local checkout (`repo.localPath`): a T3-managed worktree on the work branch (reused when it exists);
 * - a repository URL: a clone inside the node's assignment workspace on a work branch;
 * - otherwise the node's assignment workspace itself.
 */
export async function prepareWorkspace({ repo, workspace, branch, signal }) {
  if (repo?.localPath && await isDirectory(repo.localPath)) {
    const root = await realpath(repo.localPath);
    await git(root, ['rev-parse', '--git-dir'], { signal });
    // A retried or reworked item continues on its branch. T3 refuses to create
    // an existing branch, so reuse its worktree or check it out in the node's workspace.
    const existing = await worktreeFor(root, branch, signal);
    if (existing) return { workspaceRoot: root, workspaceStrategy: { type: 'existing_worktree', worktreePath: existing, branch }, mode: 'existing_worktree' };
    if (await hasBranch(root, branch, signal)) {
      if (typeof workspace !== 'string' || !workspace) throw new Error('The node did not provide an assignment workspace.');
      const path = join(await realpath(workspace), 'worktree');
      await git(root, ['worktree', 'add', path, branch], { signal });
      return { workspaceRoot: root, workspaceStrategy: { type: 'existing_worktree', worktreePath: await realpath(path), branch }, mode: 'existing_worktree' };
    }
    const baseRef = repo.defaultBranch ?? (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { signal }));
    return { workspaceRoot: root, workspaceStrategy: { type: 'worktree', baseRef, branch, startFromOrigin: false }, mode: 'worktree' };
  }
  if (typeof workspace !== 'string' || !workspace) throw new Error('The node did not provide an assignment workspace.');
  const root = await realpath(workspace);
  if (repo?.url) {
    const checkout = join(root, 'repo');
    if (!await isDirectory(join(checkout, '.git'))) {
      if ((await readdir(root)).includes('repo')) throw new Error('Assignment workspace already has a non-repository "repo" entry.');
      const args = ['clone', '--no-recurse-submodules', ...(repo.defaultBranch ? ['--branch', repo.defaultBranch] : []), '--', repositoryUrl(repo.url), checkout];
      await git(root, args, { signal, timeoutMs: 600000 });
    }
    await git(checkout, ['checkout', '-B', branch], { signal });
    return { workspaceRoot: await realpath(checkout), workspaceStrategy: { type: 'root' }, mode: 'clone' };
  }
  return { workspaceRoot: root, workspaceStrategy: { type: 'root' }, mode: 'workspace' };
}

/** Branch and head commit of a checkout, when it is a Git repository. */
export async function revisionOf(path, { signal } = {}) {
  if (!path || !await isDirectory(path)) return {};
  try {
    const [branch, headSha] = await Promise.all([
      git(path, ['rev-parse', '--abbrev-ref', 'HEAD'], { signal, timeoutMs: 15000 }),
      git(path, ['rev-parse', 'HEAD'], { signal, timeoutMs: 15000 }),
    ]);
    return { ...(branch && branch !== 'HEAD' ? { branch } : {}), ...(/^[0-9a-f]{40,64}$/.test(headSha) ? { headSha } : {}) };
  } catch { return {}; }
}

const PR_PATTERN = /https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/(?:pull|pulls|merge_requests|-\/merge_requests)\/\d+/g;

/** Last pull/merge request URL mentioned by the agent, if any. */
export function pullRequestUrl(text) {
  const matches = typeof text === 'string' ? text.match(PR_PATTERN) : null;
  return matches?.at(-1);
}
