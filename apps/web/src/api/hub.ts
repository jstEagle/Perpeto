import type {
  Account,
  AccountPatch,
  Pacing,
  PacingSettings,
  Assignment,
  DraftRequest,
  GraphDiff,
  MetricsSnapshot,
  MetricsWindow,
  Channel,
  EnrollmentCode,
  Health,
  HubEvent,
  HumanDecision,
  Job,
  Machine,
  MachinePatch,
  MergeEntry,
  MergeEntryCommand,
  MergeQueueConfig,
  MergeQueueSettings,
  MergeQueueView,
  Message,
  MessagePage,
  NewProject,
  NewWorkflow,
  Overview,
  Project,
  Run,
  RunInput,
  UnreadState,
  UsageGroupBy,
  RunSettings,
  WorkflowTemplate,
  UsageSummary,
  ValidationResult,
  WorkItem,
  Workflow,
  WorkflowGraph,
  WorkflowStatus,
  SessionPage,
  SessionQuery,
  SessionsSummary,
  SessionsWindow,
} from './types';
import type { CiArtifact, CiInsights, FlakyJob, JobLogPage, NewPipelineRun, PipelineList, PipelineRun, PipelineRunQuery, RunnersView } from './ci';
import type { CleanupRequest, FleetStorage, MachineStorage, StorageCleanup } from './storage';

export interface EventQuery {
  runId?: string;
  projectId?: string;
  /** Cursor from a previous page's `before`; omitted for the newest page. */
  before?: number;
  limit?: number;
}

export interface EventPageResult {
  /** Newest first. */
  events: HubEvent[];
  /** Pass back as `before` for the next older page. */
  before: number;
  hasMore: boolean;
}

export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'polling' | 'closed';

export interface UsageQuery {
  projectId?: string;
  runId?: string;
  groupBy: UsageGroupBy;
}

export interface MessageQuery {
  latest?: boolean;
  before?: string;
  after?: string;
  limit?: number;
  threadId?: string;
}

/** An owner message: to a role, to the whole channel (`null`), or a reply in a thread. */
export interface NewMessage {
  body: string;
  recipientRoleId?: string | null;
  parentId?: string;
}

export interface WorkflowUpdate {
  name?: string;
  status?: WorkflowStatus;
  graph: WorkflowGraph;
}

/**
 * Everything the screens need from a hub. Implemented by HttpHub (a real
 * hub, docs/architecture/README.md "Hub API v1") and DemoHub (fixtures).
 */
export interface HubApi {
  readonly mode: 'hub' | 'demo';

  health(): Promise<Health>;
  overview(projectId?: string): Promise<Overview>;

  listProjects(): Promise<Project[]>;
  createProject(input: NewProject): Promise<Project>;
  getProject(id: string): Promise<Project>;
  updateProject(id: string, patch: Partial<NewProject>): Promise<Project>;

  listWorkflows(projectId: string): Promise<Workflow[]>;
  createWorkflow(projectId: string, input: NewWorkflow): Promise<Workflow>;
  getWorkflow(id: string): Promise<Workflow>;
  saveWorkflow(id: string, update: WorkflowUpdate): Promise<Workflow>;
  validateWorkflow(id: string, graph: WorkflowGraph): Promise<ValidationResult>;
  /** Ask the workflow architect for a draft; returns the assignment to follow. */
  requestDraft(projectId: string, input: DraftRequest): Promise<Assignment>;
  /** Follow an architect (or any) assignment. */
  getAssignment(id: string): Promise<Assignment>;
  listVersions(workflowId: string): Promise<Workflow[]>;
  diffVersions(workflowId: string, from: number, to: number): Promise<GraphDiff>;
  activateVersion(workflowId: string, version: number): Promise<Workflow>;

  /** Library templates; an older hub without the route gets the web's own. */
  listTemplates(): Promise<WorkflowTemplate[]>;

  startRun(workflowId: string, settings?: RunSettings): Promise<Run>;
  /** Change keep-running, intake and budget on a running or paused run. */
  updateRun(id: string, settings: RunSettings): Promise<Run>;
  listRuns(projectId: string): Promise<Run[]>;
  getRun(id: string): Promise<Run>;
  pauseRun(id: string): Promise<Run>;
  resumeRun(id: string): Promise<Run>;
  stopRun(id: string): Promise<Run>;
  addRunInput(runId: string, input: RunInput): Promise<void>;
  listWorkItems(runId: string): Promise<WorkItem[]>;
  listAssignments(runId: string): Promise<Assignment[]>;
  decideWorkItem(id: string, decision: HumanDecision): Promise<void>;

  listMachines(): Promise<Machine[]>;
  createEnrollmentCode(): Promise<EnrollmentCode>;
  drainMachine(id: string): Promise<Machine>;
  /** Cordon, drain or tune a machine's scheduling. */
  updateMachine(id: string, patch: MachinePatch): Promise<Machine>;
  listAccounts(): Promise<Account[]>;
  /** Rename a subscription or set its plan. */
  updateAccount(id: string, patch: AccountPatch): Promise<Account>;
  /** Subscription pacing; `null` when the hub has no pacing route yet. */
  pacing(): Promise<Pacing | null>;
  updatePacing(settings: PacingSettings): Promise<Pacing>;

