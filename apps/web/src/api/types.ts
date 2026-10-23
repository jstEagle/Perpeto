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

export type WorkflowPurpose = 'build' | 'improve' | 'maintain' | 'custom' | 'bugfix' | 'docs' | 'security-audit' | 'dependency-upgrade';
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
  /** The library template the architect started from. */
  templateId?: string;
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
  /** Any terminal end. */
  stoppedAt?: IsoTime;
  /** Successful completion only. */
  completedAt?: IsoTime;
  /** Waits for new input instead of completing when the work is done. */
  keepOpen?: boolean;
  source?: RunSource;
  /** Five numeric UTC cron fields. */
  schedule?: string;
  budget?: RunBudget;
  /** Run detail and /overview.runs only. */
  intake?: RunIntake;
  budgetUsage?: BudgetUsage;
}

export type RunSource = 'goals' | 'schedule' | 'manual';

/** Daily intake limits. These pause new work; work already admitted continues. */
export interface RunBudget {
  maxTokensPerDay?: number;
  maxItemsPerDay?: number;
  maxActiveItems?: number;
}

export type BudgetLimit = keyof RunBudget;

export interface RunIntake {
  /** True after `budget.exhausted`, until `budget.available`. Separate from the run's own pause. */
  paused: boolean;
  reason?: { limit: BudgetLimit; used: number; maximum: number; requested?: number; day: string };
}

/** Today's use, in UTC days. Tokens are input plus output. */
export interface BudgetUsage {
  day: string;
  tokens: number;
  items: number;
}

/** PATCH /runs/:id, and the settings a run starts with. `budget: {}` removes every limit. */
export interface RunSettings {
  keepOpen?: boolean;
  source?: RunSource;
  schedule?: string;
  budget?: RunBudget;
}

/** GET /workflow-templates. */
export interface WorkflowTemplate {
  id: string;
  description: string;
  graph: WorkflowGraph;
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
  templateId?: string;
  additionalWorkflows?: { name: string; rationale: string; templateId?: string }[];
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
  /** Workflow architect: every draft saved, the primary first, then its additional proposals. */
  drafts?: { workflowId: Id; version: number }[];
  /** Workflow architect: validation errors and the follow-up attempt. */
  architectErrors?: (string | { code?: string; message: string })[];
  retryAssignmentId?: Id;
  architectAttempt?: number;
  placement?: PlacementDecision;
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
  placement?: PlacementDecision;
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
  /** Queue the hub admitted the entry to (a delivery queue id). */
  queueId?: Id;
  lane?: string;
  priority?: number;
  /** Why it left without merging: ci, conflict, head-changed, timeout, manual, approvals or other. */
  cause?: string;
}

/*
 * Project merge queues (GET/PUT /projects/:id/merge-queues, GET /merge-queues/:id). Named queues come from the hub
 * settings and the repository's .perpeto/merge-queue.json; workflow queues are the ones inline workflow nodes define.
 */
export type { MergeQueueConfig, QueueConfig, Lane as QueueLane, FreezeWindow, ConfigProblem } from '@perpeto/delivery/queue-config';

export interface MergeQueueFreeze {
  kind?: 'manual' | 'window';
  reason: string;
  since?: IsoTime;
  until?: IsoTime;
  by?: string;
}

export interface MergeQueueSummary {
  id: Id;
  kind: 'project' | 'workflow';
  name: string;
  projectId: Id;
  branches: string[];
  strategy: string;
  source: 'hub' | 'repo' | 'merged' | 'workflow';
  frozen: MergeQueueFreeze | null;
  counts: { queued: number; testing: number; merging: number };
}

export interface MergeQueueSettings {
  projectId: Id;
  version: number;
  updatedAt: IsoTime | null;
  /** The hub's own document, before the repository file is applied. */
  config: import('@perpeto/delivery/queue-config').MergeQueueConfig;
  history: { version: number; updatedAt: IsoTime }[];
  repo: { path: string; found: boolean; revision?: string; error?: string; errors?: import('@perpeto/delivery/queue-config').ConfigProblem[]; applied: boolean };
  effective: import('@perpeto/delivery/queue-config').MergeQueueConfig;
  queues: MergeQueueSummary[];
}

