import { DeliveryError, requireValue, sha, string } from './common.js';
import { checked, commandRunner } from './commands.js';

/**
 * GitHub CLI operations, tested with injected runners only. Authentication is owned
 * by gh; credentials never enter this API. Publication guarantees depend on the selected strategy; see README.
 */
export class GitHubAdapter {
  // Atomic remote ref update (fast-forward) or GitHub-owned native queue.
  // Neither promises the LocalGitAdapter's atomic comparison of PR heads.
  atomicMerge = true;
  constructor({ repository, runner = commandRunner, candidateAdapter, gitRepository = candidateAdapter?.repository, publication = 'fast-forward-push' }) {
    requireValue(typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository), 'repository must be owner/name.');
    this.repository = repository; this.runner = runner; this.candidateAdapter = candidateAdapter;
    this.gitRepository = gitRepository; this.publication = this.#publication(publication);
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
  async getBase(baseBranch, publication = this.publication) {
    if (this.#publication(publication) === 'fast-forward-push') return this.#remoteBase(baseBranch);
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
  #publication(value = this.publication) {
    requireValue(['fast-forward-push', 'github-merge-queue'].includes(value), 'Unknown publication strategy.');
    return value;
  }
  async #git(args) {
    requireValue(this.gitRepository, 'A synchronized Git mirror with origin is required.', 'ADAPTER_UNAVAILABLE');
    return checked(this.runner, 'git', args, { cwd: this.gitRepository, env: { GIT_TERMINAL_PROMPT: '0' } });
  }
  async #baseRef(baseBranch) {
    string(baseBranch, 'baseBranch');
    requireValue(!baseBranch.startsWith('-') && !baseBranch.startsWith('refs/'), 'Expected a short base branch name.');
    const ref = `refs/heads/${baseBranch}`;
    await this.#git(['check-ref-format', ref]);
    return ref;
  }
  async #remoteBase(baseBranch) {
    const ref = await this.#baseRef(baseBranch);
    const lines = (await this.#git(['ls-remote', '--exit-code', 'origin', ref])).split('\n');
    requireValue(lines.length === 1 && lines[0].split(/\s+/)[1] === ref, 'Remote base is ambiguous or missing.', 'ADAPTER_ERROR');
    return sha(lines[0].split(/\s+/)[0]);
  }
  async #contains(revision, remoteSha) {
    if (revision === remoteSha) return true;
    // Fetch the observed immutable object, not a mutable tracking ref. No working
    // branch or FETCH_HEAD is used as evidence across concurrent adapter calls.
    const object = await this.runner('git', ['cat-file', '-e', `${remoteSha}^{commit}`], { cwd: this.gitRepository });
    if (object.exitCode !== 0) await this.#git(['fetch', '--no-tags', '--no-write-fetch-head', 'origin', remoteSha]);
    const result = await this.runner('git', ['merge-base', '--is-ancestor', revision, remoteSha], { cwd: this.gitRepository });
    requireValue([0, 1].includes(result.exitCode), 'Could not verify published ancestry.', 'COMMAND_FAILED');
    return result.exitCode === 0;
  }
  #protected(result) {
    // Classify internally; never echo remote subprocess text (which can contain secrets).
    return /protected branch|protected ref|hook declined|GH006|GH013|required (?:review|status|check)|changes must be made through a pull request|repository rule|not (?:permitted|allowed) to push/i
      .test(`${result.stderr ?? ''}\n${result.stdout ?? ''}`);
  }
  #rejected() {
    return { status: 'rejected', reason: 'GitHub branch protection or repository rules rejected publication. Satisfy required reviews/checks or configure github-merge-queue.' };
  }
  async #pr(entry) {
    return this.#json(await this.#gh(['pr', 'view', this.#number(entry.prUrl), '--repo', this.repository,
      '--json', 'state,headRefOid,baseRefName,mergeCommit']));
  }
  async #finalize({ entries, method, revision, baseBranch, evidence, idempotencyKey }) {
    for (const entry of entries) {
      const prior = await this.#pr(entry);
      requireValue(prior.baseRefName === baseBranch, 'Published PR targets a different base; manual reconciliation required.', 'CONFLICT');
      requireValue(prior.headRefOid === entry.headSha, 'Published PR head changed; manual reconciliation required.', 'HEAD_CHANGED');
      if (prior.state === 'MERGED') continue;
      if (method === 'merge') {
        requireValue(prior.state === 'OPEN', 'Published merge PR was closed without a GitHub merge record.', 'CONFLICT');
        return { status: 'pending', publicationState: 'awaiting-github-merge-record' };
      }
      // Closed squash/rebase PRs cannot be marked MERGED through gh. The Git
      // publication and tested SHA are the delivery record, with an audit comment.
      if (prior.state === 'CLOSED') continue;
      requireValue(prior.state === 'OPEN', 'Unknown GitHub PR state.', 'ADAPTER_ERROR');
      requireValue(evidence?.status === 'passed' && evidence.revision === revision,
        'Passed candidate evidence is required to close a published PR.', 'STALE_EVIDENCE');
      const comment = `Published tested ${method} commit: https://github.com/${this.repository}/commit/${revision}\n` +
        `Perpeto evidence: job ${evidence.id}; revision ${revision}; config ${evidence.configHash}; status passed; attempt ${idempotencyKey}.`;
      const links = [evidence.logRef, ...(Array.isArray(evidence.artifacts) ? evidence.artifacts.map(artifact => artifact?.url) : [])]
        .flatMap(value => {
          try {
            const url = new URL(value);
            return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? [url.href] : [];
          } catch { return []; }
        });
      await this.#gh(['pr', 'close', this.#number(entry.prUrl), '--repo', this.repository, '--comment', [comment, ...links.map(link => `Evidence: <${link}>`)].join('\n')]);
      const after = await this.#pr(entry);
      requireValue(after.baseRefName === baseBranch && after.headRefOid === entry.headSha && ['CLOSED', 'MERGED'].includes(after.state),
        'GitHub did not confirm PR closure.', 'ADAPTER_ERROR');
    }
    return { status: 'merged', revision };
  }
  async isMerged({ baseBranch, revision, publication }) {
    sha(revision);
    if (this.#publication(publication) === 'github-merge-queue') return false;
    // This proves Git publication only. merge() also reconciles PR state before
    // acknowledging the queue, including after a crash between push and record.
    return this.#contains(revision, await this.#remoteBase(baseBranch));
  }
  async merge(request) {
    sha(request.baseSha); sha(request.revision);
    requireValue(['merge', 'squash', 'rebase'].includes(request.method), 'Unknown merge method.');
    requireValue(request.entries?.length > 0, 'Publication requires entries.');
    request.entries.forEach(entry => { this.#number(entry.prUrl); sha(entry.headSha); });
    return this.#publication(request.publication) === 'github-merge-queue'
      ? this.#nativeMerge(request) : this.#push(request);
  }
  async #push(request) {
    const { baseBranch, baseSha, revision, entries, method } = request;
    if (method !== 'merge') requireValue(request.evidence?.status === 'passed' && request.evidence.revision === revision,
      'Passed candidate evidence is required for squash/rebase publication.', 'STALE_EVIDENCE');
    // ls-remote and push must address the same single destination. A pushurl
    // override would otherwise let the checks prove a different repository.
    const fetchURL = await this.#git(['remote', 'get-url', '--all', 'origin']);
    const pushURL = await this.#git(['remote', 'get-url', '--push', '--all', 'origin']);
    requireValue(!fetchURL.includes('\n') && fetchURL === pushURL, 'origin fetch and push must use one identical URL.', 'INVALID_INPUT');
    const ref = await this.#baseRef(baseBranch);
    const before = await this.#remoteBase(baseBranch);
    if (await this.#contains(revision, before)) return this.#finalize(request);
    if (before !== baseSha) return { status: 'base_changed' };
    // The tested base must be on the first-parent chain, including squash/rebase
    // and multi-entry candidates. A secondary merge parent is insufficient.
    const commits = (await this.#git(['rev-list', '--first-parent', `${baseSha}..${revision}`])).split('\n').filter(Boolean);
    const boundary = commits.length ? (await this.#git(['rev-list', '--parents', '-n', '1', commits.at(-1)])).split(/\s+/) : [];
    requireValue(boundary[1] === baseSha,
      'Candidate first-parent chain must start at the tested base.', 'INVALID_CANDIDATE');
    if (method !== 'merge') {
      for (const commit of commits) requireValue((await this.#git(['rev-list', '--parents', '-n', '1', commit])).split(/\s+/).length === 2,
        'Squash/rebase candidates must be linear.', 'INVALID_CANDIDATE');
    } else {
      for (const entry of entries) requireValue(await this.#contains(entry.headSha, revision), 'Merge candidate must contain each tested PR head.', 'INVALID_CANDIDATE');
    }
    for (const entry of entries) {
      const pr = await this.#pr(entry);
      if (pr.headRefOid !== entry.headSha) return { status: 'head_changed', entryId: entry.id };
      if (pr.baseRefName !== baseBranch || pr.state !== 'OPEN') return { status: 'rejected', reason: 'PR is not open against the configured base.' };
    }
    // Explicit expected-old check immediately before the non-force push. Git's
    // receive transaction rejects divergent movement after this check. This is
    // fast-forward safety, not a lease/CAS and not an atomic PR-head guard.
    if (await this.#remoteBase(baseBranch) !== baseSha) return { status: 'base_changed' };
    const result = await this.runner('git', ['push', 'origin', `${revision}:${ref}`],
      { cwd: this.gitRepository, env: { GIT_TERMINAL_PROMPT: '0' } });
    const after = await this.#remoteBase(baseBranch);
    if (await this.#contains(revision, after)) return this.#finalize(request);
    if (this.#protected(result)) return this.#rejected();
    if (after !== baseSha) return { status: 'base_changed' };
    requireValue(result.exitCode === 0, 'Git publication failed.', 'COMMAND_FAILED');
    throw new DeliveryError('ADAPTER_ERROR', 'Remote base does not contain the tested candidate after push.');
  }
  async #nativePR(entry) {
    const [owner, name] = this.repository.split('/');
    const result = this.#json(await this.#gh(['api', 'graphql', '-f',
      'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state headRefOid baseRefName mergeCommit{oid} autoMergeRequest{enabledAt} mergeQueue{id} mergeQueueEntry{id}}}}',
      '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${this.#number(entry.prUrl)}`]));
    requireValue(!result.errors && result.data?.repository?.pullRequest, 'Could not read GitHub merge queue state.', 'ADAPTER_ERROR');
    return result.data.repository.pullRequest;
  }
  async #nativeMerge({ entries, baseBranch, publicationState }) {
    requireValue(entries.length === 1, 'Native GitHub publication requires a serial queue.');
    const entry = entries[0];
    let pr = await this.#nativePR(entry);
    const state = () => {
      if (pr.headRefOid !== entry.headSha) return { status: 'head_changed', entryId: entry.id };
      if (pr.baseRefName !== baseBranch || pr.state === 'CLOSED') return { status: 'rejected', reason: 'PR is closed or targets a different base.' };
      if (pr.state === 'MERGED') return { status: 'merged', revision: sha(pr.mergeCommit?.oid), publication: 'github-merge-queue' };
      requireValue(pr.state === 'OPEN', 'Unknown GitHub PR state.', 'ADAPTER_ERROR');
      if (pr.mergeQueueEntry) return { status: 'pending', publicationState: 'github-queued' };
      if (pr.autoMergeRequest) return { status: 'pending', publicationState: 'github-auto-merge-enabled' };
    };
    const prior = state();
    if (prior && prior.status !== 'pending') return prior;
    // The base branch must actually have a native queue. GraphQL covers both
    // classic branch protection and rulesets, without a rules pagination race.
    if (!pr.mergeQueue?.id) return { status: 'rejected', reason: 'The base branch does not require GitHub native merge queue.' };
    if (prior) return prior;
    if (['github-queued', 'github-auto-merge-enabled'].includes(publicationState)) {
      return { status: 'rejected', reason: 'GitHub removed the PR from its native queue or disabled auto-merge. Inspect GitHub checks/reviews before enqueueing again.' };
    }
    const result = await this.runner('gh', ['pr', 'merge', this.#number(entry.prUrl), '--repo', this.repository,
      '--auto', '--match-head-commit', entry.headSha]);
    pr = await this.#nativePR(entry);
    const observed = state();
    if (observed) return observed;
    if (this.#protected(result)) return this.#rejected();
    requireValue(result.exitCode === 0, 'GitHub native queue submission failed.', 'COMMAND_FAILED');
    return { status: 'pending', publicationState: 'awaiting-github-queue' };
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