  /** Disk and reclaimable storage across machines; `null` when the hub has no storage janitor. */
  storage(): Promise<FleetStorage | null>;
  /** One machine's storage inventory and recent cleanups. */
  machineStorage(machineId: string): Promise<MachineStorage>;
  /** Ask a machine to preview (dry-run) or run a cleanup; it runs on the machine's next heartbeat. */
  requestStorageCleanup(machineId: string, request: CleanupRequest): Promise<StorageCleanup>;
  /** Ask a machine for a fresh inventory. */
  requestStorageScan(machineId: string): Promise<void>;
  storageCleanup(machineId: string, cleanupId: string): Promise<StorageCleanup>;

  /** Observed T3 Code sessions across machines; `null` when the hub doesn't observe sessions. */
  listSessions(query?: SessionQuery): Promise<SessionPage | null>;
  /** Machines, totals and tokens for observed sessions over a window; `null` without the route. */
  sessionsSummary(window: SessionsWindow): Promise<SessionsSummary | null>;

  listJobs(query?: { projectId?: string; runId?: string }): Promise<Job[]>;
  getJob(id: string): Promise<Job>;
  getJobLog(id: string): Promise<string>;
  mergeQueue(projectId: string): Promise<MergeEntry[]>;
  /** Project merge queue settings and queues; `null` when the hub predates configurable queues. */
  mergeQueues(projectId: string): Promise<MergeQueueSettings | null>;
  /** Save the hub's merge queue settings. `baseVersion` refuses a save over someone else's change. */
  saveMergeQueues(projectId: string, config: MergeQueueConfig, baseVersion: number): Promise<MergeQueueSettings>;
  mergeQueueView(id: string, window?: MetricsWindow): Promise<MergeQueueView>;
  freezeMergeQueue(id: string, reason?: string): Promise<MergeQueueView>;
  unfreezeMergeQueue(id: string): Promise<MergeQueueView>;
  /** Move an entry to a lane or priority, eject it, or send it to the back of its lane. */
  mergeEntryCommand(id: string, command: MergeEntryCommand): Promise<MergeEntry>;

  /** Pipelines from the repository's .perpeto/ci.json or the project config; `null` when the hub has no CI pipelines. */
  ciPipelines(projectId: string): Promise<PipelineList | null>;
  ciRuns(query: PipelineRunQuery): Promise<PipelineRun[]>;
  ciRun(id: string): Promise<PipelineRun>;
  startCiRun(input: NewPipelineRun): Promise<PipelineRun>;
  cancelCiRun(id: string): Promise<PipelineRun>;
  /** Retry the run's failed jobs, or one job by key. */
  retryCiRun(id: string, job?: string): Promise<PipelineRun>;
  /** One page of a job's log after a cursor. */
  ciJobLog(jobId: string, after?: number, limit?: number): Promise<JobLogPage>;
  ciArtifacts(jobId: string): Promise<CiArtifact[]>;
  ciArtifact(jobId: string, artifactId: string): Promise<Blob>;
  /** Machines as CI runners, by pool; `null` when the hub has no runner route. */
  ciRunners(): Promise<RunnersView | null>;
  ciFlaky(projectId: string): Promise<FlakyJob[]>;
  ciInsights(projectId: string, window?: string): Promise<CiInsights>;

  runMetrics(runId: string, window?: MetricsWindow): Promise<MetricsSnapshot>;
  projectMetrics(projectId: string, window?: MetricsWindow): Promise<MetricsSnapshot>;

  usage(query: UsageQuery): Promise<UsageSummary>;
  events(after?: number, limit?: number): Promise<HubEvent[]>;
  /** Sequence number of the newest event, to start a live stream without replaying history. */
  latestSeq(): Promise<number>;
  /** One page of events, newest first: the latest page, or the page before `before`. */
  eventPage(query?: EventQuery): Promise<EventPageResult>;
  /** Live events after `after`. Returns an unsubscribe function. */
  subscribe(after: number, onEvent: (event: HubEvent) => void, onState: (state: StreamState) => void): () => void;

  listChannels(projectId: string): Promise<Channel[]>;
  readMessages(projectId: string, channelId: string, query: MessageQuery): Promise<MessagePage>;
  sendMessage(projectId: string, channelId: string, input: NewMessage): Promise<Message>;
  /** Acknowledge a message addressed to the owner. */
  ackMessage(projectId: string, channelId: string, messageId: string, note?: string): Promise<Message>;
  /** The owner's unread count and read cursor; `null` when the hub predates read cursors. */
  unread(projectId: string, channelId: string): Promise<UnreadState | null>;
  /** Move the owner's read cursor forward to this message. */
  markRead(projectId: string, channelId: string, messageId: string): Promise<UnreadState | null>;
}

export class HubError extends Error {
  readonly status: number;
  readonly code: string;
  /** Field problems with JSON paths, for example from merge queue validation. */
  readonly details?: { path: string; message: string }[];
  constructor(status: number, code: string, message: string, details?: { path: string; message: string }[]) {
    super(message);
    this.name = 'HubError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** Role the web owner sends messages as. */
export const OWNER_ROLE_ID = 'owner';
