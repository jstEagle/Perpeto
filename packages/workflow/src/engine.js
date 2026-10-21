import { compileGraph } from './graph.js';
import { canonicalJson, fail, isIsoTimestamp, isPlainObject, isText, sha256 } from './util.js';

export const STATE_VERSION = 1;
export const EVENT_TYPES = Object.freeze([
  'run.started', 'input.added', 'assignment.completed', 'job.completed', 'merge.completed', 'merge.rejected',
  'human.decision', 'run.paused', 'run.resumed', 'run.stopped',
]);
/** A work item that crosses more flow edges than this fails, as a backstop against unbounded routing. */
export const MAX_ITEM_HOPS = 1000;
/**
 * Escalations to agent or review targets an item may take without a person deciding in between. Past this the item
 * fails instead, so automatic escalation cannot cycle forever. Human decisions reset the count.
 */
export const MAX_UNATTENDED_ESCALATIONS = 3;
/** Retry n waits `backoffSec × 2^(n−1)` seconds, capped at this. */
export const MAX_BACKOFF_SEC = 86400;
export const JOB_STATUSES = Object.freeze(['passed', 'failed', 'error', 'cancelled']);
const MAX_ESCALATION_RECORDS = 20;
const MAX_VISITS = 100;
const MAX_INPUTS = 100;
const MAX_PLANNED_ITEMS = 1000;
const MAX_PLAN_CHARS = 8000;
const RUN_ID = /^run_[A-Za-z0-9_-]{1,100}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TERMINAL_ITEM = new Set(['done', 'failed']);
const OPEN_ASSIGNMENT = new Set(['queued', 'leased', 'running']);
const OPEN_JOB = new Set(['queued', 'leased', 'running']);
const OPEN_MERGE = new Set(['queued', 'testing', 'merging']);
const ACTIVE_RUN = new Set(['running', 'paused']);
const ENTITY_KEYS = Object.freeze(['workItems', 'assignments', 'jobs', 'merges']);
/** Active-work index per state: what dispatch and completion need, so neither scans the whole run. Never persisted. */
const INDEX = new WeakMap();

/**
 * Apply one event to a run's state. Pure and deterministic: the same state and event always give the same
 * result, IDs derive from the run ID plus counters, and time comes only from `event.at`. Never mutates `state`.
 *
 * Invalid events throw `WorkflowError`. Valid events that no longer apply (for example a result for a cancelled
 * assignment) return the unchanged state, no effects and an `ignored` reason.
 *
 * @param {object | null | undefined} state Previous state; absent only for `run.started`.
 * @param {{ id: string, type: string, at: string, data?: object }} event
 * @returns {{ state: object, effects: object[], ignored?: string }}
 */
export function step(state, event) {
  const { changes: _changes, ...result } = run(state, event, false);
  return result;
}

/**
 * `step` for a host that owns `state` exclusively, such as the run store's cache: applies the event to `state` in
 * place and returns it, plus the ids of the entities it created or changed. If it throws, `state` may be partly
 * changed and must be discarded. Not part of the package's public exports.
 * @returns {{ state: object, effects: object[], ignored?: string, changes: Record<string, string[]> }}
 */
export function advance(state, event) { return run(state, event, true); }

function run(state, event, inPlace) {
  if (!isPlainObject(event) || !isText(event.id, 200)) fail('INVALID_EVENT', 'Event needs a nonblank string id.');
  if (!EVENT_TYPES.includes(event.type)) fail('INVALID_EVENT', `Unknown event type ${JSON.stringify(event.type)}.`);
  if (!isIsoTimestamp(event.at)) fail('INVALID_EVENT', 'Event at must be an ISO 8601 UTC timestamp.');
  const data = event.data ?? {};
  if (!isPlainObject(data)) fail('INVALID_EVENT', 'Event data must be an object.');

  if (event.type === 'run.started') {
    if (state) fail('RUN_EXISTS', 'Run has already started.');
    const ctx = context(null, event.at, inPlace);
    start(ctx, data);
    return settled(ctx);
  }
  if (!state) fail('RUN_NOT_FOUND', 'Run has not started.');
  if (state.version !== STATE_VERSION) fail('STATE_VERSION', `Unsupported run state version ${state.version}.`);
  const ctx = context(state, event.at, inPlace);
  HANDLERS[event.type](ctx, data);
  if (ctx.ignored) {
    if (ENTITY_KEYS.some(key => ctx.touched[key].size)) throw new Error(`Engine changed state while ignoring ${event.type}.`);
    return { state, effects: [], ignored: ctx.ignored, changes: changes(ctx) };
  }
  return settled(ctx);
}

function settled(ctx) {
  settle(ctx);
  refreshIndex(ctx);
  INDEX.set(ctx.s, ctx.index);
  return { state: ctx.s, effects: ctx.effects, changes: changes(ctx) };
}

/**
 * Every write goes through `edit` or `insert`, which record the entity as touched. A pure step works copy-on-write:
 * the new state shares every untouched entity with the previous one, entities are cloned on first write, and entity
 * tables are copied (by reference) on first write. In place, writes go straight to `state`.
 */
function context(state, at, inPlace) {
  return {
    base: state, inPlace, s: state && (inPlace ? state : { ...state, counters: { ...state.counters } }),
    effects: [], at, ignored: null, index: state ? indexFor(state, inPlace) : emptyIndex(),
    touched: Object.fromEntries(ENTITY_KEYS.map(key => [key, new Set()])),
  };
}

const changes = ctx => Object.fromEntries(ENTITY_KEYS.map(key => [key, [...ctx.touched[key]]]));

function table(ctx, key) {
  if (!ctx.inPlace && ctx.base && ctx.s[key] === ctx.base[key]) ctx.s[key] = { ...ctx.base[key] };
  return ctx.s[key];
}

