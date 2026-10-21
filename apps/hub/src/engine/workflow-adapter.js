import { randomUUID } from 'node:crypto';
import {
  WorkflowError, RunStore, step, validateGraph, diffGraphs as diff, buildArchitectPrompt as architectPrompt,
  parseArchitectResult as parseArchitect, computeRunMetrics as runMetrics, listTemplates, getTemplate,
} from '@perpeto/workflow';
import { HubError } from '../errors.js';

/**
 * Hub WorkflowEngine boundary (all methods may return promises).
 * validate(graph) -> { valid: boolean, errors: unknown[], warnings?: unknown[] }
 * startRun({ run, workflow, input, project? }) -> { state: JSONValue, effects: Effect[] }
 * applyEvent({ run, workflow, state, event }) -> { state: JSONValue, effects: Effect[] }
 * An engine with `persistsState: true` keeps run state itself and returns `{ seq, duplicate?, effects }` instead of
 * `state`. The hub then stores only the last applied `seq` per run. Through `lastSeq` and `missed` it applies the
 * effects of events a rolled-back hub transaction missed; `pendingRuns` and `acknowledge` drain the engine's outbox. `open({ databasePath })` and `close()` bracket
 * the hub's lifetime; `listWorkItems(runId)`, `getWorkItem(id)` and `runState(runId)` read its run state.
 * diffGraphs(fromGraph, toGraph) -> JSON graph diff
 * buildArchitectPrompt({ prompt, project, machines, providers, workflows, baseGraph, validationErrors, attempt }) -> string
 * parseArchitectResult(assignmentResult) -> { graph, rationale } (throw on malformed output)
 * computeRunMetrics({ projectId?, runId?, runs, states, workflows, assignments, jobs, workItems, machines, usage, events, window, windowMs, from, at })
 *   -> { nodes: NodeMetrics[], edges: EdgeMetrics[], run: RunMetrics, bottlenecks: Bottleneck[] }
 * The hub overlays run.activeAgents/machines from unexpired leases.
 * Effect is { type: 'work-item'|'assignment'|'job'|'merge-entry'|'run'|'event', value: object }.
 * Entity effects carry IDs; run effects patch the current run. Opaque state is persisted atomically with effects by
 * the hub. Engines must perform no side effects beyond their own persistence.
 * @typedef {{ validate: Function, startRun: Function, applyEvent: Function }} WorkflowEngine
 */

const STATUS = { NOT_FOUND: 404, RUN_NOT_FOUND: 404, RUN_EXISTS: 409, RUN_NOT_ACTIVE: 409, NOT_WAITING: 409, INVALID_TRANSITION: 409, IDEMPOTENCY_CONFLICT: 409, STALE_DECISION: 409 };
const RUN_STATUSES = new Set(['running', 'paused', 'stopped', 'completed', 'failed']);
// The hub records these itself (lifecycle, CI/review/human gates and run transitions); the engine's copies would duplicate them.
const HUB_OWNED_EVENTS = new Set(['assignment.state', 'run.started', 'run.paused', 'run.resumed', 'run.stopped', 'run.completed', 'run.failed']);
const ENTITY_KINDS = [['workItems', 'work-item'], ['merges', 'merge-entry']];
const SUMMARY_MAX = 20000;
const INTERACTIONS = new Set(['workitem.moved', 'agent.delegated', 'agent.messaged']);
const OUTBOX_PAGE = 500;

/** Run engine calls, translating workflow errors to the hub's error envelope. */
function engine(fn) {
  try { return fn(); } catch (error) {
    if (error instanceof WorkflowError) throw new HubError(STATUS[error.code] ?? 400, error.code, error.message);
    throw error;
  }
}

const clip = (text, max = SUMMARY_MAX) => text.length > max ? `${text.slice(0, max - 15)}\n[truncated]` : text;

/** Engine `emit-event` effects become hub events, except those the hub records itself. */
function events(effects) {
  const out = [];
  for (const effect of effects) {
    if (effect.type !== 'emit-event') continue;
    const { type, subject, data } = effect.event;
    if (HUB_OWNED_EVENTS.has(type)) continue;
    // Review, CI and human gate results are recorded by the hub when the result arrives; only merges come from here.
    if (type === 'gate.result' && data.gate !== 'merge-queue') continue;
    const value = { type, subject, data: { ...data } };
    if (type === 'workitem.moved') Object.assign(value.data, { nodeId: data.from, sourceNodeId: data.from, targetNodeId: data.to });
    out.push({ type: 'event', value });
  }
  return out;
}

