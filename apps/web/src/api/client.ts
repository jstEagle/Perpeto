import { HubError, newIdempotencyKey, OWNER_ROLE_ID } from './hub';
import type { HubApi, MessageQuery, StreamState, UsageQuery, WorkflowUpdate } from './hub';
import type {
  Account,
  Assignment,
  AssignmentStatus,
  Channel,
  DraftRequest,
  EnrollmentCode,
  GraphDiff,
  Health,
  HubEvent,
  HumanDecision,
  Job,
  Machine,
  MergeEntry,
  Message,
  MessagePage,
  MetricsSnapshot,
  MetricsWindow,
  NewProject,
  NewWorkflow,
  Overview,
  Project,
  Run,
  RunInput,
  UsageSummary,
  ValidationResult,
  WorkItem,
  Workflow,
  WorkflowGraph,
} from './types';
import { diffGraphs } from '../workflow/diff';

export interface HubSettings {
  baseUrl: string;
  token: string;
}

type Query = Record<string, string | number | boolean | undefined>;

/**
 * List routes may answer with a bare array or an envelope such as
 * `{ projects: [...] }`; the contract does not fix which.
 */
function list<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === 'object') {
    for (const value of Object.values(body)) if (Array.isArray(value)) return value as T[];
  }
  return [];
}

/** Single-entity routes may answer bare or wrapped as `{ project: {...} }`. */
function one<T>(body: unknown, key: string): T {
  if (body && typeof body === 'object' && key in body) return (body as Record<string, T>)[key];
  return body as T;
}

/** Client for Hub API v1 (docs/architecture.md). */
export class HttpHub implements HubApi {
  readonly mode = 'hub' as const;
  readonly #base: string;
  readonly #token: string;

  constructor(settings: HubSettings) {
    this.#base = settings.baseUrl.replace(/\/+$/, '');
    this.#token = settings.token;
  }

