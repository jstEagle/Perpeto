/** Test-only engine. It creates work supplied as input and performs no inference or delivery. */
export function createStubEngine() {
  return {
    validate(graph) {
      const valid = graph?.schema === 'perpeto.workflow/1' && Array.isArray(graph.nodes) && Array.isArray(graph.edges);
      return { valid, errors: valid ? [] : ['Expected a workflow/1 graph.'] };
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
