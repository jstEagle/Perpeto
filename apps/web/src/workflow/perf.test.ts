import { describe, expect, it } from 'vitest';
import { autoLayout } from './layout';
import { routeEdges } from './router';
import { syntheticGraph } from './synthetic';

describe('200-node graph', () => {
  it('lays out and routes within budget', () => {
    const g = syntheticGraph(200);
    expect(g.nodes.length).toBeGreaterThanOrEqual(190);
    const size = () => ({ w: 240, h: 172 });
    const route = (pos: Map<string, { x: number; y: number }>) =>
      routeEdges(
        g.nodes.map((n) => ({ id: n.id, ...pos.get(n.id)!, ...size() })),
        g.edges.map((e) => ({ id: e.id, kind: e.kind, from: e.from.node, to: e.to.node, port: e.from.port, label: '12' })),
      );
    const t0 = performance.now();
    const first = autoLayout(g.nodes, g.edges, size);
    const positions = autoLayout(g.nodes, g.edges, size, route(first).gutterNeeds);
    const t1 = performance.now();
    const routing = route(positions);
    const t2 = performance.now();
    expect(routing.routes.size).toBe(g.edges.length);
    // Generous budgets for a cold run on a slow CI machine; typical is under 30 ms and 5 ms.
    expect(t1 - t0).toBeLessThan(400);
    expect(t2 - t1).toBeLessThan(100);
  });
});
