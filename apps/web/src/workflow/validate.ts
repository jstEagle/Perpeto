import type { GraphNode, ValidationIssue, WorkflowGraph } from '../api/types';
import { NODE_SPECS, isRole, readHarness, readPolicy } from './registry';

/**
 * Client-side checks for live feedback while editing. The hub's
 * POST /workflows/:id/validate remains authoritative; its issues are merged
 * with these when a hub is connected.
 */
export function validateGraph(graph: WorkflowGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const name = (n: GraphNode) => n.label || NODE_SPECS[n.type].title;
  const err = (message: string, at: { nodeId?: string; edgeId?: string } = {}, code = 'invalid') =>
    issues.push({ code, message, severity: 'error', ...at });
  const warn = (message: string, at: { nodeId?: string; edgeId?: string } = {}, code = 'warning') =>
    issues.push({ code, message, severity: 'warning', ...at });

  if (!graph.nodes.some((n) => n.type === 'input')) err('Add an input node so work has somewhere to start.', {}, 'no_input');
  if (!graph.nodes.some((n) => n.type === 'output')) err('Add an output node so work can finish.', {}, 'no_output');

  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from.node);
    const to = nodes.get(edge.to.node);
    if (!from || !to) {
      err('Connection points to a node that no longer exists.', { edgeId: edge.id }, 'dangling_edge');
      continue;
    }
    const key = `${edge.kind}:${edge.from.node}:${edge.from.port ?? ''}:${edge.to.node}`;
    if (seen.has(key)) err(`Duplicate ${edge.kind} connection from ${name(from)} to ${name(to)}.`, { edgeId: edge.id }, 'duplicate_edge');
    seen.add(key);

    if (edge.kind === 'flow') {
      if (to.type === 'input') err(`${name(to)} is an input and cannot receive work.`, { edgeId: edge.id });
      if (from.type === 'output') err(`${name(from)} is an output and cannot pass work on.`, { edgeId: edge.id });
      const port = edge.from.port ?? 'out';
      if (!NODE_SPECS[from.type].outputs.includes(port)) err(`${name(from)} has no "${port}" port.`, { edgeId: edge.id });
    } else if (edge.kind === 'delegates') {
      if (!isRole(from)) err(`${name(from)} is not an agent role and cannot delegate.`, { edgeId: edge.id });
      if (to.type !== 'agent' && to.type !== 'review') err(`Delegation must target an agent or review role, not ${name(to)}.`, { edgeId: edge.id });
      const policy = readPolicy(from);
      if (from.type === 'agent' && policy && policy.maxSubagents === 0)
        err(`${name(from)} delegates to ${name(to)} but its policy allows 0 subagents.`, { edgeId: edge.id, nodeId: from.id }, 'policy_conflict');
    } else if (edge.kind === 'messages') {
      if (!isRole(from) || !isRole(to)) err('Messages connect two agent roles.', { edgeId: edge.id });
      if (from.id === to.id) err(`${name(from)} cannot message itself.`, { edgeId: edge.id });
    }
  }

  const flow = graph.edges.filter((e) => e.kind === 'flow' && nodes.has(e.from.node) && nodes.has(e.to.node));

  for (const node of graph.nodes) {
    const spec = NODE_SPECS[node.type];
    for (const port of spec.outputs) {
      const connected = flow.some((e) => e.from.node === node.id && (e.from.port ?? 'out') === port);
      if (!connected)
        err(port === 'out' ? `${name(node)} does not pass work anywhere.` : `${name(node)} "${port}" port is not connected.`, { nodeId: node.id }, 'open_port');
    }

    if (spec.role) {
      const h = readHarness(node);
      if (!h?.provider || !h?.model) err(`${name(node)} needs a harness provider and model.`, { nodeId: node.id }, 'missing_harness');
    }
    if (node.type === 'agent' || node.type === 'review') {
      const c = Number(node.config.concurrency ?? 1);
      if (!Number.isInteger(c) || c < 1) err(`${name(node)} concurrency must be a whole number of at least 1.`, { nodeId: node.id });
    }
    if (node.type === 'agent') {
      const p = readPolicy(node);
      if (!p) err(`${name(node)} needs an agent policy.`, { nodeId: node.id });
      else if (!Number.isInteger(p.maxSubagents) || p.maxSubagents < 0)
        err(`${name(node)} max subagents must be 0 or more.`, { nodeId: node.id });
      else if (p.maxSubagents > 0 && p.allowedSubagentProviders.length === 0)
        warn(`${name(node)} allows subagents but no providers for them.`, { nodeId: node.id });
    }
    if (node.type === 'planner') {
      const m = Number(node.config.maxItems ?? 0);
      if (!Number.isInteger(m) || m < 1) err(`${name(node)} max items must be at least 1.`, { nodeId: node.id });
    }
    if (node.type === 'ci') {
      const steps = Array.isArray(node.config.steps) ? (node.config.steps as { name?: string; run?: string }[]) : [];
      if (steps.length === 0) err(`${name(node)} needs at least one step.`, { nodeId: node.id }, 'no_steps');
      else if (steps.some((s) => !s.name?.trim() || !s.run?.trim())) err(`${name(node)} has a step without a name or command.`, { nodeId: node.id });
    }
    if (node.type === 'merge-queue') {
      const checks = node.config.requiredChecks as unknown[] | undefined;
      if (!checks?.length) warn(`${name(node)} merges without required checks.`, { nodeId: node.id });
    }
    if (node.type === 'loop') {
      const max = Number(node.config.maxIterations ?? 0);
      if (!Number.isInteger(max) || max < 1) err(`${name(node)} max iterations must be at least 1.`, { nodeId: node.id });
    }
    if (node.type === 'human' && !String(node.config.prompt ?? '').trim())
      warn(`${name(node)} has no prompt for the person deciding.`, { nodeId: node.id });
  }

  // Reachability from inputs along flow edges.
  const reached = new Set<string>();
  const stack = graph.nodes.filter((n) => n.type === 'input').map((n) => n.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const e of flow) if (e.from.node === id) stack.push(e.to.node);
  }
  for (const node of graph.nodes)
    if (node.type !== 'input' && !reached.has(node.id))
      warn(`${name(node)} is not reachable from an input, so work never arrives.`, { nodeId: node.id }, 'unreachable');

  // Every flow cycle must pass through a loop node, which bounds iterations:
  // with loop nodes removed, no cycle may remain.
  const isLoop = (id: string) => nodes.get(id)?.type === 'loop';
  const unlooped = flow.filter((e) => !isLoop(e.from.node) && !isLoop(e.to.node));
  for (const component of stronglyConnected(graph.nodes.filter((n) => n.type !== 'loop').map((n) => n.id), unlooped.map((e) => [e.from.node, e.to.node]))) {
    const cyclic = component.length > 1 || unlooped.some((e) => e.from.node === component[0] && e.to.node === component[0]);
    if (!cyclic) continue;
    const names = component.map((id) => name(nodes.get(id)!)).join(', ');
    err(`Work can cycle forever through ${names}. Route the cycle through a loop node.`, { nodeId: component[0] }, 'unbounded_cycle');
  }
  for (const node of graph.nodes) {
    if (node.type !== 'loop') continue;
    const comp = stronglyConnected(graph.nodes.map((n) => n.id), flow.map((e) => [e.from.node, e.to.node])).find((c) => c.includes(node.id));
    if (!comp || comp.length < 2) warn(`Nothing returns to ${name(node)}, so it never repeats.`, { nodeId: node.id }, 'loop_without_body');
  }

  return issues;
}

/** Tarjan's algorithm. */
function stronglyConnected(ids: string[], edges: [string, string][]): string[][] {
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [a, b] of edges) adj.get(a)?.push(b);
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      out.push(comp);
    }
  };
  for (const id of ids) if (!idx.has(id)) visit(id);
  return out;
}
