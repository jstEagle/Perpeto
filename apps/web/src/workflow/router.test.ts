import { describe, expect, it } from 'vitest';
import buildGraph from '../../../../packages/workflow/templates/build.json';
import type { GraphEdge, GraphNode, WorkflowGraph } from '../api/types';
import { autoLayout, COL_PITCH, hasUsablePositions, layer, mainLine, nodesOverlap } from './layout';
import { routeEdges } from './router';
import type { Route, RouteNode } from './router';
import { buildTemplate } from './templates';

const size = () => ({ w: 240, h: 172 });

function routed(graph: WorkflowGraph, positions = new Map(graph.nodes.map((n) => [n.id, n.position]))) {
  const nodes: RouteNode[] = graph.nodes.map((n) => ({ id: n.id, ...positions.get(n.id)!, ...size() }));
  const edges = graph.edges.map((e, i) => ({ id: e.id, kind: e.kind, from: e.from.node, to: e.to.node, port: e.from.port, label: `${10 + i} moved` }));
  return { nodes, ...routeEdges(nodes, edges) };
}

/** Positions from the two-pass layout the canvas uses. */
function laidOut(graph: WorkflowGraph) {
  const first = autoLayout(graph.nodes, graph.edges, size);
  return autoLayout(graph.nodes, graph.edges, size, routed(graph, first).gutterNeeds);
}

