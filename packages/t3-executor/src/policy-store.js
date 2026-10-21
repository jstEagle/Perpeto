import { DatabaseSync } from 'node:sqlite';

/**
 * Durable per-thread AgentPolicy state shared by the factory executor and the
 * inherited T3 server. The server consults it before an agent creates a child
 * task or thread; the executor sets it before the first turn and reads the
 * decision log to report `agent.delegated` interactions.
 *
 * A policy is attached to a root thread. Threads created under it are linked to
 * the same policy, so one budget covers the whole delegation tree.
 */
export class AgentPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentPolicyError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new AgentPolicyError(code, message); };
const KINDS = new Set(['delegated_task', 'thread', 'provider_native']);
const MAX_PROVIDERS = 64;

function string(value, label, max = 400) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    fail('INVALID_INPUT', `${label} must be a nonblank string of at most ${max} characters without NUL.`);
  }
  return value;
}
const optionalString = (value, label) => value === undefined || value === null ? null : string(value, label);

/** @param {unknown} input */
export function normalizePolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', 'Policy must be an object.');
  const { maxSubagents, allowedSubagentProviders, t3Tools = 'full' } = /** @type {Record<string, unknown>} */ (input);
  if (!Number.isSafeInteger(maxSubagents) || /** @type {number} */ (maxSubagents) < 0 || /** @type {number} */ (maxSubagents) > 10000) {
    fail('INVALID_INPUT', 'maxSubagents must be an integer between 0 and 10000.');
  }
  if (!Array.isArray(allowedSubagentProviders) || allowedSubagentProviders.length > MAX_PROVIDERS) {
    fail('INVALID_INPUT', `allowedSubagentProviders must be an array of at most ${MAX_PROVIDERS} provider names.`);
  }
  if (!['full', 'policy'].includes(t3Tools)) fail('INVALID_INPUT', 't3Tools must be full or policy.');
  const providers = [...new Set(allowedSubagentProviders.map(item => string(item, 'provider name', 100)))].sort();
  return { maxSubagents: /** @type {number} */ (maxSubagents), allowedSubagentProviders: providers, t3Tools };
}

export class AgentPolicyStore {
  #db;

