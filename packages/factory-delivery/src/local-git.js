import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DeliveryError, requireValue, sha, stableHash, string } from './common.js';
import { checked, commandRunner } from './commands.js';

const gitConfig = ['-c', 'user.name=Perpeto', '-c', 'user.email=factory@perpeto.invalid',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
const commitEnvironment = { GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z', GIT_TERMINAL_PROMPT: '0' };

/** Local bare Git adapter. PR URLs are local:<branch>, not remote forge addresses. */
/** @implements {import('./types.js').GitForgeAdapter} */
export class LocalGitAdapter {
  atomicMerge = true;
  constructor({ repository, runner = commandRunner }) {
    string(repository, 'repository'); this.repository = resolve(repository); this.runner = runner;
  }
  async #run(args, options = {}) {
    return this.runner('git', [...gitConfig, ...args], { cwd: this.repository, env: commitEnvironment, ...options });
  }
  async #git(args, options = {}) {
    return checked((command, argv, opts) => this.#run(argv, opts), 'git', args, options);
  }
  async #branch(branch) {
    string(branch, 'branch');
    requireValue(!branch.startsWith('-') && !branch.startsWith('refs/'), 'Expected a short branch name.');
    await this.#git(['check-ref-format', `refs/heads/${branch}`]);
    return `refs/heads/${branch}`;
  }
  async #assertBare() {
    requireValue(await this.#git(['rev-parse', '--is-bare-repository']) === 'true', 'Local delivery requires a bare repository.');
  }
  async #entryRef(entry) {
    requireValue(typeof entry.prUrl === 'string' && entry.prUrl.startsWith('local:'), 'Local PRs use local:<branch>.');
    return this.#branch(entry.prUrl.slice(6));
  }
  async getBase(branch) { return sha(await this.#git(['rev-parse', '--verify', await this.#branch(branch)])); }
  async getHead(entry) { return sha(await this.#git(['rev-parse', '--verify', await this.#entryRef(entry)])); }
  async createPullRequest({ branch }) {
    await this.#branch(branch);
    return { prUrl: `local:${branch}`, headSha: await this.getBase(branch) };
  }
  async readChecks() { return []; }
  async isMerged({ baseBranch, revision }) {
    sha(revision);
    const result = await this.#run(['merge-base', '--is-ancestor', revision, await this.#branch(baseBranch)]);
    requireValue([0, 1].includes(result.exitCode), 'Could not inspect merge ancestry.', 'COMMAND_FAILED');
    return result.exitCode === 0;
  }
  /** Materialize a candidate in a disposable worktree, keeping its commit reachable by ref. */
  async prepare({ baseSha, entries, method, idempotencyKey }) {
    await this.#assertBare();
    sha(baseSha); string(idempotencyKey, 'idempotencyKey');
    requireValue(entries.length > 0, 'A candidate requires entries.');
    entries.forEach(entry => sha(entry.headSha));
    requireValue(['merge', 'squash', 'rebase'].includes(method), 'Unknown merge method.');
    const ref = `refs/perpeto/candidates/${stableHash({ baseSha, heads: entries.map(entry => entry.headSha), method, idempotencyKey })}`;
    const cached = await this.#run(['rev-parse', '--verify', ref]);
    if (cached.exitCode === 0) return { revision: sha(cached.stdout.trim()), ref };
    const directory = await mkdtemp(join(tmpdir(), 'perpeto-merge-'));
    const workspace = join(directory, 'tree');
    let added = false;
    try {
      await this.#git(['worktree', 'add', '--detach', workspace, baseSha]); added = true;
      for (const entry of entries) {
        let result;
        if (method === 'rebase') {
          const onto = await this.#git(['rev-parse', 'HEAD'], { cwd: workspace });
          const fork = await this.#git(['merge-base', onto, entry.headSha]);
          await this.#git(['checkout', '--detach', entry.headSha], { cwd: workspace });
          result = await this.#run(['rebase', '--onto', onto, fork], { cwd: workspace });
        } else {
          result = await this.#run(method === 'merge'
            ? ['merge', '--no-ff', '--no-edit', entry.headSha]
            : ['merge', '--squash', entry.headSha], { cwd: workspace });
        }
        if (result.exitCode !== 0) {
          const unmerged = await this.#git(['ls-files', '--unmerged'], { cwd: workspace });
          if (unmerged) {
            const error = new DeliveryError('MERGE_CONFLICT', 'Candidate has merge conflicts.');
            error.entryId = entry.id; throw error;
          }
          throw new DeliveryError('COMMAND_FAILED', 'Could not prepare merge candidate.');
        }
        if (method === 'squash') await this.#git(['commit', '--allow-empty', '-m', `Perpeto merge ${entry.id}`], { cwd: workspace });
      }
      const revision = sha(await this.#git(['rev-parse', 'HEAD'], { cwd: workspace }));
      await this.#git(['update-ref', ref, revision]);
      return { revision, ref };
    } finally {
      if (added) await this.#run(['worktree', 'remove', '--force', workspace]);
      await rm(directory, { recursive: true, force: true });
    }
  }
  /** Compare base and every PR head atomically while advancing the base to the tested SHA. */
  async merge({ baseBranch, baseSha, revision, entries }) {
    await this.#assertBare();
    sha(baseSha); sha(revision);
    if (await this.isMerged({ baseBranch, revision })) return { status: 'merged', revision };
    const baseRef = await this.#branch(baseBranch);
    const refs = await Promise.all(entries.map(entry => this.#entryRef(entry)));
    requireValue(!refs.includes(baseRef) && new Set(refs).size === refs.length, 'PR refs must be distinct from the base and each other.');
    const input = ['start', ...refs.map((ref, i) => `verify ${ref} ${sha(entries[i].headSha)}`),
      `update ${baseRef} ${revision} ${baseSha}`, 'prepare', 'commit', ''].join('\n');
    const result = await this.#run(['update-ref', '--stdin'], { input });
    if (result.exitCode === 0) return { status: 'merged', revision };
    if (await this.isMerged({ baseBranch, revision })) return { status: 'merged', revision };
    if (await this.getBase(baseBranch) !== baseSha) return { status: 'base_changed' };
    for (const entry of entries) if (await this.getHead(entry) !== entry.headSha) return { status: 'head_changed' };
    throw new DeliveryError('COMMAND_FAILED', 'Could not publish tested candidate.');
  }
}
