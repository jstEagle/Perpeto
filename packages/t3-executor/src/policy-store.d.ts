export type CreationKind = "delegated_task" | "thread" | "provider_native";
export interface AgentPolicy {
  threadId: string;
  maxSubagents: number;
  allowedSubagentProviders: string[];
  used: number;
  createdAt: string;
}
export interface AuthorizeInput {
  requestKey: string;
  callerThreadId: string;
  rootThreadId?: string | null;
  kind: CreationKind;
  providerInstanceId?: string | null;
  driver?: string | null;
  model?: string | null;
  childRef?: string | null;
}
export type Decision =
  | { allowed: true; governed: false }
  | { allowed: true; governed: true; retry: boolean; policyThreadId: string; maxSubagents: number; used: number }
  | { allowed: false; governed: true; reason: string; policyThreadId: string; maxSubagents: number; used: number };
export interface DecisionRecord {
  seq: number;
  outcome: "created" | "refused";
  kind: CreationKind;
  callerThreadId: string;
  providerInstanceId: string | null;
  driver: string | null;
  model: string | null;
  childRef: string | null;
  reason: string | null;
  at: string;
}
export class AgentPolicyError extends Error {
  constructor(code: string, message: string);
  code: string;
}
export function normalizePolicy(input: unknown): { maxSubagents: number; allowedSubagentProviders: string[] };
export class AgentPolicyStore {
  constructor(filename: string, options?: { busyTimeoutMs?: number });
  close(): void;
  setPolicy(input: { threadId: string; maxSubagents: unknown; allowedSubagentProviders: unknown }): { policy: AgentPolicy; created: boolean };
  getPolicy(threadId: string): AgentPolicy | null;
  authorize(input: AuthorizeInput): Decision;
  recordCreated(input: { requestKey: string; callerThreadId: string; rootThreadId?: string | null; childThreadId?: string | null; childRef?: string | null }): boolean;
  release(input: { requestKey: string; callerThreadId: string; rootThreadId?: string | null }): boolean;
  decisions(input: { threadId: string; after?: number; limit?: number }): { decisions: DecisionRecord[]; nextCursor: number; hasMore: boolean };
}
