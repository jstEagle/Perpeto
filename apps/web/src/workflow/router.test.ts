import { describe, expect, it } from 'vitest';
import buildGraph from '../../../../packages/workflow/templates/build.json';
import type { WorkflowGraph } from '../api/types';
import { autoLayout, mainLine, nodesOverlap } from './layout';
import { routeEdges } from './router';
import type { Route, RouteNode } from './router';
import { buildTemplate } from './templates';

const size = () => ({ w: 240, h: 172 });

function routed(graph: WorkflowGraph, positions = new Map(graph.nodes.map((n) => [n.id, n.position]))) {
  const nodes: RouteNode[] = graph.nodes.map((n) => ({ id: n.id, ...positions.get(n.id)!, ...size() }));
  const edges = graph.edges.map((e, i) => ({ id: e.id, kind: e.kind, from: e.from.node, to: e.to.node, port: e.from.port, label: `${10 + i} moved` }));
  return { nodes, ...routeEdges(nodes, edges) };
}

const overlap = (a: { x1: number; y1: number; x2: number; y2: number }, b: typeof a) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
const labelRect = (r: Route) => ({ x1: r.label!.x - r.label!.w / 2, y1: r.label!.y - r.label!.h / 2, x2: r.label!.x + r.label!.w / 2, y2: r.label!.y + r.label!.h / 2 });

function expectCleanLabels(nodes: RouteNode[], routes: Map<string, Route>) {
  const labels = [...routes.values()].filter((r) => r.label).map(labelRect);
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) expect(overlap(labels[i], labels[j])).toBe(false);
    for (const n of nodes) expect(overlap(labels[i], { x1: n.x, y1: n.y, x2: n.x + n.w, y2: n.y + n.h })).toBe(false);
  }
}

/** No two horizontal runs of different edges share the same y over overlapping x. */
function expectSeparateLanes(routes: Map<string, Route>) {
  const runs = [...routes.entries()].flatMap(([id, r]) =>
    r.points.slice(1).flatMap((p, i) => {
      const q = r.points[i];
      return Math.abs(p[1] - q[1]) < 0.5 && Math.abs(p[0] - q[0]) > 24 ? [{ id, y: p[1], x1: Math.min(p[0], q[0]) + 13, x2: Math.max(p[0], q[0]) - 13 }] : [];
    }),
  );
  for (const a of runs)
    for (const b of runs) if (a.id < b.id && Math.abs(a.y - b.y) < 1) expect(a.x2 < b.x1 || b.x2 < a.x1, `${a.id} and ${b.id} share a lane`).toBe(true);
}

describe('edge router', () => {
  it('routes the web build template with separate lanes and clean labels', () => {
    const { nodes, routes } = routed(buildTemplate());
    expect(routes.size).toBe(buildTemplate().edges.length);
    expectCleanLabels(nodes, routes);
    expectSeparateLanes(routes);
  });

  it('keeps main-line flow edges straight and delegates off the main line', () => {
    const g = buildTemplate();
    const { routes } = routed(g);
    expect(routes.get('e-input-out-planner')!.points).toHaveLength(2);
    const delegate = routes.get('d-planner-builder')!;
    const portY = g.nodes.find((n) => n.id === 'planner')!.position.y + 20;
    expect(delegate.points.every(([, y]) => Math.abs(y - portY) > 4)).toBe(true);
    expect(delegate.ends?.map((e) => e.end)).toEqual(['source', 'target']);
  });

  it('lays out the hub build template without overlap and routes it cleanly', () => {
    const g = buildGraph as unknown as WorkflowGraph;
    expect(nodesOverlap(g.nodes, size)).toBe(true);
    expect(mainLine(g.nodes, g.edges)).toEqual(['ideas', 'planner', 'delivery-loop', 'review-loop', 'builder', 'reviewer', 'ci', 'merge', 'shipped']);
    const first = autoLayout(g.nodes, g.edges, size);
    const positions = autoLayout(g.nodes, g.edges, size, routed(g, first).gutterNeeds);
    const laid = g.nodes.map((n) => ({ id: n.id, position: positions.get(n.id)! }));
    expect(nodesOverlap(laid, size)).toBe(false);
    const { nodes, routes } = routed(g, positions);
    expectCleanLabels(nodes, routes);
    expectSeparateLanes(routes);
    // The helper sits under the builder, so their delegate and messages run straight down as one cable.
    expect(positions.get('helper')!.x).toBe(positions.get('builder')!.x);
    const cable = [routes.get('builder-helper')!, routes.get('builder-helper-messages')!];
    for (const r of cable) expect(r.points).toHaveLength(2);
    expect(cable[0].points[0][0]).not.toBe(cable[1].points[0][0]);
  });

  it('bundles edges between the same two nodes under one label', () => {
    const nodes: RouteNode[] = [
      { id: 'a', x: 0, y: 0, w: 240, h: 100 },
      { id: 'b', x: 304, y: 0, w: 240, h: 100 },
      { id: 'c', x: 608, y: 0, w: 240, h: 100 },
    ];
    const { routes } = routeEdges(nodes, [
      { id: 'd', kind: 'delegates', from: 'a', to: 'c', label: '3 delegated' },
      { id: 'm', kind: 'messages', from: 'c', to: 'a', label: '5 messages' },
    ]);
    expect(routes.get('d')!.label?.text).toBe('3 delegated · 5 messages');
    expect(routes.get('m')!.label).toBeUndefined();
    // The message runs from c back to a.
    expect(routes.get('m')!.points[0][0]).toBeGreaterThan(routes.get('m')!.points.at(-1)![0]);
  });
});