/**
 * Hub effects from the engine's own effects alone, so outbox effects the hub missed translate the same way. Work items
 * stay in the run store. Merge entries change only through `enqueue-merge`, `cancel-merge` and results the hub itself
 * reports, so these two effects keep the hub's merge entries complete.
 */
/** The input items an event adds, in the order the engine creates their work items. */
const inputsOf = event => event?.type === 'input.added' ? event.data?.items ?? [] : event?.type === 'run.started' ? event.data?.inputs ?? [] : [];

/**
 * Work items the event created, so the hub can link them to goals: a root item takes the `goalId` of the input item
 * that produced it (the engine creates them in input order), and a planned child names its parent.
 */
function createdItems(effects, inputs) {
  let root = 0; const out = [];
  for (const effect of effects) {
    if (effect.type !== 'create-work-item') continue;
    const { id, parentId } = effect.workItem;
    const goalId = parentId ? undefined : inputs[root++]?.goalId;
    out.push({ type: 'work-item-created', value: { id, ...(parentId ? { parentId } : {}), ...(typeof goalId === 'string' ? { goalId } : {}) } });
  }
  return out;
}

function translateEffects(run, effects, status, inputs = [], event, stoppedAt) {
  const out = [...createdItems(effects, inputs)];
  for (const effect of effects) {
    if (effect.type === 'request-input') out.push({ type: 'request-input', value: effect });
    if (effect.type === 'create-assignment') out.push({ type: 'assignment', value: { ...effect.assignment, projectId: run.projectId } });
    if (effect.type === 'create-job') out.push({ type: 'job', value: effect.job });
    if (effect.type === 'enqueue-merge') out.push({ type: 'merge-entry', value: { ...effect.mergeEntry, projectId: run.projectId } });
    if (effect.type === 'cancel-merge') out.push({ type: 'merge-entry', value: { id: effect.mergeId, status: 'rejected', reason: effect.reason } });
  }
  if (event?.data?.hubIntake && (effects.some(effect => effect.type === 'create-work-item') || !event.data.items.length)) out.push({ type: 'input-delivered', value: event.data.hubIntake });
  out.push(...events(effects));
  if (status && status !== run.status && RUN_STATUSES.has(status)) out.push({ type: 'run', value: { status, ...(stoppedAt ? { stoppedAt } : {}) } });
  return out;
}

/** Runs started before state moved to the run store keep their whole state in the hub. Steps share untouched entities. */
function translate(run, before, result, inputs = [], event) {
  const { state, effects } = result;
  const out = [...createdItems(effects, inputs)];
  for (const effect of effects) {
    if (effect.type === 'request-input') out.push({ type: 'request-input', value: effect });
    if (effect.type === 'create-assignment') out.push({ type: 'assignment', value: { ...effect.assignment, projectId: run.projectId } });
    if (effect.type === 'create-job') out.push({ type: 'job', value: effect.job });
  }
  for (const [key, type] of ENTITY_KINDS) {
    if (state[key] === before?.[key]) continue;
    for (const [id, value] of Object.entries(state[key] ?? {})) if (before?.[key]?.[id] !== value) out.push({ type, value: { ...value, projectId: run.projectId } });
  }
  if (event?.data?.hubIntake && (effects.some(effect => effect.type === 'create-work-item') || !event.data.items.length)) out.push({ type: 'input-delivered', value: event.data.hubIntake });
  out.push(...events(effects));
  if (state.status !== run.status && RUN_STATUSES.has(state.status)) out.push({ type: 'run', value: { status: state.status, ...(state.stoppedAt ? { stoppedAt: state.stoppedAt } : {}) } });
  return out;
}

const stamped = event => ({ id: event.id ?? randomUUID(), at: event.at ?? new Date().toISOString(), type: event.type, data: event.data });

function apply(run, state, event) {
  const result = engine(() => step(state, stamped(event)));
  if (result.ignored) return { state, effects: [], ignored: result.ignored };
  return { state: result.state, effects: translate(run, state, result, inputsOf(event), event) };
}

/**
 * Review gates decide on `verdict`. The contract makes a review without one an error, not a rejection, so a
 * `success` without a verdict (the engine's legacy pass) is sent as a verdict-less failure, which the engine retries.
 */
