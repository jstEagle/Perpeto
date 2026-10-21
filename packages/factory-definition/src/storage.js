import { DatabaseSync } from 'node:sqlite';
import defaultLimits from '../config/limits.json' with { type: 'json' };

export const HARNESS_KINDS = Object.freeze(['codex', 'claudeAgent', 'cursor', 'grok', 'opencode', 'antigravity', 'pi', 'muse', 'acpRegistry']);
export const DEFAULT_LIMITS = Object.freeze(defaultLimits);
export class FactoryError extends Error {
  constructor(code, message) { super(message); this.name = 'FactoryError'; this.code = code; }
}
const fail = (message) => { throw new FactoryError('INVALID_INPUT', message); };
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
}
function keys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}: unknown field ${key}.`);
}
function string(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail(`${label} must be a nonblank string of at most ${max} characters without NUL.`);
  return value;
}
function identity(value, label) {
  string(value, label);
  if (value === '.' || value === '..' || /[/?#\\]/.test(value)) fail(`${label} must be a single path-safe identifier.`);
  return value;
}
function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} must be an integer between ${min} and ${max}.`);
}
function limitsWith(overrides = {}) {
  object(overrides, 'limits'); keys(overrides, Object.keys(DEFAULT_LIMITS), 'limits');
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) integer(value, key, 1, 10000000);
  return limits;
}

/** Validate configuration only. This does not start harnesses, read context files, or execute commands. */
export function validateDefinition(input, limitOverrides = {}) {
  const limits = limitsWith(limitOverrides);
  object(input, 'definition'); keys(input, ['name', 'nodes', 'edges'], 'definition'); string(input.name, 'name');
  if (!Array.isArray(input.nodes) || input.nodes.length > limits.maxNodes) fail(`nodes must be an array of at most ${limits.maxNodes} nodes.`);
  if (!Array.isArray(input.edges) || input.edges.length > limits.maxEdges) fail(`edges must be an array of at most ${limits.maxEdges} edges.`);
  const nodes = new Map();
  for (const node of input.nodes) {
    object(node, 'node'); identity(node.id, 'node.id'); string(node.label, 'node.label');
    if (nodes.has(node.id)) fail(`Duplicate node id: ${node.id}.`);
    const base = ['id', 'type', 'label', 'position'];
    if (node.position !== undefined) {
      object(node.position, 'position'); keys(node.position, ['x', 'y'], 'position');
      for (const axis of ['x', 'y']) if (!Number.isFinite(node.position[axis]) || Math.abs(node.position[axis]) > 1000000) fail('position coordinates must be finite numbers within 1000000.');
    }
    switch (node.type) {
      case 'agent':
        keys(node, [...base, 'harness', 'model', 'allowSubagents', 'maxSubagents', 'maxConcurrent'], 'agent');
        if (!HARNESS_KINDS.includes(node.harness)) fail('Unknown harness kind.');
        if (node.model !== undefined) string(node.model, 'model', 1000);
        if (typeof node.allowSubagents !== 'boolean') fail('allowSubagents must be boolean.');
        integer(node.maxSubagents, 'maxSubagents', 0, limits.maxSubagents);
        integer(node.maxConcurrent, 'maxConcurrent', 1, limits.maxConcurrent);
        if (!node.allowSubagents && node.maxSubagents !== 0) fail('Disabled subagents require maxSubagents = 0.');
        break;
      case 'context':
        keys(node, [...base, 'references'], 'context');
        if (!Array.isArray(node.references) || !node.references.length || node.references.length > 100) fail('references must contain 1 to 100 context references.');
        node.references.forEach((reference) => string(reference, 'context reference', 4096));
        break;
      case 'check':
        keys(node, [...base, 'command'], 'check');
        if (!Array.isArray(node.command) || !node.command.length || node.command.length > 100) fail('command must contain 1 to 100 argv strings.');
        node.command.forEach((arg) => { if (typeof arg !== 'string' || arg.includes('\0') || arg.length > 4096) fail('command arguments must be strings without NUL, at most 4096 characters.'); });
        string(node.command[0], 'command executable', 4096);
        break;
      case 'merge-queue':
        keys(node, [...base, 'requireChecks', 'requireReview', 'maxConcurrent'], 'merge-queue');
        if (typeof node.requireChecks !== 'boolean' || typeof node.requireReview !== 'boolean') fail('Merge queue requirements must be boolean.');
        if (node.maxConcurrent !== 1) fail('Merge queues must serialize changes with maxConcurrent = 1.');
        break;
      default: fail('Unknown node type.');
    }
    nodes.set(node.id, node);
  }
  const edgeIds = new Set(); const authority = new Map();
  for (const edge of input.edges) {
    object(edge, 'edge'); keys(edge, ['id', 'type', 'source', 'target'], 'edge'); identity(edge.id, 'edge.id');
    if (edgeIds.has(edge.id)) fail(`Duplicate edge id: ${edge.id}.`);
    edgeIds.add(edge.id);
    const source = nodes.get(edge.source); const target = nodes.get(edge.target);
    if (!source || !target) fail('Edge endpoints must reference existing nodes.');
    if (edge.type === 'delegates-to') {
      if (source.type !== 'agent' || target.type !== 'agent') fail('Delegation endpoints must both be agents.');
      const children = authority.get(edge.source) ?? []; children.push(edge.target); authority.set(edge.source, children);
    } else if (edge.type === 'context') {
      if (source.type !== 'context' || target.type === 'context') fail('Context edges must connect a context source to a non-context target.');
    } else if (edge.type !== 'workflow') fail('Unknown edge type.');
  }
  const visiting = new Set(); const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) fail('Delegation authority cannot contain a cycle.');
    if (visited.has(id)) return;
    visiting.add(id); for (const child of authority.get(id) ?? []) visit(child);
    visiting.delete(id); visited.add(id);
  }
  for (const id of nodes.keys()) visit(id);
  const encoded = JSON.stringify(input);
  if (Buffer.byteLength(encoded) > limits.maxDefinitionBytes) fail('Definition exceeds the configured size limit.');
  return JSON.parse(encoded);
}

