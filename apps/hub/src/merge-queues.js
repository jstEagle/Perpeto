import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DeliveryError, REPO_CONFIG_PATH, matchBranch, mergeQueueConfigs, normalizeMergeQueueConfig, queueMetrics } from '@perpeto/delivery';
import { commandRunner } from '@perpeto/delivery/commands';
import { HubError, fail, nonblank, object, requireValue } from './errors.js';
import { githubRepository } from './delivery/github.js';
import { localRepository } from './delivery/index.js';

const HISTORY = 20;
const REPO_TTL_MS = 10000;
const MAX_FILE_BYTES = 256 * 1024;
const WINDOWS = { '1h': 3600000, '24h': 86400000, '7d': 604800000 };
const digest = value => createHash('sha256').update(value).digest('hex');
const emptyConfig = () => ({ version: 1, queues: [] });

/** Public id of a project's named queue. Workflow-defined queues keep their delivery id (dq_…). */
export const namedQueueId = (projectId, name) => `mqn_${digest(`${projectId}\0${name}`).slice(0, 20)}`;

/**
 * Project merge queues: a versioned hub document per project, an optional `.perpeto/merge-queue.json` committed on
 * the default branch that overrides it per queue, and runtime state (manual freeze) per named queue. Live views read
 * the delivery queues backing each named queue (one per distinct CI recipe) and workflow-defined queues alike.
 */