/** The writable entity for this step. Never mutate an entity read straight from `ctx.s`. */
function edit(ctx, key, id) {
  const entities = table(ctx, key);
  if (!ctx.touched[key].has(id)) {
    if (!ctx.inPlace) entities[id] = structuredClone(entities[id]);
    ctx.touched[key].add(id);
  }
  return entities[id];
}

const emptyIndex = () => ({ queued: new Map(), unfinished: new Set(), open: new Map() });

/** The index for a state, built once by scanning it when the state came from elsewhere (JSON, an older engine). */
function indexFor(state, inPlace) {
  let index = INDEX.get(state);
  if (!index) {
    index = emptyIndex();
    for (const item of Object.values(state.workItems)) indexItem(index, item);
    for (const assignment of Object.values(state.assignments)) indexAssignment(index, assignment);
    INDEX.set(state, index);
  }
  return inPlace ? index : { queued: new Map(index.queued), unfinished: new Set(index.unfinished), open: new Map(index.open) };
}

function indexItem(index, item) {
  if (item.status === 'queued') index.queued.set(item.id, item.queuedSeq); else index.queued.delete(item.id);
  if (TERMINAL_ITEM.has(item.status)) index.unfinished.delete(item.id); else index.unfinished.add(item.id);
}

function indexAssignment(index, assignment) {
  if (OPEN_ASSIGNMENT.has(assignment.status)) index.open.set(assignment.id, assignment.nodeId); else index.open.delete(assignment.id);
}

/** Bring the index up to date with everything touched so far. Idempotent. */
function refreshIndex(ctx) {
  for (const id of ctx.touched.workItems) indexItem(ctx.index, ctx.s.workItems[id]);
  for (const id of ctx.touched.assignments) indexAssignment(ctx.index, ctx.s.assignments[id]);
}

function insert(ctx, key, entity) {
  table(ctx, key)[entity.id] = entity;
  ctx.touched[key].add(entity.id);
}

/** Replay a run's events from nothing. Duplicate-free, in application order. */
export function replay(events) {
  let state = null;
  for (const event of events) state = step(state, event).state;
  return state;
}

