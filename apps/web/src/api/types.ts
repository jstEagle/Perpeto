/**
 * Hub API v1 entities as apps/hub serves them (docs/architecture/README.md
 * plus the apps/hub README). Where the screens use a different shape than the
 * wire (validation issues, graph diffs, version status), client.ts converts.
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

/**
 * A project goal with progress over the leaf work items linked to it.
 * Older hubs stored goals as plain strings; `decodeGoals` reads those as
 * active goals with no linked items and marks them `legacy`.
 */
export interface Goal {
  id: string;
  title: string;
  status: 'active' | 'done' | 'dropped';
  workItemIds: Id[];
  done: number;
  total: number;
  /** Read from a plain string; save such goals back as strings. */
  legacy?: true;
}

/** Goals as the hub accepts them: a string for a new goal, or an existing one by id. */
export type GoalInput = string | { id?: string; title: string; status?: Goal['status'] };

/** The person the owner token acts for (GET /owner, /session, /overview). */
export interface Owner {
  name: string | null;
  initials: string | null;
}

export interface Project {
  id: Id;
  name: string;
  repo: { url: string; defaultBranch: string; localPath?: string };
  docs: DocRef[];
  goals: Goal[];
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
  /** On the workflow head: the version new runs use. */
  activeVersion?: number;
  /** Demo data only; hub version records carry no timestamp. */
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

/** Ids added, removed or changed between two versions (client.ts converts the hub's diff). */
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

/** POST /workflows/:id/validate, with the hub's errors and warnings merged into one list. */
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
  /** Set while the item waits at a human gate; names that one wait. */
  decisionId?: string;
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
  verdict?: 'pass' | 'fail';
}

export type AssignmentStatus = 'queued' | 'leased' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Assignment {
  id: Id;
  projectId?: Id;
  /** Absent on workflow-architect assignments, which belong to a project before any run. */
  runId?: Id;
  workItemId?: Id;
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
  /** Workflow architect: the draft this attempt produced. */
  draftWorkflowId?: Id;
  draftVersion?: number;
  /** Workflow architect: validation errors and the follow-up attempt. */
  architectErrors?: (string | { code?: string; message: string })[];
  retryAssignmentId?: Id;
  architectAttempt?: number;
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
  runId?: Id;
  workItemId?: Id;
  prUrl: string;
  headSha: string;
  baseBranch: string;
  status: MergeStatus;
  jobId?: Id;
  reason?: string;
  deliveryError?: string;
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

/** GET /usage?groupBy=…, whose `groups` the client exposes as rows. */
export interface UsageSummary {
  groupBy: UsageGroupBy;
  rows: UsageRow[];
}

/** GET /overview. */
export interface Overview {
  activeAgents: number;
  queuedWork: number;
  tokensToday: number;
  machinesOnline: number;
  machinesTotal?: number;
  /** Hubs from 3af3db0 on. */
  owner?: Owner;
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
  status: string;
  version: string;
}

export interface EnrollmentCode {
  id?: Id;
  code: string;
  expiresAt?: IsoTime;
}

/* Messaging, served under /api/v1/messaging (packages/messaging). */

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
  goals?: GoalInput[];
}

export interface NewWorkflow {
  name: string;
  purpose: WorkflowPurpose;
  graph: WorkflowGraph;
}

/** One item for POST /runs/:id/inputs, sent as `{ items: [input] }`. */
export interface RunInput {
  title: string;
  body?: string;
}

/** The client sends approve as the engine's `pass` and return as `fail`. */
export interface HumanDecision {
  decision: 'approve' | 'return';
  note?: string;
  /** The wait being answered. The hub refuses it with 409 STALE_DECISION once the item waits for another decision. */
  decisionId?: string;
}

/* Observing runs (docs/architecture/README.md "Observing runs"). */

export type MetricsWindow = '1h' | '24h' | '7d';

export interface NodeMetrics {
  nodeId: string;
  queued: number;
  active: number;
  done: number;
  failed: number;
  errors?: number;
  retries?: number;
  escalations?: number;
  /** Null for nodes without a concurrency limit (input, loop, output, CI). */
  concurrency: number | null;
  /** active ÷ concurrency */
  utilization: number | null;
  waitSec: Stat;
  serviceSec: Stat;
  throughputPerHour: number;
  failureRate: number | null;
  tokens: number;
}

/** Null when nothing in the window was measured. */
export interface Stat {
  avg: number | null;
  p90: number | null;
}

export interface EdgeMetrics {
  edgeId: string;
  kind: EdgeKind;
  count: number;
  unplanned: boolean;
}

export interface RunMetrics {
  velocity: { itemsDonePerDay: number; trend: number[] };
  cycleTimeSec: Stat;
  wip: number;
  tokensPerItem: number | null;
  retries?: number;
  escalations?: number;
  waitingOnHuman?: number;
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
 * GET /runs/:id/metrics and /projects/:id/metrics. Unplanned edges are named
 * `unplanned:<kind>:<from>-><to>` and carry their endpoints in `from`/`to`,
 * which may be node or role ids. `window` is the one the client asked for.
 */
export interface MetricsSnapshot {
  window: MetricsWindow;
  at?: IsoTime;
  nodes: NodeMetrics[];
  edges: (EdgeMetrics & { from?: string | null; to?: string | null })[];
  run: RunMetrics;
  bottlenecks: Bottleneck[];
}

/** Interaction event types reported by executors and messaging. */
export type InteractionType = 'workitem.moved' | 'agent.delegated' | 'agent.messaged' | 'assignment.state' | 'gate.result';

/**
 * Data on interaction events as the hub records them (apps/hub
 * src/observation.js): source and target nodes, the matched edge, and
 * `unplanned` when no edge of that kind connects them. `summary` is only set
 * by the demo; the feed writes its own sentence otherwise.
 */
export interface InteractionData {
  sourceNodeId?: string;
  targetNodeId?: string;
  nodeId?: string;
  kind?: EdgeKind;
  role?: string;
  attempt?: number;
  workItemId?: string;
  edgeId?: string;
  assignmentId?: string;
  jobId?: string;
  messageId?: string;
  senderRoleId?: string;
  recipientRoleId?: string;
  source?: 'review' | 'ci' | 'merge-queue' | 'human';
  decision?: string;
  machineId?: string;
  accountId?: string;
  state?: string;
  /** Gate outcome: pass/fail for reviews, a job status for CI and merges. */
  result?: string;
  unplanned?: boolean;
  summary?: string;
}
