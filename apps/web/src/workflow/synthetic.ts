import type { GraphEdge, GraphNode, MetricsSnapshot, NodeMetrics, WorkflowGraph, WorkItem } from '../api/types';
import { NODE_SPECS } from './registry';

/**
 * A large, realistic-shaped workflow for performance checks: a planner fans
 * out to parallel tracks of review loops (builder with a delegated helper,
 * reviewer returning to the loop, CI every other stage), joined by a merge
 * queue. Escalations go to one triage gate. Deterministic for a given size.
 */
export function syntheticGraph(target = 200, tracks = 6): WorkflowGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const add = (id: string, type: GraphNode['type'], label: string, config: Record<string, unknown> = {}) => {
    nodes.push({ id, type, label, position: { x: 0, y: 0 }, config: { ...NODE_SPECS[type].defaults(), ...config } });
    return id;
  };
  const flow = (from: string, to: string, port?: string) => edges.push({ id: `e-${from}-${port ?? 'out'}-${to}`, kind: 'flow', from: { node: from, ...(port ? { port } : {}) }, to: { node: to } });
  const role = (kind: 'delegates' | 'messages', from: string, to: string) => edges.push({ id: `${kind[0]}-${from}-${to}`, kind, from: { node: from }, to: { node: to } });

  add('input', 'input', 'Ideas');
  add('planner', 'planner', 'Planner');
  add('triage', 'human', 'Triage');
  add('merge', 'merge-queue', 'Merge queue');
  add('done', 'output', 'Shipped');
  flow('input', 'planner');
  flow('merge', 'done', 'pass');
  flow('merge', 'planner', 'fail');
  flow('triage', 'planner', 'pass');

  // Each stage adds a loop, builder, helper and reviewer, and CI every other stage.
  const perTrack = Math.max(1, Math.ceil((target - nodes.length) / tracks / 4.5));
  for (let t = 0; t < tracks; t++) {
    let prev = 'planner';
    for (let s = 0; s < perTrack && nodes.length < target; s++) {
      const k = `t${t}s${s}`;
      const loop = add(`loop-${k}`, 'loop', `Loop ${t + 1}.${s + 1}`, { onExhausted: 'triage' });
      const builder = add(`build-${k}`, 'agent', `Builder ${t + 1}.${s + 1}`, { onBlocked: 'triage' });
      const helper = add(`help-${k}`, 'agent', `Helper ${t + 1}.${s + 1}`);
      const review = add(`review-${k}`, 'review', `Reviewer ${t + 1}.${s + 1}`);
      flow(prev, loop, prev === 'planner' ? undefined : 'pass');
      flow(loop, builder);
      flow(builder, review);
      flow(review, loop, 'fail');
      role('delegates', builder, helper);
      role('messages', builder, review);
      prev = review;
      if (s % 2 === 1 && nodes.length < target) {
        const ci = add(`ci-${k}`, 'ci', `CI ${t + 1}.${s + 1}`, { onExhausted: 'triage' });
        flow(review, ci, 'pass');
        flow(ci, loop, 'fail');
        prev = ci;
      }
    }
    flow(prev, 'merge', prev === 'planner' ? undefined : 'pass');
  }
  return { schema: 'perpeto.workflow/1', nodes, edges };
}

/** Metrics and items for every node of a synthetic graph; `tick` varies the numbers. */
export function syntheticLive(graph: WorkflowGraph, tick = 0): { metrics: MetricsSnapshot; items: WorkItem[] } {
  const roll = (i: number, m: number) => (i * 7 + tick * 3) % m;
  const nodes = graph.nodes.map((n, i): NodeMetrics => {
    const limited = n.type === 'agent' || n.type === 'review';
    return {
      nodeId: n.id,
      active: roll(i, 3),
      queued: roll(i, 6),
      done: 10 + roll(i, 40),
      failed: roll(i, 2),
      concurrency: limited ? 2 : null,
      utilization: limited ? roll(i, 3) / 2 : null,
      failureRate: null,
      waitSec: { avg: 30 + roll(i, 300), p90: 300 },
      serviceSec: { avg: 600, p90: 1200 },
      throughputPerHour: roll(i, 10) / 2,
      tokens: 0,
    };
  });
  const edges = graph.edges.map((e, i) => ({ edgeId: e.id, kind: e.kind, count: roll(i, 30), unplanned: false }));
  const items: WorkItem[] = graph.nodes
    .filter((n) => n.type === 'agent' || n.type === 'review')
    .flatMap((n, i) =>
      Array.from({ length: roll(i, 4) }, (_, j) => ({
        id: `wi-${n.id}-${j}`,
        runId: 'run_perf',
        title: `Item ${i}.${j}`,
        body: '',
        nodeId: n.id,
        status: j === 0 ? 'active' : 'queued',
        iteration: 1,
      })),
    );
  const run = { velocity: { itemsDonePerDay: 0, trend: [] }, cycleTimeSec: { avg: null, p90: null }, wip: items.length, tokensPerItem: null, activeAgents: 0, machines: [] };
  const metrics: MetricsSnapshot = { window: '24h', nodes, edges, run, bottlenecks: [] };
  return { metrics, items };
}
