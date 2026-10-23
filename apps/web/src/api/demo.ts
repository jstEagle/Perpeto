import { HubError, OWNER_ROLE_ID } from './hub';
import type { EventQuery, HubApi, MessageQuery, NewMessage, StreamState, UsageQuery, WorkflowUpdate } from './hub';
import { createDemoState, DEMO_IDS } from './fixtures';
import { applyPacingSettings, demoPacing, demoSubscriptions } from './pacing-fixtures';
import { DemoMergeQueues } from './merge-queue-fixtures';
import type { DemoState } from './fixtures';
import { observeAccounts, observeMachines, observePacing, observeSessions, observeSummary } from './observe-fixtures';
import type {
  Account,
  AccountPatch,
  Assignment,
  Pacing,
  PacingSettings,
  MergeEntryCommand,
  MergeQueueConfig,
  MetricsWindow,
  DraftRequest,
  Goal,
  GoalInput,
  HubEvent,
  HumanDecision,
  Message,
  UnreadState,
  MetricsSnapshot,
  NewProject,
  NewWorkflow,
  Overview,
  Project,
  Run,
  RunInput,
  RunSettings,
  Session,
  SessionQuery,
  SessionsWindow,
  UsageRow,
  WorkItem,
  Workflow,
  WorkflowGraph,
  WorkflowTemplate,
} from './types';
import { libraryTemplates } from './library';
import { diffGraphs } from '../workflow/diff';
import { validateGraph } from '../workflow/validate';
import { COL, buildTemplate } from '../workflow/templates';

const today = () => new Date().toISOString().slice(0, 10);
const LIMITS = ['maxTokensPerDay', 'maxActiveItems', 'maxItemsPerDay'] as const;

const clone = <T>(value: T): T => structuredClone(value);
const latency = (ms = 140) => new Promise((resolve) => setTimeout(resolve, ms));
const shortId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

function notFound(what: string): never {
  throw new HubError(404, 'NOT_FOUND', `${what} was not found.`);
}

/** Interactions replayed on the live run so the map and feed move. */
const LIVE_SCRIPT: Record<string, unknown>[] = [
  { type: 'agent.messaged', sourceNodeId: 'builder', targetNodeId: 'reviewer', edgeId: 'm-builder-reviewer', summary: 'Builder asked Reviewer to look at the drain mode tests first' },
  { type: 'workitem.moved', sourceNodeId: 'loop', targetNodeId: 'builder', edgeId: 'e-loop-out-builder', summary: '"Delivery: merge queue batching" back to Builder, iteration 3' },
  { type: 'agent.delegated', sourceNodeId: 'planner', targetNodeId: 'builder', edgeId: 'd-planner-builder', summary: 'Planner assigned "CLI: install script" to Builder' },
  { type: 'assignment.state', nodeId: 'reviewer', state: 'running', machineId: DEMO_IDS.studio, summary: 'Reviewer still on "Hub: metrics endpoint", 14 min in' },
  { type: 'agent.messaged', sourceNodeId: 'reviewer', targetNodeId: 'planner', unplanned: true, edgeId: 'u-reviewer-planner', summary: 'Reviewer asked Planner which goal "Hub: usage by machine" serves' },
];

/** In-memory hub backed by fixtures. Mutations persist until reload. */
/** The demo factory's owner, as a hub reports it from its config. */
const DEMO_OWNER = { name: 'Justus', initials: 'JH' };

/** Goals as the hub stores them: existing ones keep their id and progress, new ones start empty. */
function toGoals(input: GoalInput[], existing: Goal[]): Goal[] {
  return input.map((g) => {
    const value = typeof g === 'string' ? { title: g } : g;
    const before = existing.find((x) => (value.id ? x.id === value.id : x.title === value.title));
    return before ? { ...before, title: value.title, status: value.status ?? before.status } : { id: shortId('goal'), title: value.title, status: value.status ?? 'active', workItemIds: [], done: 0, total: 0 };
  });
}

/**
 * Which demo factory to show without a hub. `full` has projects, workflows
 * and runs; `observe` has no projects and only watches T3 Code sessions and
 * subscriptions on two Macs, as a hub in observe-only mode reports them.
 */
export type DemoScenario = 'full' | 'observe';

export class DemoHub implements HubApi {
  readonly mode = 'demo' as const;
  readonly scenario: DemoScenario;
  #state: DemoState;
  #sessions: Session[];
  #listeners = new Set<(event: HubEvent) => void>();
  #ticker: ReturnType<typeof setInterval> | null = null;
  #tick = 0;
  #queues: DemoMergeQueues;