export interface QueueEntryView {
  id: Id;
  prUrl: string;
  headSha: string;
  baseBranch: string;
  status: MergeStatus;
  position: number;
  priority: number;
  workItemId?: Id;
  runId?: Id;
  lane?: string;
  pinned?: boolean;
  headBranch?: string;
  labels?: string[];
  enqueuedAt?: IsoTime;
  waitedMs?: number;
  etaAt?: IsoTime;
  finishedAt?: IsoTime;
  attemptId?: Id;
  phase?: string;
  reason?: string;
  cause?: string;
  jobId?: Id;
  retries?: number;
  deliveryError?: string;
}

export interface QueueAttemptView {
  id: Id;
  head: boolean;
  phase: 'preparing' | 'testing' | 'merging' | 'blocked' | string;
  entryIds: Id[];
  size: number;
  startedAt?: IsoTime;
  jobId?: Id;
  jobStatus?: JobStatus;
  revision?: string;
  retries?: number;
  reason?: string;
}

export interface QueueMetrics {
  windowMs: number;
  merged: number;
  rejected: number;
  throughputPerHour: number;
  medianTimeInQueueMs: number | null;
  failureRate: number | null;
  failuresByReason: { cause: string; count: number; rate: number }[];
  batches: { total: number; succeeded: number; successRate: number | null };
  flakyRetries: number;
  hourly: { start: IsoTime; merged: number; rejected: number }[];
}

export interface MergeQueueView {
  id: Id;
  kind: 'project' | 'workflow';
  projectId: Id;
  name: string;
  source: MergeQueueSummary['source'] | 'removed';
  config?: import('@perpeto/delivery/queue-config').QueueConfig;
  branches: string[];
  strategy: string;
  frozen: MergeQueueFreeze | null;
  entries: QueueEntryView[];
  attempts: QueueAttemptView[];
  testing: Id[];
  recent: QueueEntryView[];
  eta: { attemptMs: number | null; samples: number };
  metrics: QueueMetrics;
  window: string;
  generatedAt: IsoTime;
}

export type MergeEntryCommand = { action: 'priority'; lane?: string; priority?: number } | { action: 'eject'; reason?: string } | { action: 'requeue'; reason?: string };

export type MachineStatus = 'online' | 'offline' | 'draining';

/** What a node last reported about its machine. Every part is optional: older nodes send less. */
export interface MachineHealth {
  reportedAt: IsoTime;
  cpus?: number;
  /** 1, 5 and 15 minute load averages. */
  load?: [number, number, number];
  memory?: { totalBytes: number; freeBytes: number; pressure?: 'normal' | 'warn' | 'critical' };
  processes?: number;
  power?: { source: 'ac' | 'battery'; percent?: number; charging?: boolean };
  thermal?: 'nominal' | 'fair' | 'serious' | 'critical';
  uptimeSec?: number;
  nodeVersion?: string;
  runtime?: { reachable: boolean };
  /** The disk that holds the node's workspaces. */
  disk?: { totalBytes: number; freeBytes: number };
  storage?: { state: 'ok' | 'low' | 'critical' };
}

/** The owner's scheduling overrides; `null` falls back to the node's own config. */
export interface MachineSchedule {
  cordoned: boolean;
  drain: boolean;
  weight: number;
  maxAgents: number | null;
  maxJobs: number | null;
  labels: string[] | null;
  allowOnBattery: boolean | null;
  updatedAt: IsoTime;
}

export type PlacementStatus = 'online' | 'limited' | 'overloaded' | 'cordoned' | 'draining' | 'drained' | 'offline';

export type PlacementReasonCode =
  | 'offline'
  | 'revoked'
  | 'cordoned'
  | 'draining'
  | 'overloaded'
  | 'busy'
  | 'memory-pressure'
  | 'low-disk'
  | 'on-battery'
  | 'thermal'
  | 'too-many-processes'
  | 'runtime-unreachable'
  | 'no-provider'
  | 'full'
  | 'capped-by-node'
  | 'no-telemetry';

export interface PlacementReason {
  code: PlacementReasonCode;
  message: string;
  effect: 'blocks' | 'blocks-agents' | 'blocks-jobs' | 'reduces' | 'info';
}

/** How the hub places work on a machine right now, and why not when it doesn't. */
export interface MachinePlacement {
  status: PlacementStatus;
  accepting: boolean;
  /** Slots from the node config and the owner's overrides. */
  configured: { agents: number; jobs: number };
  /** Slots after health limits: what the hub will actually fill. */
  effective: { agents: number; jobs: number };
  /** Slots held by running or leased work. */
  held: { agents: number; jobs: number };
  loadPerCore?: number;
  weight: number;
  reasons: PlacementReason[];
}

