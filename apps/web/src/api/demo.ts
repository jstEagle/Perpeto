import { HubError, OWNER_ROLE_ID } from './hub';
import type { HubApi, MessageQuery, StreamState, UsageQuery, WorkflowUpdate } from './hub';
import { createDemoState, DEMO_IDS } from './fixtures';
import type { DemoState } from './fixtures';
import type {
  Assignment,
  DraftRequest,
  HubEvent,
  HumanDecision,
  MetricsSnapshot,
  NewProject,
  NewWorkflow,
  Overview,
  Project,
  Run,
  RunInput,
  UsageRow,
  WorkItem,
  Workflow,
  WorkflowGraph,
} from './types';
import { diffGraphs } from '../workflow/diff';
import { validateGraph } from '../workflow/validate';
import { COL, buildTemplate } from '../workflow/templates';

const clone = <T>(value: T): T => structuredClone(value);
const latency = (ms = 140) => new Promise((resolve) => setTimeout(resolve, ms));
const shortId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

function notFound(what: string): never {
  throw new HubError(404, 'NOT_FOUND', `${what} was not found.`);
}

/** Interactions replayed on the live run so the map and feed move. */
const LIVE_SCRIPT: Record<string, unknown>[] = [
  { type: 'agent.messaged', fromNode: 'builder', toNode: 'reviewer', edgeId: 'm-builder-reviewer', summary: 'Builder asked Reviewer to look at the drain mode tests first' },
  { type: 'workitem.moved', fromNode: 'loop', toNode: 'builder', edgeId: 'e-loop-out-builder', summary: '"Delivery: merge queue batching" back to Builder, iteration 3' },
  { type: 'agent.delegated', fromNode: 'planner', toNode: 'builder', edgeId: 'd-planner-builder', summary: 'Planner assigned "CLI: install script" to Builder' },
  { type: 'assignment.state', nodeId: 'reviewer', state: 'running', machineId: DEMO_IDS.studio, summary: 'Reviewer still on "Hub: metrics endpoint", 14 min in' },
  { type: 'agent.messaged', fromNode: 'reviewer', toNode: 'planner', unplanned: true, edgeId: 'u-reviewer-planner', summary: 'Reviewer asked Planner which goal "Hub: usage by machine" serves' },
];

/** In-memory hub backed by fixtures. Mutations persist until reload. */
export class DemoHub implements HubApi {
  readonly mode = 'demo' as const;
  #state: DemoState;
  #listeners = new Set<(event: HubEvent) => void>();
  #ticker: ReturnType<typeof setInterval> | null = null;
  #tick = 0;

  constructor(now = Date.now()) {
    this.#state = createDemoState(now);
  }

