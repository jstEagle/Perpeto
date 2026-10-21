import { classifyInteraction } from './graph.js';
import { fail, isIsoTimestamp, isPlainObject } from './util.js';

export const METRIC_WINDOWS = Object.freeze({ '1h': 3600, '24h': 86400, '7d': 604800 });
/** Thresholds behind each bottleneck rule. Every rule reports the measured numbers in `evidence`. */
export const BOTTLENECK_RULES = Object.freeze({
  saturatedUtilization: 0.9,
  saturatedCriticalQueuePerSlot: 2,
  queueGrowth: 3,
  highFailureMinFinished: 4,
  highFailureRate: 0.5,
  criticalFailureRate: 0.75,
  humanWaitWarningSec: 3600,
  humanWaitCriticalSec: 86400,
});
const INTERACTIONS = new Map([['workitem.moved', 'flow'], ['agent.delegated', 'delegates'], ['agent.messaged', 'messages']]);
const STARTED = new Set(['leased', 'running']);
const OPEN_ASSIGNMENT = new Set(['queued', 'leased', 'running']);
const OPEN_JOB = new Set(['queued', 'leased', 'running']);
const SEVERITY = { critical: 0, warning: 1, info: 2 };

const ms = iso => Date.parse(iso);
const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
function stats(values) {
  if (!values.length) return { avg: null, p90: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { avg: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length, 1), p90: round(sorted[Math.ceil(sorted.length * 0.9) - 1], 1) };
}
const duration = seconds => seconds >= 3600 ? `${round(seconds / 3600, 1)}h` : seconds >= 60 ? `${round(seconds / 60, 1)}m` : `${Math.round(seconds)}s`;
const windowLabel = seconds => Object.entries(METRIC_WINDOWS).find(([, value]) => value === seconds)?.[0] ?? duration(seconds);

function meets(machine, requirements = {}) {
  if (requirements.os && machine.os !== requirements.os) return false;
  if ((requirements.labels ?? []).some(label => !(machine.labels ?? []).includes(label))) return false;
  return (requirements.providers ?? []).every(provider => (machine.providers ?? []).includes(provider));
}

/**
 * Measure a run from its engine state and hub event log. Pure: time comes from `now`, never the clock.
 *
 * @param {object} state Engine state from `step` or `RunStore.getState`.
 * @param {Array<{ seq?: number, at: string, type: string, data: object }>} events Hub events for the run:
 *   `workitem.moved`, `agent.delegated`, `agent.messaged` (data `{ edgeId?, from, to, unplanned? }`) and
 *   `assignment.state` (data `{ assignmentId, state, machineId?, accountId? }`). Other types are ignored.
 * @param {{ now: string, window?: '1h'|'24h'|'7d'|number, machines?: Array<{ id: string, os?: string, labels?: string[], providers?: string[], status: string }>,
 *   usage?: Array<{ assignmentId?: string, inputTokens: number, outputTokens: number, at: string }> }} options
 *   `machines` enables the no-capacity rule; `usage` (UsageRecord rows) feeds token counts.
 */