const HANDLERS = {
  'input.added'(ctx, data) {
    requireActive(ctx);
    if (!Array.isArray(data.items) || data.items.length < 1) fail('INVALID_EVENT', 'input.added needs a nonempty items array.');
    addInputs(ctx, data.items);
  },

  'assignment.completed'(ctx, { assignmentId, result }) {
    const { s } = ctx;
    if (!isText(assignmentId, 200)) fail('INVALID_EVENT', 'assignment.completed needs assignmentId.');
    if (!Object.hasOwn(s.assignments, assignmentId)) fail('NOT_FOUND', `Assignment ${assignmentId} is not part of this run.`);
    checkResult(result);
    if (!ACTIVE_RUN.has(s.status)) return ignore(ctx, 'run_not_active');
    if (!OPEN_ASSIGNMENT.has(s.assignments[assignmentId].status)) return ignore(ctx, 'assignment_closed');

    const assignment = edit(ctx, 'assignments', assignmentId);
    assignment.status = result.outcome === 'success' ? 'succeeded' : 'failed';
    assignment.result = structuredClone(result);
    assignment.completedAt = assignment.updatedAt = ctx.at;
    assignmentState(ctx, assignment, { outcome: result.outcome, ...(result.verdict ? { verdict: result.verdict } : {}) });

    const item = edit(ctx, 'workItems', assignment.workItemId);
    const node = s.plan.nodes[assignment.nodeId];
    delete item.assignmentId;
    if (result.outcome === 'blocked') return blocked(ctx, item, node, result.summary);
    if (node.type === 'review') {
      // `verdict` decides the gate. Results without one fall back to `outcome` only when it is `success` (legacy
      // reviewers); a failed review without a verdict is an error to retry, never a rejection.
      const verdict = result.verdict ?? (result.outcome === 'success' ? 'pass' : null);
      if (!verdict) {
        return attemptFailed(ctx, item, node, { reason: 'review_error', summary: result.summary || `${node.label} could not complete the review.`, ref: { assignmentId } });
      }
      const passed = verdict === 'pass';
      closeVisit(ctx, item, passed ? 'pass' : 'fail');
      gateResult(ctx, item, node, passed, { assignmentId, summary: result.summary, ...(result.verdict ? {} : { legacyVerdict: true }) });
      if (passed) delete item.feedback;
      else item.feedback = { kind: 'review', from: node.role, summary: result.summary };
      return move(ctx, item, node.id, passed ? 'pass' : 'fail');
    }
    if (result.outcome === 'failure') {
      return attemptFailed(ctx, item, node, { reason: 'assignment_failed', summary: result.summary || `${node.label} reported failure.`, ref: { assignmentId } });
    }
    if (node.type === 'agent') {
      for (const key of ['branch', 'prUrl', 'headSha']) if (result[key] !== undefined) item[key] = result[key];
    }
    closeVisit(ctx, item, 'pass');
    if (node.type === 'planner') return planned(ctx, item, node, result.items ?? [], result.summary);
    delete item.feedback;
    move(ctx, item, node.id, 'next');
  },

  'job.completed'(ctx, { jobId, status, summary, logRef }) {
    const { s } = ctx;
    if (!isText(jobId, 200)) fail('INVALID_EVENT', 'job.completed needs jobId.');
    if (!Object.hasOwn(s.jobs, jobId)) fail('NOT_FOUND', `Job ${jobId} is not part of this run.`);
    if (!JOB_STATUSES.includes(status)) fail('INVALID_EVENT', 'job.completed status must be passed, failed, error or cancelled.');
    if (summary !== undefined && typeof summary !== 'string') fail('INVALID_EVENT', 'summary must be a string.');
    if (logRef !== undefined && !isText(logRef, 2000)) fail('INVALID_EVENT', 'logRef must be a nonblank string.');
    if (!ACTIVE_RUN.has(s.status)) return ignore(ctx, 'run_not_active');
    if (!OPEN_JOB.has(s.jobs[jobId].status)) return ignore(ctx, 'job_closed');

    const job = edit(ctx, 'jobs', jobId);
    job.status = status;
    job.completedAt = job.updatedAt = ctx.at;
    if (logRef) job.logRef = logRef;
    const item = edit(ctx, 'workItems', job.workItemId);
    const node = s.plan.nodes[job.nodeId];
    if (status === 'error' || status === 'cancelled') {
      // The job never judged the commit, so this is an infrastructure error to retry, not a CI failure.
      return attemptFailed(ctx, item, node, {
        reason: status === 'error' ? 'job_error' : 'job_cancelled',
        summary: summary || `CI job ended with status ${status} at ${job.revision}.`, ref: { jobId }, ...(logRef ? { logRef } : {}),
      });
    }
    const passed = status === 'passed';
    closeVisit(ctx, item, passed ? 'pass' : 'fail');
    gateResult(ctx, item, node, passed, { jobId, revision: job.revision, ...(summary ? { summary } : {}) });
    if (passed) delete item.feedback;
    else item.feedback = { kind: 'ci', from: node.id, summary: summary || `CI failed at ${job.revision}.`, ...(logRef ? { logRef } : {}) };
    move(ctx, item, node.id, passed ? 'pass' : 'fail');
  },

  'merge.completed'(ctx, { mergeId, mergedSha }) {
    const open = openMerge(ctx, mergeId);
    if (mergedSha !== undefined && !SHA.test(mergedSha)) fail('INVALID_EVENT', 'mergedSha must be a full commit SHA.');
    if (!open) return;
    const entry = edit(ctx, 'merges', mergeId);
    entry.status = 'merged';
    if (mergedSha) entry.mergedSha = mergedSha;
    entry.completedAt = entry.updatedAt = ctx.at;
    const item = edit(ctx, 'workItems', entry.workItemId);
    const node = ctx.s.plan.nodes[entry.nodeId];
    closeVisit(ctx, item, 'pass');
    gateResult(ctx, item, node, true, { mergeId });
    delete item.feedback;
    move(ctx, item, node.id, 'pass');
  },

  'merge.rejected'(ctx, { mergeId, reason }) {
    if (!isText(reason, 2000)) fail('INVALID_EVENT', 'merge.rejected needs a reason.');
    if (!openMerge(ctx, mergeId)) return;
    const entry = edit(ctx, 'merges', mergeId);
    entry.status = 'rejected';
    entry.reason = reason;
    entry.completedAt = entry.updatedAt = ctx.at;
    const item = edit(ctx, 'workItems', entry.workItemId);
    const node = ctx.s.plan.nodes[entry.nodeId];
    closeVisit(ctx, item, 'fail');
    gateResult(ctx, item, node, false, { mergeId, summary: reason });
    if (!node.routes.fail) return failItem(ctx, item, 'merge_rejected', reason);
    item.feedback = { kind: 'merge', from: node.id, summary: reason };
    move(ctx, item, node.id, 'fail');
  },

  'human.decision'(ctx, { workItemId, decision, note, decisionId }) {
    const { s } = ctx;
    if (!isText(workItemId, 200)) fail('INVALID_EVENT', 'human.decision needs workItemId.');
    if (decision !== 'pass' && decision !== 'fail') fail('INVALID_EVENT', 'decision must be pass or fail.');
    if (note !== undefined && !isText(note, 20000)) fail('INVALID_EVENT', 'note must be a nonblank string.');
    if (decisionId !== undefined && !isText(decisionId, 200)) fail('INVALID_EVENT', 'decisionId must be a nonblank string.');
    if (!Object.hasOwn(s.workItems, workItemId)) fail('NOT_FOUND', `Work item ${workItemId} is not part of this run.`);
    const current = s.workItems[workItemId];
    requireActive(ctx);
    if (current.status !== 'blocked') fail('NOT_WAITING', `Work item ${workItemId} is not waiting for a decision.`);
    // A decision names the wait it answers, so a retried or second answer cannot pass the item's next gate.
    if (decisionId !== undefined && decisionId !== current.waiting.decisionId) {
      fail('STALE_DECISION', `Decision ${decisionId} is for an earlier wait; work item ${workItemId} now waits at ${current.nodeId}.`);
    }
    const item = edit(ctx, 'workItems', workItemId);
    const node = s.plan.nodes[item.nodeId];
    const waiting = item.waiting;
    delete item.waiting;
    delete item.unattendedEscalations;
    item.updatedAt = ctx.at;
    if (waiting.kind === 'human') {
      closeVisit(ctx, item, decision);
      gateResult(ctx, item, node, decision === 'pass', note ? { summary: note } : {});
      if (decision === 'fail') {
        // Escalation targets may leave `fail` unwired: declining there ends the item.
        if (!node.routes.fail) return failItem(ctx, item, 'rejected_by_human', note ?? `${node.label}: a person declined this work item.`);
        item.feedback = { kind: 'human', from: node.id, summary: note ?? 'Returned by a person.' };
      } else if (note) item.feedback = { kind: 'human', from: node.id, summary: note };
      else delete item.feedback;
      return move(ctx, item, node.id, decision);
    }
    if (decision === 'fail') return failItem(ctx, item, 'rejected_by_human', note ?? 'A person declined to retry this work item.');
    if (note) item.feedback = { kind: 'human', from: 'human', summary: note };
    item.attempt = 1;
    delete item.lastError;
    queue(ctx, item);
  },

  'run.paused'(ctx) {
    if (ctx.s.status === 'paused') return ignore(ctx, 'already_paused');
    if (ctx.s.status !== 'running') fail('INVALID_TRANSITION', `Cannot pause a ${ctx.s.status} run.`);
    ctx.s.status = 'paused';
    emit(ctx, 'run.paused', null, {});
  },

  'run.resumed'(ctx) {
    if (ctx.s.status === 'running') return ignore(ctx, 'already_running');
    if (ctx.s.status !== 'paused') fail('INVALID_TRANSITION', `Cannot resume a ${ctx.s.status} run.`);
    ctx.s.status = 'running';
    emit(ctx, 'run.resumed', null, {});
  },

  'run.stopped'(ctx, { reason }) {
    const { s, at } = ctx;
    if (s.status === 'stopped') return ignore(ctx, 'already_stopped');
    if (!ACTIVE_RUN.has(s.status)) fail('INVALID_TRANSITION', `Cannot stop a ${s.status} run.`);
    if (reason !== undefined && !isText(reason, 2000)) fail('INVALID_EVENT', 'reason must be a nonblank string.');
    s.status = 'stopped';
    s.stoppedAt = at;
    for (const { id, status } of Object.values(s.assignments)) {
      if (!OPEN_ASSIGNMENT.has(status)) continue;
      const assignment = edit(ctx, 'assignments', id);
      assignment.status = 'cancelled';
      assignment.updatedAt = at;
      ctx.effects.push({ type: 'cancel-assignment', assignmentId: assignment.id, reason: 'run_stopped' });
      assignmentState(ctx, assignment, {});
    }
    for (const { id, status } of Object.values(s.jobs)) {
      if (!OPEN_JOB.has(status)) continue;
      const job = edit(ctx, 'jobs', id);
      job.status = 'cancelled';
      job.updatedAt = at;
      ctx.effects.push({ type: 'cancel-job', jobId: job.id, reason: 'run_stopped' });
    }
    for (const { id, status } of Object.values(s.merges)) {
      if (!OPEN_MERGE.has(status)) continue;
      const entry = edit(ctx, 'merges', id);
      entry.status = 'rejected';
      entry.reason = 'run_stopped';
      entry.updatedAt = at;
      ctx.effects.push({ type: 'cancel-merge', mergeId: entry.id, reason: 'run_stopped' });
    }
    for (const { id, status } of Object.values(s.workItems)) {
      if (TERMINAL_ITEM.has(status)) continue;
      const item = edit(ctx, 'workItems', id);
      closeVisit(ctx, item, 'cancelled');
      finish(ctx, item, 'failed', { reason: 'run_stopped', message: reason ?? 'The run was stopped.' });
    }
    emit(ctx, 'run.stopped', null, reason ? { reason } : {});
  },
};

