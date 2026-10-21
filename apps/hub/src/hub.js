import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, mkdirSync, chmodSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { MessagingStore, MessagingError } from '@perpeto/messaging';
import { HubStore } from './store.js';
import { Workflows } from './workflows.js';
import { Observation } from './observation.js';
import { HubDelivery } from './delivery/index.js';
import { HubError, fail, requireValue, nonblank, object, integer, strings } from './errors.js';

const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}
const active = value => ['leased', 'running'].includes(value.status);

/** Parse a request path once. Anything URL normalization would rewrite, such as dot segments or backslashes, is refused. */
function canonicalUrl(path) {
  const url = typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? new URL(path, 'http://hub') : null;
  if (!url || `${url.pathname}${url.search}` !== path || url.pathname.includes('//')) fail(400, 'INVALID_PATH', 'Request path must be canonical.');
  const segments = url.pathname.split('/').filter(Boolean).map(value => {
    let decoded;
    try { decoded = decodeURIComponent(value); } catch { fail(400, 'INVALID_INPUT', 'Invalid URL encoding.'); }
    if (decoded === '.' || decoded === '..' || /[/\\]/.test(decoded)) fail(400, 'INVALID_PATH', 'Request path must be canonical.');
    return decoded;
  });
  return { url, segments };
}

/** Node tokens reach only machine routes, judged on the same decoded segments route() dispatches on. */
function nodeRoute(method, segments) {
  const [collection, entityId, action] = segments;
  if (collection === 'nodes') return method === 'POST' && segments.length === 2 && ['heartbeat', 'lease'].includes(entityId);
  if (!['assignments', 'jobs'].includes(collection) || !entityId || segments.length > 3) return false;
  if (action === undefined) return method === 'GET';
  if (method === 'POST') return ['renew', 'events'].includes(action);
  return method === 'GET' && collection === 'jobs' && action === 'log';
}

