import { useCallback, useEffect, useMemo, useState } from 'react';
import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow, useStore } from '@xyflow/react';
import type { Connection, EdgeChange, IsValidConnection, NodeChange, ReactFlowState } from '@xyflow/react';
import type { Bottleneck, EdgeKind, GraphDiff, GraphEdge, GraphNode, MetricsSnapshot, NodeType, WorkItem, WorkflowGraph } from '../api/types';
import { StepNode, NODE_WIDTH } from './step-node';
import type { StepData, StepNodeType } from './step-node';
import { RuledEdge } from './ruled-edge';
import type { RuledEdgeType } from './ruled-edge';
import { changedKeys } from './diff';
import { graphPort } from './registry';
import { IconFit, IconMinus, IconPlus } from '../components/icons';
import { Segmented } from '../components/ui';
import { autoLayout, nodesOverlap } from './layout';
import type { Size } from './layout';
import { routeEdges } from './router';

export type Selection = { kind: 'node' | 'edge'; id: string } | null;

export interface GraphCanvasProps {
  graph: WorkflowGraph;
  mode: 'edit' | 'view' | 'live';
  label: string;
  /** Diff against a base graph; removed nodes and edges are drawn as ghosts. */
  diff?: { base: WorkflowGraph; diff: GraphDiff };
  live?: { metrics: MetricsSnapshot; items: WorkItem[] };
  issuesByNode?: Map<string, { errors: number; warnings: number }>;
  selection?: Selection;
  onSelect?(selection: Selection): void;
  onGraphChange?(graph: WorkflowGraph): void;
  roleKind?: Exclude<EdgeKind, 'flow'>;
  /** Which delegates and messages to draw at first. Live maps default to the selected node's. */
  connections?: Connections;
  /** Palette drops in the editor. */
  onDropNode?(type: NodeType, position: { x: number; y: number }): void;
  className?: string;
}

export const DRAG_MIME = 'application/x-perpeto-node';

const nodeTypes = { step: StepNode };
const edgeTypes = { ruled: RuledEdge };

type EdgeMeta = {
  edge: GraphEdge;
  diff?: 'added' | 'removed';
  unplanned?: boolean;
  traffic?: number;
};
export type Connections = 'selected' | 'all';

/** Height before React Flow has measured a node; close to the real one so the first frame barely moves. */
const ESTIMATED_HEIGHT = { edit: 88, view: 88, live: 172 } as const;
const TRAFFIC_WORD: Record<EdgeKind, [string, string]> = {
  flow: ['moved', 'moved'],
  delegates: ['delegated', 'delegated'],
  messages: ['message', 'messages'],
};

function labelFor(m: EdgeMeta, live: boolean): string | undefined {
  if (m.diff) return m.diff === 'added' ? 'Added' : 'Removed';
  if (!live) return undefined;
  const c = m.traffic ?? 0;
  if (m.unplanned) return `Unplanned · ${c}`;
  if (c === 0) return undefined;
  if (m.edge.kind === 'flow') return m.edge.from.port === 'fail' ? `${c} returned` : String(c);
  return `${c} ${TRAFFIC_WORD[m.edge.kind][c === 1 ? 0 : 1]}`;
}

/** Unplanned interactions may name a role rather than a node. */
function resolveNode(graph: WorkflowGraph, ref?: string | null): string | undefined {
  if (!ref) return undefined;
  if (graph.nodes.some((n) => n.id === ref)) return ref;
  return graph.nodes.find((n) => n.config?.role === ref)?.id;
}

