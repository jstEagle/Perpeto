import { HubError, newIdempotencyKey, OWNER_ROLE_ID } from './hub';
import type { HubApi, MessageQuery, StreamState, UsageQuery, WorkflowUpdate } from './hub';
import type {
  Account,
  Assignment,
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
  UsageRow,
  UsageSummary,
  ValidationResult,
  WorkItem,
  Workflow,
  WorkflowGraph,
} from './types';

/**
 * How requests prove they come from the owner. `cookie` relies on an
 * HttpOnly session cookie set by the hub (see docs/handoffs/web-app.md for
 * the requested route); `bearer` sends the owner token on each request.
 */
export type HubAuth = { kind: 'cookie' } | { kind: 'bearer'; token: string };

export interface HubSettings {
  baseUrl: string;
  auth: HubAuth;
}

type Query = Record<string, string | number | boolean | undefined>;

/** Read the named list from a hub envelope such as `{ projects: [...] }`. */
function list<T>(body: unknown, key: string): T[] {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
  if (!Array.isArray(value)) throw new HubError(200, 'INVALID_RESPONSE', `The hub response has no ${key} list.`);
  return value as T[];
}

/** Hub validation issues carry no severity; it comes from the list they are in. */
type HubIssue = { code: string; message: string; nodeId?: string; edgeId?: string };
function normaliseValidation(body: { valid: boolean; errors?: HubIssue[]; warnings?: HubIssue[] }): ValidationResult {
  return {
    valid: body.valid,
    issues: [
      ...(body.errors ?? []).map((i) => ({ ...i, severity: 'error' as const })),
      ...(body.warnings ?? []).map((i) => ({ ...i, severity: 'warning' as const })),
    ],
  };
}

/** `@perpeto/workflow` diffs list whole nodes and edges; the screens work with ids. */
type HubSection = { added: { id: string }[]; removed: { id: string }[]; changed: { id: string; layoutOnly?: boolean }[] };
function normaliseDiff(body: { nodes: HubSection; edges: HubSection }): GraphDiff {
  const ids = (section: HubSection) => ({
    added: section.added.map((x) => x.id),
    removed: section.removed.map((x) => x.id),
    changed: section.changed.filter((x) => !x.layoutOnly).map((x) => x.id),
  });
  return { nodes: ids(body.nodes), edges: ids(body.edges) };
}

/**
 * Version records keep the status they were saved with (always draft); the
 * workflow head's `activeVersion` says which one is live. Versions below it
 * are shown as previous, above it as proposals.
 */
function withActive(versions: Workflow[], activeVersion?: number): Workflow[] {
  return versions.map((v) => ({
    ...v,
    status: activeVersion === undefined ? 'draft' : v.version === activeVersion ? 'active' : v.version < activeVersion ? 'paused' : 'draft',
  }));
}

/** The hub reports `windowSec`; the screens key on the window they asked for. */
function normaliseMetrics(body: MetricsSnapshot & { windowSec?: number }, window: MetricsWindow): MetricsSnapshot {
  return { ...body, window };
}

const EVENT_PAGE = 1000;
const EVENT_CACHE = 5000;

/** Client for Hub API v1 (docs/architecture/README.md). */
export class HttpHub implements HubApi {
  readonly mode = 'hub' as const;
  readonly #base: string;
  readonly #auth: HubAuth;
  /** Recent events, oldest first, and the cursor after the last one. */
  #events: HubEvent[] = [];
  #cursor = 0;
  #loading: Promise<void> | null = null;

  constructor(settings: HubSettings) {
    this.#base = settings.baseUrl.replace(/\/+$/, '');
    this.#auth = settings.auth;
  }