  constructor(filename, { busyTimeoutMs = 5000 } = {}) {
    string(filename, 'filename', 4096);
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60000) {
      fail('INVALID_INPUT', 'busyTimeoutMs must be an integer between 0 and 60000.');
    }
    this.#db = new DatabaseSync(filename);
    try {
      this.#db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
      this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      this.#db.exec('BEGIN IMMEDIATE');
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      if (version > 2) fail('SCHEMA_VERSION', `Unsupported agent policy schema version ${version}.`);
      if (version === 0) this.#db.exec(`
        CREATE TABLE policies (
          thread_id TEXT PRIMARY KEY,
          max_subagents INTEGER NOT NULL,
          allowed_providers TEXT NOT NULL,
          used INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE links (
          thread_id TEXT PRIMARY KEY,
          policy_thread_id TEXT NOT NULL REFERENCES policies(thread_id)
        ) STRICT;
        CREATE TABLE grants (
          policy_thread_id TEXT NOT NULL REFERENCES policies(thread_id),
          request_key TEXT NOT NULL,
          kind TEXT NOT NULL,
          caller_thread_id TEXT NOT NULL,
          provider_instance_id TEXT,
          driver TEXT,
          model TEXT,
          child_ref TEXT,
          PRIMARY KEY (policy_thread_id, request_key)
        ) STRICT;
        CREATE TABLE decisions (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          policy_thread_id TEXT NOT NULL REFERENCES policies(thread_id),
          outcome TEXT NOT NULL,
          kind TEXT NOT NULL,
          caller_thread_id TEXT NOT NULL,
          provider_instance_id TEXT,
          driver TEXT,
          model TEXT,
          child_ref TEXT,
          reason TEXT,
          at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX decisions_policy ON decisions(policy_thread_id, seq);
        PRAGMA user_version = 1;
      `);
      if (version < 2) this.#db.exec("ALTER TABLE policies ADD COLUMN t3_tools TEXT NOT NULL DEFAULT 'full'; PRAGMA user_version = 2;");
      this.#db.exec('COMMIT');
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* No active transaction. */ }
      this.#db.close();
      throw error;
    }
  }

  close() { this.#db.close(); }

  #transaction(operation) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* Already rolled back. */ }
      throw error;
    }
  }

  #row(threadId) {
    return this.#db.prepare('SELECT * FROM policies WHERE thread_id = ?').get(threadId);
  }

  #present(row) {
    return {
      threadId: row.thread_id,
      maxSubagents: row.max_subagents,
      allowedSubagentProviders: JSON.parse(row.allowed_providers),
      t3Tools: row.t3_tools,
      used: row.used,
      createdAt: row.created_at,
    };
  }

  /** Policy row governing a thread: its own, or the one it was linked to. */
  #governing(threadId) {
    if (threadId === null || threadId === undefined) return undefined;
    const own = this.#row(threadId);
    if (own) return own;
    const link = this.#db.prepare('SELECT policy_thread_id FROM links WHERE thread_id = ?').get(threadId);
    return link ? this.#row(link.policy_thread_id) : undefined;
  }

  /**
   * Attach a policy to a root thread before it starts. Repeating the same
   * policy is a no-op; a different policy for the same thread is a conflict, so
   * a running agent's budget cannot be widened after the fact.
   */
  setPolicy({ threadId, ...input }) {
    string(threadId, 'threadId');
    const policy = normalizePolicy(input);
    return this.#transaction(() => {
      const existing = this.#row(threadId);
      if (existing) {
        const current = this.#present(existing);
        if (current.t3Tools !== policy.t3Tools || current.maxSubagents !== policy.maxSubagents ||
            JSON.stringify(current.allowedSubagentProviders) !== JSON.stringify(policy.allowedSubagentProviders)) {
          fail('CONFLICT', 'A different policy is already attached to this thread.');
        }
        return { policy: current, created: false };
      }
      if (this.#db.prepare('SELECT 1 FROM links WHERE thread_id = ?').get(threadId)) {
        fail('CONFLICT', 'This thread is already governed by its parent policy.');
      }
      this.#db.prepare('INSERT INTO policies(thread_id, max_subagents, allowed_providers, created_at, t3_tools) VALUES (?, ?, ?, ?, ?)')
        .run(threadId, policy.maxSubagents, JSON.stringify(policy.allowedSubagentProviders), new Date().toISOString(), policy.t3Tools);
      return { policy: this.#present(this.#row(threadId)), created: true };
    });
  }

  /** @returns policy governing the thread, or null when the thread is unrestricted. */
  getPolicy(threadId, rootThreadId = null) {
    string(threadId, 'threadId');
    const row = this.#governing(threadId) ?? this.#governing(rootThreadId);
    return row ? this.#present(row) : null;
  }

  /**
   * Decide whether `callerThreadId` may create a subagent or thread. Threads
   * without a policy (and not descended from one) are unrestricted, matching
   * upstream behavior. An accepted request reserves one unit of budget under
   * `requestKey`; a retry with the same key returns the original grant.
   */
  authorize({ requestKey, callerThreadId, rootThreadId = null, kind, providerInstanceId = null, driver = null, model = null, childRef = null }) {
    string(requestKey, 'requestKey'); string(callerThreadId, 'callerThreadId');
    if (!KINDS.has(kind)) fail('INVALID_INPUT', 'kind must be delegated_task, thread or provider_native.');
    providerInstanceId = optionalString(providerInstanceId, 'providerInstanceId');
    driver = optionalString(driver, 'driver'); model = optionalString(model, 'model'); childRef = optionalString(childRef, 'childRef');
    return this.#transaction(() => {
      const row = this.#governing(callerThreadId) ?? this.#governing(rootThreadId);
      if (!row) return { allowed: true, governed: false };
      const policy = this.#present(row);
      const grant = this.#db.prepare('SELECT 1 FROM grants WHERE policy_thread_id = ? AND request_key = ?').get(row.thread_id, requestKey);
      const base = { governed: true, policyThreadId: row.thread_id, maxSubagents: policy.maxSubagents };
      if (grant) return { ...base, allowed: true, retry: true, used: policy.used };
      const names = [providerInstanceId, driver].filter(Boolean);
      let reason = null;
      if (!names.some(name => policy.allowedSubagentProviders.includes(name))) {
        reason = `Provider ${driver ?? providerInstanceId ?? 'unknown'} is not in this agent's allowed subagent providers (${policy.allowedSubagentProviders.join(', ') || 'none'}).`;
      } else if (policy.used >= policy.maxSubagents) {
        reason = `This agent's policy allows at most ${policy.maxSubagents} subagents (${policy.used} used).`;
      }
      const at = new Date().toISOString();
      if (reason) {
        this.#db.prepare(`INSERT INTO decisions(policy_thread_id, outcome, kind, caller_thread_id, provider_instance_id, driver, model, child_ref, reason, at)
          VALUES (?, 'refused', ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.thread_id, kind, callerThreadId, providerInstanceId, driver, model, childRef, reason, at);
        return { ...base, allowed: false, reason, used: policy.used };
      }
      this.#db.prepare('UPDATE policies SET used = used + 1 WHERE thread_id = ?').run(row.thread_id);
      this.#db.prepare(`INSERT INTO grants(policy_thread_id, request_key, kind, caller_thread_id, provider_instance_id, driver, model, child_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(row.thread_id, requestKey, kind, callerThreadId, providerInstanceId, driver, model, childRef);
      if (childRef) this.#recordCreated(row.thread_id, requestKey, childRef, at);
      return { ...base, allowed: true, retry: false, used: policy.used + 1 };
    });
  }

  #recordCreated(policyThreadId, requestKey, childRef, at) {
    const grant = this.#db.prepare('SELECT * FROM grants WHERE policy_thread_id = ? AND request_key = ?').get(policyThreadId, requestKey);
    if (!grant) return false;
    this.#db.prepare('UPDATE grants SET child_ref = ? WHERE policy_thread_id = ? AND request_key = ?').run(childRef, policyThreadId, requestKey);
    this.#db.prepare(`INSERT INTO decisions(policy_thread_id, outcome, kind, caller_thread_id, provider_instance_id, driver, model, child_ref, reason, at)
      VALUES (?, 'created', ?, ?, ?, ?, ?, ?, NULL, ?)`).run(policyThreadId, grant.kind, grant.caller_thread_id, grant.provider_instance_id, grant.driver, grant.model, childRef, at);
    return true;
  }

  /**
   * Record the child created under an accepted grant. A child thread is linked
   * to the same policy so its own delegations draw from the shared budget.
   */
  recordCreated({ requestKey, callerThreadId, rootThreadId = null, childThreadId = null, childRef = childThreadId }) {
    string(requestKey, 'requestKey'); string(callerThreadId, 'callerThreadId');
    childThreadId = optionalString(childThreadId, 'childThreadId'); childRef = optionalString(childRef, 'childRef');
    return this.#transaction(() => {
      const row = this.#governing(callerThreadId) ?? this.#governing(rootThreadId);
      if (!row) return false;
      const existing = this.#db.prepare('SELECT child_ref FROM grants WHERE policy_thread_id = ? AND request_key = ?').get(row.thread_id, requestKey);
      if (!existing || existing.child_ref !== null) return false;
      if (childThreadId && !this.#db.prepare('SELECT 1 FROM policies WHERE thread_id = ?').get(childThreadId)) {
        this.#db.prepare('INSERT INTO links(thread_id, policy_thread_id) VALUES (?, ?) ON CONFLICT(thread_id) DO NOTHING').run(childThreadId, row.thread_id);
      }
      return this.#recordCreated(row.thread_id, requestKey, childRef ?? requestKey, new Date().toISOString());
    });
  }

  /** Return a reservation whose creation failed, so the budget is not lost. */
  release({ requestKey, callerThreadId, rootThreadId = null }) {
    string(requestKey, 'requestKey'); string(callerThreadId, 'callerThreadId');
    return this.#transaction(() => {
      const row = this.#governing(callerThreadId) ?? this.#governing(rootThreadId);
      if (!row) return false;
      const removed = this.#db.prepare('DELETE FROM grants WHERE policy_thread_id = ? AND request_key = ? AND child_ref IS NULL').run(row.thread_id, requestKey);
      if (removed.changes === 0) return false;
      this.#db.prepare('UPDATE policies SET used = MAX(used - 1, 0) WHERE thread_id = ?').run(row.thread_id);
      return true;
    });
  }

  /** Append-only decision log for a policy thread, ascending by sequence. */
  decisions({ threadId, after = 0, limit = 100 }) {
    string(threadId, 'threadId');
    if (!Number.isSafeInteger(after) || after < 0) fail('INVALID_INPUT', 'after must be a non-negative integer.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('INVALID_INPUT', 'limit must be between 1 and 500.');
    const row = this.#governing(threadId);
    if (!row) fail('NOT_FOUND', 'No policy governs this thread.');
    const rows = this.#db.prepare('SELECT * FROM decisions WHERE policy_thread_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(row.thread_id, after, limit + 1);
    const page = rows.slice(0, limit).map(item => ({
      seq: item.seq, outcome: item.outcome, kind: item.kind, callerThreadId: item.caller_thread_id,
      providerInstanceId: item.provider_instance_id, driver: item.driver, model: item.model,
      childRef: item.child_ref, reason: item.reason, at: item.at,
    }));
    return { decisions: page, nextCursor: page.at(-1)?.seq ?? after, hasMore: rows.length > limit };
  }
}
