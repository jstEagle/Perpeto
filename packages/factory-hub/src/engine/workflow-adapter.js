import { randomUUID } from 'node:crypto';
import {
  WorkflowError, step, validateGraph, diffGraphs as diff, buildArchitectPrompt as architectPrompt,
  parseArchitectResult as parseArchitect, computeRunMetrics as runMetrics,
} from '../../../factory-workflow/src/index.js';
import { HubError } from '../errors.js';

/**
 * Hub WorkflowEngine boundary (all methods may return promises).
 * validate(graph) -> { valid: boolean, errors: unknown[], warnings?: unknown[] }
 * startRun({ run, workflow, input, project? }) -> { state: JSONValue, effects: Effect[] }
 * applyEvent({ run, workflow, state, event }) -> { state: JSONValue, effects: Effect[] }
 * diffGraphs(fromGraph, toGraph) -> JSON graph diff
 * buildArchitectPrompt({ prompt, project, machines, providers, workflows, baseGraph, validationErrors, attempt }) -> string
 * parseArchitectResult(assignmentResult) -> { graph, rationale } (throw on malformed output)
 * computeRunMetrics({ projectId?, runId?, runs, states, workflows, assignments, jobs, workItems, machines, usage, events, window, windowMs, from, at })
 *   -> { nodes: NodeMetrics[], edges: EdgeMetrics[], run: RunMetrics, bottlenecks: Bottleneck[] }
 * The hub overlays run.activeAgents/machines from unexpired leases.
 * Effect is { type: 'work-item'|'assignment'|'job'|'merge-entry'|'run'|'event', value: object }.
 * Entity effects carry IDs; run effects patch the current run. State is opaque and
 * persisted atomically with effects by the hub. Engines must perform no side effects.
 * @typedef {{ validate: Function, startRun: Function, applyEvent: Function }} WorkflowEngine
 */

const STATUS = { NOT_FOUND: 404, RUN_EXISTS: 409, RUN_NOT_ACTIVE: 409, NOT_WAITING: 409, INVALID_TRANSITION: 409, IDEMPOTENCY_CONFLICT: 409 };
const RUN_STATUSES = new Set(['running', 'paused', 'stopped', 'completed', 'failed']);
// The hub records these itself (lifecycle, CI/review/human gates and run transitions); the engine's copies would duplicate them.
const HUB_OWNED_EVENTS = new Set(['assignment.state', 'run.started', 'run.paused', 'run.resumed', 'run.stopped', 'run.completed', 'run.failed']);
const ENTITY_KINDS = [['workItems', 'work-item'], ['merges', 'merge-entry']];
const SUMMARY_MAX = 20000;

/** Run engine calls, translating workflow errors to the hub's error envelope. */
function engine(fn) {
  try { return fn(); } catch (error) {
    if (error instanceof WorkflowError) throw new HubError(STATUS[error.code] ?? 400, error.code, error.message);
    throw error;
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clip = (text, max = SUMMARY_MAX) => text.length > max ? `${text.slice(0, max - 15)}\n[truncated]` : text;

/** Translate engine effects into hub effects. Entity values come from the new state so they are always complete. */
function translate(run, before, result) {
  const { state, effects } = result;
  const out = [];
  for (const effect of effects) {
    if (effect.type === 'create-assignment') out.push({ type: 'assignment', value: { ...effect.assignment, projectId: run.projectId } });
    if (effect.type === 'create-job') out.push({ type: 'job', value: effect.job });
  }
  for (const [key, type] of ENTITY_KINDS) {
    for (const [id, value] of Object.entries(state[key] ?? {})) {
      if (!same(before?.[key]?.[id], value)) out.push({ type, value: { ...value, projectId: run.projectId } });
    }
  }
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
  if (state.status !== run.status && RUN_STATUSES.has(state.status)) out.push({ type: 'run', value: { status: state.status } });
  return out;
}

function apply(run, state, event) {
  const result = engine(() => step(state, { id: event.id ?? randomUUID(), at: event.at ?? new Date().toISOString(), type: event.type, data: event.data }));
  if (result.ignored) return { state, effects: [], ignored: result.ignored };
  return { state: result.state, effects: translate(run, state, result) };
}

/**
 * Review gates decide on `verdict`. A review that ends without one, or contradicts itself, is an error that parks
 * the item for a person (`blocked`), never a silent rejection.
 */
function engineResult(data, node) {
  const summary = clip(typeof data.summary === 'string' ? data.summary : '');
  const result = { outcome: data.outcome, summary };
  for (const key of ['branch', 'prUrl', 'threadRef']) if (typeof data[key] === 'string') result[key] = data[key];
  if (typeof data.headSha === 'string') result.headSha = data.headSha.toLowerCase();
  if (Array.isArray(data.items)) result.items = data.items.map(item => ({ title: item?.title, ...(item?.body !== undefined ? { body: item.body } : {}) }));
  if (node?.type !== 'review' || data.outcome === 'blocked') return result;
  if (data.verdict === 'fail') return { ...result, outcome: 'failure' };
  if (data.verdict === 'pass' && data.outcome === 'success') return { ...result, outcome: 'success' };
  const problem = data.verdict === 'pass' ? 'reported verdict "pass" with a failed outcome' : 'ended without a verdict';
  return { ...result, outcome: 'blocked', summary: clip(`Review error: the reviewer ${problem}. Retry the review or fail the item.${summary ? `\n\n${summary}` : ''}`) };
}

function jobSummary(data, status) {
  const failed = (data.steps ?? []).filter(item => item?.status && item.status !== 'passed');
  const steps = failed.map(item => `step "${item.name}" ${item.status}${Number.isInteger(item.exitCode) ? ` (exit ${item.exitCode})` : ''}`).join(', ');
  if (status === 'error') return `CI could not run to completion (infrastructure error)${steps ? `: ${steps}` : ''}. The change itself may be fine.`;
  return steps ? `CI failed: ${steps}.` : undefined;
}

function hubEvent(state, event) {
  const { type, data = {} } = event;
  if (type === 'input') {
    const items = Array.isArray(data.items) ? data.items : Array.isArray(data.inputs) ? data.inputs : null;
    if (!items) throw new HubError(400, 'INVALID_INPUT', 'Run input needs an items array of { title, body?, nodeId? }.');
    return { id: `input:${data.idempotencyKey ?? randomUUID()}`, type: 'input.added', data: { items } };
  }
  if (type === 'assignment.finished') {
    const node = state.plan.nodes[state.assignments[event.assignmentId]?.nodeId];
    return { id: `assignment:${event.assignmentId}:${event.value?.attempt ?? 1}`, type: 'assignment.completed', data: { assignmentId: event.assignmentId, result: engineResult(data, node) } };
  }
  if (type === 'job.finished') {
    // A cancelled job belongs to a stopped run; the run.stopped transition already closed it.
    if (data.status === 'cancelled') return null;
    const status = data.status === 'passed' ? 'passed' : 'failed';
    const summary = jobSummary(data, data.status);
    return { id: `job:${event.jobId}:${event.value?.attempt ?? 1}`, type: 'job.completed', data: { jobId: event.jobId, status,
      ...(summary ? { summary } : {}), ...(event.value?.logRef ? { logRef: event.value.logRef } : {}) } };
  }
  if (type === 'merge.finished') {
    return data.status === 'merged'
      ? { id: `merge:${event.mergeEntryId}`, type: 'merge.completed', data: { mergeId: event.mergeEntryId, ...(data.mergedRevision ? { mergedSha: data.mergedRevision } : {}) } }
      : { id: `merge:${event.mergeEntryId}`, type: 'merge.rejected', data: { mergeId: event.mergeEntryId, reason: data.reason || 'Merge queue rejected the entry.' } };
  }
  if (type === 'human.decision') {
    return { id: `human:${event.workItemId}:${randomUUID()}`, type: 'human.decision', data: { workItemId: event.workItemId, decision: data.decision, ...(data.note !== undefined ? { note: data.note } : {}) } };
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
      failureRate: done + failed ? Math.round(failed / (done + failed) * 100) / 100 : null, tokens: sum(parts, 'tokens') };
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
    },
    bottlenecks: results.flatMap(result => result.bottlenecks.map(bottleneck => ({ ...bottleneck, runId: result.runId }))),
    runs: results.map(result => result.runId),
  };
}