function engineResult(data, node) {
  const summary = clip(typeof data.summary === 'string' ? data.summary : '');
  const result = { outcome: data.outcome, summary };
  for (const key of ['branch', 'prUrl', 'threadRef']) if (typeof data[key] === 'string') result[key] = data[key];
  if (typeof data.headSha === 'string') result.headSha = data.headSha.toLowerCase();
  if (Array.isArray(data.items)) result.items = data.items.map(item => ({ title: item?.title, ...(item?.body !== undefined ? { body: item.body } : {}), ...(item?.touches !== undefined ? { touches: item.touches } : {}) }));
  if (data.rebaseTouchedBeyondConflicts !== undefined) result.rebaseTouchedBeyondConflicts = data.rebaseTouchedBeyondConflicts;
  if (node?.type !== 'review') return result;
  if (data.verdict === 'pass' || data.verdict === 'fail') return { ...result, verdict: data.verdict };
  if (data.outcome !== 'success') return result;
  return { ...result, outcome: 'failure', summary: clip(`Review error: the reviewer ended without a verdict.${summary ? `\n\n${summary}` : ''}`) };
}

function jobSummary(data, status) {
  const failed = (data.steps ?? []).filter(item => item?.status && item.status !== 'passed');
  const steps = failed.map(item => `step "${item.name}" ${item.status}${Number.isInteger(item.exitCode) ? ` (exit ${item.exitCode})` : ''}`).join(', ');
  if (status === 'error' || status === 'cancelled') return `CI did not run to completion (${status})${steps ? `: ${steps}` : ''}. The change itself may be fine.`;
  return steps ? `CI failed: ${steps}.` : undefined;
}

function hubEvent(event, nodeOf) {
  const { type, data = {} } = event;
  if (['input.tick', 'usage.recorded'].includes(type)) return { id: event.id, at: event.at, type, data };
  if (type === 'input') {
    const items = Array.isArray(data.items) ? data.items : Array.isArray(data.inputs) ? data.inputs : null;
    if (!items) throw new HubError(400, 'INVALID_INPUT', 'Run input needs an items array of { title, body?, nodeId? }.');
    return { id: event.id ?? `input:${data.idempotencyKey ?? randomUUID()}`, at: event.at, type: 'input.added', data: { items, ...(data.requestId ? { requestId: data.requestId } : {}), ...(data.hubIntake ? { hubIntake: data.hubIntake } : {}) } };
  }
  if (type === 'assignment.finished') {
    const node = nodeOf(event.value?.nodeId);
    return { id: `assignment:${event.assignmentId}:${event.value?.attempt ?? 1}`, type: 'assignment.completed', data: { assignmentId: event.assignmentId, result: engineResult(data, node) } };
  }
  if (type === 'job.finished') {
    // error and cancelled are infrastructure outcomes the engine retries; passed and failed judge the commit.
    const status = data.status;
    const summary = jobSummary(data, status);
    return { id: `job:${event.jobId}:${event.value?.attempt ?? 1}`, type: 'job.completed', data: { jobId: event.jobId, status,
      ...(summary ? { summary } : {}), ...(event.value?.logRef ? { logRef: event.value.logRef } : {}) } };
  }
  if (type === 'merge.finished') {
    return data.status === 'merged'
      ? { id: `merge:${event.mergeEntryId}`, type: 'merge.completed', data: { mergeId: event.mergeEntryId, ...(data.mergedRevision ? { mergedSha: data.mergedRevision } : {}) } }
      : { id: `merge:${event.mergeEntryId}`, type: 'merge.rejected', data: { mergeId: event.mergeEntryId, reason: data.reason || 'Merge queue rejected the entry.', kind: data.rejectionKind ?? 'other' } };
  }
  if (type === 'lease.expired') {
    // The machine stopped renewing (crash, network loss). Report it as a failed attempt so the engine's retry policy decides.
    const kind = event.kind === 'job' ? 'job' : 'assignment';
    return kind === 'job'
      ? { id: `job:${event.entityId}:${event.attempt}:expired`, type: 'job.completed', data: { jobId: event.entityId, status: 'error', summary: 'The machine running this CI job stopped renewing its lease.' } }
      : { id: `assignment:${event.entityId}:${event.attempt}:expired`, type: 'assignment.completed', data: { assignmentId: event.entityId,
        result: { outcome: 'failure', summary: 'The machine running this assignment stopped renewing its lease (crashed harness or lost connection).' } } };
  }
  if (type === 'human.decision') {
    // The decisionId binds the answer to the wait it was given for; the engine refuses it for any later wait.
    const decisionId = data.decisionId;
    return { id: `human:${event.workItemId}:${decisionId ?? randomUUID()}`, type: 'human.decision', data: { workItemId: event.workItemId, decision: data.decision,
      ...(data.note !== undefined ? { note: data.note } : {}), ...(decisionId !== undefined ? { decisionId } : {}) } };
  }
  if (['run.paused', 'run.resumed', 'run.stopped'].includes(type)) return { id: `${type}:${randomUUID()}`, type, data: data.reason ? { reason: data.reason } : {} };
  throw new HubError(400, 'INVALID_INPUT', `Unknown engine event ${type}.`);
}

