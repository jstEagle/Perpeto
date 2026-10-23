/**
 * Retention policy. One JSON shape for the hub (`storage.policy`, with `storage.machines[<id or name>]` overrides) and for
 * a node's own `storage` section, which wins on that machine. Every field is optional; missing fields keep the defaults.
 */

export const DEFAULT_ARTIFACT_NAMES = Object.freeze(['node_modules', 'dist', 'build', '.next', '.nuxt', 'target', 'DerivedData', '.build', '.turbo', '.cache', '.parcel-cache', '.vite', '.svelte-kit']);

export const POLICY_DEFAULTS = Object.freeze({
  enabled: true,
  /** How often a node inventories its storage. */
  scanIntervalMs: 15 * 60_000,
  /** Clean policy-safe items without waiting for an owner request. */
  autoClean: true,
  /** Perpeto assignment and CI workspaces, and factory worktrees, are deleted this long after their work finished. */
  finishedWorkspaceTtlHours: 24,
  /** Build artifacts are stripped from worktrees idle this long. */
  idleArtifactTtlHours: 72,
  /** T3 or other non-Perpeto worktrees are only inventoried unless this is true; even then only merged, clean, pushed ones go. */
  cleanupForeignWorktrees: false,
  /** Foreign worktrees must also be idle this long before deletion. */
  foreignWorktreeIdleHours: 168,
  /** Strip git-ignored build artifacts from idle foreign worktrees (never touches tracked or unignored files). */
  stripForeignArtifacts: false,
  /** Below this free percentage the node is `low`: shorter retention (aggressive mode). */
  lowFreePercent: 15,
  /** Below this free percentage the node is `critical`: it stops leasing new agent work and the hub raises an alert. */
  criticalFreePercent: 5,
  /** Retention used while `low` or `critical`. */
  aggressive: Object.freeze({ finishedWorkspaceTtlHours: 2, idleArtifactTtlHours: 12 }),
  /** Dev servers running longer than this, or from a deleted directory, are reported (never killed). */
  staleProcessHours: 24,
  /** Worktree folders of the operator's own T3 (`<root>/<repo>/<branch>`). `~/` expands to the home directory. */
  foreignWorktreeRoots: Object.freeze(['~/.t3/worktrees']),
  /** Extra Perpeto-owned worktree roots beyond the managed runtime's (`<root>/<repo>/<branch>`). */
  perpetoWorktreeRoots: Object.freeze([]),
  artifactNames: DEFAULT_ARTIFACT_NAMES,
  /** Report well-known global caches (npm, Xcode DerivedData, unavailable simulators) as advisory items. */
  globalCaches: true,
  /** Scan bounds, so the janitor never becomes the thing hammering the disk. */
  maxDepth: 4,
  maxEntries: 400_000,
  scanTimeoutMs: 120_000,
  sizeCacheMs: 6 * 3_600_000,
  commandTimeoutMs: 10_000,
});

const NUMBER_FIELDS = {
  scanIntervalMs: [60_000, 7 * 86_400_000], finishedWorkspaceTtlHours: [0, 24 * 365], idleArtifactTtlHours: [0, 24 * 365],
  foreignWorktreeIdleHours: [0, 24 * 365], lowFreePercent: [0, 100], criticalFreePercent: [0, 100], staleProcessHours: [0, 24 * 365],
  maxDepth: [1, 12], maxEntries: [1000, 50_000_000], scanTimeoutMs: [1000, 3_600_000], sizeCacheMs: [0, 7 * 86_400_000], commandTimeoutMs: [100, 120_000],
};
const BOOLEAN_FIELDS = ['enabled', 'autoClean', 'cleanupForeignWorktrees', 'stripForeignArtifacts', 'globalCaches'];
const LIST_FIELDS = ['foreignWorktreeRoots', 'perpetoWorktreeRoots', 'artifactNames'];
export const POLICY_KEYS = Object.freeze(Object.keys(POLICY_DEFAULTS));

