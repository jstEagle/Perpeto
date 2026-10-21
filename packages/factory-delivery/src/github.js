import { DeliveryError, requireValue, sha, string } from './common.js';
import { checked, commandRunner } from './commands.js';

/**
 * GitHub CLI operations, tested with injected runners only. Authentication is owned
 * by gh; credentials never enter this API. Native CLI merge cannot guard base SHA.
 */
export class GitHubAdapter {
  atomicMerge = false;
  constructor({ repository, runner = commandRunner, candidateAdapter }) {
    requireValue(typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository), 'repository must be owner/name.');
    this.repository = repository; this.runner = runner; this.candidateAdapter = candidateAdapter;
  }
  #gh(args, options) { return checked(this.runner, 'gh', args, options); }
  #json(text) {
    try { return JSON.parse(text); }
    catch { throw new DeliveryError('ADAPTER_ERROR', 'GitHub returned malformed JSON.'); }
  }
  #number(prUrl) {
    string(prUrl, 'prUrl');
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/.exec(prUrl);
    requireValue(match && match[1].toLowerCase() === this.repository.toLowerCase(), 'PR URL must identify this GitHub repository.');
    return match[2];
  }
  async createPullRequest({ branch, baseBranch, title, body }) {
    for (const [name, value] of Object.entries({ branch, baseBranch, title, body })) string(value, name);
    requireValue(!branch.startsWith('-') && !baseBranch.startsWith('-'), 'Branch names cannot be options.');
    const existing = this.#json(await this.#gh(['pr', 'list', '--repo', this.repository, '--head', branch,
      '--base', baseBranch, '--state', 'open', '--json', 'url,headRefOid']));
    requireValue(Array.isArray(existing) && existing.length <= 1, 'Ambiguous PR lookup.', 'ADAPTER_ERROR');
    if (existing.length) {
      this.#number(existing[0].url);
      return { prUrl: existing[0].url, headSha: sha(existing[0].headRefOid) };
    }
    // Body goes through stdin, preserving newlines and avoiding shell interpretation.
    const prUrl = await this.#gh(['pr', 'create', '--repo', this.repository, '--head', branch, '--base', baseBranch,
      '--title', title, '--body-file', '-'], { input: body });
    this.#number(prUrl);
    return { prUrl, headSha: await this.getHead({ prUrl }) };
  }
  async getBase(baseBranch) {
    string(baseBranch, 'baseBranch');
    return sha(await this.#gh(['api', `repos/${this.repository}/commits/${encodeURIComponent(baseBranch)}`, '--jq', '.sha']));
  }
  async getHead({ prUrl }) {
    const result = this.#json(await this.#gh(['pr', 'view', this.#number(prUrl), '--repo', this.repository, '--json', 'headRefOid']));
    return sha(result.headRefOid);
  }
  async readChecks({ prUrl }) {
    const result = this.#json(await this.#gh(['pr', 'view', this.#number(prUrl), '--repo', this.repository,
      '--json', 'headRefOid,statusCheckRollup']));
    const revision = sha(result.headRefOid);
    requireValue(Array.isArray(result.statusCheckRollup), 'GitHub checks are malformed.', 'ADAPTER_ERROR');
    return result.statusCheckRollup.map(check => {
      const conclusion = (check.conclusion ?? check.state ?? '').toUpperCase();
      return { name: check.name ?? check.context, revision,
        status: ['SUCCESS'].includes(conclusion) ? 'passed'
          : ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(conclusion) ? 'failed' : 'pending',
        ...(check.detailsUrl || check.targetUrl ? { url: check.detailsUrl ?? check.targetUrl } : {}) };
    });
  }
  async prepare(request) {
    requireValue(this.candidateAdapter, 'A local candidate adapter with fetched GitHub objects is required.', 'ADAPTER_UNAVAILABLE');
    return this.candidateAdapter.prepare(request);
  }
  async isMerged({ baseBranch, revision }) {
    // Equality is sufficient proof; unlike local Git we do not infer remote ancestry.
    return await this.getBase(baseBranch) === revision;
  }
  /** Queue integration refuses this operation because it lacks a base compare-and-swap. */
  async merge() {
    throw new DeliveryError('ATOMIC_MERGE_UNSUPPORTED', 'GitHub CLI cannot atomically guard the tested base. Supply a protected merge-queue adapter.');
  }
  /** Direct forge operation, head-guarded only. Not the speculative queue publish API. */
  async mergePullRequest({ prUrl, headSha, method }) {
    sha(headSha);
    requireValue(['merge', 'squash', 'rebase'].includes(method), 'Unknown merge method.');
    const number = this.#number(prUrl);
    const prior = this.#json(await this.#gh(['pr', 'view', number, '--repo', this.repository, '--json', 'state,headRefOid,mergeCommit']));
    requireValue(prior.headRefOid === headSha, 'PR head changed.', 'HEAD_CHANGED');
    if (prior.state === 'MERGED') return { status: 'merged', revision: sha(prior.mergeCommit.oid) };
    requireValue(prior.state === 'OPEN', 'PR is not open.', 'CONFLICT');
    await this.#gh(['pr', 'merge', number, '--repo', this.repository, `--${method}`, '--match-head-commit', headSha]);
    const result = this.#json(await this.#gh(['pr', 'view', number, '--repo', this.repository, '--json', 'state,mergeCommit']));
    // Protected repositories may enqueue instead of completing the merge immediately.
    return result.state === 'MERGED' ? { status: 'merged', revision: sha(result.mergeCommit.oid) } : { status: 'pending' };
  }
}