  constructor(now = Date.now(), scenario: DemoScenario = 'full') {
    this.scenario = scenario;
    this.#state = createDemoState(now);
    this.#queues = new DemoMergeQueues(DEMO_IDS.perpeto, now);
    if (scenario === 'observe') {
      // Observe only: nothing but machines, subscriptions and the sessions they watch.
      Object.assign(this.#state, { projects: [], versions: [], runs: [], workItems: [], assignments: [], jobs: [], jobLogs: {}, mergeQueue: [], usage: [], events: [], channels: {}, messages: [], metrics: {} });
      this.#state.machines = observeMachines(now);
      this.#state.accounts = observeAccounts(now);
      this.#sessions = observeSessions(now);
    } else {
      this.#sessions = observeSessions(
        now,
        this.#state.machines.map((m) => ({ id: m.id, name: m.name })),
      );
    }
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
    return { status: 'ok', version: 'demo' };
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
      activeAgents: this.#state.assignments.filter((a) => !!a.runId && runIds.has(a.runId) && a.status === 'running').length,
      queuedWork: this.#state.workItems.filter((w) => runIds.has(w.runId) && w.status === 'queued').length,
      tokensToday,
      machinesOnline: this.#state.machines.filter((m) => m.status === 'online').length,
      machinesTotal: this.#state.machines.length,
      owner: DEMO_OWNER,
      runs: runs.filter((r) => r.status === 'running' || r.status === 'paused').map((r) => this.#view(r)),
    };
  }