function start(ctx, data) {
  const { runId, projectId, workflowId, workflowVersion, graph, repo, inputs, keepOpen } = data;
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) fail('INVALID_EVENT', 'runId must look like run_<suffix>.');
  if (!isText(projectId, 200) || !isText(workflowId, 200)) fail('INVALID_EVENT', 'run.started needs projectId and workflowId.');
  if (!Number.isSafeInteger(workflowVersion) || workflowVersion < 1) fail('INVALID_EVENT', 'workflowVersion must be a positive integer.');
  if (keepOpen !== undefined && typeof keepOpen !== 'boolean') fail('INVALID_EVENT', 'keepOpen must be a boolean.');
  const plan = compileGraph(graph);
  const needsRepo = Object.values(plan.nodes).some(node => node.type === 'ci' || node.type === 'merge-queue');
  if (repo !== undefined || needsRepo) {
    if (!isPlainObject(repo) || !isText(repo.defaultBranch, 255) || !(isText(repo.url, 2000) || isText(repo.localPath, 4096))) {
      fail('INVALID_EVENT', 'run.started needs repo { url or localPath, defaultBranch } when the workflow has CI or a merge queue.');
    }
  }
  ctx.s = {
    version: STATE_VERSION, runId, projectId, workflowId, workflowVersion,
    ...(repo ? { repo: { ...(repo.url ? { url: repo.url } : {}), defaultBranch: repo.defaultBranch, ...(repo.localPath ? { localPath: repo.localPath } : {}) } } : {}),
    keepOpen: keepOpen ?? false,
    status: 'running', startedAt: ctx.at, updatedAt: ctx.at, plan,
    counters: { workItem: 0, assignment: 0, job: 0, merge: 0, queue: 0, decision: 0 },
    workItems: {}, assignments: {}, jobs: {}, merges: {},
  };
  emit(ctx, 'run.started', null, { workflowId, workflowVersion, graphHash: plan.graphHash });
  if (inputs !== undefined) {
    if (!Array.isArray(inputs)) fail('INVALID_EVENT', 'inputs must be an array.');
    if (inputs.length) addInputs(ctx, inputs);
  }
}

function settle(ctx) {
  const { s } = ctx;
  s.updatedAt = ctx.at;
  if (s.status !== 'running') return;
  dispatch(ctx);
  refreshIndex(ctx);
  if (!s.keepOpen && s.counters.workItem > 0 && ctx.index.unfinished.size === 0) {
    const roots = Object.values(s.workItems).filter(item => !item.parentId);
    const failed = roots.filter(item => item.status === 'failed').length;
    s.status = failed ? 'failed' : 'completed';
    s.stoppedAt = ctx.at;
    emit(ctx, failed ? 'run.failed' : 'run.completed', null, { done: roots.length - failed, failed });
  }
}

function ignore(ctx, reason) { ctx.ignored = reason; }

function requireActive(ctx) {
  if (!ACTIVE_RUN.has(ctx.s.status)) fail('RUN_NOT_ACTIVE', `Run is ${ctx.s.status}.`);
}