export function computeRunMetrics(state, events = [], { now, window = '24h', machines, usage = [] } = {}) {
  if (!isPlainObject(state) || !isPlainObject(state.plan)) fail('INVALID_INPUT', 'state must be a run state.');
  if (!isIsoTimestamp(now)) fail('INVALID_INPUT', 'now must be an ISO 8601 UTC timestamp.');
  const windowSec = typeof window === 'number' ? window : Object.hasOwn(METRIC_WINDOWS, window) ? METRIC_WINDOWS[window] : NaN;
  if (!Number.isFinite(windowSec) || windowSec <= 0) fail('INVALID_INPUT', 'window must be 1h, 24h, 7d or a positive number of seconds.');
  if (!Array.isArray(events) || !Array.isArray(usage)) fail('INVALID_INPUT', 'events and usage must be arrays.');

  const { plan } = state;
  const nowMs = ms(now), fromMs = nowMs - windowSec * 1000;
  const spanSec = Math.max(60, (nowMs - Math.max(fromMs, ms(state.startedAt))) / 1000);
  const inWindow = iso => typeof iso === 'string' && ms(iso) > fromMs && ms(iso) <= nowMs;
  const items = Object.values(state.workItems);
  const assignments = Object.values(state.assignments);
  const ordered = events.filter(event => isPlainObject(event) && isIsoTimestamp(event.at) && ms(event.at) <= nowMs && isPlainObject(event.data))
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || ms(a.at) - ms(b.at));

  // Hub-reported assignment lifecycle: when work actually started, and where it is running now.
  const started = new Map(), latest = new Map();
  for (const event of ordered) {
    if (event.type !== 'assignment.state') continue;
    const { assignmentId, state: phase } = event.data;
    if (STARTED.has(phase) && !started.has(assignmentId)) started.set(assignmentId, event.at);
    latest.set(assignmentId, event.data);
  }
  const running = assignments.filter(assignment => OPEN_ASSIGNMENT.has(assignment.status) && STARTED.has(latest.get(assignment.id)?.state));

  const nodeOfAssignment = new Map(assignments.map(assignment => [assignment.id, assignment.nodeId]));
  // Per-node tables are Maps: node ids from older plans may match `Object.prototype` members.
  const tokensByNode = new Map();
  let tokens = 0;
  for (const record of usage) {
    if (!isPlainObject(record) || !inWindow(record.at)) continue;
    const count = (Number(record.inputTokens) || 0) + (Number(record.outputTokens) || 0);
    tokens += count;
    const nodeId = record.nodeId ?? nodeOfAssignment.get(record.assignmentId);
    if (nodeId) tokensByNode.set(nodeId, (tokensByNode.get(nodeId) ?? 0) + count);
  }

  // Retries are assignments and jobs beyond attempt 1; escalations come from each item's escalation records.
  const retriesByNode = new Map();
  for (const entity of [...assignments, ...Object.values(state.jobs ?? {})]) {
    if ((entity.attempt ?? 1) > 1 && inWindow(entity.createdAt)) retriesByNode.set(entity.nodeId, (retriesByNode.get(entity.nodeId) ?? 0) + 1);
  }
  const escalations = items.flatMap(item => (item.escalations ?? []).map(record => ({ ...record, item })));
  const escalationsInWindow = escalations.filter(record => inWindow(record.at));
  const escalationsByNode = new Map();
  for (const record of escalationsInWindow) escalationsByNode.set(record.from, (escalationsByNode.get(record.from) ?? 0) + 1);

  const visitsByNode = new Map();
  for (const item of items) {
    for (const visit of item.visits ?? []) {
      if (!visitsByNode.has(visit.nodeId)) visitsByNode.set(visit.nodeId, []);
      visitsByNode.get(visit.nodeId).push({ ...visit, item });
    }
  }
  const startOf = visit => started.get(visit.assignmentId) ?? visit.startedAt;
  /** Items waiting for dispatch at a node at time t, rebuilt from visits plus the current queue. */
  const depthAt = (nodeId, t) => {
    const fromVisits = (visitsByNode.get(nodeId) ?? []).filter(visit => ms(visit.enteredAt) <= t && ms(visit.startedAt) > t).length;
    const current = items.filter(item => item.nodeId === nodeId && item.status === 'queued' && ms(item.enteredAt) <= t).length;
    return fromVisits + current;
  };

  const nodes = Object.values(plan.nodes).map(node => {
    const here = items.filter(item => item.nodeId === node.id);
    const visits = visitsByNode.get(node.id) ?? [];
    const ended = visits.filter(visit => inWindow(visit.endedAt));
    const done = ended.filter(visit => visit.result === 'pass').length;
    const failed = ended.filter(visit => visit.result === 'fail').length;
    const errors = ended.filter(visit => visit.result === 'error').length;
    const active = here.filter(item => (item.status === 'active' && item.waiting?.kind !== 'children') ||
      (node.type === 'human' && item.status === 'blocked')).length;
    const concurrency = node.role ? plan.roles[node.role].concurrency : null;
    return {
      nodeId: node.id,
      queued: here.filter(item => item.status === 'queued').length,
      active, done, failed, errors, concurrency,
      utilization: concurrency ? round(active / concurrency) : null,
      waitSec: stats(visits.filter(visit => inWindow(startOf(visit))).map(visit => Math.max(0, (ms(startOf(visit)) - ms(visit.enteredAt)) / 1000))),
      serviceSec: stats(ended.map(visit => Math.max(0, (ms(visit.endedAt) - ms(startOf(visit))) / 1000))),
      throughputPerHour: round((done + failed + errors) / (spanSec / 3600)),
      failureRate: done + failed + errors ? round((failed + errors) / (done + failed + errors)) : null,
      tokens: tokensByNode.get(node.id) ?? 0,
      retries: retriesByNode.get(node.id) ?? 0,
      escalations: escalationsByNode.get(node.id) ?? 0,
    };
  });

  const edgeCounts = new Map(plan.edges.map(edge => [edge.id, 0]));
  const unplanned = new Map();
  for (const event of ordered) {
    const kind = INTERACTIONS.get(event.type);
    if (!kind || !inWindow(event.at)) continue;
    const { edgeId, from, to } = event.data;
    if (edgeId && edgeCounts.has(edgeId) && event.data.unplanned !== true) { edgeCounts.set(edgeId, edgeCounts.get(edgeId) + 1); continue; }
    const match = typeof from === 'string' && typeof to === 'string' ? classifyInteraction(plan, { kind, from, to }) : null;
    if (match?.edgeId && event.data.unplanned !== true) { edgeCounts.set(match.edgeId, edgeCounts.get(match.edgeId) + 1); continue; }
    const key = `unplanned:${kind}:${match?.from ?? from ?? '?'}->${match?.to ?? to ?? '?'}`;
    const entry = unplanned.get(key) ?? { edgeId: key, kind, count: 0, unplanned: true, from: match?.from ?? from ?? null, to: match?.to ?? to ?? null };
    entry.count += 1;
    unplanned.set(key, entry);
  }
  const edges = [
    ...plan.edges.map(edge => ({ edgeId: edge.id, kind: edge.kind, count: edgeCounts.get(edge.id), unplanned: false })),
    ...[...unplanned.values()].sort((a, b) => a.edgeId.localeCompare(b.edgeId)),
  ];

  const leaves = items.filter(item => !item.childIds?.length);
  const finished = leaves.filter(item => item.status === 'done' && inWindow(item.completedAt));
  const buckets = windowSec <= 3600 ? 12 : windowSec <= 86400 ? 24 : Math.ceil(windowSec / 86400);
  const bucketMs = windowSec * 1000 / buckets;
  const trend = Array.from({ length: buckets }, () => 0);
  for (const item of finished) trend[Math.min(buckets - 1, Math.floor((ms(item.completedAt) - fromMs) / bucketMs))] += 1;
  const machinesInUse = new Map();
  for (const assignment of running) {
    const machineId = latest.get(assignment.id).machineId;
    if (!machineId) continue;
    const entry = machinesInUse.get(machineId) ?? { machineId, activeAgents: 0, nodes: new Set() };
    entry.activeAgents += 1;
    entry.nodes.add(assignment.nodeId);
    machinesInUse.set(machineId, entry);
  }
  const run = {
    velocity: { itemsDonePerDay: round(finished.length / (spanSec / 86400)), trend },
    cycleTimeSec: stats(finished.map(item => (ms(item.completedAt) - ms(item.createdAt)) / 1000)),
    wip: leaves.filter(item => item.status !== 'done' && item.status !== 'failed').length,
    tokensPerItem: finished.length ? Math.round(tokens / finished.length) : null,
    activeAgents: running.length,
    retries: [...retriesByNode.values()].reduce((sum, count) => sum + count, 0),
    escalations: escalationsInWindow.length,
    waitingOnHuman: items.filter(item => item.status === 'blocked').length,
    machines: [...machinesInUse.values()].sort((a, b) => a.machineId.localeCompare(b.machineId))
      .map(entry => ({ machineId: entry.machineId, activeAgents: entry.activeAgents, nodes: [...entry.nodes].sort() })),
  };

  const bottlenecks = [];
  const add = (nodeId, reason, severity, evidence) => bottlenecks.push({ nodeId, reason, evidence, severity });
  const R = BOTTLENECK_RULES;
  const label = windowLabel(windowSec);
  const startDepthAt = Math.max(fromMs, ms(state.startedAt));
  for (const metric of nodes) {
    const node = plan.nodes[metric.nodeId];
    const before = depthAt(node.id, startDepthAt);
    const growth = metric.queued - before;
    const saturated = metric.concurrency && metric.utilization >= R.saturatedUtilization && metric.queued > 0 && growth > 0;
    if (saturated) {
      add(node.id, 'saturated', metric.queued >= R.saturatedCriticalQueuePerSlot * metric.concurrency ? 'critical' : 'warning',
        `utilization ${metric.utilization.toFixed(2)} (${metric.active} of ${metric.concurrency} slots busy); queue ${metric.queued}, up from ${before} at window start`);
    } else if (growth >= R.queueGrowth) {
      add(node.id, 'queue-growing', 'warning',
        `queue ${metric.queued}, up from ${before} at window start${metric.waitSec.p90 !== null ? `; p90 wait ${duration(metric.waitSec.p90)}` : ''}`);
    }
    const finishedHere = metric.done + metric.failed + metric.errors;
    if (finishedHere >= R.highFailureMinFinished && metric.failureRate >= R.highFailureRate) {
      const detail = metric.errors ? `; ${metric.errors} were errors, ${metric.retries} retried` : '';
      add(node.id, 'high-failure', metric.failureRate >= R.criticalFailureRate ? 'critical' : 'warning',
        `${metric.failed + metric.errors} of ${finishedHere} finished visits failed (${Math.round(metric.failureRate * 100)}%) in the last ${label}${detail}`);
    }
    const blocked = items.filter(item => item.nodeId === node.id && item.status === 'blocked');
    if (blocked.length) {
      const since = blocked.map(item => { const visit = item.visits?.at(-1); return visit ? visit.endedAt ?? visit.startedAt : item.updatedAt; });
      const oldest = Math.max(...since.map(at => (nowMs - ms(at)) / 1000));
      add(node.id, 'waiting-on-human', oldest >= R.humanWaitCriticalSec ? 'critical' : oldest >= R.humanWaitWarningSec ? 'warning' : 'info',
        `${blocked.length} item${blocked.length === 1 ? '' : 's'} waiting for a person; oldest ${duration(oldest)}`);
    }
    if (Array.isArray(machines)) {
      const online = machines.filter(machine => machine?.status === 'online');
      const waiting = node.role
        ? assignments.filter(assignment => assignment.nodeId === node.id && OPEN_ASSIGNMENT.has(assignment.status) && !STARTED.has(latest.get(assignment.id)?.state)).map(assignment => assignment.requirements)
        : node.type === 'ci' ? Object.values(state.jobs).filter(job => job.nodeId === node.id && job.status === 'queued').map(job => job.requirements) : [];
      const stuck = waiting.filter(requirements => !online.some(machine => meets(machine, requirements)));
      if (stuck.length) {
        const needs = stuck[0];
        const parts = [needs.os && `os ${needs.os}`, needs.labels?.length && `labels ${needs.labels.join(', ')}`, needs.providers?.length && `providers ${needs.providers.join(', ')}`].filter(Boolean);
        add(node.id, 'no-capacity', 'critical',
          `${stuck.length} waiting ${node.role ? 'assignment' : 'job'}${stuck.length === 1 ? '' : 's'} need ${parts.join('; ') || 'any machine'}; 0 of ${online.length} online machines match`);
      }
    }
    if (node.type === 'loop') {
      const loop = plan.loops[node.id];
      // An escalation clears the item's count, so its record keeps the iterations it used.
      const escalated = escalationsInWindow.filter(record => record.from === node.id && record.reason === 'loop_limit');
      const peak = item => Math.max(item.loopCounts && Object.hasOwn(item.loopCounts, node.id) ? item.loopCounts[node.id] : 0,
        ...(item.escalations ?? []).filter(record => record.from === node.id && record.reason === 'loop_limit').map(record => record.iterations ?? 0));
      const looped = items.filter(item => peak(item) > 0 && inWindow(item.updatedAt));
      if (looped.length) {
        const avg = looped.reduce((sum, item) => sum + Math.min(peak(item), loop.maxIterations), 0) / looped.length;
        const escalatedItems = new Set(escalated.map(record => record.item.id));
        const limited = looped.filter(item => (item.failure?.reason === 'loop_limit' && item.nodeId === node.id) || escalatedItems.has(item.id)).length;
        if (limited || avg > loop.expectedIterations) {
          const targets = [...new Set(escalated.map(record => record.to))].sort();
          const detail = escalated.length ? `; ${escalatedItems.size} escalated to ${targets.join(', ')}` : '';
          add(node.id, 'rework-loop', limited ? 'critical' : 'warning',
            `average ${round(avg, 1)} iterations over ${looped.length} item${looped.length === 1 ? '' : 's'} (expected ${loop.expectedIterations}, limit ${loop.maxIterations}); ${limited} hit the limit${detail}`);
        }
      }
    }
  }
  bottlenecks.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || a.nodeId.localeCompare(b.nodeId) || a.reason.localeCompare(b.reason));

  return { runId: state.runId, at: now, windowSec, nodes, edges, run, bottlenecks };
}
