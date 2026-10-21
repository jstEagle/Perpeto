import type { Bottleneck, WorkflowGraph } from '../api/types';

/** A bottleneck as a sentence about the step: "Reviewer is saturated". */
const PHRASE: Record<Bottleneck['reason'], string> = {
  saturated: 'is saturated',
  'queue-growing': 'has a growing queue',
  'high-failure': 'fails often',
  'waiting-on-human': 'is waiting on a person',
  'no-capacity': 'has no capacity',
  'rework-loop': 'keeps returning work',
};

export function nodeLabel(graph: WorkflowGraph | undefined, nodeId: string): string {
  return graph?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
}

export function bottleneckTitle(b: Bottleneck, graph?: WorkflowGraph): string {
  return `${nodeLabel(graph, b.nodeId)} ${PHRASE[b.reason]}`;
}

/** Most urgent first. */
export function byUrgency(list: Bottleneck[]): Bottleneck[] {
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  return [...list].sort((a, b) => rank[a.severity] - rank[b.severity]);
}
