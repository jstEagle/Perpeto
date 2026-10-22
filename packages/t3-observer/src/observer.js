import { randomUUID, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ReadOnlyT3Client, T3ReadError, loopbackOrigin, readRuntime } from './client.js';
import { defaultCli, mintSession, readTokenFile, t3Home, ttlMs, writeTokenFile } from './credentials.js';
import { isLive, lastActivityAt, projectOf, providerDrivers, providerSnapshots, sessionOf, sessionStatus, shellThread, usageOf } from './model.js';

const HOUR = 3600000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sleep = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {});

export const OBSERVER_DEFAULTS = Object.freeze({
  t3BaseDir: resolve(homedir(), '.t3/userdata'), pollMs: 5000, includeTitles: true, tokenTtl: '30d', backfillHours: 168,
  fetchesPerPoll: 2, activeRefreshMs: 60000, limitsPollMs: 60000, statusEveryMs: 30000, maxBatchSessions: 200, maxBatchUsage: 500,
  reconnectMinMs: 1000, reconnectMaxMs: 60000, snapshotTimeoutMs: 20000, mintIntervalMs: 600000,
});

/**
 * Watches one operator's own running T3 Code, read-only. It keeps an allowlisted copy of the thread shell and
 * provider list, fetches per-turn token usage for threads that changed, and turns the difference since the last
 * acknowledged batch into an observation batch. It never sends a command: see READ_ONLY_RPCS.
 */