/** Environment-owned SQLite definitions with immutable revisions and compare-and-swap editing. */
export class FactoryStore {
  #db; #limits;
  constructor(filename, { limits = {}, busyTimeoutMs = 5000 } = {}) {
    string(filename, 'filename', 4096); integer(busyTimeoutMs, 'busyTimeoutMs', 0, 60000); this.#limits = limitsWith(limits);
    this.#db = new DatabaseSync(filename);
    try {
      this.#db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = ${busyTimeoutMs};`);
      this.#db.exec('BEGIN IMMEDIATE');
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) throw new FactoryError('SCHEMA_VERSION', 'Unsupported factory schema version.');
      if (version === 0) this.#db.exec(`
        CREATE TABLE factories(project_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project_id,id)) STRICT;
        CREATE TABLE revisions(project_id TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,definition TEXT NOT NULL,created_at TEXT NOT NULL, PRIMARY KEY(project_id,id,version)) STRICT;
        PRAGMA user_version = 1;
      `);
      this.#db.exec('COMMIT');
    } catch (error) { try { this.#db.exec('ROLLBACK'); } catch {} this.#db.close(); throw error; }
  }
  close() { this.#db.close(); }
  #transaction(operation) {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  create({ projectId, id, ...definition }) {
    identity(projectId, 'projectId'); identity(id, 'factory id'); const validated = validateDefinition(definition, this.#limits);
    return this.#transaction(() => {
      if (this.#db.prepare('SELECT 1 FROM factories WHERE project_id=? AND id=?').get(projectId, id)) throw new FactoryError('CONFLICT', 'Factory already exists.');
      if (this.#db.prepare('SELECT count(*) AS count FROM factories WHERE project_id=?').get(projectId).count >= this.#limits.maxFactoriesPerProject) throw new FactoryError('LIMIT_EXCEEDED', 'Project factory limit reached.');
      const now = new Date().toISOString();
      this.#db.prepare('INSERT INTO factories VALUES (?,?,1,?,?)').run(projectId, id, now, now);
      this.#db.prepare('INSERT INTO revisions VALUES (?,?,1,?,?)').run(projectId, id, JSON.stringify(validated), now);
      return this.read({ projectId, id });
    });
  }
  update({ projectId, id, expectedVersion, ...definition }) {
    identity(projectId, 'projectId'); identity(id, 'factory id'); integer(expectedVersion, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER - 1);
    const validated = validateDefinition(definition, this.#limits);
    return this.#transaction(() => {
      const current = this.read({ projectId, id });
      if (current.version !== expectedVersion) throw new FactoryError('CONFLICT', `Factory changed; reload version ${current.version} before saving.`);
      const now = new Date().toISOString();
      this.#db.prepare('UPDATE factories SET version=version+1,updated_at=? WHERE project_id=? AND id=? AND version=?').run(now, projectId, id, expectedVersion);
      this.#db.prepare('INSERT INTO revisions VALUES (?,?,?,?,?)').run(projectId, id, expectedVersion + 1, JSON.stringify(validated), now);
      return this.read({ projectId, id });
    });
  }
  read({ projectId, id, version }) {
    identity(projectId, 'projectId'); identity(id, 'factory id');
    if (version !== undefined) integer(version, 'version', 1, Number.MAX_SAFE_INTEGER);
    const row = this.#db.prepare(`SELECT f.project_id,f.id,r.version,r.definition,f.created_at,r.created_at AS updated_at FROM factories f JOIN revisions r ON r.project_id=f.project_id AND r.id=f.id AND r.version=COALESCE(?,f.version) WHERE f.project_id=? AND f.id=?`).get(version ?? null, projectId, id);
    if (!row) throw new FactoryError('NOT_FOUND', 'Factory or revision not found.');
    return { projectId: row.project_id, id: row.id, ...JSON.parse(row.definition), version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  list({ projectId }) {
    identity(projectId, 'projectId');
    return this.#db.prepare('SELECT id FROM factories WHERE project_id=? ORDER BY id').all(projectId).map(({ id }) => this.read({ projectId, id }));
  }
}