function nextId(ctx, counter, prefix) {
  ctx.s.counters[counter] = (ctx.s.counters[counter] ?? 0) + 1;
  return `${prefix}_${ctx.s.runId.slice(4)}_${ctx.s.counters[counter]}`;
}

/** Identifies one wait for a person. States from before decision ids start the counter at 0. */
const decisionId = ctx => nextId(ctx, 'decision', 'hd');

function emit(ctx, type, item, data) {
  const subject = item ? { kind: 'workItem', id: item.id } : { kind: 'run', id: ctx.s.runId };
  ctx.effects.push({ type: 'emit-event', event: { type, subject, data: structuredClone(data) } });
}

function assignmentState(ctx, assignment, extra) {
  ctx.effects.push({ type: 'emit-event', event: {
    type: 'assignment.state', subject: { kind: 'assignment', id: assignment.id },
    data: { assignmentId: assignment.id, workItemId: assignment.workItemId, nodeId: assignment.nodeId, role: assignment.role, state: assignment.status, ...extra },
  } });
}

function gateResult(ctx, item, node, passed, extra) {
  emit(ctx, 'gate.result', item, { workItemId: item.id, nodeId: node.id, gate: node.type, result: passed ? 'pass' : 'fail', ...extra });
}

function checkItems(items) {
  for (const item of items) {
    if (!isPlainObject(item) || !isText(item.title, 200)) fail('INVALID_EVENT', 'Each item needs a nonblank title of at most 200 characters.');
    if (item.body !== undefined && (typeof item.body !== 'string' || item.body.length > 20000)) fail('INVALID_EVENT', 'Item body must be a string of at most 20000 characters.');
  }
}

function addInputs(ctx, items) {
  const { plan } = ctx.s;
  if (items.length > MAX_INPUTS) fail('INVALID_EVENT', `At most ${MAX_INPUTS} inputs per event.`);
  checkItems(items);
  const resolved = items.map(item => {
    if (item.nodeId !== undefined) {
      if (!plan.inputs.includes(item.nodeId)) fail('INVALID_EVENT', `Node ${item.nodeId} is not an input node.`);
      return item.nodeId;
    }
    if (plan.inputs.length !== 1) fail('AMBIGUOUS_INPUT', 'Workflow has several input nodes; give each item a nodeId.');
    return plan.inputs[0];
  });
  items.forEach((input, index) => {
    const item = createItem(ctx, { title: input.title, body: input.body ?? '', nodeId: resolved[index] });
    move(ctx, item, resolved[index], 'next');
  });
}

function createItem(ctx, { title, body, nodeId, parentId }) {
  const { s, at } = ctx;
  const item = {
    id: nextId(ctx, 'workItem', 'wi'), runId: s.runId, title, body, nodeId, status: 'queued', iteration: 0, attempt: 1,
    ...(parentId ? { parentId } : {}), createdAt: at, updatedAt: at, enteredAt: at, hops: 0, loopCounts: {}, visits: [],
  };
  insert(ctx, 'workItems', item);
  ctx.effects.push({ type: 'create-work-item', workItem: structuredClone(item) });
  return item;
}

/** Send an item along a node's output port (`next`, `pass` or `fail`). */
function move(ctx, item, fromNodeId, port) {
  const node = ctx.s.plan.nodes[fromNodeId];
  const route = node.routes[port];
  if (!route) return failItem(ctx, item, 'no_route', `${node.label} has no ${port} route.`);
  item.hops += 1;
  if (item.hops > MAX_ITEM_HOPS) return failItem(ctx, item, 'hop_limit', `Work item crossed more than ${MAX_ITEM_HOPS} flow edges.`);
  emit(ctx, 'workitem.moved', item, {
    workItemId: item.id, edgeId: route.edgeId, from: fromNodeId, to: route.node, ...(port === 'next' ? {} : { port }), unplanned: false,
  });
  enter(ctx, item, route.node, fromNodeId);
}

function enter(ctx, item, nodeId, fromNodeId) {
  const { s, at } = ctx;
  const node = s.plan.nodes[nodeId];
  item.nodeId = nodeId;
  item.enteredAt = item.updatedAt = at;
  item.attempt = 1;
  delete item.lastError;
  delete item.retryAt;
  if (node.type === 'loop') {
    const loop = s.plan.loops[nodeId];
    const count = loop.backSources.includes(fromNodeId) ? ownCount(item.loopCounts, nodeId) + 1 : 1;
    item.loopCounts[nodeId] = count;
    item.iteration = count;
    emit(ctx, 'loop.iteration', item, { workItemId: item.id, nodeId, iteration: count, maxIterations: loop.maxIterations });
    if (count > loop.maxIterations) {
      const recent = item.visits.filter(visit => loop.body.includes(visit.nodeId)).slice(-10)
        .map(visit => ({ nodeId: visit.nodeId, result: visit.result ?? null, ...visitRef(visit) }));
      return exhausted(ctx, item, node, {
        reason: 'loop_limit', failReason: 'loop_limit', message: `${node.label} reached its limit of ${loop.maxIterations} iterations.`,
        evidence: { iterations: loop.maxIterations, maxIterations: loop.maxIterations, ...(item.feedback ? { feedback: structuredClone(item.feedback) } : {}), visits: recent },
      });
    }
    return move(ctx, item, nodeId, 'next');
  }
  if (node.type === 'output') return finish(ctx, item, 'done');
  queue(ctx, item);
}

function queue(ctx, item) {
  item.status = 'queued';
  ctx.s.counters.queue += 1;
  item.queuedSeq = ctx.s.counters.queue;
  item.updatedAt = ctx.at;
}