export class MergeQueues {
  constructor(hub) { this.hub = hub; this.files = new Map(); }
  document(projectId) {
    return this.hub.store.get('merge-queue-config', projectId) ?? { id: projectId, projectId, version: 0, config: emptyConfig(), history: [] };
  }
  /** Where the repository file is read: the project's local repository, else the hub's GitHub candidate mirror. */
  repository(project) {
    let local = null;
    try { local = localRepository(project.repo); } catch { local = null; }
    if (local) return local;
    return githubRepository(project.repo.url) ? join(this.hub.config.deliveryRepositoriesPath, `${project.id}-${digest(JSON.stringify(project.repo.url)).slice(0, 12)}.git`) : null;
  }
  /** Read the committed file at the default branch head, cached per revision and refreshed at most every few seconds. */
  async refresh(projectId, { force = false } = {}) {
    const project = this.hub.store.get('project', projectId);
    if (!project) return null;
    const cached = this.files.get(projectId);
    const now = Date.now();
    if (!force && cached && now - cached.checkedAt < REPO_TTL_MS) return cached.result;
    const repository = this.repository(project);
    const branch = project.repo.defaultBranch;
    const base = { path: REPO_CONFIG_PATH, branch };
    const git = args => commandRunner('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repository, env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 10000 });
    let result;
    try {
      if (!repository) result = { ...base, found: false };
      else {
        const head = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
        const revision = head.exitCode === 0 ? head.stdout.trim() : null;
        if (!revision) result = { ...base, found: false };
        else if (cached?.result.revision === revision) result = cached.result;
        else {
          const size = await git(['cat-file', '-s', `${revision}:${REPO_CONFIG_PATH}`]);
          if (size.exitCode !== 0) result = { ...base, found: false, revision };
          else if (Number(size.stdout.trim()) > MAX_FILE_BYTES) result = { ...base, found: true, revision, error: 'The file is larger than 256 KB.' };
          else {
            const shown = await git(['show', `${revision}:${REPO_CONFIG_PATH}`]);
            try { result = { ...base, found: true, revision, raw: JSON.parse(shown.stdout) }; }
            catch { result = { ...base, found: true, revision, error: 'The file is not valid JSON.' }; }
          }
        }
      }
    } catch { result = { ...base, found: false, error: 'The repository could not be read.' }; }
    this.files.set(projectId, { checkedAt: now, result });
    return result;
  }
  /**
   * Effective configuration: hub document, then the repository file per queue (see mergeQueueConfigs). A repository
   * file that is invalid on its own, or that makes the combination invalid, is reported and not applied.
   */
  effective(projectId) {
    const document = this.document(projectId);
    const file = this.files.get(projectId)?.result ?? { path: REPO_CONFIG_PATH, found: false };
    const repo = { path: file.path, found: file.found, ...(file.revision ? { revision: file.revision } : {}), ...(file.error ? { error: file.error } : {}), applied: false };
    let raw = null;
    if (file.found && file.raw !== undefined) {
      const check = normalizeMergeQueueConfig(file.raw);
      if (check.ok) raw = file.raw; else repo.errors = check.errors;
    }
    let merged = mergeQueueConfigs(document.config, raw);
    if (raw && !merged.ok) { repo.errors = merged.errors; merged = mergeQueueConfigs(document.config, null); }
    if (raw && merged.ok) repo.applied = true;
    return { document, repo, config: merged.config, sources: merged.sources };
  }
  /** The named queue an entry joins, or `{error}` explaining why it cannot join yet (it stays blocked and retries). */
  resolve(projectId, name, baseBranch) {
    const { config } = this.effective(projectId);
    const queue = config.queues.find(item => item.name === name);
    if (!queue) return { error: `No project merge queue is named "${name}". Add it under Merge queue settings or in ${REPO_CONFIG_PATH}.` };
    if (!queue.branches.some(pattern => matchBranch(pattern, baseBranch))) return { error: `Merge queue "${name}" does not cover base branch ${baseBranch}.` };
    return { queue, state: this.state(projectId, name) };
  }
  state(projectId, name) {
    return this.hub.store.get('merge-queue', namedQueueId(projectId, name)) ?? { id: namedQueueId(projectId, name), projectId, name };
  }
  /** Delivery queues backing a named queue, or the single one a workflow defines. */
  records(target) {
    if (target.kind === 'workflow') return [target.record];
    return this.hub.store.list('delivery-queue', record => record.projectId === target.projectId && record.queueName === target.name);
  }
  target(id) {
    if (id.startsWith('dq_')) {
      const record = this.hub.store.get('delivery-queue', id);
      if (!record || record.queueName) fail(404, 'NOT_FOUND', 'merge-queue not found.');
      return { kind: 'workflow', id, projectId: record.projectId, name: `${record.config.baseBranch} (workflow)`, record };
    }
    const state = this.hub.store.get('merge-queue', id);
    if (!state) fail(404, 'NOT_FOUND', 'merge-queue not found.');
    return { kind: 'project', id, projectId: state.projectId, name: state.name, state };
  }
  /** Make sure every named queue in the effective configuration has its runtime record (and so a stable id). */
  ensure(projectId, config) {
    for (const queue of config.queues) {
      const id = namedQueueId(projectId, queue.name);
      if (!this.hub.store.get('merge-queue', id)) this.hub.store.put('merge-queue', { id, projectId, name: queue.name, createdAt: this.hub.now() });
    }
  }
  states(records) {
    return records.map(record => { try { return { record, queue: this.hub.delivery.queue(record) }; } catch { return null; } }).filter(Boolean);
  }
  summary(target, queueConfig, source) {
    const states = this.states(this.records(target)).map(({ queue }) => queue.state);
    const count = status => states.reduce((sum, state) => sum + state.entries.filter(entry => entry.status === status).length, 0);
    const frozen = target.kind === 'project' ? target.state.freeze ?? null : states[0]?.freeze ?? null;
    return { id: target.id, kind: target.kind, name: target.name, projectId: target.projectId,
      branches: queueConfig?.branches ?? [target.record.config.baseBranch], strategy: queueConfig?.strategy ?? target.record.config.strategy,
      source, frozen, counts: { queued: count('queued'), testing: count('testing'), merging: count('merging') } };
  }
  /** GET /projects/:id/merge-queues. */
  async list(projectId) {
    this.hub.store.need('project', projectId);
    await this.refresh(projectId, { force: true });
    return this.listView(projectId);
  }
  listView(projectId) {
    const { document, repo, config, sources } = this.effective(projectId);
    const queues = config.queues.map(queue => {
      const id = namedQueueId(projectId, queue.name);
      const state = this.hub.store.get('merge-queue', id) ?? { id, projectId, name: queue.name };
      return this.summary({ kind: 'project', id, projectId, name: queue.name, state }, queue, sources[queue.name] ?? 'hub');
    });
    const workflow = this.hub.store.list('delivery-queue', record => record.projectId === projectId && !record.queueName)
      .map(record => this.summary({ kind: 'workflow', id: record.id, projectId, name: `${record.config.baseBranch} (workflow)`, record }, null, 'workflow'));
    return { projectId, version: document.version, updatedAt: document.updatedAt ?? null, config: document.config,
      history: (document.history ?? []).map(item => ({ version: item.version, updatedAt: item.updatedAt })), repo, effective: config, queues: [...queues, ...workflow] };
  }
  /** PUT /projects/:id/merge-queues: validate, version and apply to the delivery queues already running. */
  async save(projectId, body) {
    this.hub.store.need('project', projectId);
    object(body, 'body');
    requireValue(Object.keys(body).every(key => ['config', 'baseVersion', 'idempotencyKey'].includes(key)), 'Merge queue settings accept config and baseVersion.');
    const check = normalizeMergeQueueConfig(body.config);
    if (!check.ok) throw new HubError(400, 'INVALID_MERGE_QUEUE_CONFIG', `Merge queue configuration is invalid: ${check.errors[0].path} ${check.errors[0].message}`, check.errors);
    const document = this.document(projectId);
    if (body.baseVersion !== undefined && body.baseVersion !== document.version) fail(409, 'VERSION_CONFLICT', `Merge queue settings changed (now version ${document.version}); reload and apply your change again.`);
    await this.refresh(projectId, { force: true });
    const stored = { version: 1, queues: body.config.queues };
    if (JSON.stringify(stored) !== JSON.stringify(document.config) || document.version === 0) {
      const next = { id: projectId, projectId, version: document.version + 1, config: stored, updatedAt: this.hub.now(),
        history: [...(document.history ?? []), ...(document.version ? [{ version: document.version, config: document.config, updatedAt: document.updatedAt }] : [])].slice(-HISTORY) };
      this.hub.store.put('merge-queue-config', next);
      const { config } = this.effective(projectId);
      this.ensure(projectId, config);
      this.reconfigure(projectId);
      this.hub.emit('merge-queue.config-updated', 'merge-queue-config', next, { version: next.version, queues: config.queues.map(queue => queue.name) });
    }
    return this.listView(projectId);
  }
  /** Re-resolve the delivery queues of a project's named queues so new policy reaches queued and future work. */
  reconfigure(projectId) {
    const { config } = this.effective(projectId);
    for (const record of this.hub.store.list('delivery-queue', item => item.projectId === projectId && item.queueName)) {
      const queue = config.queues.find(item => item.name === record.queueName);
      if (queue) this.hub.delivery.applyNamed(record, queue);
    }
    this.hub.delivery.dirty = true;
  }
  /** GET /merge-queues/:id: live state of one queue. */
  async view(id, query) {
    const target = this.target(id);
    const window = query.get('window') ?? '24h';
    requireValue(Object.hasOwn(WINDOWS, window), 'window must be 1h, 24h or 7d.');
    if (target.kind === 'project') await this.refresh(target.projectId);
    const { config, sources } = this.effective(target.projectId);
    const queueConfig = target.kind === 'project' ? config.queues.find(item => item.name === target.name) ?? null : null;
    const now = Date.now();
    const backing = this.states(this.records(target));
    const views = backing.map(({ record, queue }) => ({ record, view: queue.view({ windowMs: WINDOWS[window] }), state: queue.state }));
    const hubEntry = id => this.hub.store.get('merge-entry', id);
    const enrich = (entry, record) => {
      const value = hubEntry(entry.id);
      return { ...entry, deliveryQueueId: record.id, ...(value?.nodeId ? { nodeId: value.nodeId } : {}), ...(value?.deliveryError ? { deliveryError: value.deliveryError } : {}) };
    };
    const entries = views.flatMap(({ record, view }) => view.entries.map(entry => enrich(entry, record)));
    entries.forEach((entry, index) => { entry.position = index + 1; });
    const frozen = target.kind === 'project' && target.state.freeze
      ? { kind: 'manual', reason: target.state.freeze.reason, since: target.state.freeze.at, ...(target.state.freeze.by ? { by: target.state.freeze.by } : {}) }
      : views.map(item => item.view.frozen).find(Boolean) ?? null;
    const durations = views.map(item => item.view.eta.attemptMs).filter(value => value !== null);
    return {
      id: target.id, kind: target.kind, projectId: target.projectId, name: target.name,
      source: target.kind === 'project' ? sources[target.name] ?? 'removed' : 'workflow',
      ...(queueConfig ? { config: queueConfig } : {}),
      branches: queueConfig?.branches ?? [target.record?.config.baseBranch].filter(Boolean),
      strategy: queueConfig?.strategy ?? views[0]?.view.strategy ?? target.record?.config.strategy,
      frozen,
      entries,
      attempts: views.flatMap(({ record, view }) => view.attempts.map(attempt => ({ ...attempt, deliveryQueueId: record.id }))),
      testing: entries.filter(entry => entry.status === 'testing').map(entry => entry.id),
      recent: views.flatMap(({ record, view }) => view.recent.map(entry => enrich(entry, record)))
        .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '')).slice(0, 20),
      eta: { attemptMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
        samples: views.reduce((sum, item) => sum + item.view.eta.samples, 0) },
      metrics: queueMetrics(views.map(item => item.state), now, { windowMs: WINDOWS[window] }),
      window,
      deliveryQueues: views.map(({ record }) => ({ id: record.id, lastError: record.lastError ?? null })),
      generatedAt: new Date(now).toISOString(),
    };
  }
  /** POST /merge-queues/:id/freeze|unfreeze. A named queue's freeze outlives its delivery queues and covers new ones. */
  freeze(id, body, frozen) {
    const target = this.target(id);
    if (frozen && body.reason !== undefined) nonblank(body.reason, 'reason', 300);
    requireValue(Object.keys(body).every(key => ['reason', 'idempotencyKey'].includes(key)), 'Freeze accepts a reason.');
    const freeze = frozen ? { reason: body.reason ?? 'Frozen by the owner.', at: this.hub.now(), by: 'owner' } : null;
    if (target.kind === 'project') {
      const state = { ...target.state };
      if (freeze) state.freeze = freeze; else delete state.freeze;
      this.hub.store.put('merge-queue', state);
    }
    for (const { record, queue } of this.states(this.records(target))) this.applyFreeze(queue, freeze, record.id);
    this.hub.emit(frozen ? 'merge-queue.frozen' : 'merge-queue.unfrozen', 'merge-queue', { id: target.id, projectId: target.projectId }, { name: target.name, ...(freeze ? { reason: freeze.reason } : {}) });
    this.hub.delivery.dirty = true;
    return this.view(id, new URLSearchParams());
  }
  applyFreeze(queue, freeze, key) {
    const current = queue.state.freeze;
    if (freeze && !current) queue.freeze({ reason: freeze.reason, by: freeze.by }, { idempotencyKey: `freeze:${key}:${randomUUID()}` });
    if (!freeze && current) queue.unfreeze({ idempotencyKey: `unfreeze:${key}:${randomUUID()}` });
  }
  /** POST /merge-entries/:id/priority|eject|requeue. */
  async entryCommand(entryId, action, body) {
    const entry = this.hub.store.need('merge-entry', entryId);
    if (!entry.queueId) fail(409, 'NOT_QUEUED', 'The entry has not joined a merge queue yet.');
    const record = this.hub.store.need('delivery-queue', entry.queueId);
    const queue = this.hub.delivery.queue(record);
    const key = `${action}:${body.idempotencyKey ?? randomUUID()}`;
    try {
      if (action === 'priority') {
        requireValue(Object.keys(body).every(item => ['lane', 'priority', 'idempotencyKey'].includes(item)), 'Priority accepts lane or priority.');
        if (body.lane !== undefined) nonblank(body.lane, 'lane', 64);
        queue.prioritize({ entryId, lane: body.lane, priority: body.priority }, { idempotencyKey: key });
      } else if (action === 'eject') {
        if (body.reason !== undefined) nonblank(body.reason, 'reason', 1000);
        queue.eject({ entryId, reason: body.reason ?? 'Ejected by the owner.' }, { idempotencyKey: key });
      } else {
        if (body.reason !== undefined) nonblank(body.reason, 'reason', 1000);
        queue.requeueEntry({ entryId, reason: body.reason }, { idempotencyKey: key });
      }
    } catch (error) {
      if (error instanceof DeliveryError) throw new HubError(error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' ? 409 : 400, error.code, error.message);
      throw error;
    }
    const delivered = queue.state.entries.find(item => item.id === entryId);
    const type = { priority: 'merge-entry.prioritized', eject: 'merge-entry.ejected', requeue: 'merge-entry.requeued' }[action];
    this.hub.emit(type, 'merge-entry', entry, { queueId: record.id, ...(delivered?.lane ? { lane: delivered.lane } : {}), priority: delivered?.priority ?? 0,
      ...(action !== 'priority' ? { reason: delivered?.reason } : {}) });
    // Mirror at once, so an ejected entry reaches its run in this request and the reply shows the new state.
    await this.hub.delivery.sync([record.id]);
    this.hub.delivery.dirty = true;
    return this.hub.store.get('merge-entry', entryId);
  }
}

/** Routes: project merge queue settings, queue views and owner commands. Returns null for other paths. */
export async function mergeQueuesRoute(hub, method, segments, query, body) {
  const [collection, entityId, action, extra] = segments;
  if (collection === 'projects' && entityId && action === 'merge-queues' && segments.length === 3) {
    if (method === 'GET') return hub.mergeQueues.list(entityId);
    if (method === 'PUT') return hub.mergeQueues.save(entityId, body);
    fail(405, 'METHOD_NOT_ALLOWED', 'Use GET or PUT.');
  }
  if (collection === 'merge-queues' && entityId && extra === undefined) {
    if (!action && method === 'GET') return hub.mergeQueues.view(entityId, query);
    if (['freeze', 'unfreeze'].includes(action) && method === 'POST') return hub.mergeQueues.freeze(entityId, body, action === 'freeze');
    return null;
  }
  if (collection === 'merge-entries' && entityId && ['priority', 'eject', 'requeue'].includes(action) && extra === undefined && method === 'POST') {
    return hub.mergeQueues.entryCommand(entityId, action, body);
  }
  return null;
}
