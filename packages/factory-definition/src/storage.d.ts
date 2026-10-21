export type HarnessKind = 'codex' | 'claudeAgent' | 'cursor' | 'grok' | 'opencode' | 'antigravity' | 'pi' | 'muse' | 'acpRegistry';
export const HARNESS_KINDS: readonly HarnessKind[];
export interface Limits { maxNodes: number; maxEdges: number; maxDefinitionBytes: number; maxFactoriesPerProject: number; maxSubagents: number; maxConcurrent: number }
export const DEFAULT_LIMITS: Readonly<Limits>;
interface BaseNode { id: string; label: string; position?: { x: number; y: number } }
export type FactoryNode = BaseNode & (
  | { type: 'agent'; harness: HarnessKind; model?: string; allowSubagents: boolean; maxSubagents: number; maxConcurrent: number }
  | { type: 'context'; references: string[] }
  | { type: 'check'; command: string[] }
  | { type: 'merge-queue'; requireChecks: boolean; requireReview: boolean; maxConcurrent: 1 }
);
export interface FactoryEdge { id: string; type: 'delegates-to' | 'workflow' | 'context'; source: string; target: string }
export interface Definition { name: string; nodes: FactoryNode[]; edges: FactoryEdge[] }
export interface Factory extends Definition { projectId: string; id: string; version: number; createdAt: string; updatedAt: string }
export class FactoryError extends Error { code: string; constructor(code: string, message: string) }
export function validateDefinition(input: unknown, limits?: Partial<Limits>): Definition;
export class FactoryStore {
  constructor(filename: string, options?: { limits?: Partial<Limits>; busyTimeoutMs?: number });
  close(): void;
  create(input: Definition & { projectId: string; id: string }): Factory;
  update(input: Definition & { projectId: string; id: string; expectedVersion: number }): Factory;
  read(input: { projectId: string; id: string; version?: number }): Factory;
  list(input: { projectId: string }): Factory[];
}
