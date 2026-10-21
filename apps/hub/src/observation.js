import { object, requireValue } from './errors.js';
import { OWNER_ROLE_ID } from './messaging.js';

const windows = { '1h': 3600000, '24h': 86400000, '7d': 604800000 };
const interactions = ['workitem.moved', 'agent.delegated', 'agent.messaged', 'assignment.state', 'gate.result'];
const ROLE_TYPES = ['planner', 'agent', 'review'];
/** The node holding a role in this graph (roles are unique per graph), or null when no node does. */
const roleNode = (graph, role) => typeof role === 'string'
  ? graph.nodes.find(node => ROLE_TYPES.includes(node.type) && (typeof node.config?.role === 'string' ? node.config.role : node.id) === role)?.id ?? null : null;

export class Observation {
  constructor(hub) { this.hub = hub; this.store = hub.store; }
  isInteraction(type) { return interactions.includes(type); }
  interaction(type, value, data, subjectKind = 'assignment', engineOwned = false) {
    requireValue(interactions.includes(type), 'Invalid interaction type.'); object(data, 'interaction data');
    const run = this.store.need('run', value.runId);
    const graph = this.store.need('run-workflow', run.id).workflow.graph;
    let sourceNodeId = data.sourceNodeId ?? data.fromNodeId ?? data.nodeId ?? value.nodeId;
    let targetNodeId = data.targetNodeId ?? data.toNodeId;
    const unknown = {};
    if (type === 'agent.messaged') {
      // Messages name roles. Each end resolves to the node holding that role; an end no node holds is recorded as
      // explicitly unknown (null), never as the role id, so it can never be counted against a real edge.
      sourceNodeId ??= roleNode(graph, data.senderRoleId); targetNodeId ??= roleNode(graph, data.recipientRoleId);
      if (sourceNodeId === null) unknown.sourceUnknown = true;
      if (targetNodeId === null) unknown.targetUnknown = true;
    }
    // The owner is not a graph node, so these stay unplanned edges; `human` lets clients tell them apart.
    const human = type === 'agent.messaged' && [data.senderRoleId, data.recipientRoleId].includes(OWNER_ROLE_ID);
    const recovery = engineOwned && type === 'workitem.moved' && data.step === 'rebase' && data.edgeId === null && data.unplanned === false;
    const kind = { 'workitem.moved': 'flow', 'agent.delegated': 'delegates', 'agent.messaged': 'messages' }[type];
    const edge = kind && graph.edges.find(edge => edge.kind === kind && (!data.edgeId || edge.id === data.edgeId) &&
      sourceNodeId && targetNodeId && ((edge.from.node === sourceNodeId && edge.to.node === targetNodeId) ||
       (kind === 'messages' && edge.to.node === sourceNodeId && edge.from.node === targetNodeId)));
    // Metrics read edge endpoints as from/to; clients read sourceNodeId/targetNodeId. Record both.
    const event = { ...data, nodeId: data.nodeId ?? value.nodeId ?? sourceNodeId, sourceNodeId, ...(targetNodeId !== undefined ? { targetNodeId } : {}), ...unknown,
      ...(kind ? { from: sourceNodeId, ...(targetNodeId !== undefined ? { to: targetNodeId } : {}) } : {}),
      role: data.role ?? value.role, ...(value.machineId ? { machineId: value.machineId } : {}),
      ...(recovery ? { step: 'rebase', edgeId: null, unplanned: false, kind } : kind ? { unplanned: !edge, ...(edge ? { edgeId: edge.id, kind } : {}) } : {}), ...(human ? { human: true } : {}) };
    return this.hub.emit(type, subjectKind, value, event);
  }
  assignment(value) {
    const data = { state: value.status, nodeId: value.nodeId, role: value.role, attempt: value.attempt,
      ...(value.machineId ? { machineId: value.machineId } : {}), ...(value.accountId ? { accountId: value.accountId } : {}) };
    if (value.runId) this.interaction('assignment.state', value, data);
    else this.hub.emit('assignment.state', 'assignment', value, data);
  }
  async metrics({ projectId, runId, window = '24h' }) {
    requireValue(Object.hasOwn(windows, window), 'window must be 1h, 24h or 7d.');
    if (runId) this.store.need('run', runId); else this.store.need('project', projectId);
    const scoped = kind => runId ? this.store.forRun(kind, runId) : this.store.forProject(kind, projectId);
    const runs = this.store.list('run', value => (!runId || value.id === runId) && (!projectId || value.projectId === projectId));
    const assignments = scoped('assignment');
    const machines = this.store.list('machine');
    const from = new Date(this.hub.clock() - windows[window]).toISOString(); const at = this.hub.now();
    const events = this.store.eventsSince(from, { projectId, runId });
    const states = Object.fromEntries(runs.map(run => [run.id, this.store.get('engine-state', run.id)?.state ?? null]));
    const result = await this.hub.engine.computeRunMetrics({ projectId, runId, runs, states, workflows: runs.map(run => this.store.need('run-workflow', run.id).workflow),
      assignments, jobs: scoped('job'), workItems: scoped('work-item'), machines,
      usage: this.store.usageRecords({ projectId, runId }, from, at), events, window, windowMs: windows[window], from, at });
    object(result, 'metrics result'); object(result.run, 'run metrics');
    for (const key of ['nodes', 'edges', 'bottlenecks']) requireValue(Array.isArray(result[key]), `Metrics ${key} must be an array.`);
    const running = assignments.filter(value => ['leased', 'running'].includes(value.status) && Date.parse(value.leaseExpiresAt) > this.hub.clock());
    const byMachine = new Map();
    for (const assignment of running) {
      const group = byMachine.get(assignment.machineId) ?? { machineId: assignment.machineId, activeAgents: 0, nodes: [] };
      group.activeAgents++; if (!group.nodes.includes(assignment.nodeId)) group.nodes.push(assignment.nodeId); byMachine.set(assignment.machineId, group);
    }
    return { ...result, run: { ...result.run, activeAgents: running.length, machines: [...byMachine.values()] } };
  }
}
