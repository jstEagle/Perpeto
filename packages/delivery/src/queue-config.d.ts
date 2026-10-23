/** Types for the browser-safe merge queue configuration validator (queue-config.js). */

export type QueueStrategy = 'serial' | 'batch' | 'speculative';
export type MergeMethod = 'squash' | 'merge' | 'rebase';
export type Publication = 'fast-forward-push' | 'github-merge-queue';

export interface Lane {
  name: string;
  priority: number;
  labels: string[];
  branches: string[];
}

export type FreezeWindow =
  | { cron: string; durationMinutes: number; reason?: string }
  | { start: string; end: string; reason?: string };

export interface QueueConfig {
  name: string;
  branches: string[];
  strategy: QueueStrategy;
  maxBatchSize: number;
  depth: number;
  requiredChecks: string[];
  method: MergeMethod;
  publication: Publication;
  lanes: Lane[];
  defaultLane?: string;
  freeze: { windows: FreezeWindow[] };
  maxInFlight: number | null;
  flakyRetries: number;
  bisectOnBatchFailure: boolean;
  autoRebaseOnConflict: boolean;
  ejectAfterMinutes: number | null;
  requiredApprovals: number;
}

export interface MergeQueueConfig {
  version: number;
  queues: QueueConfig[];
}

export interface ConfigProblem {
  path: string;
  message: string;
}

export const CONFIG_VERSION: number;
export const REPO_CONFIG_PATH: string;
export const QUEUE_DEFAULTS: Readonly<Omit<QueueConfig, 'name' | 'branches' | 'defaultLane'>>;
export function normalizeMergeQueueConfig(input: unknown): { ok: boolean; errors: ConfigProblem[]; config: MergeQueueConfig };
export function assertMergeQueueConfig(input: unknown): MergeQueueConfig;
export function mergeQueueConfigs(hub: unknown, repo: unknown): { ok: boolean; errors: ConfigProblem[]; config: MergeQueueConfig; sources: Record<string, 'hub' | 'repo' | 'merged'> };
export function queueForBranch(config: MergeQueueConfig, branch: string): QueueConfig | null;
export function matchBranch(pattern: string, branch: string): boolean;
export function branchPattern(pattern: string): RegExp;
export function parseCron(expression: string): object | null;
export function freezeAt(input: { manual?: { reason?: string; at?: number }; windows?: FreezeWindow[] }, at?: number): { kind: 'manual' | 'window'; reason: string; since?: number; until?: number } | null;
export function queuePolicy(queue: QueueConfig): Record<string, unknown>;
export function normalizePolicy(policy: unknown): Record<string, unknown>;
export function laneFor(policy: { lanes?: Lane[]; defaultLane?: string } | undefined, entry?: { labels?: string[]; headBranch?: string }): Lane | null | undefined;
