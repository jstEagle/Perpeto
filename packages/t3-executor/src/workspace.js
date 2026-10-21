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
  if (url.startsWith('/') && !url.includes('\0')) return url; // local repository path
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

async function isWorkingTree(path, signal) {
  try { return (await git(path, ['rev-parse', '--is-bare-repository'], { signal })) === 'false'; }
  catch { return false; }
}

/**
 * Choose where the T3 thread works:
 * - a local working checkout (`repo.localPath`): a T3-managed worktree on the work
 *   branch, reused when it already exists;
 * - otherwise a clone of `repo.url` (or of a bare `localPath`) inside the node's
 *   assignment workspace, on the work branch, starting from the remote branch when
 *   an earlier attempt published it;
 * - with no repository, the node's assignment workspace itself.
 * `startHead` is the commit the agent starts from, used to detect new work. `publishedHead` is the
 * remote work branch's head in a clone (null when it was never published), and `baseRef` the ref the
 * default branch is read from, for rebase steps.
 */
export async function prepareWorkspace({ repo, workspace, branch, signal }) {
  const localPath = repo?.localPath && await isDirectory(repo.localPath) ? await realpath(repo.localPath) : null;
  if (localPath && await isWorkingTree(localPath, signal)) {
    // T3 refuses to create an existing branch, so reuse its worktree or check it out in the node's workspace.
    const existing = await worktreeFor(localPath, branch, signal);
    const baseRef = repo.defaultBranch ?? null;
    if (existing) return { workspaceRoot: localPath, workspaceStrategy: { type: 'existing_worktree', worktreePath: existing, branch }, mode: 'existing_worktree', startHead: await git(existing, ['rev-parse', 'HEAD'], { signal }), baseRef };
    if (await hasBranch(localPath, branch, signal)) {
      if (typeof workspace !== 'string' || !workspace) throw new Error('The node did not provide an assignment workspace.');
      const path = join(await realpath(workspace), 'worktree');
      await git(localPath, ['worktree', 'add', path, branch], { signal });
      const worktreePath = await realpath(path);
      return { workspaceRoot: localPath, workspaceStrategy: { type: 'existing_worktree', worktreePath, branch }, mode: 'existing_worktree', startHead: await git(worktreePath, ['rev-parse', 'HEAD'], { signal }), baseRef };
    }
    const defaultRef = baseRef ?? (await git(localPath, ['rev-parse', '--abbrev-ref', 'HEAD'], { signal }));
    return { workspaceRoot: localPath, workspaceStrategy: { type: 'worktree', baseRef: defaultRef, branch, startFromOrigin: false }, mode: 'worktree', startHead: await git(localPath, ['rev-parse', `${defaultRef}^{commit}`], { signal }), baseRef: defaultRef };
  }
  if (typeof workspace !== 'string' || !workspace) throw new Error('The node did not provide an assignment workspace.');
  const root = await realpath(workspace);
  const source = repo?.url ? repositoryUrl(repo.url) : localPath;
  if (source) {
    const checkout = join(root, 'repo');
    if (await isDirectory(join(checkout, '.git'))) await git(checkout, ['fetch', '--quiet', 'origin'], { signal, timeoutMs: 600000 });
    else {
      if ((await readdir(root)).includes('repo')) throw new Error('Assignment workspace already has a non-repository "repo" entry.');
      await git(root, ['clone', '--quiet', '--no-recurse-submodules', '--', source, checkout], { signal, timeoutMs: 600000 });
    }
    const publishedHead = await git(checkout, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { signal }).catch(() => null);
    const baseRef = repo.defaultBranch ? `origin/${repo.defaultBranch}` : 'origin/HEAD';
    await git(checkout, ['checkout', '--quiet', '-B', branch, publishedHead ? `origin/${branch}` : baseRef], { signal });
    return { workspaceRoot: await realpath(checkout), workspaceStrategy: { type: 'root' }, mode: 'clone', startHead: await git(checkout, ['rev-parse', 'HEAD'], { signal }), publishedHead, baseRef };
  }
  return { workspaceRoot: root, workspaceStrategy: { type: 'root' }, mode: 'workspace', startHead: null };
}

/**
 * Push the work branch to `origin`, so CI and delivery can fetch the exact head. Without `expectedHead`
 * the push never forces. With it (a rebase rewrote the branch) the push replaces the remote branch only
 * while it still points at exactly that commit, so work pushed meanwhile is never overwritten.
 */
export async function publishBranch(checkout, branch, { signal, expectedHead } = {}) {
  try { await git(checkout, ['remote', 'get-url', 'origin'], { signal }); }
  catch { return { published: false, reason: 'The checkout has no origin remote.' }; }
  const lease = expectedHead ? [`--force-with-lease=refs/heads/${branch}:${expectedHead}`] : [];
  try { await git(checkout, ['push', '--quiet', ...lease, 'origin', `HEAD:refs/heads/${branch}`], { signal, timeoutMs: 600000 }); }
  catch {
    return { published: false, failed: true, reason: expectedHead
      ? `Pushing ${branch} to origin failed: the remote branch moved from ${expectedHead}, or the push was refused.`
      : `Pushing ${branch} to origin failed.` };
  }
  return { published: true };
}

/** True when the checkout has uncommitted changes. */
export async function isDirty(checkout, { signal } = {}) {
  try { return (await git(checkout, ['status', '--porcelain'], { signal })).length > 0; } catch { return false; }
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

/**
 * Local bare repositories have no forge, so delivery addresses their work branches as
 * `local:<branch>` (see @perpeto/delivery LocalGitAdapter). GitHub projects keep real PR URLs.
 */
export function localPullRequestUrl(repo, branch) {
  const candidate = repo?.localPath ?? repo?.url;
  if (typeof candidate !== 'string' || typeof branch !== 'string' || !branch) return undefined;
  if (/^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]/.test(repo?.url ?? '')) return undefined;
  return candidate.startsWith('/') || candidate.startsWith('file://') ? `local:${branch}` : undefined;
}

const PR_PATTERN = /https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/(?:pull|pulls|merge_requests|-\/merge_requests)\/\d+/g;

/** Last pull/merge request URL mentioned by the agent, if any. */
export function pullRequestUrl(text) {
  const matches = typeof text === 'string' ? text.match(PR_PATTERN) : null;
  return matches?.at(-1);
}