function openVisit(ctx, item, ref) {
  item.visits.push({ nodeId: item.nodeId, enteredAt: item.enteredAt, startedAt: ctx.at, ...ref });
  if (item.visits.length > MAX_VISITS) item.visits.splice(0, item.visits.length - MAX_VISITS);
}

function closeVisit(ctx, item, result) {
  const visit = item.visits.at(-1);
  if (visit && !visit.endedAt) { visit.endedAt = ctx.at; visit.result = result; }
}

function failItem(ctx, item, reason, message) {
  finish(ctx, item, 'failed', { reason, message });
}

function finish(ctx, item, status, failure) {
  if (TERMINAL_ITEM.has(item.status)) return;
  item.status = status;
  item.completedAt = item.updatedAt = ctx.at;
  delete item.waiting;
  delete item.queuedSeq;
  delete item.retryAt;
  if (failure) {
    item.failure = failure;
    ctx.effects.push({ type: 'mark-item-failed', workItemId: item.id, ...failure });
  } else {
    delete item.feedback;
    ctx.effects.push({ type: 'mark-item-done', workItemId: item.id });
  }
  if (ctx.s.status === 'stopped') return;
  const current = item.parentId && ctx.s.workItems[item.parentId];
  if (!current || TERMINAL_ITEM.has(current.status)) return;
  const children = current.childIds.map(id => ctx.s.workItems[id]);
  if (!children.every(child => TERMINAL_ITEM.has(child.status))) return;
  const failed = children.filter(child => child.status === 'failed').length;
  const parent = edit(ctx, 'workItems', current.id);
  if (failed) failItem(ctx, parent, 'children_failed', `${failed} of ${children.length} planned items failed.`);
  else finish(ctx, parent, 'done');
}

/** A count from a JSON-backed table. Older plans may name nodes after `Object.prototype` members, so never read inherited keys. */
const ownCount = (table, key) => Object.hasOwn(table, key) ? table[key] : 0;
const visitRef = visit => Object.fromEntries(['assignmentId', 'jobId', 'mergeId'].filter(key => visit[key]).map(key => [key, visit[key]]));
const addSeconds = (iso, seconds) => new Date(Date.parse(iso) + seconds * 1000).toISOString();

/**
 * An assignment or job ended in an error rather than a verdict: agent `failure`, a review without a verdict, or a
 * CI job that errored or was cancelled. Retry at the same node per its `retry` policy, then escalate or fail.
 */
function attemptFailed(ctx, item, node, { reason, summary, ref, logRef }) {
  closeVisit(ctx, item, 'error');
  const { maxAttempts, backoffSec } = node.config.retry ?? { maxAttempts: 1, backoffSec: 0 };
  const attempt = item.attempt ?? 1;
  item.lastError = { nodeId: node.id, attempt, reason, summary, ...ref, ...(logRef ? { logRef } : {}) };
  if (attempt < maxAttempts) {
    const delaySec = Math.min(MAX_BACKOFF_SEC, backoffSec * 2 ** (attempt - 1));
    item.attempt = attempt + 1;
    if (delaySec > 0) item.retryAt = addSeconds(ctx.at, delaySec);
    emit(ctx, 'workitem.retried', item, {
      workItemId: item.id, nodeId: node.id, attempt: item.attempt, maxAttempts, reason, summary, ...ref,
      ...(item.retryAt ? { notBefore: item.retryAt } : {}),
    });
    return queue(ctx, item);
  }
  // Every trailing errored visit at this node is one attempt of this exhausted run of retries.
  const attempts = [];
  for (let index = item.visits.length - 1; index >= 0; index -= 1) {
    const visit = item.visits[index];
    if (visit.nodeId !== node.id || visit.result !== 'error') break;
    attempts.unshift(visitRef(visit));
  }
  exhausted(ctx, item, node, {
    reason: 'retries_exhausted', failReason: reason,
    message: maxAttempts === 1 ? summary : `${node.label} failed all ${maxAttempts} attempts. Last error: ${summary}`,
    evidence: { attempts: attempt, maxAttempts, error: reason, lastError: summary, refs: attempts, ...(logRef ? { logRef } : {}) },
  });
}

/** A node ran out of attempts or iterations: escalate to its `onExhausted` target, or fail the item. */
function exhausted(ctx, item, node, { reason, failReason, message, evidence }) {
  const target = node.escalation?.exhausted;
  if (!target) return failItem(ctx, item, failReason, message);
  const targetNode = ctx.s.plan.nodes[target];
  if (targetNode.type !== 'human') {
    const count = item.unattendedEscalations ?? 0;
    if (count >= MAX_UNATTENDED_ESCALATIONS) {
      return failItem(ctx, item, failReason, `${message} Not escalated to ${targetNode.label}: ${count} automatic escalations already happened without a person.`);
    }
    item.unattendedEscalations = count + 1;
  }
  // Escalation grants the item a fresh budget at the exhausted loop if the target sends it back.
  if (node.type === 'loop') delete item.loopCounts[node.id];
  // The message already carries the last error; keep the latest gate feedback alongside it.
  const prior = item.feedback;
  item.feedback = {
    kind: 'escalation', from: node.id,
    summary: [message, prior && prior.kind !== 'escalation' && `Latest feedback (${prior.kind} from ${prior.from}):\n${prior.summary}`]
      .filter(Boolean).join('\n\n'),
  };
  escalate(ctx, item, node, target, reason, evidence);
}

/**
 * `blocked` goes to the node's human gate (`onBlocked`, or a human `onExhausted` target) when it has one. Otherwise
 * the item is held as blocked until `human.decision` retries or fails it.
 */