function CanvasInner(props: GraphCanvasProps) {
  const { graph, mode, diff, live, issuesByNode, selection, onSelect, onGraphChange, roleKind = 'delegates', label } = props;
  const flow = useReactFlow();
  const [connections, setConnections] = useState<Connections>(props.connections ?? (mode === 'live' ? 'selected' : 'all'));

  const bottlenecks = useMemo(() => new Map<string, Bottleneck>((live?.metrics.bottlenecks ?? []).map((b) => [b.nodeId, b])), [live]);
  const metricsByNode = useMemo(() => new Map((live?.metrics.nodes ?? []).map((m) => [m.nodeId, m])), [live]);
  const itemsByNode = useMemo(() => {
    const map = new Map<string, WorkItem[]>();
    for (const item of live?.items ?? []) map.set(item.nodeId, [...(map.get(item.nodeId) ?? []), item]);
    return map;
  }, [live]);

  // Everything drawn: the graph, ghosts of removed nodes and edges, and unplanned interactions.
  const ghostNodes = useMemo<GraphNode[]>(
    () => (diff ? diff.diff.nodes.removed.flatMap((id) => diff.base.nodes.filter((n) => n.id === id)).map((n) => ({ ...n, id: `removed:${n.id}` })) : []),
    [diff],
  );
  const allNodes = useMemo(() => [...graph.nodes, ...ghostNodes], [graph, ghostNodes]);
  const allEdges = useMemo<EdgeMeta[]>(() => {
    const traffic = new Map((live?.metrics.edges ?? []).map((m) => [m.edgeId, m]));
    const out: EdgeMeta[] = graph.edges.map((e) => ({
      edge: e,
      diff: diff?.diff.edges.added.includes(e.id) ? 'added' : undefined,
      traffic: live ? (traffic.get(e.id)?.count ?? 0) : undefined,
    }));
    if (diff) {
      const exists = (id: string) => graph.nodes.some((n) => n.id === id);
      for (const id of diff.diff.edges.removed) {
        const e = diff.base.edges.find((b) => b.id === id);
        if (!e) continue;
        out.push({
          edge: {
            ...e,
            id: `removed:${e.id}`,
            from: {
              ...e.from,
              node: exists(e.from.node) ? e.from.node : `removed:${e.from.node}`,
            },
            to: {
              ...e.to,
              node: exists(e.to.node) ? e.to.node : `removed:${e.to.node}`,
            },
          },
          diff: 'removed',
        });
      }
    }
    for (const m of live?.metrics.edges ?? []) {
      if (!m.unplanned) continue;
      const from = resolveNode(graph, m.from);
      const to = resolveNode(graph, m.to);
      if (!from || !to || from === to) continue;
      out.push({
        edge: {
          id: m.edgeId,
          kind: m.kind,
          from: { node: from },
          to: { node: to },
        },
        unplanned: true,
        traffic: m.count,
      });
    }
    return out;
  }, [graph, diff, live]);

  const focusNodeIds = useMemo(() => {
    if (!selection) return null;
    if (selection.kind === 'node') return new Set([selection.id]);
    const e = allEdges.find((x) => x.edge.id === selection.id)?.edge;
    return new Set([e?.from.node, e?.to.node].filter(Boolean) as string[]);
  }, [selection, allEdges]);

  // Delegates and messages: all, or only the selected node's. Unplanned ones always show.
  const roleCount = allEdges.filter((m) => m.edge.kind !== 'flow' && !m.unplanned).length;
  const visible = useMemo(
    () =>
      allEdges.filter((m) => {
        if (m.edge.kind === 'flow' || m.unplanned || connections === 'all') return true;
        if (selection?.kind === 'edge') return selection.id === m.edge.id;
        return selection?.kind === 'node' && (m.edge.from.node === selection.id || m.edge.to.node === selection.id);
      }),
    [allEdges, connections, selection],
  );

  const sizesKey = useStore((s: ReactFlowState) => {
    let out = '';
    for (const n of s.nodeLookup.values()) out += `${n.id}:${Math.round(n.measured.width ?? 0)}:${Math.round(n.measured.height ?? 0)}|`;
    return out;
  });
  const size = useMemo(() => {
    const measured = new Map<string, Size>();
    for (const part of sizesKey.split('|')) {
      const [id, w, h] = part.split(':');
      if (id && Number(w) > 0 && Number(h) > 0) measured.set(id, { w: Number(w), h: Number(h) });
    }
    return (id: string): Size => measured.get(id) ?? { w: NODE_WIDTH, h: ESTIMATED_HEIGHT[mode] };
  }, [sizesKey, mode]);

  // View and live screens re-lay graphs whose stored positions would overlap
  // at this node size, widening the gaps between rows until the lanes fit.
  const positions = useMemo(() => {
    const stored = new Map(allNodes.map((n) => [n.id, n.position]));
    if (mode === 'edit' || !nodesOverlap(allNodes, size)) return stored;
    // Lay out with every edge so toggling which links show never moves nodes.
    const layoutEdges = allEdges.map((m) => m.edge);
    const toRoute = (pos: Map<string, { x: number; y: number }>) =>
      routeEdges(
        allNodes.map((n) => ({ id: n.id, ...pos.get(n.id)!, ...size(n.id) })),
        layoutEdges.map((e) => ({
          id: e.id,
          kind: e.kind,
          from: e.from.node,
          to: e.to.node,
          port: e.from.port,
        })),
      );
    const first = autoLayout(allNodes, layoutEdges, size);
    return autoLayout(allNodes, layoutEdges, size, toRoute(first).gutterNeeds);
  }, [allNodes, allEdges, size, mode]);

  const builtNodes = useMemo<StepNodeType[]>(
    () =>
      allNodes.map((n) => {
        const removed = n.id.startsWith('removed:');
        let mark: StepData['diff'];
        let keys: string[] | undefined;
        if (removed) mark = 'removed';
        else if (diff) {
          if (diff.diff.nodes.added.includes(n.id)) mark = 'added';
          else if (diff.diff.nodes.changed.includes(n.id)) {
            mark = 'changed';
            const before = diff.base.nodes.find((b) => b.id === n.id);
            keys = before ? changedKeys(before, n) : undefined;
          }
        }
        return {
          id: n.id,
          type: 'step',
          position: positions.get(n.id) ?? n.position,
          draggable: mode === 'edit' && !removed,
          selectable: !removed,
          deletable: mode === 'edit' && !removed,
          zIndex: removed ? -1 : undefined,
          selected: selection?.kind === 'node' && selection.id === n.id,
          data: {
            node: n,
            mode: removed ? 'view' : mode,
            issues: issuesByNode?.get(n.id),
            diff: mark,
            changedKeys: keys,
            metrics: metricsByNode.get(n.id),
            bottleneck: bottlenecks.get(n.id),
            items: itemsByNode.get(n.id),
            dimmed: mode === 'live' && !!focusNodeIds && selection?.kind === 'edge' && !focusNodeIds.has(n.id),
          },
        };
      }),
    [allNodes, positions, mode, diff, issuesByNode, metricsByNode, bottlenecks, itemsByNode, selection, focusNodeIds],
  );

  const [nodes, setNodes] = useState<StepNodeType[]>(builtNodes);
  useEffect(() => {
    setNodes((prev) =>
      builtNodes.map((n) => ({
        ...n,
        measured: prev.find((p) => p.id === n.id)?.measured,
      })),
    );
  }, [builtNodes]);

  // Routes follow the nodes as drawn, including while a node is dragged in the editor.
  const routing = useMemo(() => {
    const priority = (m: EdgeMeta) => (selection?.kind === 'edge' && selection.id === m.edge.id ? 3 : m.unplanned ? 2 : m.edge.kind === 'flow' ? 1 : 0);
    return routeEdges(
      nodes.map((n) => ({
        id: n.id,
        x: n.position.x,
        y: n.position.y,
        ...size(n.id),
      })),
      visible.map((m) => ({
        id: m.edge.id,
        kind: m.edge.kind,
        from: m.edge.from.node,
        to: m.edge.to.node,
        port: m.edge.from.port,
        label: labelFor(m, !!live),
        priority: priority(m),
      })),
    );
  }, [nodes, visible, size, selection, live]);

  const edges = useMemo<RuledEdgeType[]>(
    () =>
      visible.map(({ edge: e, diff: mark, unplanned, traffic }) => {
        const flowEdge = e.kind === 'flow';
        const highlighted = selection?.kind === 'edge' && selection.id === e.id;
        const removed = mark === 'removed';
        return {
          id: e.id,
          type: 'ruled',
          source: e.from.node,
          sourceHandle: flowEdge ? (e.from.port ?? 'out') : 'role-out',
          target: e.to.node,
          targetHandle: flowEdge ? 'in' : 'role-in',
          selectable: !removed,
          selected: highlighted,
          deletable: mode === 'edit' && !removed,
          data: {
            kind: e.kind,
            port: e.from.port,
            route: routing.routes.get(e.id),
            diff: mark,
            unplanned,
            traffic,
            highlighted,
            dimmed: mode === 'live' && !!focusNodeIds && !(focusNodeIds.has(e.from.node) || focusNodeIds.has(e.to.node)),
          },
        };
      }),
    [visible, routing, selection, mode, focusNodeIds],
  );

  // Refit once the measured layout settles, so a re-laid graph is framed.
  const layoutKey = useMemo(() => [...positions.entries()].map(([id, p]) => `${id}:${p.x}:${p.y}`).join('|'), [positions]);
  const [narrow] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 600px)').matches);
  useEffect(() => {
    if (mode === 'edit' || narrow) return;
    // After React Flow has taken the new positions from the nodes effect.
    const timer = setTimeout(() => void flow.fitView({ padding: 0.06, maxZoom: 1 }), 80);
    return () => clearTimeout(timer);
  }, [layoutKey, mode, narrow, flow]);

  const onNodesChange = useCallback(
    (changes: NodeChange<StepNodeType>[]) => {
      setNodes((prev) => applyNodeChanges(changes, prev));
      if (mode !== 'edit' || !onGraphChange) return;
      const removed = changes.flatMap((c) => (c.type === 'remove' ? [c.id] : []));
      const moved = changes.flatMap((c) => (c.type === 'position' && c.dragging === false && c.position ? [{ id: c.id, position: c.position }] : []));
      if (removed.length) {
        onGraphChange({
          ...graph,
          nodes: graph.nodes.filter((n) => !removed.includes(n.id)),
          edges: graph.edges.filter((e) => !removed.includes(e.from.node) && !removed.includes(e.to.node)),
        });
        onSelect?.(null);
      } else if (moved.length) {
        onGraphChange({
          ...graph,
          nodes: graph.nodes.map((n) => {
            const c = moved.find((m) => m.id === n.id);
            return c
              ? {
                  ...n,
                  position: {
                    x: Math.round(c.position.x),
                    y: Math.round(c.position.y),
                  },
                }
              : n;
          }),
        });
      }
    },
    [graph, mode, onGraphChange, onSelect],
  );

  // Dragging ends with a position change that has dragging: false only in
  // some cases; persist positions on drag stop as well.
  const onNodeDragStop = useCallback(
    (_: unknown, __: unknown, dragged: StepNodeType[]) => {
      if (mode !== 'edit' || !onGraphChange) return;
      onGraphChange({
        ...graph,
        nodes: graph.nodes.map((n) => {
          const d = dragged.find((x) => x.id === n.id);
          return d
            ? {
                ...n,
                position: {
                  x: Math.round(d.position.x),
                  y: Math.round(d.position.y),
                },
              }
            : n;
        }),
      });
    },
    [graph, mode, onGraphChange],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<RuledEdgeType>[]) => {
      if (mode !== 'edit' || !onGraphChange) return;
      const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
      if (removed.length) {
        onGraphChange({
          ...graph,
          edges: graph.edges.filter((e) => !removed.includes(e.id)),
        });
        onSelect?.(null);
      }
    },
    [graph, mode, onGraphChange, onSelect],
  );

  const isValidConnection = useCallback<IsValidConnection>((c) => {
    if (c.source === c.target) return false;
    const role = c.sourceHandle?.startsWith('role-out');
    return role ? !!c.targetHandle?.startsWith('role-in') : c.targetHandle === 'in';
  }, []);

  const onConnect = useCallback(
    (c: Connection) => {
      if (!onGraphChange) return;
      const kind: EdgeKind = c.sourceHandle?.startsWith('role-out') ? roleKind : 'flow';
      const port = kind === 'flow' ? graphPort(c.sourceHandle) : undefined;
      const id = `${kind === 'flow' ? 'e' : kind === 'delegates' ? 'd' : 'm'}-${c.source}-${port ?? (kind === 'flow' ? 'out' : '')}-${c.target}`.replace(/--/g, '-');
      if (graph.edges.some((e) => e.id === id)) return;
      onGraphChange({
        ...graph,
        edges: [
          ...graph.edges,
          {
            id,
            kind,
            from: { node: c.source, ...(port ? { port } : {}) },
            to: { node: c.target },
          },
        ],
      });
      onSelect?.({ kind: 'edge', id });
    },
    [graph, onGraphChange, onSelect, roleKind],
  );

  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const showToggle = mode !== 'edit' && roleCount > 0;
  // View and live canvases get a toolbar strip so zoom controls never sit on top of nodes.
  const showBar = mode !== 'edit';
  const zoom = (
    <div className={showBar ? 'graph-zoom' : 'graph-controls'} role="toolbar" aria-label="Canvas zoom">
      <button className="icon-btn" aria-label="Zoom in" onClick={() => flow.zoomIn({ duration: reduced ? 0 : 120 })}>
        <IconPlus />
      </button>
      <button className="icon-btn" aria-label="Zoom out" onClick={() => flow.zoomOut({ duration: reduced ? 0 : 120 })}>
        <IconMinus />
      </button>
      <button
        className="icon-btn"
        aria-label="Fit graph to view"
        onClick={() =>
          flow.fitView({
            padding: 0.08,
            maxZoom: 1,
            duration: reduced ? 0 : 160,
          })
        }
      >
        <IconFit />
      </button>
    </div>
  );

  return (
    <div className={`graph ${props.className ?? ''} graph-${mode} ${showBar ? 'has-bar' : ''}`} role="group" aria-label={label}>
      {showBar && (
        <div className="graph-bar">
          {zoom}
          {showToggle && (
            <>
              <span className="graph-bar-label">{connections === 'selected' && !selection ? 'Select a node to show its delegates and messages' : 'Delegates and messages'}</span>
              <Segmented<Connections>
                label="Delegates and messages"
                value={connections}
                onChange={setConnections}
                options={[
                  { value: 'selected', label: 'Selected node' },
                  { value: 'all', label: `All ${roleCount}` },
                ]}
              />
            </>
          )}
        </div>
      )}
      <ReactFlow<StepNodeType, RuledEdgeType>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeClick={(_, n) => !n.id.startsWith('removed:') && onSelect?.({ kind: 'node', id: n.id })}
        onEdgeClick={(_, e) => !e.id.startsWith('removed:') && onSelect?.({ kind: 'edge', id: e.id })}
        onPaneClick={() => onSelect?.(null)}
        onDragOver={(e) => {
          if (!props.onDropNode || !e.dataTransfer.types.includes(DRAG_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(e) => {
          const type = e.dataTransfer.getData(DRAG_MIME) as NodeType;
          if (!props.onDropNode || !type) return;
          e.preventDefault();
          const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
          props.onDropNode(type, {
            x: Math.round((p.x - NODE_WIDTH / 2) / 16) * 16,
            y: Math.round((p.y - 20) / 16) * 16,
          });
        }}
        nodesDraggable={mode === 'edit'}
        nodesConnectable={mode === 'edit'}
        elementsSelectable
        deleteKeyCode={mode === 'edit' ? ['Backspace', 'Delete'] : null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        fitView={!narrow}
        defaultViewport={narrow ? { x: 16, y: 48, zoom: 0.62 } : undefined}
        fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.6}
        snapToGrid
        snapGrid={[16, 16]}
        connectionLineStyle={{ strokeWidth: 1.5 }}
        proOptions={{ hideAttribution: false }}
        ariaLabelConfig={{
          'node.a11yDescription.default': 'Press Enter to select this node. Use arrow keys to move a selected node in the editor.',
        }}
      >
        <Background id="minor" variant={BackgroundVariant.Lines} gap={16} lineWidth={1} className="graph-grid-minor" />
        <Background id="major" variant={BackgroundVariant.Lines} gap={64} lineWidth={1} className="graph-grid-major" />
      </ReactFlow>
      {!showBar && zoom}
    </div>
  );
}

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

export function EdgeLegend({ live }: { live?: boolean }) {
  return (
    <ul className="edge-legend" aria-label="Connection kinds">
      <li>
        <svg width="28" height="8" aria-hidden="true">
          <path d="M0 4h28" className="gedge gedge-flow" />
        </svg>
        Flow
      </li>
      {live && (
        <li>
          <svg width="28" height="8" aria-hidden="true">
            <path d="M0 4h28" className="gedge gedge-flow gedge-unreached" />
          </svg>
          Not reached yet
        </li>
      )}
      <li>
        <svg width="28" height="8" aria-hidden="true">
          <rect x="0.5" y="1" width="6" height="6" rx="1" className="gedge-end gedge-end-delegates gedge-end-source" />
          <path d="M6 4h16" className="gedge gedge-delegates" />
          <rect x="21.5" y="1" width="6" height="6" rx="1" className="gedge-end gedge-end-delegates gedge-end-target" />
        </svg>
        Delegates, from the filled end
      </li>
      <li>
        <svg width="28" height="8" aria-hidden="true">
          <rect x="0.5" y="1" width="6" height="6" rx="1" className="gedge-end gedge-end-messages" />
          <path d="M6 4h16" className="gedge gedge-messages" />
          <rect x="21.5" y="1" width="6" height="6" rx="1" className="gedge-end gedge-end-messages" />
        </svg>
        Messages
      </li>
      {live && (
        <li>
          <svg width="28" height="8" aria-hidden="true">
            <path d="M0 4h28" className="gedge gedge-messages gedge-unplanned" />
          </svg>
          Unplanned
        </li>
      )}
    </ul>
  );
}

export { NODE_WIDTH };
