import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertPrivate, fail, guarded, privateDirectory, readJson, writePrivate } from './private-files.js';
import { checkHome, providers, readImport, writeHome } from './imports.js';
import { detectProviderSignal, usageWindows } from './signals.js';

export { AccountPoolError } from './private-files.js';
export { detectProviderSignal, detectClaudeSignal, detectCodexSignal } from './signals.js';

/** @typedef {{id:string,machineId:string,provider:string,label:string,status:'active'|'cooling'|'disabled'|'invalid',cooldownUntil?:string,lastUsedAt?:string}} Account */
/** @typedef {{kind:'provider-home',homePath:string,accountConfigPath?:string}|{kind:'ccswap',storePath:string,slot:string|number}} ImportSource */
const identifier = (value, pattern = /^[a-zA-Z0-9_-]{1,128}$/) => {
  if (typeof value !== 'string' || !pattern.test(value)) fail('INVALID_INPUT');
  return value;
};
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

/** One synchronous transaction per operation, with a cross-process lock.
 * A busy/crashed lock fails closed; the node may retry ACCOUNT_POOL_BUSY.
 */
export class AccountPool {
  #root; #file; #lock; #machineId; #clock; #config;

  /** @param {{nodeDataDir:string,machineId:string,selection?:'lru'|'headroom',defaultCooldownMs?:number,maxConcurrentPerAccount?:number,maxReceipts?:number,receiptRetentionMs?:number,reservationLeaseMs?:number,clock?:()=>number}} options */
  constructor({ nodeDataDir, machineId, selection = 'lru', defaultCooldownMs = 300_000,
    maxConcurrentPerAccount = 1, maxReceipts = 512, receiptRetentionMs = 86_400_000,
    reservationLeaseMs = 300_000, clock = Date.now }) {
    guarded(() => {
      if (typeof nodeDataDir !== 'string' || !path.isAbsolute(nodeDataDir)) fail('INVALID_PATH');
      this.#machineId = identifier(machineId);
      if (!['lru', 'headroom'].includes(selection) || !Number.isSafeInteger(defaultCooldownMs)
          || defaultCooldownMs <= 0 || !Number.isSafeInteger(maxConcurrentPerAccount)
          || maxConcurrentPerAccount < 1 || !Number.isSafeInteger(maxReceipts) || maxReceipts < 1
          || maxReceipts > 1024 || !Number.isSafeInteger(receiptRetentionMs) || receiptRetentionMs < 1
          || !Number.isSafeInteger(reservationLeaseMs) || reservationLeaseMs < 1
          || typeof clock !== 'function') fail('INVALID_CONFIG');
      privateDirectory(nodeDataDir);
      this.#root = path.join(fs.realpathSync(nodeDataDir), 'accounts');
      privateDirectory(this.#root);
      for (const provider of providers) privateDirectory(path.join(this.#root, provider));
      this.#file = path.join(this.#root, 'registry.json');
      this.#lock = path.join(this.#root, '.lock');
      this.#clock = clock;
      this.#config = { selection, defaultCooldownMs, maxConcurrentPerAccount, maxReceipts, receiptRetentionMs, reservationLeaseMs };
      this.#locked(() => {
        if (fs.existsSync(this.#file)) {
          const state = this.#read();
          const now = this.#now();
          this.#compact(state, now);
          this.#expire(state, now);
          this.#write(state);
        }
        else this.#write({ version: 1, machineId, accounts: [], selectionSequence: 0, reservations: {}, receipts: {} });
      });
    });
  }

  #now() {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0
        || now + Math.max(this.#config.defaultCooldownMs, this.#config.reservationLeaseMs) >= 8.64e15) fail('INVALID_CLOCK');
    return now;
  }

  #locked(fn) {
    assertPrivate(this.#root, true);
    try { fs.mkdirSync(this.#lock, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') fail('ACCOUNT_POOL_BUSY'); throw error; }
    try { return fn(); } finally { fs.rmdirSync(this.#lock); }
  }

  #read() {
    assertPrivate(this.#root, true);
    // Allow bounded recovery of legacy registries already over the old 4 MiB cap.
    // Credential reads retain their independent, smaller limit.
    const state = readJson(this.#file, 64 * 1024 * 1024);
    if (state?.version !== 1 || state.machineId !== this.#machineId || !Array.isArray(state.accounts)
        || !state.reservations || !state.receipts) fail('INVALID_REGISTRY');
    return state;
  }
  #write(state) { writePrivate(this.#file, `${JSON.stringify(state)}\n`); }
  #expire(state, now) {
    for (const [assignmentId, value] of Object.entries(state.reservations)) {
      // Persist this migration on startup so reopening never extends a legacy lease.
      const reservation = typeof value === 'string'
        ? state.reservations[assignmentId] = this.#reservation(assignmentId, value, now) : value;
      if (!reservation || reservation.assignmentId !== assignmentId
          || !Number.isFinite(Date.parse(reservation.expiresAt))) fail('INVALID_REGISTRY');
      if (Date.parse(reservation.expiresAt) <= now) delete state.reservations[assignmentId];
    }
  }
  #reservation(assignmentId, accountId, now) {
    return { id: `res_${randomUUID().replaceAll('-', '')}`, assignmentId, accountId,
      expiresAt: new Date(now + this.#config.reservationLeaseMs).toISOString() };
  }
  #held(state, assignmentId, reservationId) {
    identifier(assignmentId);
    identifier(reservationId);
    const reservation = Object.hasOwn(state.reservations, assignmentId) ? state.reservations[assignmentId] : undefined;
    if (!reservation || reservation.id !== reservationId) fail('RESERVATION_ENDED');
    return reservation;
  }
  #compact(state, now) {
    const entries = Object.entries(state.receipts);
    let bytes = 0;
    const retained = [];
    for (const [key, receipt] of entries) {
      receipt.recordedAt ??= now;
      if (receipt.recordedAt + this.#config.receiptRetentionMs <= now) {
        delete state.receipts[key];
      } else {
        const size = Buffer.byteLength(JSON.stringify([key, receipt]));
        bytes += size;
        retained.push({ key, size });
      }
    }
    // Bound bytes as well as count, since selection receipts include bindings.
    for (const [index, { key, size }] of retained.entries()) {
      if (retained.length - index <= this.#config.maxReceipts && bytes <= 1024 * 1024) break;
      delete state.receipts[key];
      bytes -= size;
    }
  }
  #record(state, id) {
    identifier(id, /^acct_[a-zA-Z0-9_-]{1,48}$/);
    const record = state.accounts.find(account => account.id === id);
    if (!record) fail('ACCOUNT_NOT_FOUND');
    return record;
  }
  #home(record) {
    if (!providers.has(record.provider)) fail('INVALID_REGISTRY');
    identifier(record.id, /^acct_[a-zA-Z0-9_-]{1,48}$/);
    return path.join(this.#root, record.provider, record.id);
  }
  #status(record, now) {
    return record.disabled ? 'disabled' : record.invalid ? 'invalid'
      : Date.parse(record.cooldownUntil) > now ? 'cooling' : 'active';
  }
  #account(record, now) {
    const status = this.#status(record, now);
    return { id: record.id, machineId: this.#machineId, provider: record.provider, label: record.label, status,
      ...(Date.parse(record.cooldownUntil) > now ? { cooldownUntil: record.cooldownUntil } : {}),
      ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}) };
  }
  #usable(record, now) {
    if (this.#status(record, now) !== 'active') fail('ACCOUNT_UNAVAILABLE');
    checkHome(this.#root, this.#home(record), record.provider);
  }
  #binding(record) {
    const providerInstanceId = `factory_${record.id}`;
    const homePath = this.#home(record);
    const instance = { driver: record.provider, displayName: record.label, enabled: true,
      config: { homePath, ...(record.provider === 'codex' ? { setupMode: 'existing', shadowHomePath: '' } : {}) } };
    return { accountId: record.id, providerInstanceId, instance,
      mutation: { operation: 'upsert', instanceId: providerInstanceId, instance },
      // Diagnostic launch mapping only. Register config.homePath in T3; do not
      // mutate process.env or serialize this local descriptor into heartbeats.
      environment: { [record.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: homePath } };
  }
  #mutate(operation, input, idempotencyKey, fn, validateReplay) {
    return guarded(() => this.#locked(() => {
      identifier(idempotencyKey, /^[a-zA-Z0-9_.:-]{1,256}$/);
      const state = this.#read();
      const now = this.#now();
      this.#compact(state, now);
      this.#expire(state, now);
      const signature = createHash('sha256').update(canonical({ operation, input })).digest('hex');
      const receipt = Object.hasOwn(state.receipts, idempotencyKey) ? state.receipts[idempotencyKey] : undefined;
      if (receipt) {
        if (receipt.signature !== signature) fail('IDEMPOTENCY_CONFLICT');
        validateReplay?.(state, receipt.result);
        return structuredClone(receipt.result);
      }
      const result = fn(state, now);
      Object.defineProperty(state.receipts, idempotencyKey, { value: { signature, result, recordedAt: now }, enumerable: true, writable: true, configurable: true });
      this.#compact(state, now);
      this.#write(state);
      return structuredClone(result);
    }));
  }

  /** Copy a selected login into a fresh Perpeto home. No default-home discovery.
   * @param {{provider:'claudeAgent'|'codex',label:string,source:ImportSource,id?:string,idempotencyKey:string}} input */
  importAccount({ provider, label, source, id, idempotencyKey }) {
    return this.#mutate('import', { provider, label, source, id }, idempotencyKey, (state, now) => {
      if (typeof label !== 'string' || !label.trim() || label.length > 128) fail('INVALID_INPUT');
      const accountId = id ?? `acct_${randomUUID().replaceAll('-', '')}`;
      identifier(accountId, /^acct_[a-zA-Z0-9_-]{1,48}$/);
      if (state.accounts.some(account => account.id === accountId)) fail('ACCOUNT_EXISTS');
      const imported = readImport(provider, source);
      const record = { id: accountId, provider, label: label.trim(), disabled: imported.disabled, invalid: false, windows: {} };
      const home = this.#home(record);
      // A leftover home after a crash is never overwritten or reused silently.
      writeHome(home, provider, imported);
      state.accounts.push(record);
      return this.#account(record, now);
    });
  }

  /** Atomically reserve capacity before returning a local-only T3 binding. */
  select({ provider, assignmentId, idempotencyKey }) {
    const replay = (state, result) => {
      if (!result?.reservation) fail('RESERVATION_ENDED');
      this.#held(state, assignmentId, result.reservation.id);
      this.#usable(this.#record(state, result.account.id), this.#now());
    };
    return this.#mutate('select', { provider, assignmentId }, idempotencyKey, (state, now) => {
      if (!providers.has(provider)) fail('UNSUPPORTED_PROVIDER');
      identifier(assignmentId);
      const reserved = Object.hasOwn(state.reservations, assignmentId) ? state.reservations[assignmentId] : undefined;
      let record;
      if (reserved) {
        record = this.#record(state, reserved.accountId);
        if (record.provider !== provider) fail('ASSIGNMENT_CONFLICT');
      } else {
        const counts = Object.values(state.reservations).map(reservation => reservation.accountId);
        const headroom = account => Math.min(100, ...Object.values(account.windows).map(window =>
          window.resetsAt && Date.parse(window.resetsAt) <= now ? 100 : 100 - window.usedPercent));
        record = state.accounts.filter(account => account.provider === provider
          && this.#status(account, now) === 'active'
          && counts.filter(id => id === account.id).length < this.#config.maxConcurrentPerAccount)
          .sort((a, b) => (this.#config.selection === 'headroom' ? headroom(b) - headroom(a) : 0)
            || (a.lastUsedOrder ?? 0) - (b.lastUsedOrder ?? 0) || a.id.localeCompare(b.id))[0];
      }
      if (!record) fail(state.accounts.some(account => account.provider === provider)
        ? 'ACCOUNT_POOL_EXHAUSTED' : 'NO_ELIGIBLE_ACCOUNT');
      this.#usable(record, now);
      const reservation = reserved ?? this.#reservation(assignmentId, record.id, now);
      Object.defineProperty(state.reservations, assignmentId, { value: reservation, enumerable: true, writable: true, configurable: true });
      record.lastUsedAt = new Date(now).toISOString();
      record.lastUsedOrder = ++state.selectionSequence;
      return { account: this.#account(record, now), binding: this.#binding(record), reservation };
    }, replay);
  }

  release({ assignmentId, reservationId, idempotencyKey }) {
    return this.#mutate('release', { assignmentId, reservationId }, idempotencyKey, state => {
      identifier(assignmentId);
      if (reservationId !== undefined) this.#held(state, assignmentId, reservationId);
      const released = Object.hasOwn(state.reservations, assignmentId);
      delete state.reservations[assignmentId];
      return { released };
    });
  }

  /** Local-only lease metadata, for reconciliation against durable assignment attempts. */
  reservations() {
    return guarded(() => this.#locked(() => {
      const state = this.#read();
      this.#expire(state, this.#now());
      this.#compact(state, this.#now());
      this.#write(state);
      return structuredClone(Object.values(state.reservations));
    }));
  }

  renewReservation({ assignmentId, reservationId, idempotencyKey }) {
    const replay = state => { this.#held(state, assignmentId, reservationId); };
    return this.#mutate('renew', { assignmentId, reservationId }, idempotencyKey, (state, now) => {
      const reservation = this.#held(state, assignmentId, reservationId);
      reservation.expiresAt = new Date(now + this.#config.reservationLeaseMs).toISOString();
      return { ...reservation };
    }, replay);
  }

  /** Only call after establishing which local attempts still own their live leases. */
  reconcileReservations({ activeReservationIds, idempotencyKey }) {
    return this.#mutate('reconcile', { activeReservationIds }, idempotencyKey, state => {
      if (!Array.isArray(activeReservationIds)) fail('INVALID_INPUT');
      for (const id of activeReservationIds) identifier(id);
      const active = new Set(activeReservationIds);
      const released = [];
      for (const [assignmentId, reservation] of Object.entries(state.reservations)) {
        if (active.has(reservation.id)) continue;
        delete state.reservations[assignmentId];
        released.push(reservation.id);
      }
      return { released, reservations: Object.values(state.reservations) };
    });
  }

  disable(input) { return this.#update('disable', input, record => { record.disabled = true; }); }
  enable(input) { return this.#update('enable', input, record => { record.disabled = false; }); }
  /** Call only after account-specific reauthentication has been confirmed externally. */
  markAuthenticated(input) {
    return this.#update('authenticated', input, record => {
      checkHome(this.#root, this.#home(record), record.provider);
      record.invalid = false;
    });
  }
  #update(operation, { accountId, idempotencyKey }, fn) {
    return this.#mutate(operation, { accountId }, idempotencyKey, (state, now) => {
      const record = this.#record(state, accountId);
      fn(record);
      return this.#account(record, now);
    });
  }

  /** Raw error/usage messages are reduced before hashing/persistence. */
  observe({ accountId, message, idempotencyKey }) {
    return guarded(() => {
      // Identify the provider without retaining any content from the message.
      const record = this.#read().accounts.find(account => account.id === accountId);
      if (!record) fail('ACCOUNT_NOT_FOUND');
      const windows = usageWindows(record.provider, message);
      const messageDigest = createHash('sha256').update(canonical(message) ?? 'null').digest('hex');
      return this.#mutate('observe', { accountId, messageDigest }, idempotencyKey, (state, now) => {
        const current = this.#record(state, accountId);
        for (const window of windows) Object.defineProperty(current.windows, window.id,
          { value: window, enumerable: true, writable: true, configurable: true });
        const mergedSignal = detectProviderSignal(current.provider, message,
          { now, windows: Object.values(current.windows), defaultCooldownMs: this.#config.defaultCooldownMs });
        if (mergedSignal?.kind === 'auth-failure') current.invalid = true;
        if (mergedSignal?.kind === 'rate-limit') {
          const fallback = now + this.#config.defaultCooldownMs;
          const reset = Date.parse(mergedSignal.cooldownUntil);
          const until = Number.isFinite(reset) && reset > now ? reset : fallback;
          current.cooldownUntil = new Date(Math.max(until, Date.parse(current.cooldownUntil) || 0)).toISOString();
        }
        return this.#account(current, now);
      });
    });
  }

  /** Account[] heartbeat allowlist. No home paths, source data, windows or credentials. */
  snapshot() {
    return guarded(() => { const now = this.#now(); return this.#read().accounts.map(record => this.#account(record, now)); });
  }

  /** Recheck eligibility immediately before launching a new thread. Local only. */
  bindingFor(accountId, { reservationId } = {}) {
    return guarded(() => this.#locked(() => {
      const state = this.#read();
      this.#expire(state, this.#now());
      if (reservationId !== undefined && !Object.values(state.reservations)
        .some(reservation => reservation.id === reservationId && reservation.accountId === accountId)) fail('RESERVATION_ENDED');
      const record = this.#record(state, accountId);
      this.#usable(record, this.#now());
      return this.#binding(record);
    }));
  }
}

export function createAccountPool(options) { return new AccountPool(options); }