function blocked(ctx, item, node, summary) {
  closeVisit(ctx, item, 'blocked');
  const target = node.escalation?.blocked;
  if (!target) {
    item.status = 'blocked';
    item.waiting = { kind: 'retry', nodeId: node.id, summary, decisionId: decisionId(ctx) };
    item.updatedAt = ctx.at;
    emit(ctx, 'workitem.blocked', item, { workItemId: item.id, nodeId: node.id, summary, decisionId: item.waiting.decisionId });
    return;
  }
  emit(ctx, 'workitem.blocked', item, { workItemId: item.id, nodeId: node.id, summary, routedTo: target });
  item.feedback = { kind: 'blocked', from: node.id, summary };
  escalate(ctx, item, node, target, 'blocked', { summary });
}

function escalate(ctx, item, node, target, reason, evidence) {
  const record = { from: node.id, to: target, reason, at: ctx.at, ...(evidence.iterations ? { iterations: evidence.iterations } : {}), ...(evidence.attempts ? { attempts: evidence.attempts } : {}) };
  item.escalations = [...(item.escalations ?? []), record].slice(-MAX_ESCALATION_RECORDS);
  emit(ctx, 'workitem.escalated', item, { workItemId: item.id, from: node.id, to: target, reason, evidence });
  item.hops += 1;
  if (item.hops > MAX_ITEM_HOPS) return failItem(ctx, item, 'hop_limit', `Work item crossed more than ${MAX_ITEM_HOPS} flow edges.`);
  enter(ctx, item, target, node.id);
}

function planned(ctx, item, node, items, summary) {
  const limit = node.config.maxItems;
  if (items.length > limit) {
    emit(ctx, 'planner.items_truncated', item, { workItemId: item.id, nodeId: node.id, proposed: items.length, kept: limit });
  }
  const kept = items.slice(0, limit);
  if (!kept.length) {
    // The item stays whole; its refined contract and acceptance criteria travel with it to every later role.
    const brief = summary?.trim();
    if (brief) item.plan = { from: node.role, summary: brief.length > MAX_PLAN_CHARS ? `${brief.slice(0, MAX_PLAN_CHARS)}\n[truncated]` : brief };
    return move(ctx, item, node.id, 'next');
  }
  item.status = 'active';
  item.waiting = { kind: 'children' };
  const children = kept.map(child => createItem(ctx, { title: child.title, body: child.body ?? '', nodeId: node.id, parentId: item.id }));
  item.childIds = children.map(child => child.id);
  for (const child of children) move(ctx, child, node.id, 'next');
}

function dispatch(ctx) {
  const { s } = ctx;
  refreshIndex(ctx);
  const open = new Map();
  for (const nodeId of ctx.index.open.values()) open.set(nodeId, (open.get(nodeId) ?? 0) + 1);
  const queued = [...ctx.index.queued].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  for (const id of queued) {
    if (s.workItems[id].status !== 'queued') continue;
    const node = s.plan.nodes[s.workItems[id].nodeId];
    if (node.role) {
      const role = s.plan.roles[node.role];
      if ((open.get(node.id) ?? 0) >= role.concurrency) continue;
      open.set(node.id, (open.get(node.id) ?? 0) + 1);
      createAssignment(ctx, edit(ctx, 'workItems', id), node, role);
      continue;
    }
    const item = edit(ctx, 'workItems', id);
    if (node.type === 'ci') {
      if (!item.headSha) { failItem(ctx, item, 'missing_head_sha', `${node.label} needs a head commit; no agent reported one.`); continue; }
      createJob(ctx, item, node);
    } else if (node.type === 'merge-queue') {
      if (!item.prUrl || !item.headSha) { failItem(ctx, item, 'missing_pull_request', `${node.label} needs a pull request URL and head commit.`); continue; }
      enqueueMerge(ctx, item, node);
    } else if (node.type === 'human') {
      item.status = 'blocked';
      item.waiting = { kind: 'human', nodeId: node.id, decisionId: decisionId(ctx) };
      delete item.queuedSeq;
      openVisit(ctx, item, {});
      emit(ctx, 'human.requested', item, {
        workItemId: item.id, nodeId: node.id, decisionId: item.waiting.decisionId, prompt: node.config.prompt,
        ...(item.feedback ? { context: { kind: item.feedback.kind, from: item.feedback.from, summary: item.feedback.summary } } : {}),
      });
    }
  }
}

function activate(ctx, item, ref) {
  item.status = 'active';
  item.updatedAt = ctx.at;
  delete item.queuedSeq;
  openVisit(ctx, item, ref);
}

function createAssignment(ctx, item, node, role) {
  const { s, at } = ctx;
  const assignment = {
    id: nextId(ctx, 'assignment', 'asg'), runId: s.runId, workItemId: item.id, nodeId: node.id, nodeType: node.type,
    role: role.role, prompt: buildPrompt(s, item, node, role), harness: structuredClone(role.harness),
    policy: structuredClone(role.policy), requirements: structuredClone(role.requirements),
    status: 'queued', ...retryFields(ctx, item), createdAt: at, updatedAt: at,
  };
  insert(ctx, 'assignments', assignment);
  item.assignmentId = assignment.id;
  activate(ctx, item, { assignmentId: assignment.id });
  ctx.effects.push({ type: 'create-assignment', assignment: structuredClone(assignment) });
  assignmentState(ctx, assignment, {});
}

/** `attempt`, plus `retryOf` and a `notBefore` backoff time for retries. The host must not start work before `notBefore`. */
function retryFields(ctx, item) {
  const attempt = item.attempt ?? 1;
  const fields = { attempt };
  if (attempt > 1 && item.lastError?.nodeId === item.nodeId) {
    const previous = item.lastError.assignmentId ?? item.lastError.jobId;
    if (previous) fields.retryOf = previous;
  }
  if (item.retryAt && Date.parse(item.retryAt) > Date.parse(ctx.at)) fields.notBefore = item.retryAt;
  delete item.retryAt;
  return fields;
}