  /** A run as the hub's detail and overview report it: today's budget use and whether intake is paused. */
  #view(run: Run): Run {
    const view = clone(run);
    if (!run.budget || !Object.keys(run.budget).length) {
      delete view.budgetUsage;
      return view;
    }
    const day = today();
    const tokens = this.#state.usage.filter((u) => u.runId === run.id && u.at.startsWith(day)).reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0);
    const items = run.budgetUsage?.day === day || !run.budgetUsage?.day ? (run.budgetUsage?.items ?? 0) : 0;
    const active = this.#state.workItems.filter((w) => w.runId === run.id && w.status !== 'done' && w.status !== 'failed').length;
    const used = { maxTokensPerDay: tokens, maxActiveItems: active, maxItemsPerDay: items };
    const limit = LIMITS.find((key) => run.budget?.[key] !== undefined && used[key] >= run.budget[key]!);
    view.budgetUsage = { day, tokens, items };
    view.intake = limit ? { paused: true, reason: { limit, used: used[limit], maximum: run.budget[limit]!, requested: 1, day } } : { paused: false };
    return view;
  }

  async listProjects() {
    await latency();
    return clone(this.#state.projects);
  }
  async createProject(input: NewProject) {
    await latency();
    const now = new Date().toISOString();
    const project: Project = { id: shortId('prj'), name: input.name, repo: input.repo, docs: input.docs ?? [], goals: toGoals(input.goals ?? [], []), createdAt: now, updatedAt: now };
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
    const { goals, ...rest } = patch;
    Object.assign(project, rest, goals ? { goals: toGoals(goals, project.goals) } : {}, { updatedAt: new Date().toISOString() });
    this.#emit('project.updated', { kind: 'project', id }, {}, { projectId: id });
    return clone(project);
  }

  async listWorkflows(projectId: string) {
    await latency();
    const ids = [...new Set(this.#state.versions.filter((v) => v.projectId === projectId).map((v) => v.id))];
    return ids.map((id) => this.#head(id));
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
    return this.#head(id);
  }
  /** The newest version, carrying the active pointer as the hub's head does. */
  #head(id: string): Workflow {
    const active = this.#state.versions.find((v) => v.id === id && v.status === 'active');
    return { ...clone(this.#latest(id)), ...(active ? { activeVersion: active.version } : {}) };
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
      projectId,
      nodeId: 'workflow-architect',
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
      this.#emit('assignment.state', { kind: 'assignment', id: assignment.id }, { state, nodeId: assignment.nodeId, role: assignment.role, attempt: 1, machineId: assignment.machineId, summary }, scope);
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
      // A new workflow comes with one more proposal, saved as its own draft.
      const extra = base ? [] : suggestAlongside(input.prompt, projectId, assignment.id, this.#state.versions);
      this.#state.versions.push(...extra);
      assignment.result = {
        outcome: 'success',
        summary: `Draft version ${wf.version} of ${wf.name} saved.`,
        additionalWorkflows: extra.map((x) => ({ name: x.name, rationale: x.rationale ?? '', templateId: x.templateId })),
      };
      assignment.status = 'succeeded';
      assignment.draftWorkflowId = wf.id;
      assignment.draftVersion = wf.version;
      assignment.drafts = [wf, ...extra].map((x) => ({ workflowId: x.id, version: x.version }));
      for (const x of [wf, ...extra]) this.#emit('workflow.version.saved', { kind: 'workflow', id: x.id }, { version: x.version, authoredBy: x.authoredBy }, scope);
      this.#emit('assignment.state', { kind: 'assignment', id: assignment.id }, { state: 'succeeded', nodeId: assignment.nodeId, role: assignment.role, attempt: 1, machineId: assignment.machineId, summary: assignment.result.summary }, scope);
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

  async listTemplates(): Promise<WorkflowTemplate[]> {
    await latency(60);
    return libraryTemplates();
  }

  async startRun(workflowId: string, settings: RunSettings = {}) {
    await latency();
    const versions = this.#state.versions.filter((v) => v.id === workflowId);
    const active = versions.find((v) => v.status === 'active');
    if (!active) throw new HubError(409, 'NO_ACTIVE_VERSION', 'Activate a version of this workflow before starting a run.');
    const run: Run = {
      id: shortId('run'),
      projectId: active.projectId,
      workflowId,
      workflowVersion: active.version,
      status: 'running',
      startedAt: new Date().toISOString(),
      keepOpen: false,
      ...checkSettings(settings),
    };
    if (run.budget) run.budgetUsage = { day: today(), tokens: 0, items: 0 };
    this.#state.runs.unshift(run);
    this.#state.channels[active.projectId]?.push({ id: `run-${run.id}`, name: `Run ${run.id}` });
    this.#emit('run.started', { kind: 'run', id: run.id }, {}, { projectId: run.projectId, runId: run.id });
    return this.#view(run);
  }
  async updateRun(id: string, settings: RunSettings) {
    await latency();
    const run = this.#run(id);
    if (run.status !== 'running' && run.status !== 'paused') throw new HubError(400, 'INVALID_REQUEST', 'Run is already terminal.');
    const next = checkSettings(settings);
    const wasPaused = !!this.#view(run).intake?.paused;
    Object.assign(run, next);
    if (next.budget && !Object.keys(next.budget).length) delete run.budget;
    if (run.budget && !run.budgetUsage) run.budgetUsage = { day: today(), tokens: 0, items: 0 };
    const view = this.#view(run);
    const scope = { projectId: run.projectId, runId: id };
    this.#emit('run.configured', { kind: 'run', id }, { ...next, summary: 'Run settings changed' }, scope);
    if (wasPaused && !view.intake?.paused) this.#emit('budget.available', { kind: 'run', id }, { summary: 'Intake resumed' }, scope);
    if (!wasPaused && view.intake?.reason) this.#emit('budget.exhausted', { kind: 'run', id }, { ...view.intake.reason, summary: 'Intake paused by the budget' }, scope);
    return view;
  }
  async listRuns(projectId: string) {
    await latency();
    return clone(this.#state.runs.filter((r) => r.projectId === projectId));
  }
  async getRun(id: string) {
    await latency(80);
    return this.#view(this.#run(id));
  }
  async #setRun(id: string, status: Run['status'], from: Run['status'][]) {
    await latency();
    const run = this.#run(id);
    if (!from.includes(run.status)) throw new HubError(409, 'INVALID_STATE', `This run is ${run.status} and cannot change to ${status}.`);
    run.status = status;
    if (status === 'stopped') run.stoppedAt = new Date().toISOString();
    if (status === 'completed') run.completedAt = run.stoppedAt = new Date().toISOString();
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
    this.#emit('run.input', { kind: 'run', id: runId }, { nodeId: inputNode, summary: `Input added: "${input.title}"` }, { projectId: run.projectId, runId });
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
    if (decision.decisionId && item.decisionId && decision.decisionId !== item.decisionId)
      throw new HubError(409, 'STALE_DECISION', 'This decision answers an earlier wait; the work item now waits for another decision.');
    delete item.decisionId;
    item.status = decision.decision === 'approve' ? 'active' : 'queued';
    this.#emit('gate.result', { kind: 'work-item', id }, { result: decision.decision === 'approve' ? 'pass' : 'fail', decision: decision.decision === 'approve' ? 'pass' : 'fail', source: 'human', nodeId: item.nodeId }, { runId: item.runId });
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
  async updateAccount(id: string, patch: AccountPatch): Promise<Account> {
    await latency();
    const account = this.#state.accounts.find((a) => a.id === id) ?? notFound('Account');
    if (patch.label !== undefined) {
      if (!patch.label.trim()) throw new HubError(400, 'INVALID_INPUT', 'A subscription needs a label.');
      account.label = patch.label.trim();
    }
    if (patch.plan !== undefined) account.plan = patch.plan?.trim() || undefined;
    this.#emit('account.updated', { kind: 'account', id }, {});
    this.#emit('pacing.updated', { kind: 'pacing', id: 'pacing' }, {});
    return clone(account);
  }
  async pacing(): Promise<Pacing> {
    await latency();
    if (this.scenario === 'observe') return observePacing(this.#state.createdAt);
    const s = this.#state;
    const plan = demoPacing(demoSubscriptions({ studio: DEMO_IDS.studio, linux: DEMO_IDS.linux }), s.pacing, s.createdAt, s.pacingUpdatedAt);
    // Labels and plans follow edits made on the Accounts screen.
    for (const a of plan.accounts) {
      const own = s.accounts.find((x) => x.id === a.accountId);
      if (own) Object.assign(a, { label: own.label, plan: own.plan });
    }
    return plan;
  }
  async updatePacing(settings: PacingSettings): Promise<Pacing> {
    await latency();
    if (this.scenario === 'observe') throw new HubError(409, 'ADVISE_ONLY', 'This hub only observes, so pacing has no settings to change.');
    if (settings.targetUsePercent !== undefined && !(settings.targetUsePercent >= 50 && settings.targetUsePercent <= 100))
      throw new HubError(400, 'INVALID_INPUT', 'Target use must be between 50% and 100%.');
    this.#state.pacing = applyPacingSettings(this.#state.pacing, settings);
    this.#state.pacingUpdatedAt = Date.now();
    this.#emit('pacing.updated', { kind: 'pacing', id: 'pacing' }, {});
    return this.pacing();
  }

  async listSessions(query: SessionQuery = {}) {
    await latency();
    const since = query.since ? Date.parse(query.since) : Number.NEGATIVE_INFINITY;
    const list = this.#sessions.filter(
      (x) =>
        (!query.machineId || x.machineId === query.machineId) &&
        (!query.status || x.status === query.status) &&
        (!query.provider || x.provider === query.provider) &&
        Date.parse(x.lastActivityAt) >= since,
    );
    const sorted = [...list].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    const start = query.cursor ? Number(query.cursor) : 0;
    const limit = query.limit ?? 100;
    const page = sorted.slice(start, start + limit);
    return { sessions: clone(page), ...(start + limit < sorted.length ? { nextCursor: String(start + limit) } : {}) };
  }
  async sessionsSummary(window: SessionsWindow) {
    await latency();
    return observeSummary(this.#state.createdAt, window, this.#sessions, this.#state.machines);
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
  async mergeQueues(projectId: string) {
    await latency();
    this.#project(projectId);
    return this.#queues.settings(projectId);
  }
  async saveMergeQueues(projectId: string, config: MergeQueueConfig, baseVersion: number) {
    await latency(120);
    const settings = this.#queues.save(projectId, config, baseVersion);
    this.#emit('merge-queue.config-updated', { kind: 'merge-queue-config', id: projectId }, { version: settings.version }, { projectId });
    return settings;
  }
  async mergeQueueView(id: string, window: MetricsWindow = '24h') {
    await latency();
    return this.#queues.view(id, window);
  }
  async freezeMergeQueue(id: string, reason?: string) {
    await latency(80);
    const view = this.#queues.freeze(id, reason);
    this.#emit('merge-queue.frozen', { kind: 'merge-queue', id }, { reason: view.frozen?.reason }, { projectId: view.projectId });
    return view;
  }
  async unfreezeMergeQueue(id: string) {
    await latency(80);
    const view = this.#queues.unfreeze(id);
    this.#emit('merge-queue.unfrozen', { kind: 'merge-queue', id }, {}, { projectId: view.projectId });
    return view;
  }
  async mergeEntryCommand(id: string, command: MergeEntryCommand) {
    await latency(80);
    const entry = this.#queues.command(id, command);
    this.#emit({ priority: 'merge-entry.prioritized', eject: 'merge-entry.ejected', requeue: 'merge-entry.requeued' }[command.action], { kind: 'merge-entry', id }, {}, { projectId: entry.projectId });
    return entry;
  }

  async runMetrics(runId: string): Promise<MetricsSnapshot> {
    await latency(80);
    this.#run(runId);
    return clone(this.#state.metrics[runId] ?? emptyMetrics());
  }
  async projectMetrics(projectId: string): Promise<MetricsSnapshot> {
    await latency(80);
    // The project's main run carries the numbers; every live run contributes its bottlenecks, tagged with the run as the hub does.
    const live = this.#state.runs.filter((r) => r.projectId === projectId && (r.status === 'running' || r.status === 'paused'));
    const snapshot = clone((live[0] && this.#state.metrics[live[0].id]) ?? emptyMetrics());
    snapshot.bottlenecks = live.flatMap((r) => (this.#state.metrics[r.id]?.bottlenecks ?? []).map((b) => ({ ...clone(b), runId: r.id })));
    return snapshot;
  }

  async usage(query: UsageQuery) {
    await latency();
    const rows = new Map<string, UsageRow>();
    const machineName = (id: string) => this.#state.machines.find((m) => m.id === id)?.name ?? id;
    for (const u of this.#state.usage) {
      if (query.projectId && u.projectId !== query.projectId) continue;
      if (query.runId && u.runId !== query.runId) continue;
      const key =
        query.groupBy === 'day'
          ? u.at.slice(0, 10)
          : query.groupBy === 'machine'
            ? machineName(u.machineId)
            : query.groupBy === 'model'
              ? u.model
              : query.groupBy === 'role'
                ? (u.role ?? 'unknown')
                : u.provider;
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

  async latestSeq() {
    return this.#state.seq;
  }

  async eventPage({ runId, projectId, before, limit = 200 }: EventQuery = {}) {
    await latency(60);
    const matching = this.#state.events.filter((e) => (!runId || e.runId === runId) && (!projectId || e.projectId === projectId) && (!before || e.seq < before));
    const page = matching.slice(-limit);
    return { events: clone(page).reverse(), before: page[0]?.seq ?? before ?? 0, hasMore: matching.length > page.length };
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
      // Running sessions take a turn now and then.
      const running = this.#sessions.filter((x) => x.status === 'running');
      const busy = running[this.#tick % Math.max(1, running.length)];
      if (busy) {
        busy.turns += 1;
        busy.tokens.input += 2_400;
        busy.tokens.output += 600;
        busy.lastActivityAt = new Date().toISOString();
        this.#emit('session.updated', { kind: 'session', id: busy.id }, { status: busy.status });
      }
      const run = this.#state.runs.find((r) => r.id === DEMO_IDS.run);
      if (!run) this.#tick++;
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
    const all = this.#state.messages
      .filter((m) => m.projectId === projectId && m.channelId === channelId && (!query.threadId || m.threadId === query.threadId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
  async sendMessage(projectId: string, channelId: string, input: NewMessage) {
    await latency();
    const parent = input.parentId ? this.#state.messages.find((m) => m.id === input.parentId) : undefined;
    // As the hub: a reply without a recipient answers the parent's sender (or, to your own message, its recipient).
    const recipient = input.recipientRoleId !== undefined ? input.recipientRoleId : parent ? (parent.senderRoleId === OWNER_ROLE_ID ? parent.recipientRoleId : parent.senderRoleId) : null;
    const id = shortId('msg');
    const message: Message = {
      id,
      projectId,
      channelId,
      senderRoleId: OWNER_ROLE_ID,
      recipientRoleId: recipient,
      body: input.body,
      createdAt: new Date().toISOString(),
      threadId: parent?.threadId ?? id,
      parentId: parent?.id ?? null,
      senderKind: 'owner',
      unplanned: false,
      receipt: recipient ? { state: 'stored' } : null,
    };
    this.#state.messages.push(message);
    this.#state.readCursors[`${projectId}|${channelId}`] = id;
    this.#emit('message.created', { kind: 'message', id }, { channelId }, { projectId });
    // A running role picks it up at its next renewal: the demo delivers it into the turn a moment later.
    if (recipient && recipient !== OWNER_ROLE_ID && channelId.startsWith('run-'))
      setTimeout(() => {
        message.receipt = { state: 'delivered', deliveredAt: new Date().toISOString(), deliveredVia: 'steer' };
        this.#emit('message.delivered', { kind: 'message', id }, { messageId: id, channelId, via: 'steer' }, { projectId });
      }, 2500);
    return clone(message);
  }
  async ackMessage(projectId: string, channelId: string, messageId: string, note?: string) {
    await latency();
    const m = this.#state.messages.find((x) => x.id === messageId && x.projectId === projectId && x.channelId === channelId) ?? notFound('Message');
    if (m.recipientRoleId !== OWNER_ROLE_ID) throw new HubError(403, 'NOT_RECIPIENT', 'This message is not addressed to you.');
    if (m.receipt?.state !== 'acked') {
      const now = new Date().toISOString();
      m.receipt = { ...m.receipt, state: 'acked', deliveredAt: m.receipt?.deliveredAt ?? now, deliveredVia: m.receipt?.deliveredVia ?? 'read', ackedAt: now, ackNote: note ?? null };
      this.#emit('message.acked', { kind: 'message', id: m.id }, { messageId: m.id, channelId, by: 'owner' }, { projectId });
    }
    return clone(m);
  }
  #unread(projectId: string, channelId: string): UnreadState {
    const all = this.#state.messages.filter((m) => m.projectId === projectId && m.channelId === channelId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const cursor = this.#state.readCursors[`${projectId}|${channelId}`] ?? null;
    const after = cursor ? all.slice(all.findIndex((m) => m.id === cursor) + 1) : all;
    const unreadCount = after.filter((m) => m.senderRoleId !== OWNER_ROLE_ID && (m.recipientRoleId === OWNER_ROLE_ID || m.recipientRoleId === null)).length;
    return { roleId: OWNER_ROLE_ID, unreadCount, lastReadMessageId: cursor };
  }
  async unread(projectId: string, channelId: string) {
    await latency(40);
    return this.#unread(projectId, channelId);
  }
  async markRead(projectId: string, channelId: string, messageId: string) {
    await latency(40);
    const all = this.#state.messages.filter((m) => m.projectId === projectId && m.channelId === channelId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const key = `${projectId}|${channelId}`;
    const current = all.findIndex((m) => m.id === this.#state.readCursors[key]);
    // Cursors only move forward.
    if (all.findIndex((m) => m.id === messageId) > current) this.#state.readCursors[key] = messageId;
    return this.#unread(projectId, channelId);
  }
}

/** The hub's run setting checks, so the demo refuses what the hub would. */
function checkSettings(settings: RunSettings): RunSettings {
  const invalid = (message: string): never => {
    throw new HubError(400, 'INVALID_REQUEST', message);
  };
  if (settings.keepOpen !== undefined && typeof settings.keepOpen !== 'boolean') invalid('keepOpen must be a boolean.');
  if (settings.source !== undefined && !['goals', 'schedule', 'manual'].includes(settings.source)) invalid('Invalid run source.');
  if (settings.schedule !== undefined && !/^(\S+\s+){4}\S+$/.test(settings.schedule.trim())) invalid('A schedule is five numeric UTC cron fields.');
  if (settings.source === 'schedule' && !settings.schedule) invalid('A schedule source needs a schedule.');
  if (settings.budget && !Object.values(settings.budget).every((n) => Number.isSafeInteger(n) && n > 0)) invalid('Budget limits must be positive safe integers.');
  return clone(settings);
}

/** One extra proposal next to a new workflow: a bugfix path, else improvement from the goals. */
function suggestAlongside(prompt: string, projectId: string, assignmentId: string, existing: Workflow[]): Workflow[] {
  const has = (purpose: string) => existing.some((w) => w.projectId === projectId && w.purpose === purpose);
  const pick = !has('improve')
    ? { templateId: 'improve', name: 'Improve', rationale: 'Between features, an auditor turns unfinished goals into small, measured improvements. Run it with a daily token budget so it never competes with Build for capacity.' }
    : !has('bugfix')
      ? { templateId: 'bugfix', name: 'Bugfix', rationale: 'Bugs take a shorter path than features: reproduce in a failing test, fix, review and merge, without the planner.' }
      : null;
  const template = pick && libraryTemplates().find((t) => t.id === pick.templateId);
  if (!pick || !template) return [];
  return [
    {
      id: shortId('wf'),
      projectId,
      name: pick.name,
      purpose: pick.templateId as Workflow['purpose'],
      templateId: pick.templateId,
      version: 1,
      graph: template.graph,
      status: 'draft',
      rationale: pick.rationale,
      authoredBy: { kind: 'agent', assignmentId, prompt },
      createdAt: new Date().toISOString(),
    },
  ];
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
