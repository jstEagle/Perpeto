import { object, requireValue } from './errors.js';

const windows = { '1h': 3600000, '24h': 86400000, '7d': 604800000 };
const interactions = ['workitem.moved', 'agent.delegated', 'agent.messaged', 'assignment.state', 'gate.result'];

export class Observation {
  constructor(hub) { this.hub = hub; this.store = hub.store; }
  isInteraction(type) { return interactions.includes(type); }
  interaction(type, value, data, subjectKind = 'assignment') {
    requireValue(interactions.includes(type), 'Invalid interaction type.'); object(data, 'interaction data');
    const run = this.store.need('run', value.runId);
    const graph = this.store.need('run-workflow', run.id).workflow.graph;
    const sourceNodeId = data.sourceNodeId ?? data.fromNodeId ?? data.nodeId ?? value.nodeId;
    const targetNodeId = data.targetNodeId ?? data.toNodeId ?? (type === 'agent.messaged' ? data.recipientRoleId : undefined);
    const kind = { 'workitem.moved': 'flow', 'agent.delegated': 'delegates', 'agent.messaged': 'messages' }[type];
    const edge = kind && graph.edges.find(edge => edge.kind === kind && (!data.edgeId || edge.id === data.edgeId) &&
      ((edge.from.node === sourceNodeId && edge.to.node === targetNodeId) ||
       (kind === 'messages' && edge.to.node === sourceNodeId && edge.from.node === targetNodeId)));
    const event = { ...data, nodeId: data.nodeId ?? value.nodeId, sourceNodeId, ...(targetNodeId ? { targetNodeId } : {}),
      role: data.role ?? value.role, ...(value.machineId ? { machineId: value.machineId } : {}),
      ...(kind ? { unplanned: !edge, ...(edge ? { edgeId: edge.id, kind } : {}) } : {}) };
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
    const matches = value => (!projectId || value.projectId === projectId) && (!runId || value.runId === runId);
    const runs = this.store.list('run', value => (!runId || value.id === runId) && (!projectId || value.projectId === projectId));
    const assignments = this.store.list('assignment', matches);
    const machines = this.store.list('machine');
    const from = new Date(Date.now() - windows[window]).toISOString(); const at = new Date().toISOString();
    const events = this.store.db.prepare('SELECT seq FROM events WHERE at>=? AND (? IS NULL OR project_id=?) AND (? IS NULL OR run_id=?) ORDER BY seq')
      .all(from, projectId ?? null, projectId ?? null, runId ?? null, runId ?? null).flatMap(row => this.store.events(row.seq - 1, 1));
    const states = Object.fromEntries(runs.map(run => [run.id, this.store.get('engine-state', run.id)?.state ?? null]));
    const result = await this.hub.engine.computeRunMetrics({ projectId, runId, runs, states, workflows: runs.map(run => this.store.need('run-workflow', run.id).workflow),
      assignments, jobs: this.store.list('job', matches), workItems: this.store.list('work-item', matches), machines,
      usage: this.store.list('usage', value => matches(value) && value.at >= from && value.at <= at), events, window, windowMs: windows[window], from, at });
    object(result, 'metrics result'); object(result.run, 'run metrics');
    for (const key of ['nodes', 'edges', 'bottlenecks']) requireValue(Array.isArray(result[key]), `Metrics ${key} must be an array.`);
    const running = assignments.filter(value => ['leased', 'running'].includes(value.status) && Date.parse(value.leaseExpiresAt) > Date.now());
    const byMachine = new Map();
    for (const assignment of running) {
      const group = byMachine.get(assignment.machineId) ?? { machineId: assignment.machineId, activeAgents: 0, nodes: [] };
      group.activeAgents++; if (!group.nodes.includes(assignment.nodeId)) group.nodes.push(assignment.nodeId); byMachine.set(assignment.machineId, group);
    }
    return { ...result, run: { ...result.run, activeAgents: running.length, machines: [...byMachine.values()] } };
  }
}