/** No flow edge passes through a node other than its own two ends. */
function expectNoEdgeThroughNodes(nodes: RouteNode[], routes: Map<string, Route>, graph: WorkflowGraph) {
  for (const e of graph.edges.filter((x) => x.kind === 'flow')) {
    const pts = routes.get(e.id)!.points;
    for (let i = 1; i < pts.length; i++) {
      const seg = { x1: Math.min(pts[i - 1][0], pts[i][0]), y1: Math.min(pts[i - 1][1], pts[i][1]), x2: Math.max(pts[i - 1][0], pts[i][0]), y2: Math.max(pts[i - 1][1], pts[i][1]) };
      for (const n of nodes) {
        if (n.id === e.from.node || n.id === e.to.node) continue;
        expect(overlap({ x1: seg.x1 - 0.5, y1: seg.y1 - 0.5, x2: seg.x2 + 0.5, y2: seg.y2 + 0.5 }, { x1: n.x, y1: n.y, x2: n.x + n.w, y2: n.y + n.h }), `${e.id} crosses ${n.id}`).toBe(false);
      }
    }
  }
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
    const g = buildTemplate();
    const { nodes, routes } = routed(g, laidOut(g));
    expect(routes.size).toBe(buildTemplate().edges.length);
    expectCleanLabels(nodes, routes);
    expectSeparateLanes(routes);
  });

  it('keeps main-line flow edges straight and delegates off the main line', () => {
    const g = buildTemplate();
    const positions = laidOut(g);
    const { routes } = routed(g, positions);
    expect(routes.get('e-input-out-planner')!.points).toHaveLength(2);
    const delegate = routes.get('d-planner-builder')!;
    const portY = positions.get('planner')!.y + 20;
    expect(delegate.points.every(([, y]) => Math.abs(y - portY) > 4)).toBe(true);
    expect(delegate.ends?.map((e) => e.end)).toEqual(['source', 'target']);
  });

  it('lays out the hub build template along the main flow and routes it cleanly', () => {
    const g = buildGraph as unknown as WorkflowGraph;
    expect(hasUsablePositions(g.nodes, size)).toBe(false);
    const line = ['ideas', 'planner', 'delivery-loop', 'review-loop', 'builder', 'reviewer', 'ci', 'merge', 'shipped'];
    expect(mainLine(g.nodes, g.edges)).toEqual(line);
    const positions = laidOut(g);
    const laid = g.nodes.map((n) => ({ id: n.id, position: positions.get(n.id)! }));
    expect(nodesOverlap(laid, size)).toBe(false);
    // One row, one column per step.
    const top = positions.get('ideas')!.y;
    line.forEach((id, i) => expect(positions.get(id)).toEqual({ x: i * COL_PITCH, y: top }));
    const { nodes, routes } = routed(g, positions);
    expectCleanLabels(nodes, routes);
    expectSeparateLanes(routes);
    expectNoEdgeThroughNodes(nodes, routes, g);
    // Forward steps run straight; returns into loops run above the main line, nested.
    for (const e of g.edges.filter((x) => x.kind === 'flow' && line.includes(x.from.node) && line.indexOf(x.to.node) === line.indexOf(x.from.node) + 1)) expect(routes.get(e.id)!.points).toHaveLength(2);
    const arcTop = (id: string) => Math.min(...routes.get(id)!.points.map(([, y]) => y));
    for (const id of ['reviewer-fail', 'ci-fail', 'merge-fail']) expect(arcTop(id)).toBeLessThan(top);
    expect(arcTop('reviewer-fail')).toBeGreaterThan(arcTop('ci-fail'));
    expect(arcTop('ci-fail')).toBeGreaterThan(arcTop('merge-fail'));
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

describe('auto layout', () => {
  it('puts side roles in a lane under the node they serve', () => {
    const g = buildGraph as unknown as WorkflowGraph;
    const { back } = layer(g.nodes, g.edges);
    expect([...back].sort()).toEqual(['ci-fail', 'merge-fail', 'reviewer-fail']);
    const p = autoLayout(g.nodes, g.edges, size);
    const lane = p.get('helper')!.y;
    expect(lane).toBeGreaterThan(p.get('builder')!.y);
    for (const id of ['senior-reviewer', 'triage']) expect(p.get(id)!.y).toBe(lane);
    expect(p.get('senior-reviewer')!.x).toBe(p.get('reviewer')!.x);
    expect(p.get('triage')!.x).toBe(p.get('ci')!.x);
  });

  it('wraps a long main line into balanced bands that fit the width', () => {
    const g = buildGraph as unknown as WorkflowGraph;
    const line = ['ideas', 'planner', 'delivery-loop', 'review-loop', 'builder', 'reviewer', 'ci', 'merge', 'shipped'];
    const first = autoLayout(g.nodes, g.edges, size, [], 4);
    const p = autoLayout(g.nodes, g.edges, size, routed(g, first).gutterNeeds, 4);
    // Nine steps at four columns: three bands of three, each below the last.
    line.forEach((id, i) => expect(p.get(id)!.x).toBe((i % 3) * COL_PITCH));
    const bandTop = [0, 3, 6].map((i) => p.get(line[i])!.y);
    expect(bandTop[1]).toBeGreaterThan(bandTop[0]);
    expect(bandTop[2]).toBeGreaterThan(bandTop[1]);
    const laid = g.nodes.map((n) => ({ id: n.id, position: p.get(n.id)! }));
    expect(nodesOverlap(laid, size)).toBe(false);
    // The wrap from one band to the next leaves the bottom of the step and enters the top of the next.
    const { nodes, routes } = routed(g, p);
    const wrap = routes.get(g.edges.find((e) => e.from.node === 'delivery-loop' && e.to.node === 'review-loop')!.id)!.points;
    const from = nodes.find((n) => n.id === 'delivery-loop')!;
    const to = nodes.find((n) => n.id === 'review-loop')!;
    expect(wrap[0][1]).toBe(from.y + from.h);
    expect(wrap.at(-1)![1]).toBe(to.y);
    expectCleanLabels(nodes, routes);
    expectSeparateLanes(routes);
  });

  it('orders nodes within a column to remove crossings', () => {
    const n = (id: string, type: GraphNode['type'], y: number): GraphNode => ({ id, type, label: id, position: { x: 0, y }, config: {} });
    const f = (from: string, to: string): GraphEdge => ({ id: `${from}-${to}`, kind: 'flow', from: { node: from }, to: { node: to } });
    const nodes = [n('i', 'input', 0), n('i2', 'input', 1), n('i3', 'input', 2), n('a', 'agent', 0), n('d', 'agent', 1), n('e', 'agent', 2), n('b', 'agent', 0), n('f', 'agent', 1), n('g', 'agent', 2)];
    const edges = [f('i', 'a'), f('i2', 'd'), f('i3', 'e'), f('a', 'b'), f('d', 'g'), f('e', 'f')];
    const { row } = layer(nodes, edges);
    expect(row.get('a')).toBe(0);
    expect(row.get('b')).toBe(0);
    expect(Math.sign(row.get('d')! - row.get('e')!)).toBe(Math.sign(row.get('g')! - row.get('f')!));
  });

  it('treats graphs without positions as needing a layout', () => {
    expect(hasUsablePositions(buildTemplate().nodes, size)).toBe(false);
    const g = buildTemplate();
    const p = laidOut(g);
    expect(hasUsablePositions(g.nodes.map((x) => ({ ...x, position: p.get(x.id)! })), size)).toBe(true);
  });
});