  #url(path: string, query: Query = {}): URL {
    const url = new URL(`${this.#base}/api/v1${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    return url;
  }

  async #request<T>(method: string, path: string, options: { body?: object; query?: Query; text?: boolean; auth?: boolean } = {}): Promise<T> {
    const mutating = method !== 'GET';
    const body = mutating ? { idempotencyKey: newIdempotencyKey(), ...(options.body ?? {}) } : undefined;
    let response: Response;
    try {
      response = await fetch(this.#url(path, options.query), {
        method,
        headers: {
          ...(options.auth === false ? {} : { Authorization: `Bearer ${this.#token}` }),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          Accept: options.text ? 'text/plain' : 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new HubError(0, 'NETWORK', 'The hub could not be reached.');
    }
    if (!response.ok) {
      let code = `HTTP_${response.status}`;
      let message = `The hub returned HTTP ${response.status}.`;
      try {
        const parsed = (await response.json()) as { error?: { code?: string; message?: string } };
        if (parsed.error?.code) code = parsed.error.code;
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        /* non-JSON error body */
      }
      throw new HubError(response.status, code, message);
    }
    if (options.text) return (await response.text()) as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new HubError(response.status, 'INVALID_JSON', 'The hub returned an unreadable response.');
    }
  }

  health() {
    return this.#request<Health>('GET', '/health', { auth: false });
  }
  overview(projectId?: string) {
    return this.#request<Overview>('GET', '/overview', { query: { projectId } });
  }

  async listProjects() {
    return list<Project>(await this.#request('GET', '/projects'));
  }
  async createProject(input: NewProject) {
    return one<Project>(await this.#request('POST', '/projects', { body: input }), 'project');
  }
  async getProject(id: string) {
    return one<Project>(await this.#request('GET', `/projects/${enc(id)}`), 'project');
  }
  async updateProject(id: string, patch: Partial<NewProject>) {
    return one<Project>(await this.#request('PATCH', `/projects/${enc(id)}`, { body: patch }), 'project');
  }

  async listWorkflows(projectId: string) {
    return list<Workflow>(await this.#request('GET', `/projects/${enc(projectId)}/workflows`));
  }
  async createWorkflow(projectId: string, input: NewWorkflow) {
    return one<Workflow>(await this.#request('POST', `/projects/${enc(projectId)}/workflows`, { body: input }), 'workflow');
  }
  async getWorkflow(id: string) {
    return one<Workflow>(await this.#request('GET', `/workflows/${enc(id)}`), 'workflow');
  }
  async saveWorkflow(id: string, update: WorkflowUpdate) {
    return one<Workflow>(await this.#request('PUT', `/workflows/${enc(id)}`, { body: update }), 'workflow');
  }
  validateWorkflow(id: string, graph: WorkflowGraph) {
    return this.#request<ValidationResult>('POST', `/workflows/${enc(id)}/validate`, { body: { graph } });
  }
  async requestDraft(projectId: string, input: DraftRequest) {
    return one<Assignment>(await this.#request('POST', `/projects/${enc(projectId)}/workflows/drafts`, { body: input }), 'assignment');
  }

  /**
   * The contract has no owner route for a single assignment, so progress is
   * read from `assignment.state` events for that assignment. The run's
   * assignment list is used when the assignment belongs to a run.
   */
  async getAssignment(id: string, runIdHint?: string): Promise<Assignment> {
    if (runIdHint) {
      const found = (await this.listAssignments(runIdHint)).find((a) => a.id === id);
      if (found) return found;
    }
    const events = await this.events(0, 500);
    const mine = events.filter((e) => e.subject.kind === 'assignment' && e.subject.id === id);
    const last = mine.at(-1);
    const state = (last?.data.state as AssignmentStatus | undefined) ?? 'queued';
    return {
      id,
      runId: '',
      workItemId: '',
      nodeId: '',
      role: 'workflow-architect',
      prompt: '',
      harness: { provider: String(last?.data.provider ?? ''), model: String(last?.data.model ?? '') },
      policy: { maxSubagents: 0, allowedSubagentProviders: [], canMessage: [] },
      requirements: {},
      status: state,
      machineId: last?.data.machineId as string | undefined,
      attempt: Number(last?.data.attempt ?? 1),
      result: last?.data.result as Assignment['result'],
    };
  }
  async listVersions(workflowId: string) {
    return list<Workflow>(await this.#request('GET', `/workflows/${enc(workflowId)}/versions`));
  }
  async diffVersions(workflowId: string, from: number, to: number): Promise<GraphDiff> {
    try {
      return await this.#request<GraphDiff>('GET', `/workflows/${enc(workflowId)}/diff`, { query: { from, to } });
    } catch (error) {
      if (!(error instanceof HubError) || error.status !== 404) throw error;
      const versions = await this.listVersions(workflowId);
      const a = versions.find((v) => v.version === from);
      const b = versions.find((v) => v.version === to);
      if (!a || !b) throw error;
      return diffGraphs(a.graph, b.graph);
    }
  }
  async activateVersion(workflowId: string, version: number) {
    return one<Workflow>(await this.#request('POST', `/workflows/${enc(workflowId)}/activate`, { body: { version } }), 'workflow');
  }

  async startRun(workflowId: string) {
    return one<Run>(await this.#request('POST', `/workflows/${enc(workflowId)}/runs`, { body: {} }), 'run');
  }

  /**
   * The contract has no project run list. Try `/projects/:id/runs` and, if the
   * hub does not serve it, reconstruct the list from run events.
   */
  async listRuns(projectId: string): Promise<Run[]> {
    try {
      return list<Run>(await this.#request('GET', `/projects/${enc(projectId)}/runs`));
    } catch (error) {
      if (!(error instanceof HubError) || error.status !== 404) throw error;
    }
    const events = await this.events(0, 1000);
    const ids = new Set<string>();
    for (const e of events) {
      if (e.projectId !== projectId) continue;
      if (e.subject.kind === 'run') ids.add(e.subject.id);
      else if (e.runId) ids.add(e.runId);
    }
    const runs = await Promise.all([...ids].map((id) => this.getRun(id).catch(() => null)));
    return runs.filter((r): r is Run => r !== null).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  async getRun(id: string) {
    return one<Run>(await this.#request('GET', `/runs/${enc(id)}`), 'run');
  }
  async pauseRun(id: string) {
    return one<Run>(await this.#request('POST', `/runs/${enc(id)}/pause`), 'run');
  }
  async resumeRun(id: string) {
    return one<Run>(await this.#request('POST', `/runs/${enc(id)}/resume`), 'run');
  }
  async stopRun(id: string) {
    return one<Run>(await this.#request('POST', `/runs/${enc(id)}/stop`), 'run');
  }
  async addRunInput(runId: string, input: RunInput) {
    return one<WorkItem>(await this.#request('POST', `/runs/${enc(runId)}/inputs`, { body: input }), 'workItem');
  }
  async listWorkItems(runId: string) {
    return list<WorkItem>(await this.#request('GET', `/runs/${enc(runId)}/work-items`));
  }
  async listAssignments(runId: string) {
    return list<Assignment>(await this.#request('GET', `/runs/${enc(runId)}/assignments`));
  }
  async decideWorkItem(id: string, decision: HumanDecision) {
    return one<WorkItem>(await this.#request('POST', `/work-items/${enc(id)}/decision`, { body: decision }), 'workItem');
  }

  async listMachines() {
    return list<Machine>(await this.#request('GET', '/machines'));
  }
  createEnrollmentCode() {
    return this.#request<EnrollmentCode>('POST', '/machines/enrollment-codes');
  }
  async drainMachine(id: string) {
    return one<Machine>(await this.#request('POST', `/machines/${enc(id)}/drain`), 'machine');
  }
  async listAccounts() {
    return list<Account>(await this.#request('GET', '/accounts'));
  }

  async listJobs(query: { projectId?: string; runId?: string } = {}) {
    return list<Job>(await this.#request('GET', '/jobs', { query }));
  }
  async getJob(id: string) {
    return one<Job>(await this.#request('GET', `/jobs/${enc(id)}`), 'job');
  }
  getJobLog(id: string) {
    return this.#request<string>('GET', `/jobs/${enc(id)}/log`, { text: true });
  }
  async mergeQueue(projectId: string) {
    return list<MergeEntry>(await this.#request('GET', `/projects/${enc(projectId)}/merge-queue`));
  }

  runMetrics(runId: string, window: MetricsWindow = '24h') {
    return this.#request<MetricsSnapshot>('GET', `/runs/${enc(runId)}/metrics`, { query: { window } });
  }
  projectMetrics(projectId: string, window: MetricsWindow = '24h') {
    return this.#request<MetricsSnapshot>('GET', `/projects/${enc(projectId)}/metrics`, { query: { window } });
  }

  async usage(query: UsageQuery): Promise<UsageSummary> {
    const body = await this.#request<unknown>('GET', '/usage', { query: { ...query } });
    return { groupBy: query.groupBy, rows: list(body) };
  }
  async events(after = 0, limit = 200) {
    return list<HubEvent>(await this.#request('GET', '/events', { query: { after, limit } }));
  }

  /**
   * Streams `/events` as Server-Sent Events. EventSource cannot send an
   * Authorization header, so this reads the stream through fetch. If the hub
   * answers with JSON instead of a stream, it falls back to polling.
   */
  subscribe(after: number, onEvent: (event: HubEvent) => void, onState: (state: StreamState) => void): () => void {
    let cursor = after;
    let stopped = false;
    let controller: AbortController | null = null;
    let retry = 0;
    const deliver = (event: HubEvent) => {
      if (event.seq <= cursor) return;
      cursor = event.seq;
      onEvent(event);
    };

    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const loop = async () => {
      onState('connecting');
      while (!stopped) {
        controller = new AbortController();
        try {
          const response = await fetch(this.#url('/events', { after: cursor }), {
            headers: { Authorization: `Bearer ${this.#token}`, Accept: 'text/event-stream' },
            signal: controller.signal,
          });
          if (!response.ok) throw new HubError(response.status, `HTTP_${response.status}`, 'Event stream rejected.');
          const type = response.headers.get('content-type') ?? '';
          if (!type.includes('text/event-stream') || !response.body) {
            onState('polling');
            for (const event of list<HubEvent>(await response.json())) deliver(event);
            await wait(5000);
            continue;
          }
          onState('live');
          retry = 0;
          await readSse(response.body, (data) => {
            try {
              deliver(JSON.parse(data) as HubEvent);
            } catch {
              /* ignore malformed frames */
            }
          });
        } catch {
          if (stopped) return;
        }
        if (stopped) return;
        onState('reconnecting');
        retry = Math.min(retry + 1, 6);
        await wait(500 * 2 ** retry);
      }
    };
    void loop();
    return () => {
      stopped = true;
      controller?.abort();
      onState('closed');
    };
  }

  async listChannels(projectId: string) {
    return list<Channel>(await this.#request('GET', `/messaging/projects/${enc(projectId)}/channels`));
  }
  readMessages(projectId: string, channelId: string, query: MessageQuery) {
    return this.#request<MessagePage>('GET', `/messaging/projects/${enc(projectId)}/channels/${enc(channelId)}/messages`, {
      query: { ...query },
    });
  }
  async sendMessage(projectId: string, channelId: string, input: { body: string; recipientRoleId?: string }) {
    const result = await this.#request<{ message: Message }>(
      'POST',
      `/messaging/projects/${enc(projectId)}/channels/${enc(channelId)}/messages`,
      { body: { senderRoleId: OWNER_ROLE_ID, ...input } },
    );
    return result.message;
  }
}

function enc(value: string) {
  return encodeURIComponent(value);
}

/** Minimal text/event-stream reader: calls onData for each `data:` frame. */
export async function readSse(stream: ReadableStream<Uint8Array>, onData: (data: string) => void): Promise<void> {
  const reader = stream.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let boundary: number;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) onData(data);
    }
  }
}