  /**
   * Ask the hub to set an HttpOnly owner session cookie. Feature check
   * first: a plain bearer `GET /session` (no credentials, so it passes the
   * hub's current CORS rules). 404 or 405 means the hub has no session
   * route yet and this returns false, so the caller keeps the token for this
   * tab only. A hub that has the route but refuses credentialed CORS also
   * returns false.
   */
  static async startSession(baseUrl: string, token: string): Promise<boolean> {
    const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/session`;
    let probe: Response;
    try {
      probe = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    } catch {
      throw new HubError(0, 'NETWORK', 'The hub could not be reached.');
    }
    if (probe.status === 404 || probe.status === 405) return false;
    if (!probe.ok) throw await errorFrom(probe);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ idempotencyKey: newIdempotencyKey() }),
      });
    } catch {
      return false;
    }
    if (!response.ok) throw await errorFrom(response);
    return true;
  }

  /** True while the hub still accepts this browser's session cookie. */
  async hasSession(): Promise<boolean> {
    try {
      await this.#request('GET', '/session');
      return true;
    } catch (error) {
      if (error instanceof HubError && (error.status === 401 || error.status === 404)) return false;
      throw error;
    }
  }

  async endSession(): Promise<void> {
    if (this.#auth.kind !== 'cookie') return;
    await this.#request('DELETE', '/session').catch(() => undefined);
  }

  #init(init: RequestInit & { headers: Record<string, string> }): RequestInit {
    if (this.#auth.kind === 'bearer') init.headers.Authorization = `Bearer ${this.#auth.token}`;
    else init.credentials = 'include';
    return init;
  }

  #url(path: string, query: Query = {}): URL {
    const url = new URL(`${this.#base}/api/v1${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    return url;
  }

  async #request<T>(method: string, path: string, options: { body?: object; query?: Query; auth?: boolean } = {}): Promise<T> {
    const mutating = method !== 'GET' && method !== 'DELETE';
    const body = mutating ? { idempotencyKey: newIdempotencyKey(), ...(options.body ?? {}) } : undefined;
    const headers: Record<string, string> = { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) };
    const init: RequestInit & { headers: Record<string, string> } = { method, headers, body: body ? JSON.stringify(body) : undefined };
    let response: Response;
    try {
      response = await fetch(this.#url(path, options.query), options.auth === false ? init : this.#init(init));
    } catch {
      throw new HubError(0, 'NETWORK', 'The hub could not be reached.');
    }
    if (!response.ok) throw await errorFrom(response);
    if (response.status === 204) return undefined as T;
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
    return list<Project>(await this.#request('GET', '/projects'), 'projects');
  }
  async createProject(input: NewProject) {
    return await this.#request<Project>('POST', '/projects', { body: input });
  }
  async getProject(id: string) {
    return await this.#request<Project>('GET', `/projects/${enc(id)}`);
  }
  async updateProject(id: string, patch: Partial<NewProject>) {
    return await this.#request<Project>('PATCH', `/projects/${enc(id)}`, { body: patch });
  }

  async listWorkflows(projectId: string) {
    return list<Workflow>(await this.#request('GET', `/projects/${enc(projectId)}/workflows`), 'workflows');
  }
  async createWorkflow(projectId: string, input: NewWorkflow) {
    return await this.#request<Workflow>('POST', `/projects/${enc(projectId)}/workflows`, { body: input });
  }
  async getWorkflow(id: string) {
    return await this.#request<Workflow>('GET', `/workflows/${enc(id)}`);
  }
  async saveWorkflow(id: string, update: WorkflowUpdate) {
    return await this.#request<Workflow>('PUT', `/workflows/${enc(id)}`, { body: update });
  }
  async validateWorkflow(id: string, graph: WorkflowGraph) {
    return normaliseValidation(await this.#request('POST', `/workflows/${enc(id)}/validate`, { body: { graph } }));
  }
  async requestDraft(projectId: string, input: DraftRequest) {
    return await this.#request<Assignment>('POST', `/projects/${enc(projectId)}/workflows/drafts`, { body: input });
  }

  getAssignment(id: string) {
    return this.#request<Assignment>('GET', `/assignments/${enc(id)}`);
  }
  async listVersions(workflowId: string) {
    const [body, head] = await Promise.all([this.#request('GET', `/workflows/${enc(workflowId)}/versions`), this.getWorkflow(workflowId)]);
    return withActive(list<Workflow>(body, 'versions'), head.activeVersion);
  }
  async diffVersions(workflowId: string, from: number, to: number): Promise<GraphDiff> {
    return normaliseDiff(await this.#request('GET', `/workflows/${enc(workflowId)}/diff`, { query: { from, to } }));
  }
  async activateVersion(workflowId: string, version: number) {
    return await this.#request<Workflow>('POST', `/workflows/${enc(workflowId)}/activate`, { body: { version } });
  }

  async startRun(workflowId: string) {
    return await this.#request<Run>('POST', `/workflows/${enc(workflowId)}/runs`, { body: {} });
  }

  async listRuns(projectId: string): Promise<Run[]> {
    return list<Run>(await this.#request('GET', `/projects/${enc(projectId)}/runs`), 'runs');
  }
  async getRun(id: string) {
    return await this.#request<Run>('GET', `/runs/${enc(id)}`);
  }
  async pauseRun(id: string) {
    return await this.#request<Run>('POST', `/runs/${enc(id)}/pause`);
  }
  async resumeRun(id: string) {
    return await this.#request<Run>('POST', `/runs/${enc(id)}/resume`);
  }
  async stopRun(id: string) {
    return await this.#request<Run>('POST', `/runs/${enc(id)}/stop`);
  }
  async addRunInput(runId: string, input: RunInput) {
    await this.#request('POST', `/runs/${enc(runId)}/inputs`, { body: { items: [input] } });
  }
  async listWorkItems(runId: string) {
    return list<WorkItem>(await this.#request('GET', `/runs/${enc(runId)}/work-items`), 'workItems');
  }
  async listAssignments(runId: string) {
    return list<Assignment>(await this.#request('GET', `/runs/${enc(runId)}/assignments`), 'assignments');
  }
  /** The engine decides human gates with `pass` or `fail`. */
  async decideWorkItem(id: string, decision: HumanDecision) {
    await this.#request('POST', `/work-items/${enc(id)}/decision`, { body: { decision: decision.decision === 'approve' ? 'pass' : 'fail', ...(decision.note ? { note: decision.note } : {}) } });
  }

  async listMachines() {
    return list<Machine>(await this.#request('GET', '/machines'), 'machines');
  }
  createEnrollmentCode() {
    return this.#request<EnrollmentCode>('POST', '/machines/enrollment-codes');
  }
  async drainMachine(id: string) {
    return await this.#request<Machine>('POST', `/machines/${enc(id)}/drain`);
  }
  async listAccounts() {
    return list<Account>(await this.#request('GET', '/accounts'), 'accounts');
  }

  async listJobs(query: { projectId?: string; runId?: string } = {}) {
    return list<Job>(await this.#request('GET', '/jobs', { query }), 'jobs');
  }
  async getJob(id: string) {
    return await this.#request<Job>('GET', `/jobs/${enc(id)}`);
  }
  async getJobLog(id: string) {
    const body = await this.#request<{ chunks: { chunk: string }[] }>('GET', `/jobs/${enc(id)}/log`);
    return body.chunks.map((c) => c.chunk).join('');
  }
  async mergeQueue(projectId: string) {
    return list<MergeEntry>(await this.#request('GET', `/projects/${enc(projectId)}/merge-queue`), 'entries');
  }

  async runMetrics(runId: string, window: MetricsWindow = '24h') {
    return normaliseMetrics(await this.#request('GET', `/runs/${enc(runId)}/metrics`, { query: { window } }), window);
  }
  async projectMetrics(projectId: string, window: MetricsWindow = '24h') {
    return normaliseMetrics(await this.#request('GET', `/projects/${enc(projectId)}/metrics`, { query: { window } }), window);
  }

  async usage(query: UsageQuery): Promise<UsageSummary> {
    const body = await this.#request<unknown>('GET', '/usage', { query: { ...query } });
    return { groupBy: query.groupBy, rows: list<UsageRow>(body, 'groups') };
  }
  async events(after = 0, limit = 200) {
    return list<HubEvent>(await this.#request('GET', '/events', { query: { after, limit } }), 'events');
  }

  /**
   * The hub pages events oldest first and has no "latest" or per-run query,
   * so this reads forward from the last cursor and keeps the newest
   * EVENT_CACHE events in memory. Later calls only fetch what is new.
   */
  async #catchUp(): Promise<void> {
    this.#loading ??= (async () => {
      for (;;) {
        const page = await this.events(this.#cursor, EVENT_PAGE);
        this.#events.push(...page);
        if (this.#events.length > EVENT_CACHE) this.#events.splice(0, this.#events.length - EVENT_CACHE);
        if (page.length) this.#cursor = page.at(-1)!.seq;
        if (page.length < EVENT_PAGE) return;
      }
    })().finally(() => {
      this.#loading = null;
    });
    return this.#loading;
  }
  async latestSeq() {
    await this.#catchUp();
    return this.#cursor;
  }
  async recentEvents(limit: number, match: (event: HubEvent) => boolean = () => true) {
    await this.#catchUp();
    return this.#events.filter(match).slice(-limit);
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
      if (event.seq > this.#cursor) {
        this.#events.push(event);
        if (this.#events.length > EVENT_CACHE) this.#events.shift();
        this.#cursor = event.seq;
      }
      onEvent(event);
    };

    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const loop = async () => {
      onState('connecting');
      while (!stopped) {
        controller = new AbortController();
        try {
          const response = await fetch(this.#url('/events', { after: cursor }), this.#init({ headers: { Accept: 'text/event-stream' }, signal: controller.signal }));
          if (!response.ok) throw await errorFrom(response);
          const type = response.headers.get('content-type') ?? '';
          if (!type.includes('text/event-stream') || !response.body) {
            onState('polling');
            for (const event of list<HubEvent>(await response.json(), 'events')) deliver(event);
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
    return list<Channel>(await this.#request('GET', `/messaging/projects/${enc(projectId)}/channels`), 'channels');
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

async function errorFrom(response: Response): Promise<HubError> {
  let code = `HTTP_${response.status}`;
  let message = `The hub returned HTTP ${response.status}.`;
  try {
    const parsed = (await response.json()) as { error?: { code?: string; message?: string } };
    if (parsed.error?.code) code = parsed.error.code;
    if (parsed.error?.message) message = parsed.error.message;
  } catch {
    /* non-JSON error body */
  }
  return new HubError(response.status, code, message);
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