function buildPrompt(s, item, node, role) {
  // Work-item context, in this order for every role: what to do, the agreed plan, where the work is, what to fix.
  const parts = [role.prompt, `Work item: ${item.title}`];
  if (item.body) parts.push(item.body);
  const parent = item.parentId ? s.workItems[item.parentId] : null;
  if (parent) parts.push(`Part of: ${parent.title}`);
  if (item.plan) parts.push(`Plan from ${item.plan.from}:\n${item.plan.summary}`);
  if (node.type === 'review' && node.config.rubric) parts.push(`Rubric:\n${node.config.rubric}`);
  const refs = [['Branch', item.branch], ['Pull request', item.prUrl], ['Head commit', item.headSha]].filter(([, value]) => value);
  if (refs.length) parts.push(refs.map(([label, value]) => `${label}: ${value}`).join('\n'));
  if (item.feedback?.kind === 'escalation') {
    parts.push(`Escalated to you from ${item.feedback.from}:\n${item.feedback.summary}`);
  } else if (item.feedback && node.type !== 'review') {
    parts.push(`Feedback to address (${item.feedback.kind} from ${item.feedback.from}):\n${item.feedback.summary}`);
  }
  if (item.iteration > 1) parts.push(`This is attempt ${item.iteration} in the current loop.`);
  if ((item.attempt ?? 1) > 1 && item.lastError?.nodeId === node.id) {
    parts.push(`This is retry ${item.attempt} of ${node.config.retry?.maxAttempts ?? item.attempt} at this step. The previous attempt failed: ${item.lastError.summary}`);
  }
  if (node.type === 'planner') {
    parts.push(`Split the work item into at most ${node.config.maxItems} items, each small enough for one pull request, with a title and a body that states its contract and acceptance criteria. ` +
      'If it is already that small, keep it whole: return no items and put its contract and acceptance criteria in your summary. The builder and reviewer receive that summary.');
  }
  if (node.type === 'review') {
    parts.push('Give verdict "pass" if the work passes review, or verdict "fail" with actionable feedback in the summary. If you could not complete the review, give no verdict.');
  }
  return parts.join('\n\n');
}

function createJob(ctx, item, node) {
  const { s, at } = ctx;
  const steps = structuredClone(node.config.steps);
  const requirements = structuredClone(node.config.requirements);
  const job = {
    id: nextId(ctx, 'job', 'job'), projectId: s.projectId, runId: s.runId, workItemId: item.id, nodeId: node.id,
    repo: s.repo.url ?? s.repo.localPath, revision: item.headSha, steps, requirements,
    status: 'queued', ...retryFields(ctx, item), artifacts: [], configHash: sha256(canonicalJson({ steps, requirements })), createdAt: at, updatedAt: at,
  };
  insert(ctx, 'jobs', job);
  activate(ctx, item, { jobId: job.id });
  ctx.effects.push({ type: 'create-job', job: structuredClone(job) });
}

function enqueueMerge(ctx, item, node) {
  const { s, at } = ctx;
  const entry = {
    id: nextId(ctx, 'merge', 'mq'), projectId: s.projectId, runId: s.runId, workItemId: item.id, nodeId: node.id,
    prUrl: item.prUrl, headSha: item.headSha, baseBranch: s.repo.defaultBranch, status: 'queued',
    strategy: node.config.strategy, method: node.config.method, requiredChecks: [...node.config.requiredChecks], createdAt: at, updatedAt: at,
  };
  insert(ctx, 'merges', entry);
  activate(ctx, item, { mergeId: entry.id });
  ctx.effects.push({ type: 'enqueue-merge', mergeEntry: structuredClone(entry) });
}

function openMerge(ctx, mergeId) {
  if (!isText(mergeId, 200)) fail('INVALID_EVENT', 'Merge events need mergeId.');
  if (!Object.hasOwn(ctx.s.merges, mergeId)) fail('NOT_FOUND', `Merge entry ${mergeId} is not part of this run.`);
  const entry = ctx.s.merges[mergeId];
  if (!ACTIVE_RUN.has(ctx.s.status)) return ignore(ctx, 'run_not_active');
  if (!OPEN_MERGE.has(entry.status)) return ignore(ctx, 'merge_closed');
  return entry;
}

function checkResult(result) {
  if (!isPlainObject(result)) fail('INVALID_EVENT', 'assignment.completed needs a result object.');
  if (!['success', 'failure', 'blocked'].includes(result.outcome)) fail('INVALID_EVENT', 'result.outcome must be success, failure or blocked.');
  if (typeof result.summary !== 'string' || result.summary.length > 20000) fail('INVALID_EVENT', 'result.summary must be a string of at most 20000 characters.');
  if (result.branch !== undefined && !isText(result.branch, 255)) fail('INVALID_EVENT', 'result.branch must be a nonblank string.');
  if (result.prUrl !== undefined && !isText(result.prUrl, 2000)) fail('INVALID_EVENT', 'result.prUrl must be a nonblank string.');
  if (result.headSha !== undefined && !(typeof result.headSha === 'string' && SHA.test(result.headSha))) {
    fail('INVALID_EVENT', 'result.headSha must be a full lowercase commit SHA.');
  }
  if (result.threadRef !== undefined && !isText(result.threadRef, 2000)) fail('INVALID_EVENT', 'result.threadRef must be a nonblank string.');
  if (result.verdict !== undefined && result.verdict !== 'pass' && result.verdict !== 'fail') fail('INVALID_EVENT', 'result.verdict must be pass or fail.');
  if (result.items !== undefined) {
    if (!Array.isArray(result.items) || result.items.length > MAX_PLANNED_ITEMS) fail('INVALID_EVENT', `result.items must be an array of at most ${MAX_PLANNED_ITEMS} items.`);
    checkItems(result.items);
  }
}