/** Hub adapter over `@perpeto/factory-workflow`: the pure engine, graph validation, diffs, architect support and metrics. */
export function createWorkflowAdapter() {
  return {
    validate(graph) {
      const { ok, errors, warnings } = validateGraph(graph);
      return { valid: ok, errors, warnings };
    },
    startRun({ run, workflow, input, project }) {
      const repo = project?.repo;
      const items = Array.isArray(input) ? input : input?.items ?? input?.inputs;
      const data = { runId: run.id, projectId: run.projectId, workflowId: workflow.id, workflowVersion: workflow.version, graph: workflow.graph,
        ...(repo ? { repo: { ...(repo.url ? { url: repo.url } : {}), defaultBranch: repo.defaultBranch, ...(repo.localPath ? { localPath: repo.localPath } : {}) } } : {}),
        ...(items !== undefined && items !== null ? { inputs: items } : {}), ...(typeof input?.keepOpen === 'boolean' ? { keepOpen: input.keepOpen } : {}) };
      return apply(run, null, { id: `run:${run.id}`, type: 'run.started', data });
    },
    applyEvent({ run, state, event }) {
      const translated = hubEvent(state, event);
      if (!translated) return { state, effects: [] };
      return apply(run, state, translated);
    },
    diffGraphs(from, to) { return diff(from ?? null, to); },
    buildArchitectPrompt({ prompt, project, machines = [], providers = [], baseGraph, validationErrors = [] }) {
      return engine(() => architectPrompt({ project, docs: project.docs ?? [], goals: project.goals ?? [],
        machines: machines.map(machine => ({ name: machine.name, id: machine.id, os: machine.os, arch: machine.arch, labels: machine.labels, providers: machine.providers, capacity: machine.capacity, status: machine.status })),
        providers, ...(baseGraph ? { existingWorkflow: { graph: baseGraph } } : {}), userPrompt: prompt, previousErrors: architectErrors(validationErrors) }));
    },
    /** Accepts `{ graph, rationale }` on the result, or the architect's reply text (one fenced json block) in `summary`. */
    parseArchitectResult(result) {
      return engine(() => parseArchitect(result?.graph && typeof result.graph === 'object' ? { graph: result.graph, rationale: result.rationale } : result?.summary));
    },
    computeRunMetrics({ runId, runs, states = {}, events, machines, usage, window, at }) {
      const results = [];
      for (const run of runs) {
        const state = states[run.id];
        if (!state?.plan) continue;
        // Hub lifecycle events identify the assignment by subject; the engine's formulas read it from data.
        const runEvents = events.filter(event => event.runId === run.id).map(event => event.type === 'assignment.state'
          ? { ...event, data: { assignmentId: event.subject.id, ...event.data } } : event);
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
