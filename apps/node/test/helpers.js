import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const cleanupLists = new WeakMap();
export function addCleanup(t, callback) {
  if (!cleanupLists.has(t)) {
    cleanupLists.set(t, []);
    t.after(async () => { for (const fn of cleanupLists.get(t).reverse()) await fn(); });
  }
  cleanupLists.get(t).push(callback);
}

export async function eventually(check, timeout = 3000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await sleep(5); }
  throw new Error('Condition did not become true.');
}

export async function fakeHub(t, options = {}) {
  const requests = [];
  const events = [];
  const renewals = [];
  const heartbeats = [];
  const assignments = [];
  const jobs = [];
  const cache = new Map();
  let outage = false;
  let lost = false;
  let renewOutage = false;
  let enrollments = 0;
  let dropEnrollment = false;
  let dropLease = false;
  const ttl = options.ttl ?? 400;
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      body = JSON.parse(body);
      requests.push({ path: req.url, body, auth: req.headers.authorization });
      const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (outage || (renewOutage && req.url.endsWith('/renew'))) return send(503, { error: { code: 'HUB_UNAVAILABLE' } });
      if (req.url !== '/api/v1/nodes/enroll' && req.headers.authorization !== 'Bearer private-machine-token') return send(401, { error: { code: 'UNAUTHORIZED' } });
      if (cache.has(body.idempotencyKey)) return send(200, cache.get(body.idempotencyKey));
      let result = {};
      if (req.url === '/api/v1/nodes/enroll') {
        if (body.code !== 'enroll-once') return send(401, { error: { code: 'INVALID_CODE' } });
        enrollments++;
        result = { machineId: options.machineId ?? 'mch_test', token: 'private-machine-token' };
      } else if (req.url === '/api/v1/nodes/heartbeat') {
        heartbeats.push(body);
        const response = await options.heartbeat?.(body);
        if (response?.statusCode) return send(response.statusCode, response.body);
        result = response ?? {};
      }
      else if (req.url === '/api/v1/nodes/lease') {
        const kind = body.kinds[0];
        const source = kind === 'job' ? jobs : assignments;
        const values = source.splice(0, body.max).map(item => ({ ...item, leaseExpiresAt: new Date(Date.now() + ttl).toISOString() }));
        result = { assignments: kind === 'assignment' ? values : [], jobs: kind === 'job' ? values : [] };
      } else if (req.url.endsWith('/renew')) {
        renewals.push({ path: req.url, body });
        if (lost) return send(409, { error: { code: 'lease_lost' } });
        result = { leaseExpiresAt: new Date(Date.now() + ttl).toISOString() };
      } else if (req.url.endsWith('/events')) {
        if (lost) return send(409, { error: { code: 'lease_lost' } });
        events.push({ path: req.url, ...body });
      } else return send(404, { error: { code: 'NOT_FOUND' } });
      cache.set(body.idempotencyKey, result);
      if (dropEnrollment && req.url.endsWith('/enroll')) { dropEnrollment = false; req.socket.destroy(); return; }
      if (dropLease && req.url.endsWith('/lease') && (result.assignments?.length || result.jobs?.length)) { dropLease = false; req.socket.destroy(); return; }
      send(200, result);
    } catch { res.destroy(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  addCleanup(t, () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { requests, events, renewals, heartbeats, assignments, jobs,
    url: `http://127.0.0.1:${server.address().port}`,
    get enrollments() { return enrollments; },
    set outage(value) { outage = value; },
    set lost(value) { lost = value; },
    set renewOutage(value) { renewOutage = value; },
    set dropEnrollment(value) { dropEnrollment = value; },
    set dropLease(value) { dropLease = value; },
  };
}

export function assignment(id, overrides = {}) {
  return { id, attempt: 1, harness: { provider: 'fake', model: 'test' }, requirements: {}, policy: {}, ...overrides };
}

export async function nodeConfig(t, hub, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'perpeto-node-'));
  addCleanup(t, () => rm(dir, { recursive: true, force: true }));
  const codeFile = join(dir, 'enroll');
  await writeFile(codeFile, 'enroll-once', { mode: 0o600 });
  const configPath = join(dir, 'node.json');
  const config = { hubUrl: hub.url, name: 'test-node', dataDir: join(dir, 'data'), enrollmentCodeFile: codeFile,
    capacity: { maxAgents: 1, maxJobs: 0 }, fake: {},
    timing: { heartbeatMs: 40, renewMs: 30, requestMs: 150, pollIdleMs: 5, backoffMinMs: 5, backoffMaxMs: 25 }, ...overrides };
  await writeFile(configPath, JSON.stringify(config));
  return { dir, configPath, config };
}
