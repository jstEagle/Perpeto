import { hostname } from 'node:os';
import { mkdir, readFile, open, unlink, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { loadConfig, readSecret, writePrivate } from './config.js';
import { HubClient, HubError, sleep, jitter } from './hub.js';
import { detectProviders, loadIntegrations } from './executors.js';
import { loadRedaction, runJob } from './job.js';
import { createRuntimeSupervisor } from './runtime.js';
import { FINGERPRINT } from './transport.js';
import { sanitizeFailure } from './failure.js';

import { processIdentity } from './lock.js';

const VERSION = '0.1.0';
const accountFields = ['id', 'machineId', 'provider', 'label', 'status', 'cooldownUntil', 'lastUsedAt', 'plan'];
const WINDOW_KINDS = ['session', 'weekly', 'monthly', 'other'];
/** Usage percentages and reset times only; anything else an account provider returns stays on this machine. */
function publicUsage(usage) {
  if (!usage || typeof usage !== 'object' || !Array.isArray(usage.windows) || !usage.windows.length) return undefined;
  const windows = usage.windows.slice(0, 16).flatMap(window => window && typeof window.id === 'string' && Number.isFinite(window.usedPercent)
    && WINDOW_KINDS.includes(window.kind) && typeof window.label === 'string' ? [{
      id: window.id, kind: window.kind, label: window.label, usedPercent: window.usedPercent,
      ...(typeof window.resetsAt === 'string' ? { resetsAt: window.resetsAt } : {}),
      ...(Number.isSafeInteger(window.windowMins) ? { windowMins: window.windowMins } : {}) }] : []);
  return windows.length ? { checkedAt: typeof usage.checkedAt === 'string' ? usage.checkedAt : new Date().toISOString(), windows } : undefined;
}

/**
 * Build a daemon without starting it. Optional injected integrations support embedders/tests.
 * @param {{configPath: string, registry?: object, accountProvider?: object, runtimeSupervisor?: object, onStatus?: (status: object) => void, clock?: () => number}} options
 * `clock` (epoch ms) judges hub lease expiry; it must agree with the hub's clock, so tests that inject one into the hub pass the same one here.
 */
export async function createNode({ configPath, registry, accountProvider, runtimeSupervisor, onStatus = () => {}, clock = Date.now }) {
  const config = await loadConfig(configPath);
  // Pinned hub certificates: the fingerprint from joining, then the set the hub announces over the pinned channel.
  const pinsFile = resolve(config.dataDir, 'hub-pins.json');
  let pins = await readPins(pinsFile, config.hubFingerprint);
  let pinWrites = Promise.resolve();
  const hub = new HubClient(config, undefined, { onUnauthorized: error => fatal(error), ...(pins ? { pins: () => pins } : {}) });
  const service = new AbortController();
  const polling = new AbortController();
  const active = new Map();
  let seen = {};
  let settledReservations = {};
  let settlementWrites = Promise.resolve();
  let freshEnrollment = false;
  let journalWrites = Promise.resolve();
  let lastAccounts;
  let namespaceAllAccounts = false;
  // Public (hub) account ids to the local ids the account provider uses, from the latest snapshot.
  let localAccountIds = new Map();
  const appliedAccountUpdates = new Set();
  let token;
  let tokenGeneration = 0;
  let tokenRotatedAt = Date.now();
  let tokenRotationKey;
  let rotationTask;
  let rotationLoopTask;
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
  let observer;
  let observationTask;
  const runtime = runtimeSupervisor ?? createRuntimeSupervisor(config.runtime, { configRoot: config.configRoot });
  const status = () => ({ machineId, state: stopped ? 'stopped' : fatalError ? 'error' : draining ? 'draining' : started ? 'running' : 'idle',
    running: { agents: [...active.values()].filter(item => item.kind === 'assignment').length,
      jobs: [...active.values()].filter(item => item.kind === 'job').length }, ...(observer ? { observe: observer.status } : {}) });
  const notify = () => { try { onStatus(status()); } catch { /* Observers cannot affect lease ownership. */ } };
  const fatal = error => {
    fatalError = new Error(error instanceof HubError ? error.message : 'Node background service failed.');
    draining = true;
    if (error?.code === 'machine_revoked') service.abort(error);
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
    const startedAt = await processIdentity(process.pid);
    const acquire = async () => {
      const file = await open(path, 'wx', 0o600);
      lockPath = path;
      try { await file.writeFile(JSON.stringify({ pid: process.pid, startedAt })); }
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
      let owner;
      try { owner = JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (owner !== undefined) {
        const pid = typeof owner === 'number' ? owner : owner?.pid;
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Node data directory has an invalid lock.');
        let alive = true;
        try { process.kill(pid, 0); }
        catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
        if (alive && (typeof owner === 'number' || !owner.startedAt || await processIdentity(pid) === owner.startedAt)) {
          throw new Error('Node data directory is already in use.');
        }
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
      machineId = credentials.machineId; token = credentials.token; hub.setToken(token);
      freshEnrollment = credentials.pendingAccountRebind === true;
      tokenGeneration = credentials.tokenGeneration ?? 0;
      tokenRotatedAt = credentials.tokenRotatedAt ? Date.parse(credentials.tokenRotatedAt) : Date.now();
      tokenRotationKey = credentials.tokenRotationKey;
      if (!Number.isSafeInteger(tokenGeneration) || tokenGeneration < 0 || !Number.isFinite(tokenRotatedAt) ||
          (tokenRotationKey !== undefined && (typeof tokenRotationKey !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(tokenRotationKey)))) throw new Error('Invalid machine credential file.');
      return;
    }
    if (!config.enrollmentCodeFile) throw new Error('Enrollment requires an owner-only enrollmentCodeFile.');
    const code = (await readSecret(config.enrollmentCodeFile)).trim();
    if (!code || /[\r\n]/.test(code)) throw new Error('Invalid enrollment code file.');
    const enrollmentKey = credentials?.enrollmentKey ?? randomUUID();
    await writePrivate(config.credentialFile, { enrollmentKey });
    const result = await hub.retry('/nodes/enroll', { code, name: machine.name, os: machine.os, arch: machine.arch,
      labels: machine.labels, providers: machine.providers, version: VERSION }, { signal: service.signal, key: enrollmentKey });
    if (!result?.machineId || typeof result.machineId !== 'string' || !result.token || typeof result.token !== 'string' || /[\r\n]/.test(result.token)) throw new Error('Invalid enrollment response.');
    machineId = result.machineId; token = result.token; hub.setToken(token); freshEnrollment = true;
    await saveCredentials();
  }
  function credentialValue() {
    return { machineId, token, tokenGeneration, tokenRotatedAt: new Date(tokenRotatedAt).toISOString(),
      ...(freshEnrollment ? { pendingAccountRebind: true } : {}), ...(tokenRotationKey ? { tokenRotationKey } : {}) };
  }
  const saveCredentials = () => writePrivate(config.credentialFile, credentialValue());
  function rotateCredentials() {
    if (rotationTask) return rotationTask;
    rotationTask = hub.withTokenRotation(async transport => {
      service.signal.throwIfAborted();
      tokenRotationKey ??= randomUUID();
      // Persist replay intent with the still-valid old token before issuing the mutation.
      await saveCredentials();
      const next = await transport.retry('/nodes/token', {}, { signal: service.signal, key: tokenRotationKey });
      if (next.machineId !== machineId || typeof next.token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(next.token) ||
          !Number.isSafeInteger(next.generation) || next.generation <= tokenGeneration) throw new Error('Invalid token rotation response.');
      const rotatedAt = Date.now();
      // Commit atomically before any request can present (and thereby activate) the new token.
      await writePrivate(config.credentialFile, { machineId, token: next.token, tokenGeneration: next.generation,
        tokenRotatedAt: new Date(rotatedAt).toISOString() });
      token = next.token; tokenGeneration = next.generation; tokenRotatedAt = rotatedAt; tokenRotationKey = undefined;
      hub.setToken(token);
      const response = await transport.retry('/nodes/heartbeat', { capacity: config.capacity, running: status().running,
        labels: machine.labels, providers: machine.providers, status: draining ? 'draining' : 'online' }, { signal: service.signal });
      handleHeartbeat(response);
      return { machineId, generation: tokenGeneration };
    }).finally(() => { rotationTask = undefined; });
    return rotationTask;
  }
  async function rotationLoop() {
    while (!service.signal.aborted) {
      try {
        await sleep(Math.max(1, tokenRotatedAt + config.tokenRotationMs - Date.now()), service.signal);
        await rotateCredentials();
      } catch {
        if (service.signal.aborted) return;
        await sleep(jitter(config.timing.backoffMaxMs), service.signal).catch(() => {});
      }
    }
  }

  function persistSeen(item) {
    seen[item.key] = Math.max(seen[item.key] ?? -1, item.attempt);
    const write = journalWrites.then(() => writePrivate(resolve(config.dataDir, 'leases.json'), seen));
    // Each caller sees its failure; subsequent leases still get their own durable write.
    journalWrites = write.catch(() => {});
    return write;
  }
  const scopedAccountId = id => `${machineId}:${createHash('sha256').update(id).digest('hex')}`;
  // Existing consumers retain pool-generated UUID identities; operator-chosen IDs are machine-scoped.
  const publicAccountId = id => !namespaceAllAccounts && /^acct_[a-f0-9]{32}$/.test(id) ? id : scopedAccountId(id);
  async function heartbeat(retry = false) {
    let accounts = lastAccounts;
    let localAccounts;
    try {
      // Namespace public IDs without changing executor-local account IDs/bindings.
      localAccounts = await accountProvider.list();
      accounts = localAccounts.map(account => {
        const usage = publicUsage(account.usage);
        return {
          ...Object.fromEntries(accountFields.filter(key => typeof account[key] === 'string').map(key => [key, account[key]])),
          ...(typeof account.id === 'string' ? { id: publicAccountId(account.id) } : {}),
          ...(usage ? { usage } : {}),
          machineId,
        };
      });
      localAccountIds = new Map(localAccounts.filter(account => typeof account.id === 'string').map(account => [publicAccountId(account.id), account.id]));
    } catch { /* A local account snapshot failure must not interrupt leased work. */ }
    const body = { capacity: config.capacity, running: status().running, labels: machine.labels,
      ...(accounts ? { accounts } : {}), providers: machine.providers, status: draining ? 'draining' : 'online' };
    let result;
    try {
      result = await hub[retry ? 'retry' : 'post']('/nodes/heartbeat', body, { signal: service.signal });
      lastAccounts = accounts;
    } catch (error) {
      if (!(error instanceof HubError) || ![400, 409].includes(error.status) || !accounts) throw error;
      // A deliberately duplicated legacy UUID must also get a machine-scoped public ID.
      if (error.status === 409 && localAccounts && !namespaceAllAccounts) {
        namespaceAllAccounts = true;
        body.accounts = accounts.map((account, index) => ({ ...account, id: scopedAccountId(localAccounts[index].id) }));
        localAccountIds = new Map(localAccounts.map(account => [scopedAccountId(account.id), account.id]));
        try {
          result = await hub[retry ? 'retry' : 'post']('/nodes/heartbeat', body, { signal: service.signal });
          lastAccounts = body.accounts;
        } catch (retryError) {
          if (!(retryError instanceof HubError) || ![400, 409].includes(retryError.status)) throw retryError;
        }
      }
      if (!result) {
        // Bad metadata cannot prevent liveness/cancellation delivery.
        delete body.accounts;
        result = await hub[retry ? 'retry' : 'post']('/nodes/heartbeat', body, { signal: service.signal });
      }
    }
    handleHeartbeat(result);
  }
  function handleHeartbeat(result) {
    for (const [kind, ids] of [['assignment', result.cancel?.assignments], ['job', result.cancel?.jobs]]) {
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        const record = active.get(`${kind}:${id}`);
        if (!record || record.cancelRequested) continue;
        record.cancelRequested = true;
        record.work.abort(new Error('Hub cancelled execution.'));
      }
    }
    if (result.status === 'draining' || result.machine?.status === 'draining') drain();
    adoptPins(result.tls?.fingerprints);
    applyPacing(result.pacing);
    void applyAccountUpdates(result.accountUpdates);
  }
  /** Hub allowances for `paced` account selection; no plan in the response means no pacing. */
  function applyPacing(pacing) {
    if (typeof accountProvider?.setPacing !== 'function') return;
    const accounts = pacing && typeof pacing.accounts === 'object' && !Array.isArray(pacing.accounts) ? pacing.accounts : null;
    if (!accounts) { try { accountProvider.setPacing(null); } catch { /* Selection keeps its own policy. */ } return; }
    const local = {};
    for (const [publicId, value] of Object.entries(accounts)) {
      const id = localAccountIds.get(publicId);
      if (id && Number.isSafeInteger(value?.targetAgents) && value.targetAgents >= 0) local[id] = value.targetAgents;
    }
    try { accountProvider.setPacing(local); } catch { /* A malformed plan leaves selection on its own policy. */ }
  }
  /** Operator label/plan edits relayed by the hub; each update id is applied once per process and is idempotent. */
  async function applyAccountUpdates(updates) {
    if (!Array.isArray(updates) || typeof accountProvider?.updateAccount !== 'function') return;
    for (const update of updates.slice(0, 100)) {
      const id = localAccountIds.get(update?.accountId);
      if (!id || typeof update.id !== 'string' || appliedAccountUpdates.has(update.id)) continue;
      try {
        await accountProvider.updateAccount({ accountId: id, ...(update.label !== undefined ? { label: update.label } : {}),
          ...(update.plan !== undefined ? { plan: update.plan } : {}), idempotencyKey: `account-update:${update.id}` });
        appliedAccountUpdates.add(update.id);
      } catch { /* Retried from the next heartbeat. */ }
    }
  }
  /**
   * During certificate rotation the hub announces the served and next fingerprints over the pinned channel. Adopt the
   * list only if it still contains one this machine trusts, so a bad response cannot lock the machine out.
   */
  function adoptPins(list) {
    if (!pins || !Array.isArray(list) || !list.length || list.length > 4 || !list.every(value => typeof value === 'string' && FINGERPRINT.test(value))) return;
    if (!list.some(value => pins.includes(value)) || JSON.stringify(list) === JSON.stringify(pins)) return;
    pins = [...list];
    pinWrites = pinWrites.then(() => writePrivate(pinsFile, pins)).catch(() => { /* The in-memory pins still apply; the next heartbeat writes again. */ });
  }
  async function heartbeatLoop() {
    let wait = config.timing.heartbeatMs;
    let backoff = config.timing.backoffMinMs;
    while (!service.signal.aborted) {
      try { await sleep(wait, service.signal); await heartbeat(); wait = config.timing.heartbeatMs; backoff = config.timing.backoffMinMs; }
      catch (error) {
        if (service.signal.aborted) return;
        if (!(error instanceof HubError) || !error.retryable) { fatal(error); return; }
        wait = jitter(backoff);
        backoff = Math.min(backoff * 2, config.timing.backoffMaxMs);
      }
    }
  }
  const pathFor = record => `/${record.kind === 'assignment' ? 'assignments' : 'jobs'}/${encodeURIComponent(record.item.id)}`;
  async function report(record, event) {
    if (record.cancelRequested && event.type !== 'cancelled') throw record.work.signal.reason;
    if (record.lost || clock() >= record.expires) { lose(record); throw record.lease.signal.reason; }
    try {
      // Account ids leave the machine as their public ids: usage records and the account.bound progress the hub uses
      // to count agents per account for pacing.
      const bound = event.type === 'progress' && event.data?.interaction === 'account.bound';
      const outgoing = (event.type === 'usage' || bound) && typeof event.data?.accountId === 'string'
        ? { ...event, data: { ...event.data, accountId: publicAccountId(event.data.accountId) } } : event;
      return await hub.retry(`${pathFor(record)}/events`, { ...outgoing, attempt: record.attempt }, { signal: record.lease.signal });
    } catch (error) {
      if (error.code === 'lease_lost' || error.status === 409) lose(record);
      throw error;
    }
  }
  async function renewLoop(record) {
    while (!record.lease.signal.aborted && !record.cancelRequested) {
      try {
        await sleep(Math.min(config.timing.renewMs, Math.max(1, (record.expires - clock()) / 3)), record.lease.signal);
        if (record.cancelRequested) return;
        const result = await hub.retry(`${pathFor(record)}/renew`, { attempt: record.attempt }, { signal: record.lease.signal });
        const expires = Date.parse(result.leaseExpiresAt ?? result.lease?.leaseExpiresAt);
        if (!Number.isFinite(expires) || expires <= clock()) { lose(record); return; }
        record.expires = expires;
        armExpiry(record);
        // Messages that reached this assignment's role since the last renewal; the hub re-offers them until the
        // executor reports them delivered, and the executor delivers each id once.
        if (Array.isArray(result.inbox) && result.inbox.length) record.inbox.push(result.inbox);
      } catch (error) {
        if (record.lease.signal.aborted || record.cancelRequested) return;
        // A rejected renewal cannot establish ownership, regardless of its HTTP status.
        lose(record); return;
      }
    }
  }
  function armExpiry(record) {
    clearTimeout(record.expiryTimer);
    record.expiryTimer = setTimeout(() => lose(record), Math.max(0, record.expires - clock()));
  }
  async function execute(record) {
    armExpiry(record);
    const renewal = renewLoop(record);
    const workspace = resolve(config.dataDir, 'assignments', randomUUID());
    try {
      await persistSeen(record);
      if (record.kind === 'assignment') await mkdir(workspace, { recursive: true, mode: 0o700 });
      const ctx = { signal: record.work.signal, report: event => report(record, event), workspace,
        inbox: { take: () => record.inbox.take(), subscribe: listener => record.inbox.subscribe(listener) },
        // Where the agent's run-scoped messaging credential reaches the hub, with this machine's certificate pins.
        messaging: { baseUrl: config.hubUrl, ...(pins ? { tlsFingerprints: [...pins] } : {}) },
        runtimeUrl: machine.runtimeUrl, accountProvider,
        // Jobs whose revision lives on the hub fetch it over the job's authenticated route, for this lease's attempt.
        fetchSource: (path, file) => hub.download(`${path}?attempt=${record.attempt}`, file,
          { signal: record.work.signal, timeoutMs: (config.jobs?.checkoutTimeoutSec ?? 120) * 1000 }) };
      let result;
      if (record.kind === 'job') {
        const redaction = await loadRedaction(config);
        result = await runJob(record.item, ctx, {
          ...config.jobs, dataDir: config.dataDir,
          protectedPaths: [dirname(config.credentialFile), config.credentialFile, config.enrollmentCodeFile,
            config.jobs?.redactionFile && resolve(config.configRoot, config.jobs.redactionFile),
            config.accounts?.nodeDataDir && resolve(config.configRoot, config.accounts.nodeDataDir),
            config.runtime?.repoRoot && resolve(config.configRoot, config.runtime.repoRoot, '.perpeto'),
            ...[config.runtime, config.runtime?.t3].flatMap(settings => [settings?.credentialFile, settings?.baseDir].filter(Boolean).map(path => resolve(config.configRoot, path))),
            ...(config.jobs?.protectedPaths ?? [])].filter(Boolean),
          redaction: { ...redaction, literals: [...redaction.literals, token] },
        });
      } else {
        await report(record, { type: 'started', data: {} });
        const executor = registry.find(record.item, machine);
        if (!executor) result = { outcome: 'failure', summary: 'No compatible executor is installed.' };
        else {
          record.executed = true;
          record.executorKind = executor.kind;
          try { result = await executor.run(record.item, ctx); }
          catch (error) { record.executorThrew = true; throw error; }
        }
        if (!['success', 'failure', 'blocked'].includes(result?.outcome) || typeof result.summary !== 'string') throw new Error('Invalid executor result.');
      }
      record.work.signal.throwIfAborted();
      if (!record.lost) await report(record, { type: record.kind === 'assignment' && result.outcome === 'failure' ? 'failed' : 'completed', data: result });
    } catch (error) {
      let failureReason;
      if (record.kind === 'assignment' && record.executorThrew && !record.work.signal.aborted) {
        try {
          const redaction = await loadRedaction(config);
          const environmentSecrets = Object.entries(process.env).filter(([name]) => /token|secret|password|credential|api_?key/i.test(name)).map(([, value]) => value);
          failureReason = sanitizeFailure(error, { ...redaction, literals: [...redaction.literals, token, record.item.messaging?.token, ...environmentSecrets] });
        } catch { failureReason = 'Executor failed; diagnostic redaction is unavailable.'; }
        // The daemon launcher captures stderr in node.log. Logging cannot prevent lease settlement.
        try { console.error(JSON.stringify({ event: 'executor.failed', assignmentId: record.item.id, attempt: record.attempt,
          executorKind: sanitizeFailure(String(record.executorKind)).slice(0, 100), failureReason })); } catch { /* Continue reporting. */ }
      }
      if (!record.lost) {
        const data = record.kind === 'job'
          ? { status: record.work.signal.aborted ? 'cancelled' : 'error', revision: record.item.revision, configHash: record.item.configHash, steps: [], artifacts: [] }
          : { outcome: 'failure', summary: record.work.signal.aborted ? 'Node execution was cancelled.' : failureReason ?? 'Executor failed.', ...(failureReason ? { failureReason } : {}) };
        await report(record, { type: record.cancelRequested ? 'cancelled' : record.kind === 'job' ? 'completed' : 'failed', data }).catch(() => lose(record));
      }
    } finally {
      record.lease.abort();
      clearTimeout(record.expiryTimer);
      await renewal;
      let pendingReservation;
      try { if (record.executed) pendingReservation = await accountProvider.settledReservation?.({ assignmentId: record.item.id, attempt: record.attempt }); }
      catch { /* Uncertain reservations keep their finite lease. */ }
      if (pendingReservation) {
        settledReservations[`${record.item.id}-${record.attempt}`] = pendingReservation;
        const write = settlementWrites.then(() => writePrivate(resolve(config.dataDir, 'settled-reservations.json'), settledReservations));
        // Persistence failure keeps recovery conservative; the reservation can still expire.
        settlementWrites = write.catch(() => {});
        await settlementWrites;
      }
      if (record.kind === 'assignment') await rm(workspace, { recursive: true, force: true }).catch(() => {});
      active.delete(record.key);
      notify();
    }
  }
  function accepts(item, kind) {
    if (!item || typeof item.id !== 'string' || !Number.isSafeInteger(item.attempt) || item.attempt < 0 || !Number.isFinite(Date.parse(item.leaseExpiresAt)) || Date.parse(item.leaseExpiresAt) <= clock()) return false;
    const key = `${kind}:${item.id}`;
    if (active.has(key) || (seen[key] ?? -1) >= item.attempt) return false;
    const req = item.requirements ?? {};
    return (!req.os || req.os === machine.os) && (req.labels ?? []).every(value => machine.labels.includes(value)) &&
      (req.providers ?? []).every(value => machine.providers.includes(value));
  }
  async function relinquish(item, kind) {
    if (!['assignment', 'job'].includes(kind) || typeof item?.id !== 'string' || !Number.isSafeInteger(item.attempt)) return;
    // Never finalise a duplicate response for an attempt that is still executing locally.
    if (active.has(`${kind}:${item.id}`)) return;
    try {
      await hub.retry(`/${kind === 'assignment' ? 'assignments' : 'jobs'}/${encodeURIComponent(item.id)}/release`,
        { attempt: item.attempt, reason: 'Node cannot run this lease with its current capacity or requirements.' }, { signal: service.signal });
    } catch (error) {
      // A stale/started lease cannot be released. Never turn a rejection into a terminal result.
      if (error instanceof HubError && error.status === 409) return;
      throw error;
    }
  }

  async function pollLoop(kind) {
    const limit = kind === 'job' ? config.capacity.maxJobs : config.capacity.maxAgents;
    let wait = config.timing.backoffMinMs;
    while (!polling.signal.aborted) {
      try {
        const used = [...active.values()].filter(item => item.kind === kind).length;
        if (used >= limit) { await sleep(config.timing.pollIdleMs, polling.signal); continue; }
        const response = await hub.retry('/nodes/lease', { kinds: [kind], max: Math.min(1000, limit - used) }, { signal: polling.signal });
        const items = response.leases ?? response.items ?? [
          ...(response.assignments ?? []).map(item => ({ kind: 'assignment', ...item })),
          ...(response.jobs ?? []).map(item => ({ kind: 'job', ...item })),
        ];
        if (!Array.isArray(items)) throw new Error('Invalid lease response.');
        for (const value of items) {
          const inner = value.assignment ?? value.job ?? value.item;
          const item = inner ? { ...inner, leaseExpiresAt: value.leaseExpiresAt ?? inner.leaseExpiresAt, attempt: value.attempt ?? inner.attempt } : value;
          const itemKind = value.kind ?? kind;
          if (polling.signal.aborted || itemKind !== kind || [...active.values()].filter(item => item.kind === kind).length >= limit || !accepts(item, kind)) {
            await relinquish(item, itemKind);
            continue;
          }
          const record = { kind, item, key: `${kind}:${item.id}`, attempt: item.attempt, expires: Date.parse(item.leaseExpiresAt),
            work: new AbortController(), lease: new AbortController(), lost: false, inbox: createInbox() };
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
        await sleep(jitter(wait), polling.signal).catch(() => {});
        wait = Math.min(wait * 2, config.timing.backoffMaxMs);
      }
    }
  }
  /**
   * Observe-only reporting: the read-only T3 observer's batches go to the hub, and each is acknowledged only after the
   * hub accepted it, so nothing is lost while the hub is unreachable. The batch id is the idempotency key.
   */
  async function startObserver() {
    const { createT3Observer } = await import('@perpeto/t3-observer');
    let last = '';
    observer = createT3Observer({ ...config.observe, dataDir: config.dataDir, log(event) {
      // Connection changes only, never payloads or credentials; the daemon launcher captures stderr in node.log.
      const line = JSON.stringify(event);
      if (line !== last) { last = line; try { console.error(line); } catch { /* Logging cannot stop observation. */ } }
    } }).start();
    observationTask = observationLoop();
  }
  async function observationLoop() {
    while (!service.signal.aborted) {
      try {
        await sleep(config.observe.pollMs, service.signal);
        for (let round = 0; round < 10; round++) {
          const batch = observer.collect();
          if (!batch) break;
          try { await hub.retry('/nodes/observations', batch, { signal: service.signal, key: batch.batchId }); }
          catch (error) {
            // A batch the hub refuses as invalid is dropped rather than resent forever; the next change resends its sessions.
            if (!(error instanceof HubError) || error.retryable || error.status === 401) throw error;
            try { console.error(JSON.stringify({ event: 'observer.batch-refused', status: error.status, code: error.code })); } catch { /* Continue. */ }
          }
          observer.acknowledge(batch);
        }
      } catch (error) {
        if (service.signal.aborted) return;
        if (error instanceof HubError && error.status === 401) return;
        await sleep(jitter(config.timing.backoffMaxMs), service.signal).catch(() => {});
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
      await Promise.allSettled([heartbeatTask, rotationLoopTask, rotationTask, observationTask, ...pollTasks]);
      await observer?.stop().catch(() => {});
      try { if (integrationsReady) { await registry?.close?.(); await accountProvider?.close?.(); } }
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
        try { settledReservations = JSON.parse(await readSecret(resolve(config.dataDir, 'settled-reservations.json'))); }
        catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid settled-reservation journal.'); }
        if (!settledReservations || typeof settledReservations !== 'object' || Array.isArray(settledReservations) || Object.values(settledReservations).some(value => typeof value !== 'string' || !/^res_[a-zA-Z0-9_-]+$/.test(value))) throw new Error('Invalid settled-reservation journal.');
        const detected = await detectProviders();
        machine = { name: config.name ?? hostname(), os: process.platform === 'win32' ? 'windows' : process.platform,
          arch: process.arch, labels: config.labels, providers: config.providers ? detected.filter(provider => config.providers.includes(provider)) : detected,
          capacity: config.capacity, version: VERSION };
        if (config.fake !== undefined) machine.providers.push('fake');
        runtimeAttempted = true;
        machine.runtimeUrl = await runtime.start({ signal: service.signal });
        ({ registry, accountProvider } = await loadIntegrations(config, { registry, accountProvider, runtimeUrl: machine.runtimeUrl }));
        integrationsReady = true;
        // The runtime may run harnesses this daemon's PATH does not show (another Node version, a managed CLI).
        const reported = await registry.providers?.({ signal: AbortSignal.any([service.signal, AbortSignal.timeout(10000)]) }) ?? [];
        for (const provider of reported) {
          if (!machine.providers.includes(provider) && (!config.providers || config.providers.includes(provider))) machine.providers.push(provider);
        }
        machine.providers = machine.providers.filter(provider => registry.find({ harness: { provider, model: 'discovery' }, requirements: {}, policy: {} }, machine));
        await enroll();
        // Machine-scoped integrations (the account pool) can only open once the machine ID is known.
        if (typeof accountProvider.prepare === 'function') {
          await accountProvider.prepare({ machineId, reEnroll: freshEnrollment, settledReservations });
          // Successful reconciliation consumed these proofs; keep only future pending settlements.
          if (Object.keys(settledReservations).length) await writePrivate(resolve(config.dataDir, 'settled-reservations.json'), {});
          settledReservations = {};
        } else await accountProvider.bind?.({ machineId });
        freshEnrollment = false;
        await saveCredentials();
        if (tokenRotationKey) await rotateCredentials();
        // Initial heartbeat may reconnect too, but no work is accepted until capacity is announced.
        await heartbeat(true);
        service.signal.throwIfAborted();
        started = true;
        heartbeatTask = heartbeatLoop();
        if (config.tokenRotationMs) rotationLoopTask = rotationLoop();
        pollTasks = ['assignment', 'job'].filter(kind => kind === 'job' ? config.capacity.maxJobs : config.capacity.maxAgents)
          .map(kind => pollLoop(kind));
        if (config.observe?.enabled) await startObserver();
        notify();
        return this;
      } catch (error) { await cleanup(); throw error; }
      finally { finishStartup(); }
    },
    drain,
    rotateToken() {
      if (!started || stopped || service.signal.aborted) return Promise.reject(new Error('Node must be running to rotate its token.'));
      return rotateCredentials();
    },
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

/** Messages relayed from renewals to a running executor: a queue it takes from and a wake-up when more arrive. */
function createInbox() {
  let queue = [];
  const listeners = new Set();
  return {
    push(messages) {
      queue.push(...messages.filter(message => typeof message?.id === 'string'));
      for (const listener of listeners) { try { listener(); } catch { /* A listener cannot affect lease ownership. */ } }
    },
    take() { const taken = queue; queue = []; return taken; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

/** Pins persisted after a rotation win over the fingerprint the machine joined with. Null means no pinning. */
async function readPins(path, joined) {
  try {
    const pins = JSON.parse(await readSecret(path));
    if (Array.isArray(pins) && pins.length && pins.every(value => typeof value === 'string' && FINGERPRINT.test(value))) return pins;
    throw new Error('Invalid hub pins file.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return joined ? [joined] : null;
  }
}