export class T3Observer {
  #options; #client = null; #abort = new AbortController(); #task = null; #token = null; #invalidToken = null; #lastMintAt = -Infinity;
  #threads = new Map(); #projects = new Map(); #providers = []; #drivers = new Map();
  #fetched = new Map(); #pendingUsage = new Map(); #sentTurns = new Set();
  #acked = new Map(); #removed = new Set(); #providersAcked = null; #sourceAcked = null; #lastSentAt = -Infinity;
  #resync = null; #resynced = false; #inflight = null; #stateDirty = false; #stateWrittenAt = 0; #stateLoaded = false;
  constructor(options = {}) {
    this.#options = { ...OBSERVER_DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) };
    const o = this.#options;
    o.clock ??= Date.now;
    o.log ??= () => {};
    if (o.url !== undefined) o.url = loopbackOrigin(o.url);
    ttlMs(o.tokenTtl);
    this.state = 'idle'; this.connected = false; this.serverVersion = undefined; this.error = undefined; this.lastSyncAt = undefined;
  }
  get status() {
    const sessions = [...this.#threads.values()].filter(isLive);
    return { state: this.state, connected: this.connected, ...(this.serverVersion ? { serverVersion: this.serverVersion } : {}), ...(this.error ? { error: this.error } : {}),
      ...(this.lastSyncAt ? { lastSyncAt: new Date(this.lastSyncAt).toISOString() } : {}), sessions: sessions.length,
      running: sessions.filter(thread => sessionStatus(thread) === 'running').length, pendingUsage: this.#pendingUsage.size };
  }
  start() {
    if (this.#task) return this;
    this.state = 'connecting';
    this.#task = this.#run().catch(() => {});
    return this;
  }
  async stop() {
    this.#abort.abort();
    this.#client?.close();
    await this.#task;
    await this.#saveState(true).catch(() => {});
    this.state = 'stopped'; this.connected = false;
  }
  /** Resolve once the first full shell snapshot arrived, or reject after `timeoutMs`. */
  async ready(timeoutMs = 30000) {
    const until = this.#options.clock() + timeoutMs;
    while (!this.lastSyncAt) {
      if (this.#abort.signal.aborted) throw new T3ReadError('Observer stopped.', 'STOPPED');
      if (this.#options.clock() > until) throw new T3ReadError(`T3 did not answer (${this.error ?? 'timeout'}).`, this.error ?? 'TIMEOUT');
      await sleep(25);
    }
  }
  /** Fetch usage for changed threads now instead of waiting for the next poll. Returns how many were fetched. */
  async fetchUsage(limit = this.#options.fetchesPerPoll) { return this.#client?.connected ? this.#fetchUsage(this.#client, limit) : 0; }
  /** Threads still waiting for a usage fetch inside the backfill window. */
  get usageBacklog() { const now = this.#options.clock(); return [...this.#threads.values()].filter(thread => this.#needsFetch(thread, now)).length; }

  async #run() {
    const o = this.#options; const signal = this.#abort.signal;
    await this.#loadState();
    let backoff = o.reconnectMinMs;
    while (!signal.aborted) {
      let client;
      try {
        const runtime = o.url ? { url: o.url } : await readRuntime(o.t3BaseDir);
        if (runtime.serverVersion) this.serverVersion = runtime.serverVersion;
        const token = await this.#sessionToken();
        client = this.#client = new ReadOnlyT3Client({ baseUrl: runtime.url, token, fetchImpl: o.fetchImpl, WebSocketImpl: o.WebSocketImpl, pingMs: o.pingMs });
        await client.connect({ signal });
        const closed = new Promise(resolvePromise => client.onClose(resolvePromise));
        await this.#refreshConfig(client);
        const shell = await client.stream('orchestration.subscribeShell', { requestCompletionMarker: true }, values => this.#applyShell(values));
        shell.done.catch(() => {}).finally(() => client.close());
        this.connected = true; this.state = 'connected'; this.error = undefined;
        let lastLimits = o.clock();
        o.log({ event: 'observer.connected', serverVersion: this.serverVersion });
        while (!signal.aborted && client.connected) {
          const stopped = await Promise.race([sleep(o.pollMs, signal).then(() => false), closed.then(() => true)]);
          if (stopped || signal.aborted || !client.connected) break;
          if (this.lastSyncAt) backoff = o.reconnectMinMs;
          if (o.clock() - lastLimits >= o.limitsPollMs) { await this.#refreshConfig(client); lastLimits = o.clock(); }
          await this.#fetchUsage(client, o.fetchesPerPoll);
          await this.#saveState();
        }
        if (!signal.aborted) this.error = 'CONNECTION_CLOSED';
      } catch (error) {
        if (signal.aborted) break;
        this.error = typeof error?.code === 'string' ? error.code.slice(0, 60) : 'T3_UNAVAILABLE';
        if (error?.code === 'UNAUTHORIZED') this.#invalidToken = this.#token;
        o.log({ event: 'observer.disconnected', code: this.error });
      } finally {
        client?.close();
        if (this.#client === client) this.#client = null;
        this.connected = false;
        if (!signal.aborted) this.state = 'disconnected';
      }
      if (signal.aborted) break;
      await sleep(Math.floor(backoff / 2 + Math.random() * backoff / 2), signal);
      backoff = Math.min(backoff * 2, o.reconnectMaxMs);
    }
  }

  /** The operator's own token file, else a stored observer session, else a freshly minted read-only one. */
  async #sessionToken() {
    const o = this.#options;
    if (o.token) return (this.#token = o.token);
    if (o.credentialFile) {
      const stored = await readTokenFile(o.credentialFile);
      if (!stored) throw new T3ReadError('The configured T3 credentialFile does not exist.', 'CREDENTIAL_MISSING');
      return (this.#token = stored.token);
    }
    const file = o.dataDir ? resolve(o.dataDir, 't3-observer-session.json') : null;
    if (this.#token && this.#token !== this.#invalidToken) return this.#token;
    const stored = file ? await readTokenFile(file) : null;
    const fresh = stored && stored.token !== this.#invalidToken && (!stored.expiresAt || Date.parse(stored.expiresAt) - o.clock() > HOUR);
    if (fresh) return (this.#token = stored.token);
    // A server that keeps refusing new sessions must not fill T3's auth store: mint at most once per interval.
    if (o.clock() - this.#lastMintAt < o.mintIntervalMs) throw new T3ReadError('Waiting before minting another T3 session.', 'UNAUTHORIZED');
    this.#lastMintAt = o.clock();
    const token = await mintSession({ cli: o.cli ?? defaultCli(o.t3BaseDir), home: t3Home(o.t3BaseDir), ttl: o.tokenTtl, execFileImpl: o.execFileImpl });
    const issuedAt = o.clock();
    if (file) await writeTokenFile(file, { token, scopes: ['orchestration:read'], issuedAt: new Date(issuedAt).toISOString(), expiresAt: new Date(issuedAt + ttlMs(o.tokenTtl)).toISOString() });
    this.#invalidToken = null;
    o.log({ event: 'observer.session-minted', scope: 'orchestration:read', ttl: o.tokenTtl });
    return (this.#token = token);
  }

  async #refreshConfig(client) {
    const config = await client.request('server.getConfig', {});
    this.#providers = providerSnapshots(config?.providers);
    this.#drivers = providerDrivers(config?.providers);
  }

  /** Apply shell stream items, keeping only allowlisted fields (see model.shellThread). */
  #applyShell(values) {
    for (const item of Array.isArray(values) ? values : []) {
      if (item?.kind === 'snapshot' && item.snapshot) {
        const projects = (item.snapshot.projects ?? []).map(projectOf).filter(Boolean);
        // Later snapshots carrying resolvedRepositoryIdentityRoots are project-metadata refreshes with no threads.
        if (Object.hasOwn(item, 'resolvedRepositoryIdentityRoots')) { for (const [id, project] of projects) this.#projects.set(id, project); continue; }
        this.#projects = new Map(projects);
        const next = new Map((item.snapshot.threads ?? []).filter(isLive).map(thread => [thread.id, shellThread(thread)]));
        for (const id of this.#threads.keys()) if (!next.has(id)) this.#removed.add(id);
        this.#threads = next;
        if (!this.#resynced) { this.#resynced = true; this.#resync = { id: randomUUID(), remaining: [...next.keys()] }; }
        // A resync still in progress restarts from the new snapshot, so it never misses a thread that appeared meanwhile.
        else if (this.#resync) this.#resync.remaining = [...next.keys()];
      } else if (item?.kind === 'synchronized') this.lastSyncAt = this.#options.clock();
      else if (item?.kind === 'project.updated') { const entry = projectOf(item.project); if (entry) this.#projects.set(...entry); }
      else if (item?.kind === 'project.removed') this.#projects.delete(item.projectId);
      else if (item?.kind === 'thread.updated' && item.thread?.id) {
        if (item.location === 'active' && isLive(item.thread)) { this.#threads.set(item.thread.id, shellThread(item.thread)); this.#removed.delete(item.thread.id); }
        else if (this.#threads.delete(item.thread.id)) this.#removed.add(item.thread.id);
      } else if (item?.kind === 'thread.removed' && typeof item.threadId === 'string') {
        if (this.#threads.delete(item.threadId)) this.#removed.add(item.threadId);
      }
      // Unknown kinds are skipped: newer T3 builds may add items.
    }
  }

  #fetchKey(thread) { return [thread.latestRunId, thread.latestRunCompletedAt, thread.status, thread.activityRunStatus, thread.pendingRuntimeRequest?.kind].join('|'); }
  #needsFetch(thread, now) {
    // Imported v1 threads would be hydrated (written) by T3 on first subscription; the observer leaves them alone.
    if (thread.historyOrigin === 'v1_import') return false;
    if (Date.parse(lastActivityAt(thread)) < now - this.#options.backfillHours * HOUR) return false;
    const fetched = this.#fetched.get(thread.id);
    if (!fetched || fetched.key !== this.#fetchKey(thread)) return true;
    return sessionStatus(thread) === 'running' && now - fetched.at >= this.#options.activeRefreshMs;
  }
  async #fetchUsage(client, limit) {
    const now = this.#options.clock();
    const due = [...this.#threads.values()].filter(thread => this.#needsFetch(thread, now))
      .sort((a, b) => lastActivityAt(b).localeCompare(lastActivityAt(a))).slice(0, limit);
    let fetched = 0;
    for (const thread of due) {
      if (this.#abort.signal.aborted || !client.connected) break;
      const key = this.#fetchKey(thread);
      const projection = await this.#threadUsage(client, thread.id);
      if (!projection) continue;
      const { records, turns } = usageOf(projection, thread, this.#drivers);
      for (const record of records) if (!this.#sentTurns.has(record.providerTurnId)) this.#pendingUsage.set(record.providerTurnId, record);
      this.#fetched.set(thread.id, { key, at: this.#options.clock(), turns });
      this.#stateDirty = true; fetched++;
    }
    return fetched;
  }
  /**
   * One bounded thread snapshot, reduced on receipt to runs, attempts and provider turns. Messages and turn items
   * arrive on the socket (T3 has no usage-only read) and are dropped here without being kept or forwarded.
   */
  async #threadUsage(client, threadId) {
    let projection = null; let finish;
    const done = new Promise(resolvePromise => { finish = resolvePromise; });
    const timer = setTimeout(() => finish(), this.#options.snapshotTimeoutMs);
    let stream;
    try {
      stream = await client.stream('orchestration.subscribeThread', { threadId, requestCompletionMarker: true, acceptBoundedSnapshot: true, acceptCompactTurnItems: true }, values => {
        for (const item of values) {
          if (item?.kind === 'snapshot' && item.projection) {
            const value = item.projection;
            projection = {
              runs: (value.runs ?? []).map(run => ({ id: run.id, ordinal: run.ordinal, providerInstanceId: run.providerInstanceId,
                modelSelection: run.modelSelection ? { instanceId: run.modelSelection.instanceId, model: run.modelSelection.model } : undefined })),
              attempts: (value.attempts ?? []).map(attempt => ({ id: attempt.id, runId: attempt.runId })),
              providerTurns: (value.providerTurns ?? []).map(turn => ({ id: turn.id, status: turn.status, runAttemptId: turn.runAttemptId,
                startedAt: turn.startedAt, completedAt: turn.completedAt, turnTokenUsage: turn.turnTokenUsage })),
            };
          } else if (item?.kind === 'synchronized') finish();
        }
      });
      stream.done.then(() => finish(), () => finish());
      await done;
    } catch { /* A failed thread read is retried on a later poll. */ }
    finally { clearTimeout(timer); stream?.cancel(); }
    return projection;
  }

  /** Session views of every live thread, keyed by thread id. */
  #sessions() {
    const sessions = new Map();
    for (const thread of this.#threads.values()) {
      sessions.set(thread.id, sessionOf(thread, { projects: this.#projects, providers: this.#drivers, includeTitles: this.#options.includeTitles, turns: this.#fetched.get(thread.id)?.turns }));
    }
    return sessions;
  }
  #source() { return { connected: this.connected, ...(this.serverVersion ? { serverVersion: this.serverVersion } : {}), ...(this.error ? { error: this.error } : {}) }; }

  /**
   * The next observation batch: changed sessions (all of them, chunked, after a restart), removed threads, unsent
   * usage records and provider instances when they changed. Null when nothing changed and a status ping is not due.
   * The same content is offered again until `acknowledge` is called with it.
   */
  collect() {
    const o = this.#options; const now = o.clock();
    const sessions = this.#sessions(); const sent = new Map();
    let resync;
    if (this.#resync) {
      const ids = this.#resync.remaining.filter(id => sessions.has(id)).slice(0, o.maxBatchSessions);
      for (const id of ids) sent.set(id, JSON.stringify(sessions.get(id)));
      resync = { id: this.#resync.id, final: this.#resync.remaining.filter(id => sessions.has(id)).length <= ids.length };
    } else {
      for (const [id, session] of sessions) {
        if (sent.size >= o.maxBatchSessions) break;
        const json = JSON.stringify(session);
        if (this.#acked.get(id) !== json) sent.set(id, json);
      }
    }
    const removed = [...this.#removed].filter(id => !sessions.has(id)).slice(0, 1000);
    const usage = [...this.#pendingUsage.values()].slice(0, o.maxBatchUsage);
    const providersHash = digest(this.#providers); const source = this.#source(); const sourceHash = digest(source);
    const providersChanged = providersHash !== this.#providersAcked && (this.#providers.length > 0 || this.#providersAcked !== null);
    const empty = !sent.size && !removed.length && !usage.length && !providersChanged && !resync && sourceHash === this.#sourceAcked;
    if (empty && now - this.#lastSentAt < o.statusEveryMs) return null;
    const batch = { batchId: randomUUID(), observedAt: new Date(now).toISOString(), source,
      ...(resync ? { resync } : {}), sessions: [...sent.values()].map(json => JSON.parse(json)),
      ...(removed.length ? { removedThreadIds: removed } : {}), ...(usage.length ? { usage } : {}),
      ...(providersChanged ? { providers: this.#providers } : {}) };
    this.#inflight = { batchId: batch.batchId, sent, removed, usage: usage.map(record => record.providerTurnId), providersHash, sourceHash, resync };
    return batch;
  }
  /** Mark a delivered batch (the hub answered 2xx) so it is not offered again. */
  acknowledge(batch) {
    const inflight = this.#inflight;
    if (!inflight || inflight.batchId !== batch?.batchId) return false;
    for (const [id, json] of inflight.sent) this.#acked.set(id, json);
    for (const id of inflight.removed) { this.#removed.delete(id); this.#acked.delete(id); this.#fetched.delete(id); }
    for (const id of inflight.usage) { this.#pendingUsage.delete(id); this.#sentTurns.add(id); }
    if (this.#sentTurns.size > 100000) this.#sentTurns = new Set([...this.#sentTurns].slice(-50000));
    this.#providersAcked = inflight.providersHash; this.#sourceAcked = inflight.sourceHash;
    if (inflight.resync && this.#resync?.id === inflight.resync.id) {
      if (inflight.resync.final) this.#resync = null;
      else this.#resync.remaining = this.#resync.remaining.filter(id => !inflight.sent.has(id));
    }
    this.#lastSentAt = this.#options.clock(); this.#inflight = null;
    return true;
  }

  /** Fetch keys and turn counts survive restarts, so a restart does not re-read every thread. */
  async #loadState() {
    if (this.#stateLoaded || !this.#options.dataDir) return;
    this.#stateLoaded = true;
    try {
      const value = JSON.parse(await readFile(resolve(this.#options.dataDir, 't3-observer-state.json'), 'utf8'));
      if (value?.version === 1 && value.fetched && typeof value.fetched === 'object') {
        for (const [id, entry] of Object.entries(value.fetched)) if (typeof entry?.key === 'string') this.#fetched.set(id, { key: entry.key, at: 0, turns: Number.isSafeInteger(entry.turns) ? entry.turns : 0 });
      }
    } catch { /* No state yet, or unreadable: fetch again. */ }
  }
  async #saveState(force = false) {
    const o = this.#options;
    if (!o.dataDir || !this.#stateDirty || (!force && o.clock() - this.#stateWrittenAt < 30000)) return;
    // Forget threads T3 no longer lists so the file stays bounded.
    if (this.lastSyncAt) for (const id of this.#fetched.keys()) if (!this.#threads.has(id)) this.#fetched.delete(id);
    // A thread whose usage the hub has not acknowledged is fetched again after a restart, so nothing is lost.
    const unsent = new Set([...this.#pendingUsage.values()].map(record => record.threadId));
    const fetched = Object.fromEntries([...this.#fetched].filter(([id]) => !unsent.has(id)).map(([id, entry]) => [id, { key: entry.key, turns: entry.turns }]));
    await writeTokenFile(resolve(o.dataDir, 't3-observer-state.json'), { version: 1, fetched });
    this.#stateDirty = false; this.#stateWrittenAt = o.clock();
  }
}

export function createT3Observer(options) { return new T3Observer(options); }
