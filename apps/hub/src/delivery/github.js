import { mkdir, rename, rm, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GitHubAdapter, LocalGitAdapter } from '@perpeto/delivery';
import { checked, commandRunner } from '@perpeto/delivery/commands';

/** Public GitHub URLs and SSH clone URLs identify the forge; credentials remain with git/gh. */
export function githubRepository(url = '') {
  return /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null;
}

/** Own the candidate mirror, preserving candidate refs across fetches and process restarts. */
export function githubAdapter(record) {
  const { repository, remote, github, config } = record;
  const git = args => checked(commandRunner, 'git', args, { cwd: repository, env: { GIT_TERMINAL_PROMPT: '0' } });
  let initialized;
  async function ready() {
    initialized ??= (async () => {
      try { await access(repository); }
      catch {
        await mkdir(dirname(repository), { recursive: true, mode: 0o700 });
        const temporary = `${repository}.${randomUUID()}`;
        try {
          await checked(commandRunner, 'git', ['clone', '--bare', '--', remote, temporary], { env: { GIT_TERMINAL_PROMPT: '0' } });
          await rename(temporary, repository);
        } finally { await rm(temporary, { recursive: true, force: true }); }
      }
    })().catch(error => { initialized = null; throw error; });
    return initialized;
  }
  const candidate = new LocalGitAdapter({ repository });
  const adapter = new GitHubAdapter({ repository: github, publication: config.publication, candidateAdapter: {
    repository,
    async prepare(request) {
      await ready();
      // Fetch immutable observed commits, including a new base after a publication race. Never prune candidate refs.
      for (const revision of new Set([request.baseSha, ...request.entries.map(entry => entry.headSha)])) {
        await git(['fetch', '--no-tags', '--no-write-fetch-head', 'origin', revision]);
      }
      return candidate.prepare(request);
    },
  } });
  return {
    atomicMerge: true,
    getBase: async (...args) => { await ready(); return adapter.getBase(...args); },
    getHead: entry => adapter.getHead(entry),
    isMerged: async request => { await ready(); return adapter.isMerged(request); },
    prepare: request => adapter.prepare(request),
    merge: async request => { await ready(); return adapter.merge(request); },
  };
}