function prepareDatabase(path) {
  try { closeSync(openSync(path, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  for (const filename of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const stat = lstatSync(filename);
      requireValue(stat.isFile() && (!process.getuid || stat.uid === process.getuid()), 'Database files must be owned regular files.');
      chmodSync(filename, 0o600);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export class Hub {
  constructor(config, engine) {
    this.config = config; this.engine = engine; this.listeners = new Set(); this.pending = Promise.resolve();
    for (const path of [config.databasePath, config.messagingDatabasePath, config.deliveryDatabasePath, config.ownerTokenPath]) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    for (const path of [config.databasePath, config.messagingDatabasePath, config.deliveryDatabasePath]) prepareDatabase(path);
    this.store = new HubStore(config.databasePath);
    this.workflows = new Workflows(this); this.observation = new Observation(this);
    try {
      try {
        const stat = lstatSync(config.ownerTokenPath);
        requireValue(stat.isFile() && (stat.mode & 0o077) === 0 && (!process.getuid || stat.uid === process.getuid()), 'Owner token file must be an owner-only regular file.');
        this.ownerToken = readFileSync(config.ownerTokenPath, 'utf8').trim();
        requireValue(/^[A-Za-z0-9_-]{32,}$/.test(this.ownerToken), 'Invalid owner token file.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (this.store.db.prepare("SELECT 1 FROM tokens WHERE kind='owner'").get()) fail(500, 'OWNER_TOKEN_MISSING', 'Restore the existing owner token file before starting this hub.');
        this.ownerToken = randomBytes(32).toString('base64url');
        writeFileSync(config.ownerTokenPath, `${this.ownerToken}\n`, { flag: 'wx', mode: 0o600 });
      }
      const owner = this.store.db.prepare("SELECT hash FROM tokens WHERE kind='owner'").get();
      if (owner && owner.hash !== hash(this.ownerToken)) fail(500, 'OWNER_TOKEN_MISMATCH', 'Owner token file does not match this hub.');
      this.store.db.prepare("INSERT OR IGNORE INTO tokens VALUES(?,'owner',NULL)").run(hash(this.ownerToken));
      this.messaging = new MessagingStore(config.messagingDatabasePath);
      this.delivery = new HubDelivery(this);
      // Hub snapshots may contain private prompts/logs. Keep all persisted files private.
      for (const file of [config.databasePath, config.messagingDatabasePath, config.deliveryDatabasePath]) chmodSync(file, 0o600);
    } catch (error) { this.messaging?.close(); this.store.close(); throw error; }
  }
  secret(kind, entityId) { return createHmac('sha256', this.ownerToken).update(`${kind}:${entityId}`).digest('base64url'); }
  authenticate(header) {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header ?? '');
    const token = match && this.store.db.prepare('SELECT kind,machine_id FROM tokens WHERE hash=?').get(hash(match[1]));
    if (!token) fail(401, 'UNAUTHORIZED', 'A valid bearer token is required.');
    return { kind: token.kind, machineId: token.machine_id, scope: hash(match[1]) };
  }
  serialize(fn) {
    const result = this.pending.then(fn);
    this.pending = result.catch(() => {});
    return result;
  }
  notify() { for (const fn of this.listeners) fn(); }
  async request({ method, path, body = {}, authorization, key, finalLease = true }) {
    return this.serialize(async () => {
      // Authorization and routing read the same parsed path, so no later normalization can redirect a node token.
      const target = canonicalUrl(path);
      const enroll = method === 'POST' && target.url.pathname === '/nodes/enroll';
      const auth = enroll ? { kind: 'enroll', scope: hash(String(body.code ?? '')) } : this.authenticate(authorization);
      const mutation = !['GET', 'HEAD'].includes(method);
      const idempotencyKey = key ?? body.idempotencyKey;
      if (key && body.idempotencyKey && key !== body.idempotencyKey) fail(400, 'INVALID_INPUT', 'Idempotency keys disagree.');
      if (idempotencyKey !== undefined) nonblank(idempotencyKey, 'idempotencyKey', 200);
      const scope = `${auth.scope}:${method}:${target.url.pathname}`;
      const fingerprint = hash(canonical({ method, path, body }));
      const perform = async () => {
        if (mutation && idempotencyKey) {
          const previous = this.store.db.prepare('SELECT fingerprint,response FROM idempotency WHERE scope=? AND key=?').get(scope, idempotencyKey);
          if (previous) {
            if (previous.fingerprint !== fingerprint) fail(409, 'CONFLICT', 'Idempotency key already identifies a different request.');
            return this.restoreResponse(JSON.parse(previous.response));
          }
        }
        const routeBody = key && body.idempotencyKey === undefined ? { ...body, idempotencyKey: key } : body;
        const result = await this.route(method, target, routeBody, auth);
        const emptyLease = target.url.pathname === '/nodes/lease' && !result.body.assignments.length && !result.body.jobs.length;
        if (mutation && idempotencyKey && (!emptyLease || finalLease)) {
          this.store.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run(scope, idempotencyKey, fingerprint, JSON.stringify(this.persistResponse(result)));
        }
        return result;
      };
      try {
        const result = mutation ? await this.store.transaction(perform) : await perform();
        if (mutation && (target.url.pathname !== '/nodes/lease' || result.body.assignments.length || result.body.jobs.length)) this.notify();
        if (this.delivery.dirty) this.delivery.schedule();
        return result;
      } catch (error) {
        if (error instanceof MessagingError) throw new HubError(error.code.includes('CONFLICT') ? 409 : error.code === 'NOT_FOUND' ? 404 : 400, error.code, error.message);
        throw error;
      }
    });
  }
  persistResponse(result) {
    const body = { ...result.body };
    if (body.token) { delete body.token; body._tokenMachineId = body.machineId; }
    if (body.code) { delete body.code; body._codeId = body.id; }
    return { ...result, body };
  }
  restoreResponse(result) {
    const body = { ...result.body };
    if (body._tokenMachineId) { body.token = this.secret('node', body._tokenMachineId); delete body._tokenMachineId; }
    if (body._codeId) { body.code = this.secret('enrollment', body._codeId); delete body._codeId; }
    return { ...result, body };
  }
  emit(type, kind, value, data = {}) {
    return this.store.event(type, { kind, id: value.id }, data, {
      ...(value.projectId ? { projectId: value.projectId } : {}), ...(value.runId ? { runId: value.runId } : {}),
    });
  }
  async maintenance() {
    await this.serialize(async () => {
      let changed = false;
      await this.store.transaction(async () => {
        const time = Date.now();
        for (const cancellation of this.store.list('cancellation', value => Date.parse(value.leaseExpiresAt) <= time)) this.store.remove('cancellation', cancellation.id);
        for (const machine of this.store.list('machine')) {
          if (machine.status !== 'offline' && time - Date.parse(machine.lastHeartbeatAt) >= this.config.heartbeatIntervalMs * 3) {
            machine.status = 'offline'; this.store.put('machine', machine); this.emit('machine.offline', 'machine', machine); changed = true;
          }
        }
        for (const kind of ['assignment', 'job']) for (const value of this.store.list(kind, active)) {
          if (Date.parse(value.leaseExpiresAt) <= time) {
            const run = value.runId && !value.delivery && this.engine.retriesLostWork ? this.store.get('run', value.runId) : null;
            if (run) {
              // The engine owns retries for run work: close this attempt and let its retry policy create the next one.
              const attempt = value.attempt;
              value.status = kind === 'job' ? 'error' : 'failed'; delete value.leaseExpiresAt;
              if (kind === 'assignment') value.result = { outcome: 'failure', summary: 'Lease expired before a result arrived.' };
              this.store.put(kind, value); this.emit(`${kind}.expired`, kind, value, { attempt, machineId: value.machineId });
              if (kind === 'assignment') this.observation.assignment(value);
              if (['running', 'paused'].includes(run.status)) await this.engineEvent(run, { type: 'lease.expired', kind, entityId: value.id, attempt });
              changed = true; continue;
            }
            value.status = 'queued'; value.attempt += 1;
            delete value.machineId; delete value.leaseExpiresAt;
            this.store.put(kind, value); this.emit(`${kind}.requeued`, kind, value, { attempt: value.attempt });
            if (kind === 'assignment') this.observation.assignment(value); changed = true;
          }
        }
      });
      if (changed) this.notify();
    });
    // Merge queue progress (Git preparation and publication) runs outside the request serializer between its two syncs.
    this.delivery.schedule();
  }
  fenced(kind, entityId, auth, body, read = false) {
    const value = this.store.need(kind, entityId);
    const owned = value.machineId === auth.machineId && active(value) && Date.parse(value.leaseExpiresAt) > Date.now();
    if (auth.kind === 'node' && !owned) fail(409, 'lease_lost', 'This machine no longer holds the lease.');
    if (!read && (!active(value) || Date.parse(value.leaseExpiresAt) <= Date.now() ||
        !Number.isSafeInteger(body.attempt) || body.attempt !== value.attempt)) {
      fail(409, 'lease_lost', 'The current attempt and an unexpired lease are required.');
    }
    return value;
  }
  cancelWork(kind, value) {
    if (active(value)) {
      this.store.put('cancellation', { id: `${kind}:${value.id}:${value.attempt}`, kind, entityId: value.id,
        machineId: value.machineId, attempt: value.attempt, leaseExpiresAt: value.leaseExpiresAt });
    }
    value.status = 'cancelled'; delete value.leaseExpiresAt;
    this.store.put(kind, value); this.emit(`${kind}.cancelled`, kind, value);
    if (kind === 'assignment') this.observation.assignment(value);
    if (kind === 'job' && value.delivery) this.delivery.record(value, { status: 'cancelled' });
  }
  cancellationAck(kind, entityId, auth, body) {
    if (!Number.isSafeInteger(body.attempt)) return null;
    const cancelled = body.type === 'cancelled' || (kind === 'job' && body.type === 'completed' && body.data?.status === 'cancelled') ||
      (kind === 'assignment' && body.type === 'failed' && body.data?.outcome === 'blocked');
    if (!cancelled) return null;
    const cancellation = this.store.get('cancellation', `${kind}:${entityId}:${body.attempt}`);
    if (!cancellation || cancellation.machineId !== auth.machineId || Date.parse(cancellation.leaseExpiresAt) <= Date.now()) return null;
    if (kind === 'job') requireValue(body.data?.revision === this.store.need(kind, entityId).revision, 'Job cancellation must match the leased revision.');
    this.store.remove('cancellation', cancellation.id);
    this.emit(`${kind}.cancellation-acknowledged`, kind, this.store.need(kind, entityId));
    return { status: 200, body: { accepted: true, status: 'cancelled' } };
  }
  async engineEvent(run, event) { this.applyEffects(run, await this.engineStep(run, event)); }
  /** Compute the engine's response to an event without applying it. Engines are pure, so this doubles as validation. */
  engineStep(run, event) {
    const workflow = this.store.need('run-workflow', run.id).workflow;
    const snapshot = this.store.need('engine-state', run.id);
    return this.engine.applyEvent({ run, workflow, state: snapshot.state, event });
  }
  applyEffects(run, result) {
    object(result, 'engine result'); requireValue(Array.isArray(result.effects), 'Engine effects must be an array.');
    this.store.put('engine-state', { id: run.id, state: result.state ?? null });
    // When the engine reports each flow-edge crossing itself, the hub does not derive a coarser move from nodeId changes.
    const reportedMoves = new Set(result.effects.filter(effect => effect.type === 'event' && effect.value?.type === 'workitem.moved').map(effect => effect.value.data?.workItemId));
    for (const effect of result.effects) {
      object(effect.value, 'effect value');
      if (effect.type === 'event') {
        const subject = effect.value.subject ?? { kind: 'assignment', id: effect.value.assignmentId ?? run.id };
        const context = { id: subject.id, runId: run.id, projectId: run.projectId, nodeId: effect.value.data?.nodeId };
        if (this.observation.isInteraction(effect.value.type)) this.observation.interaction(effect.value.type, context, effect.value.data ?? {}, subject.kind);
        else this.emit(nonblank(effect.value.type, 'engine event type', 200), subject.kind, context, object(effect.value.data ?? {}, 'engine event data'));
        continue;
      }
      if (effect.type === 'run') {
        requireValue(['running', 'paused', 'stopped', 'completed', 'failed'].includes(effect.value.status), 'Invalid engine run status.');
        run.status = effect.value.status;
        if (['stopped', 'completed', 'failed'].includes(run.status)) run.stoppedAt = now();
        this.store.put('run', run); this.emit('run.updated', 'run', { ...run, runId: run.id }, { status: run.status });
        continue;
      }
      const kind = { 'work-item': 'work-item', assignment: 'assignment', job: 'job', 'merge-entry': 'merge-entry' }[effect.type];
      requireValue(Boolean(kind), 'Unknown engine effect.');
      nonblank(effect.value.id, 'effect id', 200);
      const previous = this.store.get(kind, effect.value.id);
      requireValue(!previous || previous.runId === run.id, 'Engine cannot modify another run.');
      // Merge entries also carry hub delivery fields (queue, job, merged revision) that engine snapshots do not know.
      const value = { ...(kind === 'merge-entry' ? previous : {}), ...effect.value, projectId: run.projectId, runId: run.id };
      if (kind === 'merge-entry' && value.status === 'queued' && !value.queueId) this.delivery.dirty = true;
      if (kind === 'assignment') value.repo = previous?.repo ?? structuredClone(this.store.need('project', run.projectId).repo);
      if (kind === 'assignment' || kind === 'job') {
        requireValue(!previous || previous.status === 'queued', 'Engine cannot overwrite leased or finished work.');
        value.status = 'queued'; value.attempt = previous?.attempt ?? value.attempt ?? 1; value.requirements ??= {};
        if (value.notBefore !== undefined) requireValue(Number.isFinite(Date.parse(value.notBefore)), 'Invalid notBefore.');
        this.requirements(value.requirements);
        if (kind === 'job') {
          requireValue(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.revision), 'Job revision must be a full commit SHA.');
          requireValue(Array.isArray(value.steps), 'Job steps are required.');
          nonblank(value.configHash, 'job configHash'); value.artifacts ??= [];
        }
      }
      this.store.put(kind, value); this.emit(`${kind}.updated`, kind, value, { status: value.status });
      if (kind === 'assignment') this.observation.assignment(value);
      if (kind === 'work-item' && previous && previous.nodeId !== value.nodeId && !reportedMoves.has(value.id)) this.observation.interaction('workitem.moved', value, { workItemId: value.id, sourceNodeId: previous.nodeId, targetNodeId: value.nodeId });
    }
    if (['stopped', 'completed', 'failed'].includes(run.status)) this.cancelRunWork(run);
  }
  cancelRunWork(run) {
    for (const kind of ['assignment', 'job']) for (const value of this.store.list(kind, item => item.runId === run.id && (item.status === 'queued' || active(item)))) this.cancelWork(kind, value);
  }
  requirements(value) {
    object(value, 'requirements');
    if (value.os !== undefined) requireValue(['darwin', 'linux', 'windows'].includes(value.os), 'Invalid requirements OS.');
    for (const key of ['labels', 'providers']) if (value[key] !== undefined) strings(value[key], `requirements.${key}`);
  }
  lease(machine, body) {
    const kinds = body.kinds ?? ['assignment', 'job'];
    requireValue(Array.isArray(kinds) && kinds.length > 0 && kinds.every(kind => ['assignment', 'job'].includes(kind)), 'Invalid lease kinds.');
    const max = integer(body.max ?? 1, 'max', 1, 1000);
    const result = { assignments: [], jobs: [] };
    if (machine.status !== 'online' || Date.now() - Date.parse(machine.lastHeartbeatAt) >= this.config.heartbeatIntervalMs * 3) return result;
    let remaining = max;
    for (const kind of [...new Set(kinds)]) {
      const resource = kind === 'assignment' ? 'agents' : 'jobs';
      const capacity = machine.capacity[kind === 'assignment' ? 'maxAgents' : 'maxJobs'];
      const held = this.store.list(kind, value => value.machineId === machine.id && active(value) && Date.parse(value.leaseExpiresAt) > Date.now()).length;
      let available = Math.max(0, capacity - Math.max(held, machine.running[resource]));
      for (const value of this.store.list(kind, item => item.status === 'queued')) {
        if (!remaining || !available) break;
        const requirements = value.requirements ?? {};
        if (requirements.os && requirements.os !== machine.os) continue;
        if (!(requirements.labels ?? []).every(label => machine.labels.includes(label))) continue;
        if (!(requirements.providers ?? []).every(provider => machine.providers.includes(provider))) continue;
        if (kind === 'assignment' && value.harness?.provider && !machine.providers.includes(value.harness.provider)) continue;
        if (value.runId && this.store.need('run', value.runId).status !== 'running') continue;
        // Engine retries carry a backoff; the engine has no clock, so the hub enforces it here.
        if (value.notBefore && Date.parse(value.notBefore) > Date.now()) continue;
        value.status = 'leased'; value.machineId = machine.id;
        value.leaseExpiresAt = new Date(Date.now() + this.config.leaseDurationMs).toISOString();
        this.store.put(kind, value); this.emit(`${kind}.leased`, kind, value, { machineId: machine.id, attempt: value.attempt });
        if (kind === 'assignment') this.observation.assignment(value);
        result[kind === 'assignment' ? 'assignments' : 'jobs'].push(value); remaining--; available--;
      }
    }
    return result;
  }
  async route(method, { url, segments }, body, auth) {
    const path = url.pathname; const query = url.searchParams;
    // Deny by default: only owner tokens reach routes outside the machine protocol.
    if (auth.kind === 'node' && !nodeRoute(method, segments)) fail(403, 'FORBIDDEN', 'Node tokens cannot access owner APIs.');
    if (auth.kind === 'enroll' && !(method === 'POST' && path === '/nodes/enroll')) fail(403, 'FORBIDDEN', 'Enrollment codes only enroll machines.');
    if (!['owner', 'node', 'enroll'].includes(auth.kind)) fail(403, 'FORBIDDEN', 'Unknown token kind.');
    const [collection, entityId, action, childId, childAction] = segments;
    const reply = (value, status = 200) => ({ status, body: value });
    if (collection === 'messaging') return reply(this.messagingRoute(method, segments.slice(1), body, query));
    if (path === '/projects') {
      if (method === 'GET') return reply({ projects: this.store.list('project') });
      if (method === 'POST') {
        nonblank(body.name, 'name', 200); object(body.repo, 'repo'); nonblank(body.repo.url, 'repo.url', 4096); nonblank(body.repo.defaultBranch, 'repo.defaultBranch', 200);
        if (body.docs !== undefined) requireValue(Array.isArray(body.docs), 'docs must be an array.');
        if (body.goals !== undefined) strings(body.goals, 'goals');
        const value = { id: id('prj'), name: body.name, repo: body.repo, docs: body.docs ?? [], goals: body.goals ?? [], createdAt: now(), updatedAt: now() };
        this.store.put('project', value); this.messaging.createProject({ id: value.id, name: value.name }); this.emit('project.created', 'project', { ...value, projectId: value.id });
        return reply(value, 201);
      }
    }
    if (collection === 'projects' && entityId && action === 'workflows' && childId === 'drafts' && segments.length === 4 && method === 'POST') {
      return reply(await this.workflows.requestDraft(this.store.need('project', entityId), body), 202);
    }
    if (collection === 'projects' && entityId && action === 'metrics' && segments.length === 3 && method === 'GET') {
      return reply(await this.observation.metrics({ projectId: entityId, window: query.get('window') ?? '24h' }));
    }
    if (collection === 'projects' && entityId && segments.length <= 3) {
      const project = this.store.need('project', entityId);
      if (!action && method === 'GET') return reply(project);
      if (!action && method === 'PATCH') {
        for (const key of ['name', 'repo', 'docs', 'goals']) if (Object.hasOwn(body, key)) {
          if (key === 'name') nonblank(body.name, 'name', 200);
          if (key === 'repo') { object(body.repo, 'repo'); nonblank(body.repo.url, 'repo.url', 4096); nonblank(body.repo.defaultBranch, 'repo.defaultBranch', 200); }
          if (key === 'docs') requireValue(Array.isArray(body.docs), 'docs must be an array.');
          if (key === 'goals') strings(body.goals, 'goals');
          project[key] = body[key];
        }
        project.updatedAt = now(); this.store.put('project', project); this.emit('project.updated', 'project', { ...project, projectId: project.id }); return reply(project);
      }
      if (action === 'runs' && method === 'GET') {
        const status = query.get('status');
        if (status !== null) requireValue(['running', 'paused', 'stopped', 'completed', 'failed'].includes(status), 'Invalid run status.');
        const runs = this.store.list('run', value => value.projectId === entityId && (!status || value.status === status));
        return reply({ runs: runs.reverse().sort((a, b) => b.startedAt.localeCompare(a.startedAt)) });
      }
      if (action === 'workflows' && method === 'GET') return reply({ workflows: this.store.list('workflow', value => value.projectId === entityId) });
      if (action === 'workflows' && method === 'POST') {
        this.workflowFields(body);
        const validation = await this.engine.validate(body.graph);
        if (!validation.valid) fail(400, 'INVALID_WORKFLOW', 'Workflow graph is invalid.');
        const workflow = this.workflows.save({ id: id('wf'), projectId: entityId, name: body.name, purpose: body.purpose ?? 'custom', graph: body.graph, authoredBy: { kind: 'user' }, ...(body.rationale ? { rationale: body.rationale } : {}) });
        this.emit('workflow.created', 'workflow', workflow); return reply(workflow, 201);
      }
      if (action === 'merge-queue' && method === 'GET') return reply({ entries: this.store.list('merge-entry', value => value.projectId === entityId) });
    }
    if (collection === 'workflows' && entityId && segments.length <= 3) {
      const workflow = this.store.need('workflow', entityId);
      if (!action && method === 'GET') return reply(workflow);
      if (!action && method === 'PUT') {
        const next = { ...workflow, ...body }; this.workflowFields(next);
        const validation = await this.engine.validate(next.graph);
        if (!validation.valid) fail(400, 'INVALID_WORKFLOW', 'Workflow graph is invalid.');
        const value = this.workflows.save({ id: workflow.id, projectId: workflow.projectId, name: next.name, purpose: next.purpose, graph: next.graph, authoredBy: { kind: 'user' }, parentVersion: workflow.version, ...(body.rationale ? { rationale: body.rationale } : {}) });
        this.emit('workflow.updated', 'workflow', value); return reply(value);
      }
      if (action === 'versions' && method === 'GET') return reply({ versions: this.workflows.versions(workflow.id) });
      if (action === 'diff' && method === 'GET') return reply(await this.workflows.diff(workflow.id, query));
      if (action === 'activate' && method === 'POST') return reply(this.workflows.activate(workflow, integer(body.version, 'version', 1)));
      if (action === 'validate' && method === 'POST') return reply(await this.engine.validate(body.graph ?? workflow.graph));
      if (action === 'runs' && method === 'POST') {
        if (!workflow.activeVersion) fail(409, 'WORKFLOW_NOT_ACTIVE', 'Activate a workflow version before starting a run.');
        const selected = this.workflows.version(workflow.id, workflow.activeVersion);
        const run = { id: id('run'), projectId: workflow.projectId, workflowId: workflow.id, workflowVersion: selected.version, status: 'running', startedAt: now() };
        this.store.put('run', run); this.store.put('run-workflow', { id: run.id, workflow: selected });
        const result = await this.engine.startRun({ run, workflow: selected, input: body.input ?? null, project: this.store.need('project', run.projectId) }); this.applyEffects(run, result);
        this.messaging.createChannel({ projectId: run.projectId, id: `run-${run.id}`, name: `Run ${run.id}` });
        this.emit('run.started', 'run', { ...run, runId: run.id }); return reply(run, 201);
      }
    }
    if (collection === 'runs' && entityId && segments.length <= 3) {
      const run = this.store.need('run', entityId);
      if (!action && method === 'GET') return reply(run);
      if (action === 'metrics' && method === 'GET') return reply(await this.observation.metrics({ runId: run.id, window: query.get('window') ?? '24h' }));
      if (action === 'work-items' && method === 'GET') return reply({ workItems: this.store.list('work-item', item => item.runId === run.id) });
      if (action === 'assignments' && method === 'GET') return reply({ assignments: this.store.list('assignment', item => item.runId === run.id) });
      if (method === 'POST' && ['pause', 'resume', 'stop'].includes(action)) {
        const target = { pause: 'paused', resume: 'running', stop: 'stopped' }[action];
        requireValue(!['stopped', 'completed', 'failed'].includes(run.status), 'Run is already terminal.');
        run.status = target; if (action === 'stop') { run.stoppedAt = now(); this.cancelRunWork(run); }
        this.store.put('run', run); this.emit(`run.${action}`, 'run', { ...run, runId: run.id });
        // The engine closes its own items/merges; the hub already revoked leases above.
        if (this.store.get('engine-state', run.id)?.state) await this.engineEvent(run, { type: { pause: 'run.paused', resume: 'run.resumed', stop: 'run.stopped' }[action], data: body.reason ? { reason: body.reason } : {} });
        return reply(this.store.need('run', run.id));
      }
      if (action === 'inputs' && method === 'POST') {
        if (run.status !== 'running') fail(409, 'CONFLICT', 'Run must be running to accept input.');
        await this.engineEvent(run, { type: 'input', data: body }); this.emit('run.input', 'run', { ...run, runId: run.id }); return reply({ accepted: true }, 202);
      }
    }
    if (collection === 'work-items' && entityId && action === 'decision' && segments.length === 3 && method === 'POST') {
      const item = this.store.need('work-item', entityId); const run = this.store.need('run', item.runId);
      if (run.status !== 'running' || item.status !== 'blocked') fail(409, 'CONFLICT', 'Work item is not awaiting a decision in a running run.');
      await this.engineEvent(run, { type: 'human.decision', workItemId: item.id, data: body }); this.emit('work-item.decision', 'work-item', item); this.observation.interaction('gate.result', item, { nodeId: item.nodeId, decision: body.decision, source: 'human' }); return reply({ accepted: true });
    }
    if (path === '/machines' && method === 'GET') return reply({ machines: this.store.list('machine') });
    if (path === '/machines/enrollment-codes' && method === 'POST') {
      const codeId = id('enr'); const code = this.secret('enrollment', codeId);
      const ttl = integer(body.ttlMs ?? this.config.enrollmentTtlMs, 'ttlMs', 1, this.config.enrollmentTtlMs);
      const expiresAt = new Date(Date.now() + ttl).toISOString();
      this.store.db.prepare('INSERT INTO enrollment_codes(hash,id,expires_at) VALUES(?,?,?)').run(hash(code), codeId, expiresAt);
      this.store.event('enrollment.created', { kind: 'enrollment', id: codeId }); return reply({ id: codeId, code, expiresAt }, 201);
    }
    if (collection === 'machines' && entityId && action === 'drain' && segments.length === 3 && method === 'POST') {
      const machine = this.store.need('machine', entityId); machine.status = 'draining'; machine.drainRequested = true; this.store.put('machine', machine); this.emit('machine.draining', 'machine', machine); return reply(machine);
    }
    if (path === '/nodes/enroll' && method === 'POST') {
      nonblank(body.code, 'code'); nonblank(body.name, 'name', 200); nonblank(body.arch, 'arch', 100); nonblank(body.version, 'version', 100);
      requireValue(['darwin', 'linux', 'windows'].includes(body.os), 'Invalid OS.'); strings(body.labels ?? [], 'labels'); strings(body.providers ?? [], 'providers');
      const code = this.store.db.prepare('SELECT * FROM enrollment_codes WHERE hash=?').get(hash(body.code));
      if (!code || code.used || Date.parse(code.expires_at) <= Date.now()) fail(401, 'INVALID_ENROLLMENT_CODE', 'Enrollment code is invalid, expired, or already used.');
      this.store.db.prepare('UPDATE enrollment_codes SET used=1 WHERE hash=? AND used=0').run(hash(body.code));
      const machine = { id: id('mch'), name: body.name, os: body.os, arch: body.arch, version: body.version, labels: body.labels ?? [], providers: body.providers ?? [], capacity: { maxAgents: 1, maxJobs: 1 }, running: { agents: 0, jobs: 0 }, status: 'online', lastHeartbeatAt: now() };
      const token = this.secret('node', machine.id);
      this.store.put('machine', machine); this.store.db.prepare("INSERT INTO tokens VALUES(?,'node',?)").run(hash(token), machine.id); this.emit('machine.enrolled', 'machine', machine);
      return reply({ machineId: machine.id, token }, 201);
    }
    if (['/nodes/heartbeat', '/nodes/lease'].includes(path) && method === 'POST') {
      if (auth.kind !== 'node') fail(403, 'FORBIDDEN', 'A machine token is required.');
      const machine = this.store.need('machine', auth.machineId);
      if (path === '/nodes/lease') return reply(this.lease(machine, body));
      object(body.capacity, 'capacity'); object(body.running, 'running');
      for (const key of ['maxAgents', 'maxJobs']) integer(body.capacity[key], key, 0, 100000);
      for (const key of ['agents', 'jobs']) integer(body.running[key], key, 0, 100000);
      if (body.providers !== undefined) strings(body.providers, 'providers');
      requireValue(body.status === undefined || ['online', 'draining'].includes(body.status), 'Invalid heartbeat status.');
      machine.capacity = { maxAgents: body.capacity.maxAgents, maxJobs: body.capacity.maxJobs }; machine.running = { agents: body.running.agents, jobs: body.running.jobs };
      machine.providers = body.providers ?? machine.providers; machine.lastHeartbeatAt = now(); machine.status = machine.drainRequested || body.status === 'draining' ? 'draining' : 'online';
      if (body.accounts !== undefined) {
        requireValue(Array.isArray(body.accounts) && body.accounts.length <= 1000, 'Invalid accounts snapshot.');
        const accounts = body.accounts.map(account => {
          object(account, 'account'); nonblank(account.id, 'account id', 200); nonblank(account.provider, 'account provider', 200); nonblank(account.label, 'account label', 200);
          requireValue(['active', 'cooling', 'disabled', 'invalid'].includes(account.status), 'Invalid account status.');
          const previous = this.store.get('account', account.id);
          if (previous && previous.machineId !== machine.id) fail(409, 'CONFLICT', 'Account belongs to another machine.');
          for (const field of ['cooldownUntil', 'lastUsedAt']) if (account[field] !== undefined) requireValue(typeof account[field] === 'string' && Number.isFinite(Date.parse(account[field])), `Invalid account ${field}.`);
          // Only allow public metadata through. Credentials never belong in hub snapshots.
          return { id: account.id, machineId: machine.id, provider: account.provider, label: account.label, status: account.status,
            ...(account.cooldownUntil ? { cooldownUntil: account.cooldownUntil } : {}), ...(account.lastUsedAt ? { lastUsedAt: account.lastUsedAt } : {}) };
        });
        requireValue(new Set(accounts.map(account => account.id)).size === accounts.length, 'Duplicate account IDs.');
        for (const account of this.store.list('account', value => value.machineId === machine.id)) this.store.remove('account', account.id);
        for (const account of accounts) this.store.put('account', account);
      }
      this.store.put('machine', machine); this.emit('machine.heartbeat', 'machine', machine); const cancelled = this.store.list('cancellation', value => value.machineId === machine.id && Date.parse(value.leaseExpiresAt) > Date.now());
      return reply({ status: machine.status, cancel: { assignments: cancelled.filter(value => value.kind === 'assignment').map(value => value.entityId), jobs: cancelled.filter(value => value.kind === 'job').map(value => value.entityId) } });
    }
    if (path === '/accounts' && method === 'GET') return reply({ accounts: this.store.list('account') });
    if (path === '/jobs' && method === 'GET') return reply({ jobs: this.store.list('job', value => (!query.get('projectId') || value.projectId === query.get('projectId')) && (!query.get('runId') || value.runId === query.get('runId'))) });
    if (['assignments', 'jobs'].includes(collection) && entityId && segments.length <= 3) {
      const kind = collection === 'assignments' ? 'assignment' : 'job';
      if (!action && method === 'GET') return reply(auth.kind === 'node' ? this.fenced(kind, entityId, auth, body, true) : this.store.need(kind, entityId));
      if (kind === 'job' && action === 'log' && method === 'GET') {
        if (auth.kind === 'node') this.fenced(kind, entityId, auth, body, true); else this.store.need(kind, entityId);
        return reply({ jobId: entityId, chunks: this.store.list('job-log', value => value.jobId === entityId) });
      }
      if (action === 'cancel' && kind === 'job' && method === 'POST') {
        const value = this.store.need(kind, entityId);
        if (value.status === 'queued' || active(value)) {
          this.cancelWork(kind, value);
          // The engine owns retries for run CI: report the cancelled attempt so its retry policy applies and the run can finish.
          const run = value.runId && !value.delivery ? this.store.get('run', value.runId) : null;
          if (run && ['running', 'paused'].includes(run.status)) await this.engineEvent(run, { type: 'job.finished', jobId: value.id, data: { status: 'cancelled', revision: value.revision }, value });
        }
        return reply(value);
      }
      if (action === 'renew' && method === 'POST') {
        const value = this.fenced(kind, entityId, auth, body); value.leaseExpiresAt = new Date(Date.now() + this.config.leaseDurationMs).toISOString();
        this.store.put(kind, value); this.emit(`${kind}.renewed`, kind, value); return reply({ leaseExpiresAt: value.leaseExpiresAt });
      }
      if (action === 'events' && method === 'POST') {
        const acknowledgement = this.cancellationAck(kind, entityId, auth, body);
        if (acknowledgement) return acknowledgement;
        const value = this.fenced(kind, entityId, auth, body); object(body.data ?? {}, 'event data');
        const types = kind === 'assignment' ? ['started', 'progress', 'usage', 'message', 'completed', 'failed', 'workitem.moved', 'agent.delegated', 'agent.messaged', 'gate.result'] : ['started', 'log', 'step', 'completed', 'gate.result'];
        requireValue(types.includes(body.type), 'Invalid work event type.');
        let data = body.data ?? {};
        if (['workitem.moved', 'agent.delegated', 'agent.messaged', 'gate.result'].includes(body.type)) {
          requireValue(Boolean(value.runId), 'Interaction events require a run.');
          this.observation.interaction(body.type, value, data);
          return reply({ accepted: true, status: value.status });
        }
        if (body.type === 'message') {
          requireValue(Boolean(value.runId), 'Messages require a run.');
          nonblank(data.recipientRoleId, 'recipientRoleId', 200);
          if (!(value.policy?.canMessage ?? []).includes(data.recipientRoleId)) fail(403, 'FORBIDDEN', 'Assignment policy does not allow messaging this role.');
          const sent = this.messaging.send({ projectId: value.projectId, channelId: `run-${value.runId}`, senderRoleId: value.role, recipientRoleId: data.recipientRoleId, body: data.body,
            idempotencyKey: body.idempotencyKey ?? data.idempotencyKey ?? id('msg') });
          this.messageInteraction(value.runId, sent.message);
          return reply({ accepted: true, message: sent.message });
        }
        if (body.type === 'started') value.status = 'running';
        if (kind === 'assignment' && body.type === 'usage') { this.recordUsage(value, data); if (data.accountId) { value.accountId = data.accountId; this.observation.assignment(value); } }
        if (kind === 'job' && body.type === 'log') {
          // Blank lines are ordinary CI output; NUL is replaced rather than failing the step.
          requireValue(typeof data.chunk === 'string' && data.chunk.length > 0 && data.chunk.length <= this.config.requestMaxBytes, 'Invalid log chunk.');
          this.store.put('job-log', { id: id('log'), jobId: value.id, chunk: data.chunk.replaceAll('\0', '\uFFFD'), at: now() }); value.logRef = `/api/v1/jobs/${value.id}/log`;
        }
        const final = ['completed', 'failed'].includes(body.type);
        if (final) {
          if (kind === 'assignment') {
            requireValue(['success', 'failure', 'blocked'].includes(data.outcome), 'Invalid assignment outcome.'); nonblank(data.summary, 'summary', 65536);
            requireValue(body.type !== 'failed' || data.outcome !== 'success', 'A failed event cannot report success.');
            value.result = { outcome: data.outcome, summary: data.summary };
            for (const key of ['branch', 'prUrl', 'headSha', 'threadRef']) if (data[key] !== undefined) value.result[key] = nonblank(data[key], key, 4096);
            if (data.verdict !== undefined) { requireValue(['pass', 'fail'].includes(data.verdict), 'verdict must be pass or fail.'); value.result.verdict = data.verdict; }
            if (data.items !== undefined) { requireValue(Array.isArray(data.items) && data.items.length <= 1000, 'items must be an array.'); value.result.items = data.items; }
            value.status = data.outcome === 'success' ? 'succeeded' : 'failed';
            if (value.architectRequestId) { value.result.graph = data.graph; value.result.rationale = data.rationale; }
          } else {
            requireValue(data.revision === value.revision, 'Job result must match the leased revision.');
            requireValue(['passed', 'failed', 'error', 'cancelled'].includes(data.status), 'Invalid final job status.');
            if (data.configHash !== undefined) requireValue(data.configHash === value.configHash, 'Job result must match configHash.');
            value.status = data.status; requireValue(Array.isArray(data.artifacts ?? []), 'Invalid artifacts.'); value.artifacts = data.artifacts ?? [];
          }
          delete value.leaseExpiresAt;
        }
        // Validate a run result with the engine before acknowledging it. A result the engine refuses (a short SHA, an
        // oversized branch or item) becomes an explicit failure carrying the reason and the agent's summary, which the
        // engine retries, instead of a 400 that makes the node discard the result.
        let outcome = null; let refused = null;
        if (final && kind === 'assignment' && value.runId) {
          const run = this.store.need('run', value.runId);
          const event = result => ({ type: 'assignment.finished', assignmentId: value.id, data: result, value });
          try { outcome = await this.engineStep(run, event(data)); }
          catch (error) {
            if (!(error instanceof HubError) || error.code !== 'INVALID_EVENT') throw error;
            refused = error.message;
            data = { outcome: 'failure', summary: `The hub could not accept this result: ${refused}\n\n${data.summary}` };
            value.result = { outcome: 'failure', summary: data.summary }; value.status = 'failed';
            outcome = await this.engineStep(run, event(data));
          }
        }
        this.store.put(kind, value);
        if (refused) this.emit('assignment.result-refused', kind, value, { reason: refused });
        if (final && value.architectRequestId) await this.workflows.completed(value, data);
        if (kind === 'assignment' && (final || body.type === 'started')) this.observation.assignment(value);
        if (final && value.runId) {
          const graph = this.store.need('run-workflow', value.runId).workflow.graph;
          const review = kind === 'assignment' && graph.nodes.some(node => node.id === value.nodeId && node.type === 'review');
          // Review gates pass or fail on verdict; a missing verdict is reported as an error, not a rejection.
          if (kind === 'job' || review) this.observation.interaction('gate.result', value, { nodeId: value.nodeId, source: kind === 'job' ? (value.delivery ? 'merge-queue' : 'ci') : 'review',
            result: kind === 'job' ? value.status : data.outcome === 'blocked' ? 'blocked' : data.verdict ?? 'error', ...(kind === 'job' ? { revision: value.revision } : {}) });
        }
        if (final && kind === 'job' && value.delivery) this.delivery.record(value, data);
        else if (outcome) this.applyEffects(this.store.need('run', value.runId), outcome);
        else if (final && value.runId) await this.engineEvent(this.store.need('run', value.runId), { type: `${kind}.finished`, [kind === 'assignment' ? 'assignmentId' : 'jobId']: value.id, data, value });
        this.emit(`${kind}.${body.type}`, kind, value, data); return reply({ accepted: true, status: value.status, ...(refused ? { reason: refused } : {}) });
      }
    }
    if (path === '/events' && method === 'GET') {
      const after = integer(Number(query.get('after') ?? 0), 'after'); const limit = integer(Number(query.get('limit') ?? 100), 'limit', 1, 1000);
      const events = this.store.events(after, limit); return reply({ events, nextCursor: events.at(-1)?.seq ?? after });
    }
    if (path === '/usage' && method === 'GET') return reply(this.usage(query));
    if (path === '/overview' && method === 'GET') {
      const projectId = query.get('projectId'); const matches = value => !projectId || value.projectId === projectId;
      const assignments = this.store.list('assignment', matches); const jobs = this.store.list('job', matches);
      const tokensToday = this.store.list('usage', value => matches(value) && value.at.slice(0, 10) === now().slice(0, 10)).reduce((total, value) => total + value.inputTokens + value.outputTokens + value.cacheReadTokens + value.cacheWriteTokens, 0);
      return reply({ activeAgents: assignments.filter(active).length, queuedWork: assignments.filter(value => value.status === 'queued').length + jobs.filter(value => value.status === 'queued').length, tokensToday,
        machinesOnline: this.store.list('machine', value => value.status === 'online' && Date.now() - Date.parse(value.lastHeartbeatAt) < this.config.heartbeatIntervalMs * 3).length });
    }
    fail(404, 'NOT_FOUND', 'Route not found.');
  }
  workflowFields(value) {
    nonblank(value.name, 'workflow name', 200); object(value.graph, 'graph');
    requireValue(['build', 'improve', 'maintain', 'custom'].includes(value.purpose ?? 'custom'), 'Invalid workflow purpose.');
    requireValue(['draft', 'active', 'paused'].includes(value.status ?? 'draft'), 'Invalid workflow status.');
  }
  recordUsage(assignment, data) {
    nonblank(data.provider, 'usage provider', 200); nonblank(data.model, 'usage model', 200);
    const usage = { id: id('use'), projectId: assignment.projectId, runId: assignment.runId, assignmentId: assignment.id, machineId: assignment.machineId, provider: data.provider, model: data.model, at: now() };
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) usage[key] = integer(data[key] ?? 0, key);
    if (data.accountId !== undefined) {
      const account = this.store.need('account', nonblank(data.accountId, 'accountId', 200));
      requireValue(account.machineId === assignment.machineId, 'Usage account belongs to another machine.'); usage.accountId = account.id;
    }
    if (data.costUsd !== undefined) { requireValue(Number.isFinite(data.costUsd) && data.costUsd >= 0, 'Invalid costUsd.'); usage.costUsd = data.costUsd; }
    if (data.at !== undefined) { requireValue(typeof data.at === 'string' && Number.isFinite(Date.parse(data.at)), 'Invalid usage timestamp.'); usage.at = new Date(data.at).toISOString(); }
    this.store.put('usage', usage);
  }
  usage(query) {
    const groupBy = query.get('groupBy') ?? 'provider'; requireValue(['provider', 'model', 'machine', 'day'].includes(groupBy), 'Invalid usage groupBy.');
    for (const field of ['from', 'to']) if (query.has(field)) requireValue(Number.isFinite(Date.parse(query.get(field))), `Invalid ${field} timestamp.`);
    const records = this.store.list('usage', value => ['projectId', 'runId', 'machineId', 'provider', 'model', 'accountId'].every(key => !query.get(key) || value[key] === query.get(key)) &&
      (!query.get('from') || Date.parse(value.at) >= Date.parse(query.get('from'))) && (!query.get('to') || Date.parse(value.at) <= Date.parse(query.get('to'))));
    const groups = new Map();
    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, records: 0 };
    for (const value of records) {
      const key = groupBy === 'day' ? value.at.slice(0, 10) : value[groupBy === 'machine' ? 'machineId' : groupBy];
      const group = groups.get(key) ?? { key, ...Object.fromEntries(Object.keys(totals).map(name => [name, 0])) };
      for (const name of Object.keys(totals)) { const amount = name === 'records' ? 1 : value[name] ?? 0; totals[name] += amount; group[name] += amount; }
      groups.set(key, group);
    }
    return { groupBy, groups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)), totals };
  }
  messageInteraction(runId, message) {
    if (this.store.db.prepare("SELECT 1 FROM events WHERE type='agent.messaged' AND json_extract(data,'$.messageId')=?").get(message.id)) return;
    const run = this.store.need('run', runId);
    const assignments = this.store.list('assignment', value => value.runId === runId);
    const source = assignments.find(value => value.role === message.senderRoleId);
    const target = assignments.find(value => value.role === message.recipientRoleId);
    this.observation.interaction('agent.messaged', { id: message.id, projectId: run.projectId, runId, nodeId: source?.nodeId ?? message.senderRoleId, role: message.senderRoleId },
      { messageId: message.id, sourceNodeId: source?.nodeId ?? message.senderRoleId, targetNodeId: target?.nodeId ?? message.recipientRoleId, senderRoleId: message.senderRoleId, recipientRoleId: message.recipientRoleId });
  }
  messagingRoute(method, segments, body, query) {
    const [collection, projectId, channels, channelId, messages] = segments;
    if (collection !== 'projects' || !projectId) fail(404, 'NOT_FOUND', 'Messaging route not found.');
    if (segments.length === 2 && method === 'PUT') return this.messaging.createProject({ id: projectId, name: body.name });
    if (channels === 'channels' && segments.length === 3) {
      if (method === 'GET') return { channels: this.messaging.listChannels({ projectId }) };
      if (method === 'POST') return this.messaging.createChannel({ projectId, id: body.id, name: body.name });
    }
    if (channels === 'channels' && channelId && messages === 'messages' && segments.length === 5) {
      if (method === 'POST') {
        const result = this.messaging.send({ ...body, projectId, channelId });
        if (channelId.startsWith('run-')) {
          const runId = channelId.slice(4); const run = this.store.get('run', runId);
          if (run?.projectId === projectId) this.messageInteraction(runId, result.message);
        }
        return result;
      }
      if (method === 'GET') return this.messaging.readMessages({ projectId, channelId, recipientRoleId: query.get('recipientRoleId'), after: query.get('after'), before: query.get('before'), latest: query.get('latest') === 'true', limit: query.has('limit') ? Number(query.get('limit')) : 100 });
    }
    fail(404, 'NOT_FOUND', 'Messaging route not found.');
  }
  async close() { await this.delivery.close(); await this.pending; this.messaging.close(); this.store.close(); }
}