export interface Machine {
  id: Id;
  name: string;
  os: string;
  arch: string;
  /** Effective labels: the owner's override, else what the node reported. */
  labels: string[];
  reportedLabels?: string[];
  providers: string[];
  /** Slots from the node's own config. */
  capacity: { maxAgents: number; maxJobs: number };
  running: { agents: number; jobs: number };
  /** Legacy liveness; `placement.status` is the full picture on newer hubs. */
  status: MachineStatus;
  lastHeartbeatAt: IsoTime;
  version: string;
  revokedAt?: IsoTime;
  health?: MachineHealth;
  schedule?: MachineSchedule;
  placement?: MachinePlacement;
}

/** Changes to a machine's scheduling. Uncordon is `{ cordoned: false, drain: false }`. */
export interface MachinePatch {
  cordoned?: boolean;
  drain?: boolean;
  /** 0 to 10, default 1. */
  weight?: number;
  /** `null` returns to the node config. */
  maxAgents?: number | null;
  maxJobs?: number | null;
  /** `null` returns to the node-reported labels. */
  labels?: string[] | null;
  allowOnBattery?: boolean | null;
}

/** Why the hub placed an assignment or job where it did. */
export interface PlacementDecision {
  machineId: Id;
  score: number;
  reasons: string[];
  at: IsoTime;
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
  /** Subscription plan as the owner or the harness named it ("Max 20x"). */
  plan?: string;
  /** Limit windows the harness last reported for this login. */
  usage?: AccountUsage;
  /**
   * Where the hub learned of it: `observed` for a subscription seen in the
   * operator's own T3 Code app (read-only), else the machine's account pool.
   */
  source?: string;
}

/** Kinds of subscription limit. Anything else a hub sends decodes as `other`. */
export type UsageWindowKind = 'session' | 'weekly' | 'monthly' | 'other';

export interface UsageWindow {
  id: string;
  kind: UsageWindowKind;
  label: string;
  /** 0 to 100. */
  usedPercent: number;
  resetsAt?: IsoTime;
  windowMins?: number;
}

export interface AccountUsage {
  checkedAt?: IsoTime;
  windows: UsageWindow[];
}

export interface AccountPatch {
  label?: string;
  /** Null clears the plan. */
  plan?: string | null;
}

/*
 * Subscription pacing: GET /pacing. The hub scales running agents so each
 * subscription's limit is used up by its reset. Enums carry an `unknown`
 * member so a newer hub's values decode instead of failing.
 */
export type PacingStrategy = 'rotation' | 'parallel' | 'unknown';
export type PacingLimit = 'weekly' | 'session' | 'slots' | 'work' | 'none' | 'unknown';
export type PacingAccountState = 'burning' | 'next' | 'resting' | 'cooling' | 'exhausted' | 'unknown';
export type OnTrack = 'under' | 'on' | 'over' | 'unknown';

export interface PacingProvider {
  provider: string;
  targetAgents: number;
  runningAgents: number;
  slots: number;
  readyWork: number;
  limitedBy: PacingLimit;
  starved: boolean;
}

export interface PacingWindow {
  id: string;
  kind: UsageWindowKind;
  label: string;
  usedPercent: number;
  resetsAt?: IsoTime;
  projectedPercentAtReset: number;
  onTrack: OnTrack;
}

export interface PacingAccount {
  accountId: Id;
  machineId: Id;
  provider: string;
  label: string;
  plan?: string;
  state: PacingAccountState;
  targetAgents: number;
  runningAgents: number;
  /** Percent of the binding window one agent uses per hour. */
  burnPerAgentHour?: number;
  windows: PacingWindow[];
  /** Minutes this subscription is forecast to sit unused before its reset. */
  idleForecastMins: number;
  /** Advise mode: about how many more agents it could run and still land at the target by its reset. */
  headroomAgents?: number;
}

export interface PacingSegment {
  accountId: Id;
  from: IsoTime;
  to: IsoTime;
  phase: 'burn' | 'rest';
}

/**
 * `enforce`: the hub scales the agents it runs. `advise`: it only observes
 * and suggests; nothing is enforced. A hub without the field enforces; any
 * other value is treated as advice, so no control claims an effect it lacks.
 */
