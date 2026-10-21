import { describe, expect, it } from 'vitest';
import buildGraph from '../../../../packages/workflow/templates/build.json';
import type { WorkflowGraph } from '../api/types';
import { autoLayout, backEdges } from './layout';
import { routeEdges } from './router';
import type { Pt, Route, RouteNode } from './router';
import { buildTemplate } from './templates';

const size = () => ({ w: 208, h: 120 });

/** The live map's flow lines for a graph laid out on one row, as the canvas draws them by default. */
function flowLines(graph: WorkflowGraph) {
  const back = backEdges(graph.nodes, graph.edges);
  const flow = graph.edges.filter((e) => e.kind === 'flow');
  const route = (pos: Map<string, { x: number; y: number }>) => {
    const nodes: RouteNode[] = graph.nodes.map((n) => ({ id: n.id, ...pos.get(n.id)!, ...size() }));
    const edges = flow.map((e) => ({ id: e.id, kind: e.kind, from: e.from.node, to: e.to.node, port: e.from.port, back: back.has(e.id), label: '12' }));
    return { nodes, ...routeEdges(nodes, edges, { singleRow: true }) };
  };
  const first = autoLayout(graph.nodes, graph.edges, size);
  return route(autoLayout(graph.nodes, graph.edges, size, route(first).gutterNeeds));
}

type Seg = { id: string; a: Pt; b: Pt };
const segments = (routes: Map<string, Route>): Seg[] => [...routes].flatMap(([id, r]) => r.points.slice(1).map((b, i) => ({ id, a: r.points[i], b })));
const horizontal = (s: Seg) => Math.abs(s.a[1] - s.b[1]) < 0.5;
const vertical = (s: Seg) => Math.abs(s.a[0] - s.b[0]) < 0.5;
const strictlyInside = (v: number, p: number, q: number) => v > Math.min(p, q) + 0.5 && v < Math.max(p, q) - 0.5;

/** A horizontal and a vertical segment of different edges that pass through each other (touching at an end is a join, not a crossing). */
function crossings(routes: Map<string, Route>) {
  const segs = segments(routes);
  const out: string[] = [];
  for (const h of segs.filter(horizontal))
    for (const v of segs.filter(vertical)) if (h.id !== v.id && strictlyInside(v.a[0], h.a[0], h.b[0]) && strictlyInside(h.a[1], v.a[1], v.b[1])) out.push(`${h.id} × ${v.id}`);
  return out;
}

/** Distinct heights of horizontal runs in each gap between rows of nodes, including above the first and below the last. */
function linesPerGap(nodes: RouteNode[], routes: Map<string, Route>) {
  const rows = [...new Set(nodes.map((n) => n.y))].sort((a, b) => a - b).map((y) => ({ top: y, bottom: y + Math.max(...nodes.filter((n) => n.y === y).map((n) => n.h)) }));
  const gaps = new Map<number, Set<number>>();
  for (const s of segments(routes).filter(horizontal)) {
    const y = s.a[1];
    if (rows.some((r) => y >= r.top && y <= r.bottom)) continue;
    const gap = rows.filter((r) => r.bottom < y).length;
    gaps.set(gap, new Set([...(gaps.get(gap) ?? []), Math.round(y)]));
  }
  return [...gaps.values()].map((ys) => ys.size);
}

describe('live map geometry', () => {
  for (const [name, graph] of [
    ['web build template', buildTemplate()],
    ['hub build template', buildGraph as unknown as WorkflowGraph],
  ] as const) {
    it(`${name}: no flow or return lines cross, and each gap holds at most one line`, () => {
      const { nodes, routes } = flowLines(graph);
      expect(crossings(routes)).toEqual([]);
      for (const n of linesPerGap(nodes, routes)) expect(n).toBeLessThanOrEqual(1);
      // All returns over the main line share one channel above it.
      const top = Math.min(...nodes.map((n) => n.y));
      const back = backEdges(graph.nodes, graph.edges);
      const channel = new Set([...routes].filter(([id]) => back.has(id)).flatMap(([, r]) => r.points.filter(([, y]) => y < top).map(([, y]) => Math.round(y))));
      expect(channel.size).toBeLessThanOrEqual(1);
    });
  }
});
