// Dev-only page (vite dev server: /perf.html) that renders the live map for
// a synthetic graph. scripts/perf.mjs drives it and reports frame rates and
// latencies. Not part of the production build.
// Query: ?n=200 nodes, &large=0 to turn off virtualisation and compact nodes.
import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GraphCanvas } from '../workflow/graph-canvas';
import type { Selection } from '../workflow/graph-canvas';
import { syntheticGraph, syntheticLive } from '../workflow/synthetic';
import '../styles/tokens.css';
import '@xyflow/react/dist/base.css';
import '../styles/app.css';
import '../styles/graph.css';

const params = new URLSearchParams(location.search);
const graph = syntheticGraph(Number(params.get('n') ?? 200));
const large = params.has('large') ? params.get('large') !== '0' : undefined;

declare global {
  interface Window {
    perf: { nodes: number; edges: number; tick(): Promise<number>; ready: boolean };
  }
}

const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

function App() {
  const [tick, setTick] = useState(0);
  const [selection, setSelection] = useState<Selection>(null);
  const live = useMemo(() => syntheticLive(graph, tick), [tick]);
  window.perf = {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    ready: true,
    async tick() {
      const t0 = performance.now();
      setTick((t) => t + 1);
      await nextPaint();
      return performance.now() - t0;
    },
  };
  return (
    <div style={{ padding: 24, maxWidth: 1180 }}>
      <GraphCanvas graph={graph} mode="live" label="Synthetic live map" live={live} selection={selection} onSelect={setSelection} large={large} className="graph-map" />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