const architectErrors = errors => (errors ?? []).map(error => typeof error === 'string' ? { code: 'ARCHITECT_RESULT', message: error } : error);
const sum = (values, key) => values.reduce((total, value) => total + (value[key] ?? 0), 0);
const weighted = (parts, pick, weight) => {
  const usable = parts.filter(part => pick(part)?.avg !== null && pick(part)?.avg !== undefined && weight(part) > 0);
  const total = usable.reduce((value, part) => value + weight(part), 0);
  return total ? Math.round(usable.reduce((value, part) => value + pick(part).avg * weight(part), 0) / total * 10) / 10 : null;
};
const worst = (parts, pick) => parts.map(part => pick(part)?.p90).filter(value => value !== null && value !== undefined).reduce((max, value) => Math.max(max, value), -Infinity);
const stat = (parts, pick, weight) => { const p90 = worst(parts, pick); return { avg: weighted(parts, pick, weight), p90: Number.isFinite(p90) ? p90 : null }; };

/**
 * Combine per-run metrics for a project. Counts, tokens and throughput add up. Averages are weighted by finished work.
 * Exact percentiles cannot be merged from summaries, so p90 is the worst run's p90, an upper bound.
 */
function aggregate(results) {
  const nodes = new Map();
  for (const { nodes: list } of results) for (const node of list) (nodes.get(node.nodeId) ?? nodes.set(node.nodeId, []).get(node.nodeId)).push(node);
  const finished = node => node.done + node.failed;
  const nodeMetrics = [...nodes.entries()].map(([nodeId, parts]) => {
    const limits = parts.map(part => part.concurrency).filter(value => value !== null);
    const concurrency = limits.length ? limits.reduce((a, b) => a + b, 0) : null;
    const active = sum(parts, 'active'); const done = sum(parts, 'done'); const failed = sum(parts, 'failed');
    return { nodeId, queued: sum(parts, 'queued'), active, done, failed, concurrency,
      utilization: concurrency ? Math.round(active / concurrency * 100) / 100 : null,
      waitSec: stat(parts, part => part.waitSec, part => finished(part) + part.active), serviceSec: stat(parts, part => part.serviceSec, finished),
      throughputPerHour: Math.round(sum(parts, 'throughputPerHour') * 100) / 100,
      failureRate: done + failed + sum(parts, 'errors') ? Math.round((failed + sum(parts, 'errors')) / (done + failed + sum(parts, 'errors')) * 100) / 100 : null,
      tokens: sum(parts, 'tokens'), errors: sum(parts, 'errors'), retries: sum(parts, 'retries'), escalations: sum(parts, 'escalations'), conflictRejections: sum(parts, 'conflictRejections'), rebases: sum(parts, 'rebases') };
  });
  const edges = new Map();
  for (const { edges: list } of results) for (const edge of list) {
    const entry = edges.get(edge.edgeId) ?? { ...edge, count: 0 };
    entry.count += edge.count; edges.set(edge.edgeId, entry);
  }
  const runs = results.map(result => result.run);
  const itemsDone = results.map(result => result.run.velocity.trend.reduce((a, b) => a + b, 0));
  const totalDone = itemsDone.reduce((a, b) => a + b, 0);
  const tokens = results.reduce((total, result, index) => total + (result.run.tokensPerItem ?? 0) * itemsDone[index], 0);
  const length = Math.max(0, ...runs.map(run => run.velocity.trend.length));
  return {
    nodes: nodeMetrics, edges: [...edges.values()],
    run: {
      velocity: { itemsDonePerDay: Math.round(sum(runs.map(run => run.velocity), 'itemsDonePerDay') * 100) / 100,
        trend: Array.from({ length }, (_, index) => runs.reduce((total, run) => total + (run.velocity.trend[index] ?? 0), 0)) },
      cycleTimeSec: stat(runs, run => run.cycleTimeSec, run => run.velocity.trend.reduce((a, b) => a + b, 0)),
      wip: sum(runs, 'wip'), tokensPerItem: totalDone ? Math.round(tokens / totalDone) : null,
      activeAgents: sum(runs, 'activeAgents'), machines: [],
      retries: sum(runs, 'retries'), escalations: sum(runs, 'escalations'), waitingOnHuman: sum(runs, 'waitingOnHuman'), conflictRejections: sum(runs, 'conflictRejections'), rebases: sum(runs, 'rebases'),
    },
    bottlenecks: results.flatMap(result => result.bottlenecks.map(bottleneck => ({ ...bottleneck, runId: result.runId }))),
    runs: results.map(result => result.runId),
  };
}