export type PacingMode = 'enforce' | 'advise';

export interface Pacing {
  mode: PacingMode;
  enabled: boolean;
  strategy: PacingStrategy;
  targetUsePercent: number;
  /** Only when the hub reports them; a null maximum means no cap. */
  minAgents?: number;
  maxAgents?: number | null;
  updatedAt?: IsoTime;
  providers: PacingProvider[];
  accounts: PacingAccount[];
  timeline: PacingSegment[];
}

export interface PacingSettings {
  enabled?: boolean;
  strategy?: 'rotation' | 'parallel';
  targetUsePercent?: number;
  minAgents?: number;
  /** Null removes the cap. */
  maxAgents?: number | null;
}

export interface UsageRecord {
  id: Id;
  projectId: Id;
  runId?: Id;
  assignmentId?: Id;
  machineId: Id;
  accountId?: Id;
  /** Assignment role, else its node id. */
  role?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  at: IsoTime;
}

export type UsageGroupBy = 'provider' | 'model' | 'machine' | 'day' | 'role';

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
  /** Active and paused runs with their settings, intake and budget use. */
  runs?: Run[];
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

/**
 * Delivery evidence for an addressed message (docs/architecture/messaging.md).
 * States only move forward. None of them proves the agent understood or complied.
 */
export interface Receipt {
  state: 'stored' | 'delivered' | 'acked';
  deliveredAt?: IsoTime | null;
  /** In the assignment's first prompt, steered into a running turn, or acked without being offered. */
  deliveredVia?: 'prompt' | 'steer' | 'read' | null;
  deliveredTo?: Id | null;
  ackedAt?: IsoTime | null;
  ackNote?: string | null;
}

export interface Message {
  id: string;
  projectId: string;
  channelId: string;
  senderRoleId: string;
  recipientRoleId: string | null;
  body: string;
  createdAt: IsoTime;
  /** The thread's root id; a root is its own thread. Older hubs omit it, and the client fills in the message id. */
  threadId: string;
  parentId: string | null;
  senderKind?: 'owner' | 'agent' | null;
  senderAssignmentId?: Id | null;
  /** An agent sent it outside the run's messages edges; the workflow flags rather than refuses it. */
  unplanned: boolean;
  receipt: Receipt | null;
}

/** GET …/unread for one role: messages addressed to it or the channel after its read cursor. */
export interface UnreadState {
  roleId: string;
  unreadCount: number;
  lastReadMessageId: string | null;
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
  /** Project metrics: the run the bottleneck is in. */
  runId?: Id;
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

/*
 * Observed T3 Code sessions: GET /sessions and GET /sessions/summary. Each
 * machine's node watches the operator's own T3 Code app read-only and the
 * hub aggregates. Unknown statuses decode as `unknown`.
 */
export type SessionStatus = 'running' | 'waiting' | 'idle' | 'error' | 'unknown';

export interface SessionTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface Session {
  id: Id;
  machineId: Id;
  machineName: string;
  threadId: string;
  title?: string;
  project?: { name: string; path?: string };
  branch?: string;
  provider: string;
  providerInstanceId?: string;
  model?: string;
  status: SessionStatus;
  parentThreadId?: string;
  childCount: number;
  createdAt: IsoTime;
  lastActivityAt: IsoTime;
  turns: number;
  tokens: SessionTokens;
}

export interface SessionQuery {
  machineId?: string;
  status?: Exclude<SessionStatus, 'unknown'>;
  provider?: string;
  since?: IsoTime;
  limit?: number;
  cursor?: string;
}

export interface SessionPage {
  sessions: Session[];
  nextCursor?: string;
}

export type SessionsWindow = '1h' | '24h' | '7d';

export interface ObservedMachine {
  machineId: Id;
  name: string;
  online: boolean;
  observing: boolean;
  lastObservedAt?: IsoTime;
  running: number;
  waiting: number;
  idle: number;
}

export interface TokenGroup {
  key: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionsSummary {
  window: SessionsWindow;
  machines: ObservedMachine[];
  totals: { running: number; waiting: number; sessionsActive: number };
  tokens: {
    byProvider: TokenGroup[];
    byModel: TokenGroup[];
    byMachine: TokenGroup[];
    series: { at: IsoTime; input: number; output: number }[];
  };
}
