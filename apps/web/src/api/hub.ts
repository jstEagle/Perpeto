import type {
  Account,
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
  MergeEntry,
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
  UsageSummary,
  ValidationResult,
  WorkItem,
  Workflow,
  WorkflowGraph,
  WorkflowStatus,
} from './types';

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

  startRun(workflowId: string): Promise<Run>;
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
  listAccounts(): Promise<Account[]>;

  listJobs(query?: { projectId?: string; runId?: string }): Promise<Job[]>;
  getJob(id: string): Promise<Job>;
  getJobLog(id: string): Promise<string>;
  mergeQueue(projectId: string): Promise<MergeEntry[]>;

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
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HubError';
    this.status = status;
    this.code = code;
  }
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** Role the web owner sends messages as. */
export const OWNER_ROLE_ID = 'owner';
