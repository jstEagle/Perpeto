import { hostname } from 'node:os';
import { mkdir, readFile, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, readSecret, writePrivate } from './config.js';
import { HubClient, HubError, sleep } from './hub.js';
import { detectProviders, loadIntegrations } from './executors.js';
import { loadRedaction, runJob } from './job.js';
import { createRuntimeSupervisor } from './runtime.js';

const VERSION = '0.1.0';
const accountFields = ['id', 'machineId', 'provider', 'label', 'status', 'cooldownUntil', 'lastUsedAt'];

/**
 * Build a daemon without starting it. Optional injected integrations support embedders/tests.
 * @param {{configPath: string, registry?: object, accountProvider?: object, runtimeSupervisor?: object, onStatus?: (status: object) => void}} options
 */
export async function createNode({ configPath, registry, accountProvider, runtimeSupervisor, onStatus = () => {} }) {
  const config = await loadConfig(configPath);
  const hub = new HubClient(config);
  const service = new AbortController();
  const polling = new AbortController();
  const active = new Map();
  let seen = {};
  let journalWrites = Promise.resolve();
  let machineId;
  let machine;
  let heartbeatTask;
  let pollTasks = [];
  let draining = false;
  let started = false;
  let stopped = false;
  let stopping;
  let lockPath;
  let fatalError;
  let startupDone;
  let finishStartup;
  let cleanupTask;
  let runtimeAttempted = false;
  let integrationsReady = false;
  const runtime = runtimeSupervisor ?? createRuntimeSupervisor(config.runtime, { configRoot: config.configRoot });
  const status = () => ({ machineId, state: stopped ? 'stopped' : fatalError ? 'error' : draining ? 'draining' : started ? 'running' : 'idle',
    running: { agents: [...active.values()].filter(item => item.kind === 'assignment').length,
      jobs: [...active.values()].filter(item => item.kind === 'job').length } });
  const notify = () => { try { onStatus(status()); } catch { /* Observers cannot affect lease ownership. */ } };
  const fatal = error => {
    fatalError = new Error(error instanceof HubError ? error.message : 'Node background service failed.');
    draining = true;
    polling.abort();
    for (const record of active.values()) lose(record);
    notify();
  };
  function lose(record) {
    if (record.lost) return;
    record.lost = true;
    const reason = new HubError(409, 'lease_lost');
    record.work.abort(reason);
    record.lease.abort(reason);
  }
  async function lock() {
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    const path = resolve(config.dataDir, 'daemon.lock');
    const acquire = async () => {
      const file = await open(path, 'wx', 0o600);
      lockPath = path;
      try { await file.writeFile(String(process.pid)); }
      finally { await file.close(); }
    };
    try { await acquire(); return; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    // Serialise stale-lock recovery so two new daemons cannot unlink each other's lock.
    const recoveryPath = resolve(config.dataDir, 'daemon-recovery.lock');
    let recovery;
    try { recovery = await open(recoveryPath, 'wx', 0o600); }
    catch { throw new Error('Node data directory lock is being recovered.'); }
    try {
      let pid;
      try { pid = Number(await readFile(path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (pid !== undefined) {
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Node data directory has an invalid lock.');
        try { process.kill(pid, 0); throw new Error('Node data directory is already in use.'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
        await unlink(path);
      }
      await acquire();
    } finally { await recovery.close(); await unlink(recoveryPath); }
  }
  async function enroll() {
    let credentials;
    try { credentials = JSON.parse(await readSecret(config.credentialFile)); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid machine credential file.'); }
    if (credentials?.token && credentials?.machineId) {
      if (typeof credentials.token !== 'string' || /[\r\n]/.test(credentials.token) || typeof credentials.machineId !== 'string') throw new Error('Invalid machine credential file.');
      machineId = credentials.machineId; hub.setToken(credentials.token); return;
    }
    if (!config.enrollmentCodeFile) throw new Error('Enrollment requires an owner-only enrollmentCodeFile.');
    const code = (await readSecret(config.enrollmentCodeFile)).trim();
    if (!code || /[\r\n]/.test(code)) throw new Error('Invalid enrollment code file.');
    const enrollmentKey = credentials?.enrollmentKey ?? randomUUID();
    await writePrivate(config.credentialFile, { enrollmentKey });
    const result = await hub.retry('/nodes/enroll', { code, name: machine.name, os: machine.os, arch: machine.arch,
      labels: machine.labels, providers: machine.providers, version: VERSION }, { signal: service.signal, key: enrollmentKey });
    if (!result?.machineId || typeof result.machineId !== 'string' || !result.token || typeof result.token !== 'string' || /[\r\n]/.test(result.token)) throw new Error('Invalid enrollment response.');
    await writePrivate(config.credentialFile, { machineId: result.machineId, token: result.token });
    machineId = result.machineId; hub.setToken(result.token);
  }
  function persistSeen(item) {
    seen[item.key] = Math.max(seen[item.key] ?? -1, item.attempt);
    journalWrites = journalWrites.then(() => writePrivate(resolve(config.dataDir, 'leases.json'), seen));
    return journalWrites;
  }
  async function heartbeat(retry = false) {
    // Explicit allowlist prevents account adapters from accidentally sending credentials.
    const accounts = (await accountProvider.list()).map(account => Object.fromEntries(accountFields.filter(key => typeof account[key] === 'string').map(key => [key, account[key]])));
    const result = await hub[retry ? 'retry' : 'post']('/nodes/heartbeat', { capacity: config.capacity, running: status().running,
      accounts, providers: machine.providers, status: draining ? 'draining' : 'online' }, { signal: service.signal });
    if (result.status === 'draining' || result.machine?.status === 'draining') drain();
  }
  async function heartbeatLoop() {
    let wait = config.timing.heartbeatMs;
    let backoff = config.timing.backoffMinMs;
    while (!service.signal.aborted) {
      try { await sleep(wait, service.signal); await heartbeat(); wait = config.timing.heartbeatMs; backoff = config.timing.backoffMinMs; }
      catch (error) {
        if (service.signal.aborted) return;
        if (!(error instanceof HubError) || !error.retryable) { fatal(error); return; }
        wait = backoff;
        backoff = Math.min(backoff * 2, config.timing.backoffMaxMs);
      }
    }
  }
  const pathFor = record => `/${record.kind === 'assignment' ? 'assignments' : 'jobs'}/${encodeURIComponent(record.item.id)}`;
  async function report(record, event) {
    if (record.lost || Date.now() >= record.expires) { lose(record); throw record.lease.signal.reason; }
    try {
      return await hub.retry(`${pathFor(record)}/events`, { ...event, attempt: record.attempt }, { signal: record.lease.signal });
    } catch (error) {
      if (error.code === 'lease_lost' || error.status === 409) lose(record);
      throw error;
    }
  }
  async function renewLoop(record) {
    while (!record.lease.signal.aborted) {
      try {
        await sleep(Math.min(config.timing.renewMs, Math.max(1, (record.expires - Date.now()) / 3)), record.lease.signal);
        const result = await hub.retry(`${pathFor(record)}/renew`, { attempt: record.attempt }, { signal: record.lease.signal });
        const expires = Date.parse(result.leaseExpiresAt ?? result.lease?.leaseExpiresAt);
        if (!Number.isFinite(expires) || expires <= Date.now()) { lose(record); return; }
        record.expires = expires;
        armExpiry(record);
      } catch (error) {
        if (record.lease.signal.aborted) return;
        // A rejected renewal cannot establish ownership, regardless of its HTTP status.
        lose(record); return;
      }
    }
  }
  function armExpiry(record) {
    clearTimeout(record.expiryTimer);
    record.expiryTimer = setTimeout(() => lose(record), Math.max(0, record.expires - Date.now()));
  }
  async function execute(record) {
    armExpiry(record);
    const renewal = renewLoop(record);
    const workspace = resolve(config.dataDir, 'assignments', randomUUID());
    try {
      await persistSeen(record);
      if (record.kind === 'assignment') await mkdir(workspace, { recursive: true, mode: 0o700 });
      const ctx = { signal: record.work.signal, report: event => report(record, event), workspace,
        runtimeUrl: machine.runtimeUrl, accountProvider };
      let result;
      if (record.kind === 'job') result = await runJob(record.item, ctx, {
        ...config.jobs, dataDir: config.dataDir, redaction: await loadRedaction(config),
      });
      else {
        await report(record, { type: 'started', data: {} });
        const executor = registry.find(record.item, machine);
        if (!executor) result = { outcome: 'blocked', summary: 'No compatible executor is installed.' };
        else result = await executor.run(record.item, ctx);
        if (!['success', 'failure', 'blocked'].includes(result?.outcome) || typeof result.summary !== 'string') throw new Error('Invalid executor result.');
      }
      record.work.signal.throwIfAborted();
      if (!record.lost) await report(record, { type: record.kind === 'assignment' && result.outcome === 'failure' ? 'failed' : 'completed', data: result });
    } catch (error) {
      if (!record.lost) {
        const data = record.kind === 'job'
          ? { status: record.work.signal.aborted ? 'cancelled' : 'error', revision: record.item.revision, configHash: record.item.configHash, steps: [], artifacts: [] }
          : { outcome: record.work.signal.aborted ? 'blocked' : 'failure', summary: record.work.signal.aborted ? 'Node execution was cancelled.' : 'Executor failed.' };
        await report(record, { type: record.kind === 'job' ? 'completed' : 'failed', data }).catch(() => lose(record));
      }
    } finally {
      record.lease.abort();
      clearTimeout(record.expiryTimer);
      await renewal;
      // Assignment workspaces may contain useful changes; the executor owns their cleanup.
      active.delete(record.key);
      notify();
    }
  }
  function accepts(item, kind) {
    if (!item || typeof item.id !== 'string' || !Number.isSafeInteger(item.attempt) || item.attempt < 0 || !Number.isFinite(Date.parse(item.leaseExpiresAt)) || Date.parse(item.leaseExpiresAt) <= Date.now()) return false;
    const key = `${kind}:${item.id}`;
    if (active.has(key) || (seen[key] ?? -1) >= item.attempt) return false;
    const req = item.requirements ?? {};
    return (!req.os || req.os === machine.os) && (req.labels ?? []).every(value => machine.labels.includes(value)) &&
      (req.providers ?? []).every(value => machine.providers.includes(value));
  }
  async function pollLoop(kind) {
    const limit = kind === 'job' ? config.capacity.maxJobs : config.capacity.maxAgents;
    let wait = config.timing.backoffMinMs;
    while (!polling.signal.aborted) {
      try {
        const used = [...active.values()].filter(item => item.kind === kind).length;
        if (used >= limit) { await sleep(config.timing.pollIdleMs, polling.signal); continue; }
        const response = await hub.retry('/nodes/lease', { kinds: [kind], max: limit - used }, { signal: polling.signal });
        const items = response.leases ?? response.items ?? [
          ...(response.assignments ?? []).map(item => ({ kind: 'assignment', ...item })),
          ...(response.jobs ?? []).map(item => ({ kind: 'job', ...item })),
        ];
        if (!Array.isArray(items)) throw new Error('Invalid lease response.');
        for (const value of items) {
          if (polling.signal.aborted) break;
          const inner = value.assignment ?? value.job ?? value.item;
          const item = inner ? { ...inner, leaseExpiresAt: value.leaseExpiresAt ?? inner.leaseExpiresAt, attempt: value.attempt ?? inner.attempt } : value;
          if (value.kind && value.kind !== kind) continue;
          if ([...active.values()].filter(item => item.kind === kind).length >= limit) break;
          if (!accepts(item, kind)) continue;
          const record = { kind, item, key: `${kind}:${item.id}`, attempt: item.attempt, expires: Date.parse(item.leaseExpiresAt),
            work: new AbortController(), lease: new AbortController(), lost: false };
          active.set(record.key, record);
          record.task = execute(record);
          notify();
        }
        wait = config.timing.backoffMinMs;
        // Also avoid a busy loop when a misbehaving hub returns duplicate or incompatible work.
        await sleep(config.timing.pollIdleMs, polling.signal);
      } catch (error) {
        if (polling.signal.aborted) return;
        if (!(error instanceof HubError) || !error.retryable) { fatal(error); return; }
        await sleep(wait, polling.signal).catch(() => {});
        wait = Math.min(wait * 2, config.timing.backoffMaxMs);
      }
    }
  }
  function drain() {
    if (draining) return;
    draining = true; polling.abort(); notify();
    if (started && !service.signal.aborted) void heartbeat().catch(() => {});
  }
  function cleanup() {
    cleanupTask ??= (async () => {
      service.abort(); polling.abort();
      await Promise.allSettled([heartbeatTask, ...pollTasks]);
      try { if (integrationsReady) await accountProvider?.close?.(); }
      finally {
        try { if (runtimeAttempted) await runtime.stop(); }
        finally {
          if (lockPath) { await unlink(lockPath); lockPath = undefined; }
          stopped = true; notify();
        }
      }
    })();
    return cleanupTask;
  }
  return {
    get status() { return status(); },
    get error() { return fatalError; },
    async start() {
      if (started || stopped || startupDone) throw new Error('Node can only be started once.');
      startupDone = new Promise(resolve => { finishStartup = resolve; });
      try {
        service.signal.throwIfAborted();
        await lock();
        try { seen = JSON.parse(await readFile(resolve(config.dataDir, 'leases.json'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid lease journal.'); }
        if (!seen || typeof seen !== 'object' || Array.isArray(seen) || Object.values(seen).some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid lease journal.');
        const detected = await detectProviders();
        machine = { name: config.name ?? hostname(), os: process.platform === 'win32' ? 'windows' : process.platform,
          arch: process.arch, labels: config.labels, providers: config.providers ? detected.filter(provider => config.providers.includes(provider)) : detected,
          capacity: config.capacity, version: VERSION };
        if (config.fake !== undefined) machine.providers.push('fake');
        runtimeAttempted = true;
        machine.runtimeUrl = await runtime.start({ signal: service.signal });
        ({ registry, accountProvider } = await loadIntegrations(config, { registry, accountProvider, runtimeUrl: machine.runtimeUrl }));
        integrationsReady = true;
        await enroll();
        // Initial heartbeat may reconnect too, but no work is accepted until capacity is announced.
        await heartbeat(true);
        service.signal.throwIfAborted();
        started = true;
        heartbeatTask = heartbeatLoop();
        pollTasks = ['assignment', 'job'].filter(kind => kind === 'job' ? config.capacity.maxJobs : config.capacity.maxAgents)
          .map(kind => pollLoop(kind));
        notify();
        return this;
      } catch (error) { await cleanup(); throw error; }
      finally { finishStartup(); }
    },
    drain,
    stop({ drain: shouldDrain = true } = {}) {
      if (stopping) return stopping;
      drain();
      if (!started) service.abort();
      if (!shouldDrain) for (const record of active.values()) record.work.abort(new Error('Node stopping.'));
      stopping = (async () => {
        await startupDone;
        await Promise.allSettled([...active.values()].map(record => record.task));
        await cleanup();
      })();
      return stopping;
    },
  };
}