  #emit(type: string, subject: HubEvent['subject'], data: Record<string, unknown>, scope: { projectId?: string; runId?: string } = {}) {
    const event: HubEvent = { seq: ++this.#state.seq, at: new Date().toISOString(), type, subject, data, ...scope };
    this.#state.events.push(event);
    for (const listener of this.#listeners) listener(event);
    return event;
  }

  #project(id: string) {
    return this.#state.projects.find((p) => p.id === id) ?? notFound('Project');
  }
  #latest(workflowId: string) {
    const all = this.#state.versions.filter((v) => v.id === workflowId);
    if (!all.length) notFound('Workflow');
    return all.reduce((a, b) => (b.version > a.version ? b : a));
  }
  #run(id: string) {
    return this.#state.runs.find((r) => r.id === id) ?? notFound('Run');
  }

  async health() {
    await latency(60);
    return { ok: true, version: 'demo' };
  }

  async overview(projectId?: string): Promise<Overview> {
    await latency();
    const runs = this.#state.runs.filter((r) => !projectId || r.projectId === projectId);
    const runIds = new Set(runs.map((r) => r.id));
    const today = new Date().toISOString().slice(0, 10);
    const tokensToday = this.#state.usage
      .filter((u) => u.at.startsWith(today) && (!projectId || u.projectId === projectId))
      .reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0);
    return {
      activeAgents: this.#state.assignments.filter((a) => runIds.has(a.runId) && a.status === 'running').length,
      queuedWork: this.#state.workItems.filter((w) => runIds.has(w.runId) && w.status === 'queued').length,
      tokensToday,
      machinesOnline: this.#state.machines.filter((m) => m.status === 'online').length,
      machinesTotal: this.#state.machines.length,
    };
  }

  async listProjects() {
    await latency();
    return clone(this.#state.projects);
  }
  async createProject(input: NewProject) {
    await latency();
    const now = new Date().toISOString();
    const project: Project = { id: shortId('prj'), name: input.name, repo: input.repo, docs: input.docs ?? [], goals: input.goals ?? [], createdAt: now, updatedAt: now };
    this.#state.projects.push(project);
    this.#state.channels[project.id] = [{ id: 'general', name: 'General' }];
    this.#emit('project.created', { kind: 'project', id: project.id }, {}, { projectId: project.id });
    return clone(project);
  }
  async getProject(id: string) {
    await latency(80);
    return clone(this.#project(id));
  }
  async updateProject(id: string, patch: Partial<NewProject>) {
    await latency();
    const project = this.#project(id);
    Object.assign(project, patch, { updatedAt: new Date().toISOString() });
    this.#emit('project.updated', { kind: 'project', id }, {}, { projectId: id });
    return clone(project);
  }

  async listWorkflows(projectId: string) {
    await latency();
    const ids = [...new Set(this.#state.versions.filter((v) => v.projectId === projectId).map((v) => v.id))];
    return ids.map((id) => clone(this.#latest(id)));
  }
  async createWorkflow(projectId: string, input: NewWorkflow) {
    await latency();
    this.#project(projectId);
    const wf: Workflow = {
      id: shortId('wf'),
      projectId,
      name: input.name,
      purpose: input.purpose,
      version: 1,
      graph: input.graph,
      status: 'draft',
      authoredBy: { kind: 'user' },
      createdAt: new Date().toISOString(),
    };
    this.#state.versions.push(wf);
    this.#emit('workflow.created', { kind: 'workflow', id: wf.id }, { version: 1 }, { projectId });
    return clone(wf);
  }
  async getWorkflow(id: string) {
    await latency(80);
    return clone(this.#latest(id));
  }
  async saveWorkflow(id: string, update: WorkflowUpdate) {
    await latency();
    const issues = validateGraph(update.graph).filter((i) => i.severity === 'error');
    if (issues.length) throw new HubError(422, 'INVALID_WORKFLOW', `${issues.length} validation ${issues.length === 1 ? 'error' : 'errors'}: ${issues[0].message}`);
    const latest = this.#latest(id);
    const next: Workflow = {
      ...clone(latest),
      name: update.name ?? latest.name,
      version: latest.version + 1,
      parentVersion: latest.version,
      graph: clone(update.graph),
      status: 'draft',
      authoredBy: { kind: 'user' },
      rationale: undefined,
      createdAt: new Date().toISOString(),
    };
    this.#state.versions.push(next);
    this.#emit('workflow.saved', { kind: 'workflow', id }, { version: next.version }, { projectId: next.projectId });
    return clone(next);
  }
  async validateWorkflow(_id: string, graph: WorkflowGraph) {
    await latency(60);
    const issues = validateGraph(graph);
    return { valid: !issues.some((i) => i.severity === 'error'), issues };
  }

  async requestDraft(projectId: string, input: DraftRequest): Promise<Assignment> {
    await latency();
    const project = this.#project(projectId);
    const assignment: Assignment = {
      id: shortId('asg'),
      runId: '',
      workItemId: '',
      nodeId: '',
      role: 'workflow-architect',
      prompt: input.prompt,
      harness: { provider: 'claudeAgent', model: 'claude-opus-5-5' },
      policy: { maxSubagents: 0, allowedSubagentProviders: [], canMessage: [] },
      requirements: {},
      status: 'queued',
      attempt: 1,
    };
    this.#state.assignments.push(assignment);
    const scope = { projectId };
    const step = (delay: number, fn: () => void) => setTimeout(fn, delay);
    const progress = (summary: string, state: Assignment['status'] = 'running') => {
      assignment.status = state;
      this.#emit('assignment.state', { kind: 'assignment', id: assignment.id }, { state, summary, machineId: assignment.machineId, provider: 'claudeAgent', model: 'claude-opus-5-5' }, scope);
    };
    progress('Queued for the workflow architect', 'queued');
    step(900, () => {
      assignment.machineId = DEMO_IDS.studio;
      progress('Leased by studio-mac', 'leased');
    });
    step(1800, () => progress(`Reading ${project.docs.length} docs and ${project.goals.length} goals`));
    step(3200, () => progress('Checking 2 online machines and their providers'));
    step(4600, () => progress('Drafting the graph'));
    step(6000, () => progress('Validated: 0 errors, attempt 1 of 3'));
    step(7000, () => {
      const base = input.baseWorkflowId ? this.#latest(input.baseWorkflowId) : undefined;
      const { graph, rationale } = architect(input.prompt, base?.graph);
      let wf: Workflow;
      if (base) {
        wf = { ...clone(base), version: base.version + 1, parentVersion: base.version, graph, status: 'draft', rationale, authoredBy: { kind: 'agent', assignmentId: assignment.id, prompt: input.prompt }, createdAt: new Date().toISOString() };
      } else {
        wf = { id: shortId('wf'), projectId, name: 'Build', purpose: 'build', version: 1, graph, status: 'draft', rationale, authoredBy: { kind: 'agent', assignmentId: assignment.id, prompt: input.prompt }, createdAt: new Date().toISOString() };
      }
      this.#state.versions.push(wf);
      assignment.result = { outcome: 'success', summary: `Draft version ${wf.version} of ${wf.name} saved.` };
      assignment.status = 'succeeded';
      this.#emit('assignment.state', { kind: 'assignment', id: assignment.id }, { state: 'succeeded', summary: assignment.result.summary, workflowId: wf.id, version: wf.version }, scope);
      this.#emit('workflow.draft', { kind: 'workflow', id: wf.id }, { version: wf.version, summary: `Architect proposed ${wf.name} version ${wf.version}` }, scope);
    });
    return clone(assignment);
  }

  async getAssignment(id: string) {
    await latency(40);
    return clone(this.#state.assignments.find((a) => a.id === id) ?? notFound('Assignment'));
  }
  async listVersions(workflowId: string) {
    await latency();
    const all = this.#state.versions.filter((v) => v.id === workflowId);
    if (!all.length) notFound('Workflow');
    return clone(all.sort((a, b) => b.version - a.version));
  }
  async diffVersions(workflowId: string, from: number, to: number) {
    await latency(60);
    const all = this.#state.versions.filter((v) => v.id === workflowId);
    const a = all.find((v) => v.version === from) ?? notFound('Version');
    const b = all.find((v) => v.version === to) ?? notFound('Version');
    return diffGraphs(a.graph, b.graph);
  }
  async activateVersion(workflowId: string, version: number) {
    await latency();
    const all = this.#state.versions.filter((v) => v.id === workflowId);
    const target = all.find((v) => v.version === version) ?? notFound('Version');
    for (const v of all) if (v.status === 'active') v.status = 'paused';
    target.status = 'active';
    this.#emit('workflow.activated', { kind: 'workflow', id: workflowId }, { version }, { projectId: target.projectId });
    return clone(target);
  }

  async startRun(workflowId: string) {
    await latency();
    const versions = this.#state.versions.filter((v) => v.id === workflowId);
    const active = versions.find((v) => v.status === 'active');
    if (!active) throw new HubError(409, 'NO_ACTIVE_VERSION', 'Activate a version of this workflow before starting a run.');
    const run: Run = { id: shortId('run'), projectId: active.projectId, workflowId, workflowVersion: active.version, status: 'running', startedAt: new Date().toISOString() };
    this.#state.runs.unshift(run);
    this.#state.channels[active.projectId]?.push({ id: `run-${run.id}`, name: `Run ${run.id}` });
    this.#emit('run.started', { kind: 'run', id: run.id }, {}, { projectId: run.projectId, runId: run.id });
    return clone(run);
  }
  async listRuns(projectId: string) {
    await latency();
    return clone(this.#state.runs.filter((r) => r.projectId === projectId));
  }
  async getRun(id: string) {
    await latency(80);
    return clone(this.#run(id));
  }
  async #setRun(id: string, status: Run['status'], from: Run['status'][]) {
    await latency();
    const run = this.#run(id);
    if (!from.includes(run.status)) throw new HubError(409, 'INVALID_STATE', `This run is ${run.status} and cannot change to ${status}.`);
    run.status = status;
    if (status === 'stopped') run.stoppedAt = new Date().toISOString();
    this.#emit(`run.${status}`, { kind: 'run', id }, { summary: `Run ${status}` }, { projectId: run.projectId, runId: id });
    return clone(run);
  }
  pauseRun(id: string) {
    return this.#setRun(id, 'paused', ['running']);
  }
  resumeRun(id: string) {
    return this.#setRun(id, 'running', ['paused']);
  }
  stopRun(id: string) {
    return this.#setRun(id, 'stopped', ['running', 'paused']);
  }
  async addRunInput(runId: string, input: RunInput) {
    await latency();
    const run = this.#run(runId);
    const graph = this.#state.versions.find((v) => v.id === run.workflowId && v.version === run.workflowVersion)?.graph;
    const inputNode = graph?.nodes.find((n) => n.type === 'input')?.id ?? 'input';
    const item: WorkItem = { id: shortId('wi'), runId, title: input.title, body: input.body ?? '', nodeId: inputNode, status: 'queued', iteration: 1 };
    this.#state.workItems.push(item);
    this.#emit('workitem.created', { kind: 'work_item', id: item.id }, { nodeId: inputNode, summary: `${input.kind === 'idea' ? 'Idea' : 'Input'} added: "${input.title}"` }, { projectId: run.projectId, runId });
    return clone(item);
  }
  async listWorkItems(runId: string) {
    await latency();
    return clone(this.#state.workItems.filter((w) => w.runId === runId));
  }
  async listAssignments(runId: string) {
    await latency();
    return clone(this.#state.assignments.filter((a) => a.runId === runId));
  }
  async decideWorkItem(id: string, decision: HumanDecision) {
    await latency();
    const item = this.#state.workItems.find((w) => w.id === id) ?? notFound('Work item');
    item.status = decision.decision === 'approve' ? 'active' : 'queued';
    this.#emit('gate.result', { kind: 'work_item', id }, { result: decision.decision === 'approve' ? 'pass' : 'fail', nodeId: item.nodeId }, { runId: item.runId });
    return clone(item);
  }

  async listMachines() {
    await latency();
    return clone(this.#state.machines);
  }
  async createEnrollmentCode() {
    await latency();
    const code = Array.from({ length: 3 }, () => Math.random().toString(36).slice(2, 6).toUpperCase()).join('-');
    return { code, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
  }
  async drainMachine(id: string) {
    await latency();
    const machine = this.#state.machines.find((m) => m.id === id) ?? notFound('Machine');
    machine.status = 'draining';
    this.#emit('machine.draining', { kind: 'machine', id }, {});
    return clone(machine);
  }
  async listAccounts() {
    await latency();
    return clone(this.#state.accounts);
  }

  async listJobs(query: { projectId?: string; runId?: string } = {}) {
    await latency();
    return clone(this.#state.jobs.filter((j) => (!query.projectId || j.projectId === query.projectId) && (!query.runId || j.runId === query.runId)));
  }
  async getJob(id: string) {
    await latency(60);
    return clone(this.#state.jobs.find((j) => j.id === id) ?? notFound('Job'));
  }
  async getJobLog(id: string) {
    await latency(60);
    return this.#state.jobLogs[id] ?? '';
  }
  async mergeQueue(projectId: string) {
    await latency();
    return clone(this.#state.mergeQueue.filter((m) => m.projectId === projectId));
  }

  async runMetrics(runId: string): Promise<MetricsSnapshot> {
    await latency(80);
    this.#run(runId);
    return clone(this.#state.metrics[runId] ?? emptyMetrics());
  }
  async projectMetrics(projectId: string): Promise<MetricsSnapshot> {
    await latency(80);
    const run = this.#state.runs.find((r) => r.projectId === projectId && (r.status === 'running' || r.status === 'paused'));
    return clone((run && this.#state.metrics[run.id]) ?? emptyMetrics());
  }

  async usage(query: UsageQuery) {
    await latency();
    const rows = new Map<string, UsageRow>();
    const machineName = (id: string) => this.#state.machines.find((m) => m.id === id)?.name ?? id;
    for (const u of this.#state.usage) {
      if (query.projectId && u.projectId !== query.projectId) continue;
      if (query.runId && u.runId !== query.runId) continue;
      const key = query.groupBy === 'day' ? u.at.slice(0, 10) : query.groupBy === 'machine' ? machineName(u.machineId) : query.groupBy === 'model' ? u.model : u.provider;
      const row = rows.get(key) ?? { key, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      row.inputTokens += u.inputTokens;
      row.outputTokens += u.outputTokens;
      row.cacheReadTokens += u.cacheReadTokens;
      row.cacheWriteTokens += u.cacheWriteTokens;
      rows.set(key, row);
    }
    const list = [...rows.values()];
    list.sort(query.groupBy === 'day' ? (a, b) => a.key.localeCompare(b.key) : (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
    return { groupBy: query.groupBy, rows: list };
  }

  async events(after = 0, limit = 200) {
    await latency(60);
    return clone(this.#state.events.filter((e) => e.seq > after).slice(-limit));
  }

  subscribe(after: number, onEvent: (event: HubEvent) => void, onState: (state: StreamState) => void) {
    for (const e of this.#state.events) if (e.seq > after) onEvent(clone(e));
    this.#listeners.add(onEvent);
    onState('live');
    this.#startTicker();
    return () => {
      this.#listeners.delete(onEvent);
      if (this.#listeners.size === 0 && this.#ticker) {
        clearInterval(this.#ticker);
        this.#ticker = null;
      }
      onState('closed');
    };
  }

  /** Replays small interactions on the live run so the demo feels current. */
  #startTicker() {
    if (this.#ticker) return;
    this.#ticker = setInterval(() => {
      const run = this.#state.runs.find((r) => r.id === DEMO_IDS.run);
      if (!run || run.status !== 'running') return;
      const next = LIVE_SCRIPT[this.#tick++ % LIVE_SCRIPT.length];
      const { type, ...data } = next;
      const metrics = this.#state.metrics[DEMO_IDS.run];
      const edge = metrics.edges.find((e) => e.edgeId === data.edgeId);
      if (edge) edge.count += 1;
      this.#emit(String(type), { kind: String(type).split('.')[0], id: shortId('ev') }, data, { projectId: DEMO_IDS.perpeto, runId: DEMO_IDS.run });
    }, 9000);
  }

  async listChannels(projectId: string) {
    await latency();
    return clone(this.#state.channels[projectId] ?? []);
  }
  async readMessages(projectId: string, channelId: string, query: MessageQuery) {
    await latency();
    const all = this.#state.messages.filter((m) => m.projectId === projectId && m.channelId === channelId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const limit = query.limit ?? 50;
    const indexOf = (cursor?: string) => (cursor ? Number(cursor.replace('c', '')) : -1);
    let page = all;
    if (query.before) page = all.slice(Math.max(0, indexOf(query.before) - limit), indexOf(query.before));
    else if (query.after) page = all.slice(indexOf(query.after) + 1, indexOf(query.after) + 1 + limit);
    else page = all.slice(-limit);
    const first = all.indexOf(page[0]);
    const last = all.indexOf(page[page.length - 1]);
    return {
      messages: clone(page),
      previousCursor: `c${Math.max(first, 0)}`,
      nextCursor: `c${last}`,
      hasMore: first > 0,
    };
  }
  async sendMessage(projectId: string, channelId: string, input: { body: string; recipientRoleId?: string }) {
    await latency();
    const message = {
      id: shortId('msg'),
      projectId,
      channelId,
      senderRoleId: OWNER_ROLE_ID,
      recipientRoleId: input.recipientRoleId ?? null,
      body: input.body,
      createdAt: new Date().toISOString(),
    };
    this.#state.messages.push(message);
    this.#emit('message.created', { kind: 'message', id: message.id }, { channelId }, { projectId });
    return clone(message);
  }
}

function emptyMetrics(): MetricsSnapshot {
  return {
    window: '24h',
    nodes: [],
    edges: [],
    run: { velocity: { itemsDonePerDay: 0, trend: [] }, cycleTimeSec: { avg: 0, p90: 0 }, wip: 0, tokensPerItem: 0, activeAgents: 0, machines: [] },
    bottlenecks: [],
  };
}

/**
 * Stand-in for the workflow architect. The real architect is an agent run
 * through T3; this only adapts a template so the demo can show the flow.
 */
function architect(prompt: string, base?: WorkflowGraph): { graph: WorkflowGraph; rationale: string } {
  const text = prompt.toLowerCase();
  const graph = clone(base ?? buildTemplate());
  const notes: string[] = [];
  if (/approv|human|sign.?off|deploy/.test(text) && !graph.nodes.some((n) => n.type === 'human')) {
    const merge = graph.nodes.find((n) => n.type === 'merge-queue');
    const into = graph.edges.find((e) => e.kind === 'flow' && e.to.node === merge?.id && e.from.port === 'pass');
    if (merge && into) {
      const at = { ...merge.position };
      for (const n of graph.nodes) if (n.position.y === at.y && n.position.x >= at.x) n.position = { ...n.position, x: n.position.x + COL };
      graph.nodes.push({ id: 'approval', type: 'human', label: 'Owner approval', position: at, config: { prompt: 'Approve this change for merge.' } });
      into.to = { node: 'approval' };
      into.id = `e-${into.from.node}-${into.from.port}-approval`;
      graph.edges.push(
        { id: 'e-approval-pass-merge', from: { node: 'approval', port: 'pass' }, to: { node: merge.id }, kind: 'flow' },
        { id: 'e-approval-fail-loop', from: { node: 'approval', port: 'fail' }, to: { node: 'loop' }, kind: 'flow' },
      );
      notes.push('A human approval gate sits before the merge queue, so nothing merges without you.');
    }
  }
  if (/review|second opinion|quality/.test(text)) {
    const reviewer = graph.nodes.find((n) => n.type === 'review');
    if (reviewer) {
      reviewer.config = { ...reviewer.config, concurrency: Math.max(2, Number(reviewer.config.concurrency ?? 1) + 1) };
      notes.push(`Reviewer concurrency is ${String(reviewer.config.concurrency)} so review keeps pace with builders.`);
    }
  }
  if (/codex|second model|different model/.test(text)) {
    const reviewer = graph.nodes.find((n) => n.type === 'review');
    if (reviewer) {
      reviewer.config = { ...reviewer.config, harness: { provider: 'codex', model: 'gpt-5.5-codex' } };
      notes.push('Review runs on Codex for an independent second model family.');
    }
  }
  if (/fast|cheap|small|budget/.test(text)) {
    const builder = graph.nodes.find((n) => n.type === 'agent');
    if (builder) {
      builder.config = { ...builder.config, harness: { provider: 'claudeAgent', model: 'claude-haiku-5-5' }, policy: { maxSubagents: 0, allowedSubagentProviders: [], maxTurns: 40 } };
      notes.push('Builders use a smaller model with no subagents to keep token use low.');
    }
  }
  if (!notes.length) notes.push('A planner splits the goals into work items, builders work in parallel, and every change passes an agent review and CI before the merge queue. Failed review or CI returns through a loop capped at 3 iterations.');
  return { graph, rationale: `${notes.join(' ')} Validated against the workflow schema with 0 errors.` };
}
