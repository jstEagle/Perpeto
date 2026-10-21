import type { GraphDiff, GraphEdge, GraphNode, WorkflowGraph } from '../api/types';

/** Edges are compared by meaning, not id, since a new version may renumber them. */
export function edgeSignature(e: GraphEdge): string {
  return `${e.kind}|${e.from.node}|${e.from.port ?? ''}|${e.to.node}|${e.to.port ?? ''}`;
}

function nodeContent(n: GraphNode): string {
  return JSON.stringify([n.type, n.label, sortKeys(n.config)]);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)]));
  return value;
}

/**
 * Differences from `before` to `after`. Node ids are stable across versions;
 * moving a node is not a change. Added ids refer to `after`, removed ids to
 * `before`.
 */
export function diffGraphs(before: WorkflowGraph, after: WorkflowGraph): GraphDiff {
  const a = new Map(before.nodes.map((n) => [n.id, n]));
  const b = new Map(after.nodes.map((n) => [n.id, n]));
  const nodes = { added: [] as string[], removed: [] as string[], changed: [] as string[] };
  for (const [id, n] of b) {
    const old = a.get(id);
    if (!old) nodes.added.push(id);
    else if (nodeContent(old) !== nodeContent(n)) nodes.changed.push(id);
  }
  for (const id of a.keys()) if (!b.has(id)) nodes.removed.push(id);

  const aSig = new Map(before.edges.map((e) => [edgeSignature(e), e]));
  const bSig = new Map(after.edges.map((e) => [edgeSignature(e), e]));
  const edges = { added: [] as string[], removed: [] as string[], changed: [] as string[] };
  for (const [sig, e] of bSig) if (!aSig.has(sig)) edges.added.push(e.id);
  for (const [sig, e] of aSig) if (!bSig.has(sig)) edges.removed.push(e.id);
  return { nodes, edges };
}

export function diffIsEmpty(diff: GraphDiff): boolean {
  return [diff.nodes.added, diff.nodes.removed, diff.nodes.changed, diff.edges.added, diff.edges.removed].every((l) => l.length === 0);
}

/** Config keys whose values differ, for the "changed" detail list. */
export function changedKeys(before: GraphNode, after: GraphNode): string[] {
  const keys = new Set([...Object.keys(before.config), ...Object.keys(after.config)]);
  const out: string[] = [];
  if (before.label !== after.label) out.push('label');
  for (const k of keys) if (JSON.stringify(sortKeys(before.config[k])) !== JSON.stringify(sortKeys(after.config[k]))) out.push(k);
  return out;
}
