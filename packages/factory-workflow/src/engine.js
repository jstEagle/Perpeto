import { compileGraph } from './graph.js';
import { canonicalJson, fail, isIsoTimestamp, isPlainObject, isText, sha256 } from './util.js';

export const STATE_VERSION = 1;
export const EVENT_TYPES = Object.freeze([
  'run.started', 'input.added', 'assignment.completed', 'job.completed', 'merge.completed', 'merge.rejected',
  'human.decision', 'run.paused', 'run.resumed', 'run.stopped',
]);
/** A work item that crosses more flow edges than this fails, as a backstop against unbounded routing. */
export const MAX_ITEM_HOPS = 1000;
const MAX_VISITS = 100;
const MAX_INPUTS = 100;
const MAX_PLANNED_ITEMS = 1000;
const RUN_ID = /^run_[A-Za-z0-9_-]{1,100}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TERMINAL_ITEM = new Set(['done', 'failed']);
const OPEN_ASSIGNMENT = new Set(['queued', 'leased', 'running']);
const OPEN_JOB = new Set(['queued', 'leased', 'running']);
const OPEN_MERGE = new Set(['queued', 'testing', 'merging']);
const ACTIVE_RUN = new Set(['running', 'paused']);

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
  if (!isPlainObject(event) || !isText(event.id, 200)) fail('INVALID_EVENT', 'Event needs a nonblank string id.');
  if (!EVENT_TYPES.includes(event.type)) fail('INVALID_EVENT', `Unknown event type ${JSON.stringify(event.type)}.`);
  if (!isIsoTimestamp(event.at)) fail('INVALID_EVENT', 'Event at must be an ISO 8601 UTC timestamp.');
  const data = event.data ?? {};
  if (!isPlainObject(data)) fail('INVALID_EVENT', 'Event data must be an object.');

  if (event.type === 'run.started') {
    if (state) fail('RUN_EXISTS', 'Run has already started.');
    const ctx = { s: null, effects: [], at: event.at, ignored: null };
    start(ctx, data);
    settle(ctx);
    return { state: ctx.s, effects: ctx.effects };
  }
  if (!state) fail('RUN_NOT_FOUND', 'Run has not started.');
  if (state.version !== STATE_VERSION) fail('STATE_VERSION', `Unsupported run state version ${state.version}.`);
  const ctx = { s: structuredClone(state), effects: [], at: event.at, ignored: null };
  HANDLERS[event.type](ctx, data);
  if (ctx.ignored) return { state, effects: [], ignored: ctx.ignored };
  settle(ctx);
  return { state: ctx.s, effects: ctx.effects };
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
    const assignment = s.assignments[assignmentId];
    if (!assignment) fail('NOT_FOUND', `Assignment ${assignmentId} is not part of this run.`);
    checkResult(result);
    if (!ACTIVE_RUN.has(s.status)) return ignore(ctx, 'run_not_active');
    if (!OPEN_ASSIGNMENT.has(assignment.status)) return ignore(ctx, 'assignment_closed');

    assignment.status = result.outcome === 'success' ? 'succeeded' : 'failed';
    assignment.result = structuredClone(result);
    assignment.completedAt = assignment.updatedAt = ctx.at;
    assignmentState(ctx, assignment, { outcome: result.outcome });

    const item = s.workItems[assignment.workItemId];
    const node = s.plan.nodes[assignment.nodeId];
    delete item.assignmentId;
    if (node.type === 'agent' && result.outcome === 'success') {
      for (const key of ['branch', 'prUrl', 'headSha']) if (result[key] !== undefined) item[key] = result[key];
    }
    if (result.outcome === 'blocked') {
      closeVisit(ctx, item, 'blocked');
      item.status = 'blocked';
      item.waiting = { kind: 'retry', nodeId: node.id, summary: result.summary };
      item.updatedAt = ctx.at;
      emit(ctx, 'workitem.blocked', item, { workItemId: item.id, nodeId: node.id, summary: result.summary });
      return;
    }
    if (node.type === 'review') {
      const passed = result.outcome === 'success';
      closeVisit(ctx, item, passed ? 'pass' : 'fail');
      gateResult(ctx, item, node, passed, { assignmentId, summary: result.summary });
      if (passed) delete item.feedback;
      else item.feedback = { kind: 'review', from: node.role, summary: result.summary };
      return move(ctx, item, node.id, passed ? 'pass' : 'fail');
    }
    if (result.outcome === 'failure') {
      closeVisit(ctx, item, 'fail');
      return failItem(ctx, item, 'assignment_failed', result.summary || `${node.label} reported failure.`);
    }
    closeVisit(ctx, item, 'pass');
    if (node.type === 'planner') return planned(ctx, item, node, result.items ?? []);
    delete item.feedback;
    move(ctx, item, node.id, 'next');
  },

  'job.completed'(ctx, { jobId, status, summary, logRef }) {
    const { s } = ctx;
    if (!isText(jobId, 200)) fail('INVALID_EVENT', 'job.completed needs jobId.');
    const job = s.jobs[jobId];
    if (!job) fail('NOT_FOUND', `Job ${jobId} is not part of this run.`);
    if (status !== 'passed' && status !== 'failed') fail('INVALID_EVENT', 'job.completed status must be passed or failed.');
    if (summary !== undefined && typeof summary !== 'string') fail('INVALID_EVENT', 'summary must be a string.');
    if (logRef !== undefined && !isText(logRef, 2000)) fail('INVALID_EVENT', 'logRef must be a nonblank string.');
    if (!ACTIVE_RUN.has(s.status)) return ignore(ctx, 'run_not_active');
    if (!OPEN_JOB.has(job.status)) return ignore(ctx, 'job_closed');

    job.status = status;
    job.completedAt = job.updatedAt = ctx.at;
    if (logRef) job.logRef = logRef;
    const item = s.workItems[job.workItemId];
    const node = s.plan.nodes[job.nodeId];
    const passed = status === 'passed';
    closeVisit(ctx, item, passed ? 'pass' : 'fail');
    gateResult(ctx, item, node, passed, { jobId, revision: job.revision, ...(summary ? { summary } : {}) });
    if (passed) delete item.feedback;
    else item.feedback = { kind: 'ci', from: node.id, summary: summary || `CI failed at ${job.revision}.`, ...(logRef ? { logRef } : {}) };
    move(ctx, item, node.id, passed ? 'pass' : 'fail');
  },

  'merge.completed'(ctx, { mergeId, mergedSha }) {
    const entry = openMerge(ctx, mergeId);
    if (mergedSha !== undefined && !SHA.test(mergedSha)) fail('INVALID_EVENT', 'mergedSha must be a full commit SHA.');
    if (!entry) return;
    entry.status = 'merged';
    if (mergedSha) entry.mergedSha = mergedSha;
    entry.completedAt = entry.updatedAt = ctx.at;
    const item = ctx.s.workItems[entry.workItemId];
    const node = ctx.s.plan.nodes[entry.nodeId];
    closeVisit(ctx, item, 'pass');
    gateResult(ctx, item, node, true, { mergeId });
    delete item.feedback;
    move(ctx, item, node.id, 'pass');
  },

  'merge.rejected'(ctx, { mergeId, reason }) {
    if (!isText(reason, 2000)) fail('INVALID_EVENT', 'merge.rejected needs a reason.');
    const entry = openMerge(ctx, mergeId);
    if (!entry) return;
    entry.status = 'rejected';
    entry.reason = reason;
    entry.completedAt = entry.updatedAt = ctx.at;
    const item = ctx.s.workItems[entry.workItemId];
    const node = ctx.s.plan.nodes[entry.nodeId];
    closeVisit(ctx, item, 'fail');
    gateResult(ctx, item, node, false, { mergeId, summary: reason });
    if (!node.routes.fail) return failItem(ctx, item, 'merge_rejected', reason);
    item.feedback = { kind: 'merge', from: node.id, summary: reason };
    move(ctx, item, node.id, 'fail');
  },

  'human.decision'(ctx, { workItemId, decision, note }) {
    const { s } = ctx;
    if (!isText(workItemId, 200)) fail('INVALID_EVENT', 'human.decision needs workItemId.');
    if (decision !== 'pass' && decision !== 'fail') fail('INVALID_EVENT', 'decision must be pass or fail.');
    if (note !== undefined && !isText(note, 20000)) fail('INVALID_EVENT', 'note must be a nonblank string.');
    const item = s.workItems[workItemId];
    if (!item) fail('NOT_FOUND', `Work item ${workItemId} is not part of this run.`);
    requireActive(ctx);
    if (item.status !== 'blocked') fail('NOT_WAITING', `Work item ${workItemId} is not waiting for a decision.`);
    const node = s.plan.nodes[item.nodeId];
    const waiting = item.waiting;
    delete item.waiting;
    item.updatedAt = ctx.at;
    if (waiting.kind === 'human') {
      closeVisit(ctx, item, decision);
      gateResult(ctx, item, node, decision === 'pass', note ? { summary: note } : {});
      if (decision === 'fail') item.feedback = { kind: 'human', from: node.id, summary: note ?? 'Returned by a person.' };
      else delete item.feedback;
      return move(ctx, item, node.id, decision);
    }
    if (decision === 'fail') return failItem(ctx, item, 'rejected_by_human', note ?? 'A person declined to retry this work item.');
    if (note) item.feedback = { kind: 'human', from: 'human', summary: note };
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
    for (const assignment of Object.values(s.assignments)) {
      if (!OPEN_ASSIGNMENT.has(assignment.status)) continue;
      assignment.status = 'cancelled';
      assignment.updatedAt = at;
      ctx.effects.push({ type: 'cancel-assignment', assignmentId: assignment.id, reason: 'run_stopped' });
      assignmentState(ctx, assignment, {});
    }
    for (const job of Object.values(s.jobs)) {
      if (!OPEN_JOB.has(job.status)) continue;
      job.status = 'cancelled';
      job.updatedAt = at;
      ctx.effects.push({ type: 'cancel-job', jobId: job.id, reason: 'run_stopped' });
    }
    for (const entry of Object.values(s.merges)) {
      if (!OPEN_MERGE.has(entry.status)) continue;
      entry.status = 'rejected';
      entry.reason = 'run_stopped';
      entry.updatedAt = at;
      ctx.effects.push({ type: 'cancel-merge', mergeId: entry.id, reason: 'run_stopped' });
    }
    for (const item of Object.values(s.workItems)) {
      if (TERMINAL_ITEM.has(item.status)) continue;
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
    counters: { workItem: 0, assignment: 0, job: 0, merge: 0, queue: 0 },
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
  const items = Object.values(s.workItems);
  if (!s.keepOpen && items.length && items.every(item => TERMINAL_ITEM.has(item.status))) {
    const roots = items.filter(item => !item.parentId);
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
  ctx.s.counters[counter] += 1;
  return `${prefix}_${ctx.s.runId.slice(4)}_${ctx.s.counters[counter]}`;
}

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
    id: nextId(ctx, 'workItem', 'wi'), runId: s.runId, title, body, nodeId, status: 'queued', iteration: 0,
    ...(parentId ? { parentId } : {}), createdAt: at, updatedAt: at, enteredAt: at, hops: 0, loopCounts: {}, visits: [],
  };
  s.workItems[item.id] = item;
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
  if (node.type === 'loop') {
    const loop = s.plan.loops[nodeId];
    const count = loop.backSources.includes(fromNodeId) ? (item.loopCounts[nodeId] ?? 0) + 1 : 1;
    item.loopCounts[nodeId] = count;
    item.iteration = count;
    emit(ctx, 'loop.iteration', item, { workItemId: item.id, nodeId, iteration: count, maxIterations: loop.maxIterations });
    if (count > loop.maxIterations) {
      return failItem(ctx, item, 'loop_limit', `${node.label} reached its limit of ${loop.maxIterations} iterations.`);
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
  if (failure) {
    item.failure = failure;
    ctx.effects.push({ type: 'mark-item-failed', workItemId: item.id, ...failure });
  } else {
    delete item.feedback;
    ctx.effects.push({ type: 'mark-item-done', workItemId: item.id });
  }
  if (ctx.s.status === 'stopped') return;
  const parent = item.parentId && ctx.s.workItems[item.parentId];
  if (!parent || TERMINAL_ITEM.has(parent.status)) return;
  const children = parent.childIds.map(id => ctx.s.workItems[id]);
  if (!children.every(child => TERMINAL_ITEM.has(child.status))) return;
  const failed = children.filter(child => child.status === 'failed').length;
  if (failed) failItem(ctx, parent, 'children_failed', `${failed} of ${children.length} planned items failed.`);
  else finish(ctx, parent, 'done');
}

function planned(ctx, item, node, items) {
  const limit = node.config.maxItems;
  if (items.length > limit) {
    emit(ctx, 'planner.items_truncated', item, { workItemId: item.id, nodeId: node.id, proposed: items.length, kept: limit });
  }
  const kept = items.slice(0, limit);
  if (!kept.length) return move(ctx, item, node.id, 'next');
  item.status = 'active';
  item.waiting = { kind: 'children' };
  const children = kept.map(child => createItem(ctx, { title: child.title, body: child.body ?? '', nodeId: node.id, parentId: item.id }));
  item.childIds = children.map(child => child.id);
  for (const child of children) move(ctx, child, node.id, 'next');
}

function dispatch(ctx) {
  const { s } = ctx;
  const open = {};
  for (const assignment of Object.values(s.assignments)) {
    if (OPEN_ASSIGNMENT.has(assignment.status)) open[assignment.nodeId] = (open[assignment.nodeId] ?? 0) + 1;
  }
  const queued = Object.values(s.workItems).filter(item => item.status === 'queued').sort((a, b) => a.queuedSeq - b.queuedSeq);
  for (const item of queued) {
    if (item.status !== 'queued') continue;
    const node = s.plan.nodes[item.nodeId];
    if (node.role) {
      const role = s.plan.roles[node.role];
      if ((open[node.id] ?? 0) >= role.concurrency) continue;
      open[node.id] = (open[node.id] ?? 0) + 1;
      createAssignment(ctx, item, node, role);
    } else if (node.type === 'ci') {
      if (!item.headSha) { failItem(ctx, item, 'missing_head_sha', `${node.label} needs a head commit; no agent reported one.`); continue; }
      createJob(ctx, item, node);
    } else if (node.type === 'merge-queue') {
      if (!item.prUrl || !item.headSha) { failItem(ctx, item, 'missing_pull_request', `${node.label} needs a pull request URL and head commit.`); continue; }
      enqueueMerge(ctx, item, node);
    } else if (node.type === 'human') {
      item.status = 'blocked';
      item.waiting = { kind: 'human', nodeId: node.id };
      delete item.queuedSeq;
      openVisit(ctx, item, {});
      emit(ctx, 'human.requested', item, { workItemId: item.id, nodeId: node.id, prompt: node.config.prompt });
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
    status: 'queued', attempt: 1, createdAt: at, updatedAt: at,
  };
  s.assignments[assignment.id] = assignment;
  item.assignmentId = assignment.id;
  activate(ctx, item, { assignmentId: assignment.id });
  ctx.effects.push({ type: 'create-assignment', assignment: structuredClone(assignment) });
  assignmentState(ctx, assignment, {});
}

function buildPrompt(s, item, node, role) {
  const parts = [role.prompt, `Work item: ${item.title}`];
  if (item.body) parts.push(item.body);
  if (node.type === 'review' && node.config.rubric) parts.push(`Rubric:\n${node.config.rubric}`);
  const refs = [['Branch', item.branch], ['Pull request', item.prUrl], ['Head commit', item.headSha]].filter(([, value]) => value);
  if (refs.length) parts.push(refs.map(([label, value]) => `${label}: ${value}`).join('\n'));
  if (item.feedback && node.type !== 'review') {
    parts.push(`Feedback to address (${item.feedback.kind} from ${item.feedback.from}):\n${item.feedback.summary}`);
  }
  if (item.iteration > 1) parts.push(`This is attempt ${item.iteration} in the current loop.`);
  if (node.type === 'planner') {
    parts.push(`Report success with result.items listing at most ${node.config.maxItems} work items as [{ "title": "…", "body": "…" }]. ` +
      'Return an empty items list when the work item is already small enough to build as one pull request.');
  }
  if (node.type === 'review') {
    parts.push('Report outcome "success" with verdict "pass" if the work passes review, or verdict "fail" with actionable feedback in the summary if it does not. ' +
      'A review that ends without a verdict is treated as an error, not a rejection.');
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
    status: 'queued', attempt: 1, artifacts: [], configHash: sha256(canonicalJson({ steps, requirements })), createdAt: at, updatedAt: at,
  };
  s.jobs[job.id] = job;
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
  s.merges[entry.id] = entry;
  activate(ctx, item, { mergeId: entry.id });
  ctx.effects.push({ type: 'enqueue-merge', mergeEntry: structuredClone(entry) });
}

function openMerge(ctx, mergeId) {
  if (!isText(mergeId, 200)) fail('INVALID_EVENT', 'Merge events need mergeId.');
  const entry = ctx.s.merges[mergeId];
  if (!entry) fail('NOT_FOUND', `Merge entry ${mergeId} is not part of this run.`);
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
  if (result.items !== undefined) {
    if (!Array.isArray(result.items) || result.items.length > MAX_PLANNED_ITEMS) fail('INVALID_EVENT', `result.items must be an array of at most ${MAX_PLANNED_ITEMS} items.`);
    checkItems(result.items);
  }
}
