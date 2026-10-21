/**
 * Hub API v1 entities, transcribed from docs/architecture.md.
 * Response envelopes the contract leaves open (overview, usage, list
 * wrappers) are marked "assumed" and normalised in client.ts.
 */

export type Id = string;
export type IsoTime = string;

export interface DocRef {
  id: Id;
  title: string;
  path?: string;
  url?: string;
  kind: 'requirements' | 'vision' | 'spec' | 'notes';
}

export interface Project {
  id: Id;
  name: string;
  repo: { url: string; defaultBranch: string; localPath?: string };
  docs: DocRef[];
  goals: string[];
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export type WorkflowPurpose = 'build' | 'improve' | 'maintain' | 'custom';
export type WorkflowStatus = 'draft' | 'active' | 'paused';

export interface Workflow {
  id: Id;
  projectId: Id;
  name: string;
  purpose: WorkflowPurpose;
  version: number;
  graph: WorkflowGraph;
  status: WorkflowStatus;
  authoredBy?: AuthoredBy;
  rationale?: string;
  parentVersion?: number;
  /** Assumed: when the version was saved. Not in the contract. */
  createdAt?: IsoTime;
}

export interface AuthoredBy {
  kind: 'agent' | 'user';
  assignmentId?: Id;
  prompt?: string;
}

/** POST /projects/:id/workflows/drafts body. */
export interface DraftRequest {
  prompt: string;
  baseWorkflowId?: Id;
}

/** Assumed shape of GET /workflows/:id/diff. The app also computes it locally. */
export interface GraphDiff {
  nodes: { added: string[]; removed: string[]; changed: string[] };
  edges: { added: string[]; removed: string[]; changed: string[] };
}

export type NodeType =
  | 'input'
  | 'planner'
  | 'agent'
  | 'review'
  | 'ci'
  | 'merge-queue'
  | 'loop'
  | 'human'
  | 'output';

export type EdgeKind = 'flow' | 'delegates' | 'messages';

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  from: { node: string; port?: string };
  to: { node: string; port?: string };
  kind: EdgeKind;
}

export interface WorkflowGraph {
  schema: 'perpeto.workflow/1';
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ValidationIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  nodeId?: string;
  edgeId?: string;
}

/** Assumed shape of POST /workflows/:id/validate. */
export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export type RunStatus = 'running' | 'paused' | 'stopped' | 'completed' | 'failed';

export interface Run {
  id: Id;
  projectId: Id;
  workflowId: Id;
  workflowVersion: number;
  status: RunStatus;
  startedAt: IsoTime;
  stoppedAt?: IsoTime;
}

export type WorkItemStatus = 'queued' | 'active' | 'blocked' | 'done' | 'failed';

export interface WorkItem {
  id: Id;
  runId: Id;
  title: string;
  body: string;
  nodeId: string;
  status: WorkItemStatus;
  branch?: string;
  prUrl?: string;
  headSha?: string;
  iteration: number;
  parentId?: Id;
}

export interface Harness {
  provider: string;
  model: string;
  options?: Record<string, string | boolean>;
}

export interface AgentPolicy {
  maxSubagents: number;
  allowedSubagentProviders: string[];
  maxTurns?: number;
  maxTokens?: number;
  canMessage: string[];
}

export interface MachineRequirements {
  os?: 'darwin' | 'linux' | 'windows';
  labels?: string[];
  providers?: string[];
}

export interface AssignmentResult {
  outcome: 'success' | 'failure' | 'blocked';
  summary: string;
  branch?: string;
  prUrl?: string;
  headSha?: string;
  threadRef?: string;
}

export type AssignmentStatus = 'queued' | 'leased' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Assignment {
  id: Id;
  runId: Id;
  workItemId: Id;
  nodeId: string;
  role: string;
  prompt: string;
  harness: Harness;
  policy: AgentPolicy;
  requirements: MachineRequirements;
  status: AssignmentStatus;
  machineId?: Id;
  leaseExpiresAt?: IsoTime;
  attempt: number;
  result?: AssignmentResult;
}

export interface JobStep {
  name: string;
  run: string;
  timeoutSec?: number;
}

export interface ArtifactRef {
  name: string;
  path?: string;
  url?: string;
}

export type JobStatus = 'queued' | 'leased' | 'running' | 'passed' | 'failed' | 'cancelled' | 'error';

export interface Job {
  id: Id;
  projectId: Id;
  runId?: Id;
  workItemId?: Id;
  repo: string;
  revision: string;
  steps: JobStep[];
  requirements: MachineRequirements;
  status: JobStatus;
  machineId?: Id;
  leaseExpiresAt?: IsoTime;
  attempt: number;
  logRef?: string;
  artifacts: ArtifactRef[];
  configHash: string;
}

export type MergeStatus = 'queued' | 'testing' | 'merging' | 'merged' | 'rejected';

export interface MergeEntry {
  id: Id;
  projectId: Id;
  prUrl: string;
  headSha: string;
  baseBranch: string;
  status: MergeStatus;
  jobId?: Id;
  reason?: string;
}

