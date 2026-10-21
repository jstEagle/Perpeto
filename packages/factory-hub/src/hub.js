import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { MessagingStore, MessagingError } from '../../factory-core/src/messaging-store.js';
import { HubStore } from './store.js';
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

export class Hub {
  constructor(config, engine) {
    this.config = config; this.engine = engine; this.listeners = new Set(); this.pending = Promise.resolve();
    for (const path of [config.databasePath, config.messagingDatabasePath, config.ownerTokenPath]) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.store = new HubStore(config.databasePath);
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
      // Hub snapshots may contain private prompts/logs. Keep all persisted files private.
      for (const file of [config.databasePath, config.messagingDatabasePath]) chmodSync(file, 0o600);
    } catch (error) { this.store.close(); throw error; }
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
      const enroll = method === 'POST' && path === '/nodes/enroll';
      const auth = enroll ? { kind: 'enroll', scope: hash(String(body.code ?? '')) } : this.authenticate(authorization);
      if (auth.kind === 'node' && !(/^\/nodes\/(heartbeat|lease)$/.test(path) || /^\/(assignments|jobs)\/[^/]+(?:\/(renew|events|log))?$/.test(path))) fail(403, 'FORBIDDEN', 'Node tokens cannot access owner APIs.');
      if (auth.kind === 'node' && path.startsWith('/nodes/') && method !== 'POST') fail(403, 'FORBIDDEN', 'Node operation is not permitted.');
      const mutation = !['GET', 'HEAD'].includes(method);
      const idempotencyKey = key ?? body.idempotencyKey;
      if (key && body.idempotencyKey && key !== body.idempotencyKey) fail(400, 'INVALID_INPUT', 'Idempotency keys disagree.');
      if (idempotencyKey !== undefined) nonblank(idempotencyKey, 'idempotencyKey', 200);
      const scope = `${auth.scope}:${method}:${path.split('?')[0]}`;
      const fingerprint = hash(canonical({ method, path, body }));
      const perform = async () => {
        if (mutation && idempotencyKey) {
          const previous = this.store.db.prepare('SELECT fingerprint,response FROM idempotency WHERE scope=? AND key=?').get(scope, idempotencyKey);
          if (previous) {
            if (previous.fingerprint !== fingerprint) fail(409, 'CONFLICT', 'Idempotency key already identifies a different request.');
            return this.restoreResponse(JSON.parse(previous.response));
          }
        }
        const result = await this.route(method, new URL(path, 'http://hub'), body, auth);
        const emptyLease = path === '/nodes/lease' && !result.body.assignments.length && !result.body.jobs.length;
        if (mutation && idempotencyKey && (!emptyLease || finalLease)) {
          this.store.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run(scope, idempotencyKey, fingerprint, JSON.stringify(this.persistResponse(result)));
        }
        return result;
      };
      try {
        const result = mutation ? await this.store.transaction(perform) : await perform();
        if (mutation && path !== '/nodes/lease') this.notify();
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
    return this.serialize(async () => {
      let changed = false;
      await this.store.transaction(() => {
        const time = Date.now();
        for (const machine of this.store.list('machine')) {
          if (machine.status === 'online' && time - Date.parse(machine.lastHeartbeatAt) >= this.config.heartbeatIntervalMs * 3) {
            machine.status = 'offline'; this.store.put('machine', machine); this.emit('machine.offline', 'machine', machine); changed = true;
          }
        }
        for (const kind of ['assignment', 'job']) for (const value of this.store.list(kind, active)) {
          if (Date.parse(value.leaseExpiresAt) <= time) {
            value.status = 'queued'; value.attempt += 1;
            delete value.machineId; delete value.leaseExpiresAt; delete value.leaseId;
            this.store.put(kind, value); this.emit(`${kind}.requeued`, kind, value, { attempt: value.attempt }); changed = true;
          }
        }
      });
      if (changed) this.notify();
    });
  }
  fenced(kind, entityId, auth, body, read = false) {
    const value = this.store.need(kind, entityId);
    const owned = value.machineId === auth.machineId && active(value) && Date.parse(value.leaseExpiresAt) > Date.now();
    if (auth.kind === 'node' && !owned) fail(409, 'LEASE_LOST', 'This machine no longer holds the lease.');
    if (!read) {
      // A machine can reacquire the same item. Its token alone cannot fence old results.
      if (!active(value) || Date.parse(value.leaseExpiresAt) <= Date.now() ||
          !((typeof body.leaseId === 'string' && body.leaseId === value.leaseId) || (Number.isSafeInteger(body.attempt) && body.attempt === value.attempt))) {
        fail(409, 'LEASE_LOST', 'A current leaseId or attempt is required.');
      }
    }
    return value;
  }
  async engineEvent(run, event) {
    const workflow = this.store.need('run-workflow', run.id).workflow;
    const snapshot = this.store.need('engine-state', run.id);
    const result = await this.engine.applyEvent({ run, workflow, state: snapshot.state, event });
    this.applyEffects(run, result);
  }
  applyEffects(run, result) {
    object(result, 'engine result'); requireValue(Array.isArray(result.effects), 'Engine effects must be an array.');
    this.store.put('engine-state', { id: run.id, state: result.state ?? null });
    for (const effect of result.effects) {
      object(effect.value, 'effect value');
      if (effect.type === 'run') {
        requireValue(['running', 'paused', 'stopped', 'completed', 'failed'].includes(effect.value.status), 'Invalid engine run status.');
        run.status = effect.value.status;
        if (['stopped', 'completed', 'failed'].includes(run.status)) run.stoppedAt = now();
        this.store.put('run', run); this.emit('run.updated', 'run', { ...run, runId: run.id }, { status: run.status });
        continue;
      }
      const kind = { 'work-item': 'work-item', assignment: 'assignment', job: 'job', 'merge-entry': 'merge-entry' }[effect.type];
      requireValue(Boolean(kind), 'Unknown engine effect.');
      const value = { ...effect.value, projectId: run.projectId, runId: run.id };
      nonblank(value.id, 'effect id', 200);
      const previous = this.store.get(kind, value.id);
      requireValue(!previous || previous.runId === run.id, 'Engine cannot modify another run.');
      if (kind === 'assignment' || kind === 'job') {
        requireValue(!previous || previous.status === 'queued', 'Engine cannot overwrite leased or finished work.');
        value.status = 'queued'; value.attempt = previous?.attempt ?? 1; value.requirements ??= {};
        this.requirements(value.requirements);
        if (kind === 'job') {
          requireValue(/^[a-f0-9]{40}$/i.test(value.revision), 'Job revision must be a full commit SHA.');
          requireValue(Array.isArray(value.steps), 'Job steps are required.');
          nonblank(value.configHash, 'job configHash'); value.artifacts ??= [];
        }
      }
      this.store.put(kind, value); this.emit(`${kind}.updated`, kind, value, { status: value.status });
    }
    if (['stopped', 'completed', 'failed'].includes(run.status)) this.cancelRunWork(run);
  }
  cancelRunWork(run) {
    for (const kind of ['assignment', 'job']) for (const value of this.store.list(kind, item => item.runId === run.id && (item.status === 'queued' || active(item)))) {
      value.status = 'cancelled'; delete value.leaseExpiresAt; delete value.leaseId;
      this.store.put(kind, value); this.emit(`${kind}.cancelled`, kind, value);
    }
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
        value.status = 'leased'; value.machineId = machine.id; value.leaseId = id('lease');
        value.leaseExpiresAt = new Date(Date.now() + this.config.leaseDurationMs).toISOString();
        this.store.put(kind, value); this.emit(`${kind}.leased`, kind, value, { machineId: machine.id, attempt: value.attempt });
        result[kind === 'assignment' ? 'assignments' : 'jobs'].push(value); remaining--; available--;
      }
    }
    return result;
  }
  async route(method, url, body, auth) {
    const path = url.pathname; const query = url.searchParams;
    const segments = path.split('/').filter(Boolean).map(value => {
      try { return decodeURIComponent(value); } catch { fail(400, 'INVALID_INPUT', 'Invalid URL encoding.'); }
    });
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
      if (action === 'workflows' && method === 'GET') return reply({ workflows: this.store.list('workflow', value => value.projectId === entityId) });
      if (action === 'workflows' && method === 'POST') {
        this.workflowFields(body);
        const validation = await this.engine.validate(body.graph);
        if (!validation.valid) fail(400, 'INVALID_WORKFLOW', 'Workflow graph is invalid.');
        const workflow = { id: id('wf'), projectId: entityId, name: body.name, purpose: body.purpose ?? 'custom', version: 1, graph: body.graph, status: body.status ?? 'draft' };
        this.store.put('workflow', workflow); this.emit('workflow.created', 'workflow', workflow); return reply(workflow, 201);
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
        const value = { ...workflow, name: next.name, purpose: next.purpose, graph: next.graph, status: next.status, version: workflow.version + 1 };
        this.store.put('workflow', value); this.emit('workflow.updated', 'workflow', value); return reply(value);
      }
      if (action === 'validate' && method === 'POST') return reply(await this.engine.validate(body.graph ?? workflow.graph));
      if (action === 'runs' && method === 'POST') {
        const run = { id: id('run'), projectId: workflow.projectId, workflowId: workflow.id, workflowVersion: workflow.version, status: 'running', startedAt: now() };
        this.store.put('run', run); this.store.put('run-workflow', { id: run.id, workflow });
        const result = await this.engine.startRun({ run, workflow, input: body.input ?? null }); this.applyEffects(run, result);
        this.messaging.createChannel({ projectId: run.projectId, id: `run-${run.id}`, name: `Run ${run.id}` });
        this.emit('run.started', 'run', { ...run, runId: run.id }); return reply(run, 201);
      }
    }
    if (collection === 'runs' && entityId && segments.length <= 3) {
      const run = this.store.need('run', entityId);
      if (!action && method === 'GET') return reply(run);
      if (action === 'work-items' && method === 'GET') return reply({ workItems: this.store.list('work-item', item => item.runId === run.id) });
      if (action === 'assignments' && method === 'GET') return reply({ assignments: this.store.list('assignment', item => item.runId === run.id) });
      if (method === 'POST' && ['pause', 'resume', 'stop'].includes(action)) {
        const target = { pause: 'paused', resume: 'running', stop: 'stopped' }[action];
        requireValue(!['stopped', 'completed', 'failed'].includes(run.status), 'Run is already terminal.');
        run.status = target; if (action === 'stop') { run.stoppedAt = now(); this.cancelRunWork(run); }
        this.store.put('run', run); this.emit(`run.${action}`, 'run', { ...run, runId: run.id }); return reply(run);
      }
      if (action === 'inputs' && method === 'POST') {
        if (run.status !== 'running') fail(409, 'CONFLICT', 'Run must be running to accept input.');
        await this.engineEvent(run, { type: 'input', data: body }); this.emit('run.input', 'run', { ...run, runId: run.id }); return reply({ accepted: true }, 202);
      }
    }
    if (collection === 'work-items' && entityId && action === 'decision' && segments.length === 3 && method === 'POST') {
      const item = this.store.need('work-item', entityId); const run = this.store.need('run', item.runId);
      if (run.status !== 'running' || item.status !== 'blocked') fail(409, 'CONFLICT', 'Work item is not awaiting a decision in a running run.');
      await this.engineEvent(run, { type: 'human.decision', workItemId: item.id, data: body }); this.emit('work-item.decision', 'work-item', item); return reply({ accepted: true });
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
      const machine = this.store.need('machine', entityId); machine.status = 'draining'; this.store.put('machine', machine); this.emit('machine.draining', 'machine', machine); return reply(machine);
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
      machine.capacity = { maxAgents: body.capacity.maxAgents, maxJobs: body.capacity.maxJobs }; machine.running = { agents: body.running.agents, jobs: body.running.jobs };
      machine.providers = body.providers ?? machine.providers; machine.lastHeartbeatAt = now(); if (machine.status !== 'draining') machine.status = 'online';
      if (body.accounts !== undefined) {
        requireValue(Array.isArray(body.accounts) && body.accounts.length <= 1000, 'Invalid accounts snapshot.');
        const accounts = body.accounts.map(account => {
          object(account, 'account'); nonblank(account.id, 'account id', 200); nonblank(account.provider, 'account provider', 200); nonblank(account.label, 'account label', 200);
          requireValue(['active', 'cooling', 'disabled', 'invalid'].includes(account.status), 'Invalid account status.');
          const previous = this.store.get('account', account.id);
          if (previous && previous.machineId !== machine.id) fail(409, 'CONFLICT', 'Account belongs to another machine.');
          // Only allow public metadata through. Credentials never belong in hub snapshots.
          return { id: account.id, machineId: machine.id, provider: account.provider, label: account.label, status: account.status,
            ...(account.cooldownUntil ? { cooldownUntil: account.cooldownUntil } : {}), ...(account.lastUsedAt ? { lastUsedAt: account.lastUsedAt } : {}) };
        });
        requireValue(new Set(accounts.map(account => account.id)).size === accounts.length, 'Duplicate account IDs.');
        for (const account of this.store.list('account', value => value.machineId === machine.id)) this.store.remove('account', account.id);
        for (const account of accounts) this.store.put('account', account);
      }
      this.store.put('machine', machine); this.emit('machine.heartbeat', 'machine', machine); return reply({ machineId: machine.id, status: machine.status, heartbeatIntervalMs: this.config.heartbeatIntervalMs });
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
      if (action === 'renew' && method === 'POST') {
        const value = this.fenced(kind, entityId, auth, body); value.leaseExpiresAt = new Date(Date.now() + this.config.leaseDurationMs).toISOString();
        this.store.put(kind, value); this.emit(`${kind}.renewed`, kind, value); return reply({ id: value.id, leaseId: value.leaseId, attempt: value.attempt, leaseExpiresAt: value.leaseExpiresAt });
      }
      if (action === 'events' && method === 'POST') {
        const value = this.fenced(kind, entityId, auth, body); object(body.data ?? {}, 'event data');
        const types = kind === 'assignment' ? ['started', 'progress', 'usage', 'message', 'completed', 'failed'] : ['started', 'log', 'step', 'completed'];
        requireValue(types.includes(body.type), 'Invalid work event type.');
        const data = body.data ?? {};
        if (body.type === 'started') value.status = 'running';
        if (kind === 'assignment' && body.type === 'usage') this.recordUsage(value, data);
        if (kind === 'job' && body.type === 'log') {
          nonblank(data.chunk, 'log chunk', this.config.requestMaxBytes); this.store.put('job-log', { id: id('log'), jobId: value.id, chunk: data.chunk, at: now() }); value.logRef = `/api/v1/jobs/${value.id}/log`;
        }
        const final = ['completed', 'failed'].includes(body.type);
        if (final) {
          if (kind === 'assignment') {
            requireValue(['success', 'failure', 'blocked'].includes(data.outcome), 'Invalid assignment outcome.'); nonblank(data.summary, 'summary', 65536);
            requireValue(body.type !== 'failed' || data.outcome !== 'success', 'A failed event cannot report success.');
            value.result = { outcome: data.outcome, summary: data.summary };
            for (const key of ['branch', 'prUrl', 'headSha', 'threadRef']) if (data[key] !== undefined) value.result[key] = nonblank(data[key], key, 4096);
            value.status = data.outcome === 'success' ? 'succeeded' : 'failed';
          } else {
            requireValue(data.revision === value.revision, 'Job result must match the leased revision.');
            requireValue(['passed', 'failed', 'error', 'cancelled'].includes(data.status), 'Invalid final job status.');
            if (data.configHash !== undefined) requireValue(data.configHash === value.configHash, 'Job result must match configHash.');
            value.status = data.status; requireValue(Array.isArray(data.artifacts ?? []), 'Invalid artifacts.'); value.artifacts = data.artifacts ?? [];
          }
          delete value.leaseExpiresAt; delete value.leaseId;
        }
        this.store.put(kind, value);
        if (final && value.runId) await this.engineEvent(this.store.need('run', value.runId), { type: `${kind}.finished`, [kind === 'assignment' ? 'assignmentId' : 'jobId']: value.id, data, value });
        this.emit(`${kind}.${body.type}`, kind, value, data); return reply({ accepted: true, status: value.status });
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
  messagingRoute(method, segments, body, query) {
    const [collection, projectId, channels, channelId, messages] = segments;
    if (collection !== 'projects' || !projectId) fail(404, 'NOT_FOUND', 'Messaging route not found.');
    if (segments.length === 2 && method === 'PUT') return this.messaging.createProject({ id: projectId, name: body.name });
    if (channels === 'channels' && segments.length === 3) {
      if (method === 'GET') return { channels: this.messaging.listChannels({ projectId }) };
      if (method === 'POST') return this.messaging.createChannel({ projectId, id: body.id, name: body.name });
    }
    if (channels === 'channels' && channelId && messages === 'messages' && segments.length === 5) {
      if (method === 'POST') return this.messaging.send({ ...body, projectId, channelId });
      if (method === 'GET') return this.messaging.readMessages({ projectId, channelId, recipientRoleId: query.get('recipientRoleId'), after: query.get('after'), before: query.get('before'), latest: query.get('latest') === 'true', limit: query.has('limit') ? Number(query.get('limit')) : 100 });
    }
    fail(404, 'NOT_FOUND', 'Messaging route not found.');
  }
  async close() { await this.pending; this.messaging.close(); this.store.close(); }
}