export class PolicyError extends Error {
  constructor(message) { super(message); this.code = 'INVALID_POLICY'; }
}
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Validate a partial policy and return a copy. Throws PolicyError naming the field. */
export function validatePolicy(value, label = 'storage policy') {
  if (value === undefined) return {};
  if (!isObject(value)) throw new PolicyError(`${label} must be an object.`);
  const result = {};
  for (const [key, field] of Object.entries(value)) {
    if (!POLICY_KEYS.includes(key)) throw new PolicyError(`Unknown ${label} field: ${key}.`);
    if (BOOLEAN_FIELDS.includes(key)) {
      if (typeof field !== 'boolean') throw new PolicyError(`${label}.${key} must be a boolean.`);
    } else if (NUMBER_FIELDS[key]) {
      const [min, max] = NUMBER_FIELDS[key];
      if (typeof field !== 'number' || !Number.isFinite(field) || field < min || field > max) throw new PolicyError(`${label}.${key} must be a number from ${min} to ${max}.`);
    } else if (LIST_FIELDS.includes(key)) {
      if (!Array.isArray(field) || field.length > 100 || field.some(item => typeof item !== 'string' || !item.trim() || item.includes('\0') || item.length > 4096)) throw new PolicyError(`${label}.${key} must be a list of non-empty strings.`);
      if (key === 'artifactNames' && field.some(item => /[/\\]/.test(item) || item === '.' || item === '..')) throw new PolicyError(`${label}.artifactNames are folder names, not paths.`);
      if (key !== 'artifactNames' && field.some(item => !item.startsWith('/') && !item.startsWith('~/'))) throw new PolicyError(`${label}.${key} must be absolute or start with ~/.`);
    } else if (key === 'aggressive') {
      if (!isObject(field) || Object.keys(field).some(name => !['finishedWorkspaceTtlHours', 'idleArtifactTtlHours'].includes(name))) throw new PolicyError(`${label}.aggressive accepts finishedWorkspaceTtlHours and idleArtifactTtlHours.`);
      for (const [name, hours] of Object.entries(field)) if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0 || hours > 24 * 365) throw new PolicyError(`${label}.aggressive.${name} must be hours.`);
    }
    result[key] = Array.isArray(field) ? [...field] : isObject(field) ? { ...field } : field;
  }
  return result;
}

/** Defaults, then each partial layer in order (hub policy, hub machine override, node's own config). */
export function mergePolicy(...layers) {
  const result = structuredClone({ ...POLICY_DEFAULTS, aggressive: { ...POLICY_DEFAULTS.aggressive }, foreignWorktreeRoots: [...POLICY_DEFAULTS.foreignWorktreeRoots],
    perpetoWorktreeRoots: [], artifactNames: [...POLICY_DEFAULTS.artifactNames] });
  for (const layer of layers) {
    const valid = validatePolicy(layer);
    for (const [key, value] of Object.entries(valid)) result[key] = key === 'aggressive' ? { ...result.aggressive, ...value } : value;
  }
  if (result.criticalFreePercent > result.lowFreePercent) throw new PolicyError('storage policy criticalFreePercent cannot exceed lowFreePercent.');
  return result;
}

/** Disk state from free space: `critical` stops new agent work, `low` switches to aggressive retention. */
export function diskState(disk, policy) {
  if (!disk || !(disk.totalBytes > 0)) return 'ok';
  const percent = (disk.freeBytes / disk.totalBytes) * 100;
  return percent < policy.criticalFreePercent ? 'critical' : percent < policy.lowFreePercent ? 'low' : 'ok';
}

/** Retention hours in effect for a disk state. */
export function retention(policy, state) {
  const aggressive = state === 'low' || state === 'critical';
  return {
    aggressive,
    finishedWorkspaceTtlHours: aggressive ? Math.min(policy.finishedWorkspaceTtlHours, policy.aggressive.finishedWorkspaceTtlHours ?? policy.finishedWorkspaceTtlHours) : policy.finishedWorkspaceTtlHours,
    idleArtifactTtlHours: aggressive ? Math.min(policy.idleArtifactTtlHours, policy.aggressive.idleArtifactTtlHours ?? policy.idleArtifactTtlHours) : policy.idleArtifactTtlHours,
  };
}