export type MachineStatus = 'online' | 'offline' | 'draining';

export interface Machine {
  id: Id;
  name: string;
  os: string;
  arch: string;
  labels: string[];
  providers: string[];
  capacity: { maxAgents: number; maxJobs: number };
  running: { agents: number; jobs: number };
  status: MachineStatus;
  lastHeartbeatAt: IsoTime;
  version: string;
}

export type AccountStatus = 'active' | 'cooling' | 'disabled' | 'invalid';

export interface Account {
  id: Id;
  machineId: Id;
  provider: string;
  label: string;
  status: AccountStatus;
  cooldownUntil?: IsoTime;
  lastUsedAt?: IsoTime;
}

export interface UsageRecord {
  id: Id;
  projectId: Id;
  runId?: Id;
  assignmentId?: Id;
  machineId: Id;
  accountId?: Id;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  at: IsoTime;
}

export type UsageGroupBy = 'provider' | 'model' | 'machine' | 'day';

export interface UsageRow {
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
}

/** Assumed shape of GET /usage?groupBy=… */
export interface UsageSummary {
  groupBy: UsageGroupBy;
  rows: UsageRow[];
}

/** Assumed shape of GET /overview. */
export interface Overview {
  activeAgents: number;
  queuedWork: number;
  tokensToday: number;
  machinesOnline: number;
  machinesTotal?: number;
}

export interface HubEvent {
  seq: number;
  at: IsoTime;
  type: string;
  projectId?: Id;
  runId?: Id;
  subject: { kind: string; id: string };
  data: Record<string, unknown>;
}

export interface EventPage {
  events: HubEvent[];
}

export interface Health {
  ok: boolean;
  version: string;
}

export interface EnrollmentCode {
  code: string;
  expiresAt?: IsoTime;
}

/* Messaging, served under /api/v1/messaging (packages/factory-core). */

export interface Channel {
  id: string;
  name: string;
}

export interface Message {
  id: string;
  projectId: string;
  channelId: string;
  senderRoleId: string;
  recipientRoleId: string | null;
  body: string;
  createdAt: IsoTime;
}

export interface MessagePage {
  messages: Message[];
  previousCursor: string;
  nextCursor: string;
  hasMore: boolean;
}

export interface NewProject {
  name: string;
  repo: { url: string; defaultBranch: string; localPath?: string };
  docs?: DocRef[];
  goals?: string[];
}

export interface NewWorkflow {
  name: string;
  purpose: WorkflowPurpose;
  graph: WorkflowGraph;
}

export interface RunInput {
  kind: 'idea' | 'input';
  title: string;
  body?: string;
}

export interface HumanDecision {
  decision: 'approve' | 'return';
  note?: string;
}

/* Observing runs (docs/architecture.md "Observing runs"). */

export type MetricsWindow = '1h' | '24h' | '7d';

export interface NodeMetrics {
  nodeId: string;
  queued: number;
  active: number;
  done: number;
  failed: number;
  concurrency: number;
  /** active ÷ concurrency */
  utilization: number;
  waitSec: { avg: number; p90: number };
  serviceSec: { avg: number; p90: number };
  throughputPerHour: number;
  failureRate: number;
  tokens: number;
}

export interface EdgeMetrics {
  edgeId: string;
  kind: EdgeKind;
  count: number;
  unplanned: boolean;
}

export interface RunMetrics {
  velocity: { itemsDonePerDay: number; trend: number[] };
  cycleTimeSec: { avg: number; p90: number };
  wip: number;
  tokensPerItem: number;
  activeAgents: number;
  machines: { machineId: Id; activeAgents: number; nodes: string[] }[];
}

export type BottleneckReason =
  | 'saturated'
  | 'queue-growing'
  | 'high-failure'
  | 'waiting-on-human'
  | 'no-capacity'
  | 'rework-loop';

export interface Bottleneck {
  nodeId: string;
  reason: BottleneckReason;
  evidence: string;
  severity: 'info' | 'warning' | 'critical';
}

/**
 * Assumed envelope of GET /runs/:id/metrics and /projects/:id/metrics. Edge
 * metrics with unplanned: true and no matching graph edge carry their
 * endpoints in `from`/`to` (assumed) so the map can draw them.
 */
export interface MetricsSnapshot {
  window: MetricsWindow;
  nodes: NodeMetrics[];
  edges: (EdgeMetrics & { from?: string; to?: string })[];
  run: RunMetrics;
  bottlenecks: Bottleneck[];
}

/** Interaction event types reported by executors and messaging. */
export type InteractionType = 'workitem.moved' | 'agent.delegated' | 'agent.messaged' | 'assignment.state' | 'gate.result';

/**
 * Assumed data carried by interaction events. The contract says events record
 * "the run and node roles they connect"; these names are the app's guess.
 */
export interface InteractionData {
  fromNode?: string;
  toNode?: string;
  nodeId?: string;
  edgeId?: string;
  workItemId?: string;
  assignmentId?: string;
  machineId?: string;
  accountId?: string;
  state?: string;
  result?: 'pass' | 'fail';
  unplanned?: boolean;
  summary?: string;
}
