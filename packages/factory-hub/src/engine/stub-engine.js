/** Test-only engine. It creates work supplied as input and performs no inference or delivery. */
export function createStubEngine() {
  return {
    validate(graph) {
      const valid = graph?.schema === 'perpeto.workflow/1' && Array.isArray(graph.nodes) && Array.isArray(graph.edges);
      return { valid, errors: valid ? [] : ['Expected a workflow/1 graph.'] };
    },
    diffGraphs(from, to) { return { changed: JSON.stringify(from) !== JSON.stringify(to) }; },
    buildArchitectPrompt(context) { return JSON.stringify(context); },
    parseArchitectResult(result) { return { graph: result.graph, rationale: result.rationale }; },
    computeRunMetrics({ assignments, workflows, workItems }) {
      const nodes = [...new Map(workflows.flatMap(workflow => workflow.graph.nodes).map(node => [node.id, node])).values()].map(node => ({ nodeId: node.id,
        queued: assignments.filter(value => value.nodeId === node.id && value.status === 'queued').length,
        active: assignments.filter(value => value.nodeId === node.id && ['running', 'leased'].includes(value.status)).length,
        done: 0, failed: 0, concurrency: node.config.concurrency ?? 1, utilization: 0,
        waitSec: { avg: 0, p90: 0 }, serviceSec: { avg: 0, p90: 0 }, throughputPerHour: 0, failureRate: 0, tokens: 0 }));
      return { nodes, edges: [], run: { velocity: { itemsDonePerDay: 0, trend: [] }, cycleTimeSec: { avg: 0, p90: 0 }, wip: workItems.length, tokensPerItem: 0, activeAgents: 0, machines: [] }, bottlenecks: [] };
    },
    startRun() { return { state: { inputs: 0 }, effects: [] }; },
    applyEvent({ run, state, event }) {
      if (event.type !== 'input') return { state, effects: [] };
      const effects = [];
      for (const value of event.data.workItems ?? []) effects.push({ type: 'work-item', value: { ...value, runId: run.id } });
      for (const value of event.data.assignments ?? []) effects.push({ type: 'assignment', value: { ...value, runId: run.id } });
      for (const value of event.data.jobs ?? []) effects.push({ type: 'job', value: { ...value, runId: run.id } });
      return { state: { inputs: state.inputs + 1 }, effects };
    },
  };
}