/**
 * Hub adapter over `@perpeto/workflow`: the engine with its incremental RunStore, graph validation, diffs, architect
 * support and metrics. Each event costs what it changes; the hub keeps only the last applied sequence per run.
 */
export function createWorkflowAdapter() {
  let store = null; let path = null;
  const runs = () => store ?? (() => { throw new Error('The workflow adapter is not open.'); })();
  function applyStored(run, event) {
    const result = engine(() => runs().apply(run.id, stamped(event)));
    const { status, stoppedAt } = runs().getRun(run.id) ?? {};
    return { seq: result.seq, ...(result.duplicate ? { duplicate: true } : {}), ...(result.ignored ? { ignored: result.ignored } : {}), effects: translateEffects(run, result.effects, status, inputsOf(event), event, stoppedAt) };
  }
  return {
    /** The engine owns retries: the hub reports expired leases instead of requeueing run work itself. */
    retriesLostWork: true,
    persistsState: true,
    open({ databasePath }) {
      if (store && path !== databasePath) throw new Error('This workflow adapter is already open on another database.');
      store ??= new RunStore(databasePath); path = databasePath;
    },
    close() { store?.close(); store = null; path = null; },
    lastSeq(runId) { return runs().getRun(runId)?.lastSeq ?? 0; },
    /**
     * The translated effects of every event after `after`, by sequence. Re-applying a stored event returns its
     * original effects without stepping the engine again, and the event log pages by sequence, so nothing is skipped.
     */
    missed(run, after) {
      const groups = []; let seq = after;
      for (;;) {
        const page = engine(() => runs().listEvents(run.id, { after: seq, limit: OUTBOX_PAGE }));
        for (const row of page) {
          seq = row.seq;
          if (!row.ignored) groups.push({ seq: row.seq, raw: engine(() => runs().apply(run.id, row.event)).effects, inputs: inputsOf(row.event), event: row.event });
        }
        if (page.length < OUTBOX_PAGE) break;
      }
      const { status, stoppedAt } = runs().getRun(run.id) ?? {};
      return { seq, groups: groups.map((group, index) => ({ seq: group.seq, effects: translateEffects(run, group.raw, index === groups.length - 1 ? status : null, group.inputs, group.event, stoppedAt) })) };
    },
    pendingRuns() { return [...new Set(runs().pendingEffects({ limit: OUTBOX_PAGE }).map(row => row.runId))]; },
    /** Acknowledge outbox effects the hub has committed: those at or below `applied(runId)`. */
    acknowledge(applied) {
      for (;;) {
        const rows = runs().pendingEffects({ limit: OUTBOX_PAGE });
        const ids = rows.filter(row => row.seq <= applied(row.runId)).map(row => row.id);
        if (ids.length) runs().ackEffects(ids);
        if (rows.length < OUTBOX_PAGE || !ids.length) return;
      }
    },
    listWorkItems(runId) { return engine(() => runs().listWorkItems(runId)); },
    getWorkItem(id) { return engine(() => runs().getWorkItem(id)); },
    runState(runId) { return engine(() => runs().getState(runId)); },
    validate(graph) {
      const { ok, errors, warnings } = validateGraph(graph);
      // Delivery config is hub-owned until the shared workflow schema recognizes publication.
      for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
        if (node?.type !== 'merge-queue' || node.config?.publication === undefined) continue;
        const publication = node.config.publication;
        if (!['fast-forward-push', 'github-merge-queue'].includes(publication) || (publication === 'github-merge-queue' && node.config.strategy !== 'serial')) {
          errors.push({ code: 'INVALID_CONFIG', nodeId: node.id, message: 'publication must be fast-forward-push, or github-merge-queue with strategy serial.' });
        }
      }
      return { valid: ok && errors.length === 0, errors, warnings };
    },
    startRun({ run, workflow, input, project }) {
      const repo = project?.repo;
      const items = Array.isArray(input) ? input : input?.items ?? input?.inputs;
      const data = { runId: run.id, projectId: run.projectId, workflowId: workflow.id, workflowVersion: workflow.version, graph: workflow.graph,
        ...(repo ? { repo: { ...(repo.url ? { url: repo.url } : {}), defaultBranch: repo.defaultBranch, ...(repo.localPath ? { localPath: repo.localPath } : {}) } } : {}),
        ...(items !== undefined && items !== null ? { inputs: items } : {}), ...Object.fromEntries(['keepOpen', 'budget', 'source', 'schedule'].filter(key => input?.[key] !== undefined).map(key => [key, input[key]])) };
      return applyStored(run, { id: `run:${run.id}`, at: run.startedAt, type: 'run.started', data });
    },
    validateInput(state, data) { return engine(() => step({ ...state, budget: undefined }, stamped(hubEvent({ type: 'input', data })))); },
    applyEvent({ run, workflow, state, event }) {
      if (event.type === 'run.configured') {
        const before = state ?? runs().getState(run.id);
        const configured = { ...before, ...event.data };
        // Validate settings with the engine's run-start contract, without creating another durable run.
        engine(() => step(null, stamped({ type: 'run.started', at: event.at, data: {
          runId: run.id, projectId: run.projectId, workflowId: workflow.id, workflowVersion: workflow.version,
          graph: workflow.graph, repo: before.repo, keepOpen: configured.keepOpen, source: configured.source,
          schedule: configured.schedule, budget: configured.budget,
        } })));
        if (event.data.source !== undefined || event.data.schedule !== undefined) configured.intake = { ...before.intake, requests: {} };
        const result = apply(run, configured, { type: 'input.tick', at: event.at, data: {} });
        if (!state) result.effects.unshift(...Object.values(before.workItems).map(value => ({ type: 'work-item', value })));
        return result;
      }
      const translated = hubEvent(event, nodeId => workflow.graph.nodes.find(node => node.id === nodeId));
      return state ? apply(run, state, translated) : applyStored(run, translated);
    },
    diffGraphs(from, to) { return diff(from ?? null, to); },
    listTemplates() { return listTemplates().map(template => ({ ...template, graph: getTemplate(template.id) })); },
    buildArchitectPrompt({ prompt, project, machines = [], providers = [], workflows = [], baseGraph, validationErrors = [] }) {
      return engine(() => architectPrompt({ project, docs: project.docs ?? [], goals: (project.goals ?? []).map(goal => typeof goal === 'string' ? goal : goal.title),
        machines: machines.map(machine => ({ name: machine.name, id: machine.id, os: machine.os, arch: machine.arch, labels: machine.labels, providers: machine.providers, capacity: machine.capacity, status: machine.status })),
        providers, existingWorkflows: workflows, ...(baseGraph ? { existingWorkflow: { graph: baseGraph } } : {}), userPrompt: prompt, previousErrors: architectErrors(validationErrors) }));
    },
    /** Accepts `{ graph, rationale }` on the result, or the architect's reply text (one fenced json block) in `summary`. */
    parseArchitectResult(result) {
      return engine(() => parseArchitect(result?.graph && typeof result.graph === 'object' ? result : result?.summary));
    },
    computeRunMetrics({ runId, runs, states = {}, events, machines, usage, window, at }) {
      const results = [];
      for (const run of runs) {
        const state = states[run.id] ?? (store ? this.runState(run.id) : null);
        if (!state?.plan) continue;
        // Hub lifecycle events identify the assignment by subject; the engine's formulas read it from data. Interactions
        // recorded before the hub wrote from/to carry their endpoints only as sourceNodeId/targetNodeId.
        const runEvents = events.filter(event => event.runId === run.id).map(event => event.type === 'assignment.state'
          ? { ...event, data: { assignmentId: event.subject.id, ...event.data } }
          : INTERACTIONS.has(event.type) && event.data.from === undefined
            ? { ...event, data: { ...event.data, from: event.data.sourceNodeId, to: event.data.targetNodeId } } : event);
        const result = engine(() => runMetrics(state, runEvents, { now: at, window, machines, usage: usage.filter(record => record.runId === run.id) }));
        results.push(result);
      }
      if (runId) {
        if (!results.length) throw new HubError(409, 'NO_RUN_STATE', 'This run has no engine state to measure.');
        const [{ nodes, edges, run, bottlenecks }] = results;
        return { nodes, edges, run, bottlenecks };
      }
      return aggregate(results);
    },
  };
}
