import { relative, sep } from 'node:path';

/**
 * Read-only Git questions the janitor asks before it reports or deletes anything. Every call goes through an injected
 * `exec` (no shell) with a timeout and never takes Git's optional locks, so a scan cannot block a running agent's Git.
 */
export function createGit({ exec, timeoutMs = 10_000, realpath = async path => path }) {
  const git = (cwd, args) => exec('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], { timeoutMs });
  const out = async (cwd, args) => { const result = await git(cwd, args); return result.code === 0 ? result.stdout.trim() : null; };

  /** True only when `path` is the top level of a work tree (not a folder inside some other repository). */
  async function isWorkTree(path) {
    const top = await out(path, ['rev-parse', '--show-toplevel']);
    if (!top) return false;
    try { return (await realpath(top)) === (await realpath(path)); } catch { return false; }
  }

  /** The ref merged work lands on: origin's HEAD, else origin/main|master, else local main|master. */
  async function baseRef(path) {
    const symbolic = await out(path, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (symbolic) return symbolic;
    for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master']) {
      if ((await git(path, ['show-ref', '--verify', '--quiet', ref])).code === 0) return ref.replace(/^refs\/(?:remotes|heads)\//, '');
    }
    return null;
  }

  /**
   * Whether HEAD's work is already in the base: an ancestor, or (for squash merges) merging it into the base changes
   * nothing. Undefined when there is no base or Git cannot tell.
   */
  async function merged(path, base) {
    if (!base) return undefined;
    const ancestor = await git(path, ['merge-base', '--is-ancestor', 'HEAD', base]);
    if (ancestor.code === 0) return true;
    if (ancestor.code !== 1) return undefined;
    const tree = await out(path, ['merge-tree', '--write-tree', base, 'HEAD']);
    const baseTree = await out(path, ['rev-parse', `${base}^{tree}`]);
    if (!tree || !baseTree) return false;
    return tree.split('\n')[0] === baseTree;
  }

  /**
   * `{ branch?, dirty, unpushedCommits, merged? }`. Unpushed commits are on HEAD but on no remote-tracking branch and not
   * in the base, so they exist nowhere else. Anything Git cannot answer reads as unsafe (dirty), never as clean.
   */
  async function state(path) {
    const branchName = await out(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const status = await git(path, ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=dirty']);
    const dirty = status.code !== 0 || status.stdout.trim().length > 0;
    const base = await baseRef(path);
    const count = await out(path, ['rev-list', '--count', 'HEAD', '--not', '--remotes', ...(base ? [base] : [])]);
    const head = await out(path, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    // An empty repository has no HEAD commit and nothing to lose beyond its (dirty-checked) files.
    const unpushedCommits = head === null ? 0 : count === null ? 1 : Number(count) || 0;
    const isMerged = head === null ? undefined : await merged(path, base);
    return { ...(branchName && branchName !== 'HEAD' ? { branch: branchName } : {}), dirty, unpushedCommits,
      ...(isMerged !== undefined ? { merged: isMerged } : {}) };
  }

  /** True when Git ignores `path` inside the work tree `root`, so removing it cannot lose tracked or unignored work. */
  async function ignored(root, path) {
    const rel = relative(root, path).split(sep).join('/');
    if (!rel || rel.startsWith('..')) return false;
    const tracked = await git(root, ['ls-files', '--error-unmatch', '--', rel]);
    if (tracked.code === 0) return false;
    return (await git(root, ['check-ignore', '-q', '--', rel])).code === 0;
  }

  /** The common Git directory of a linked worktree, read from its `.git` file, so its metadata can be pruned after removal. */
  async function commonDir(path) {
    const dir = await out(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    return dir || null;
  }

  return { isWorkTree, state, ignored, commonDir, baseRef, merged,
    prune: dir => exec('git', ['--git-dir', dir, 'worktree', 'prune'], { timeoutMs }) };
}
