import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { autoLayout, backEdges, COL_GAP, COL_PITCH, GRID, hasUsablePositions } from './layout';
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
  /**
   * Editor only: the graph arrived without usable positions, so the canvas
   * laid it out. Apply it without marking the graph as changed.
   */
  onLayout?(graph: WorkflowGraph): void;
  /** Overrides the node-count check for virtualised, compact rendering. The perf page compares both. */
  large?: boolean;
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
const ESTIMATED_HEIGHT = { edit: 64, view: 64, live: 120 } as const;
/** The editor never opens below this zoom; a longer graph opens at its start instead. */
const EDIT_MIN_ZOOM = 0.6;
/** Space kept clear around the graph inside the canvas when choosing how many columns fit. */
const PANE_PAD = 16;
/** Height limits for view and live canvases, and the room kept for padding, legend and toolbar. */
const MIN_HEIGHT = 360;
const MAX_HEIGHT = 900;
const CANVAS_CHROME = 160;
/** Space under the graph for the legend and toolbar when fitting. */
const FIT_BOTTOM = 72;
/** Above this many nodes, only nodes and edges in view are rendered, and far-out zoom draws compact nodes. */
export const LARGE_GRAPH = 60;
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

function sameNode(a: StepNodeType, b: StepNodeType): boolean {
  if (a.position.x !== b.position.x || a.position.y !== b.position.y || a.selected !== b.selected || a.draggable !== b.draggable) return false;
  const keys = Object.keys(b.data) as (keyof StepData)[];
  return keys.length === Object.keys(a.data).length && keys.every((k) => a.data[k] === b.data[k]);
}

function CanvasInner(props: GraphCanvasProps) {
  const { graph, mode, diff, live, issuesByNode, selection, onSelect, onGraphChange, roleKind = 'delegates', label } = props;
  const flow = useReactFlow();
  // Delegates and messages show for the selected node only, unless the editor needs them or a proposal changes them.
  const roleChanged = !!diff && [...diff.diff.edges.added, ...diff.diff.edges.removed].some((id) => [...diff.base.edges, ...graph.edges].find((e) => e.id === id)?.kind !== 'flow');
  const [connections, setConnections] = useState<Connections>(props.connections ?? (mode === 'edit' || roleChanged ? 'all' : 'selected'));

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

  const large = props.large ?? allNodes.length > LARGE_GRAPH;
  const measuredKey = useStore((s: ReactFlowState) => {
    let out = '';
    for (const n of s.nodeLookup.values()) out += `${n.id}:${Math.round(n.measured.width ?? 0)}:${Math.round(n.measured.height ?? 0)}|`;
    return out;
  });
  // On large graphs, nodes scrolled into view are measured while the user
  // pans. Take their sizes once the pan pauses, so edges re-route once
  // rather than on every frame.
  const [settledKey, setSettledKey] = useState(measuredKey);
  useEffect(() => {
    if (!large) return;
    const timer = setTimeout(() => setSettledKey(measuredKey), 160);
    return () => clearTimeout(timer);
  }, [large, measuredKey]);
  const sizesKey = large ? settledKey : measuredKey;
  const size = useMemo(() => {
    const measured = new Map<string, Size>();
    for (const part of sizesKey.split('|')) {
      const [id, w, h] = part.split(':');
      if (id && Number(w) > 0 && Number(h) > 0) measured.set(id, { w: Number(w), h: Number(h) });
    }
    return (id: string): Size => measured.get(id) ?? { w: NODE_WIDTH, h: ESTIMATED_HEIGHT[mode] };
  }, [sizesKey, mode]);

  // Automatic layout uses one row height for every node: the tallest seen
  // for this graph. It only grows, so nodes measured late (offscreen ones on
  // large graphs) or drawn compact never move the layout.
  const nodeKey = useMemo(() => allNodes.map((n) => n.id).join('|'), [allNodes]);
  const slot = useRef({ key: '', h: 0 });
  const slotHeight = useMemo(() => {
    const h = Math.max(ESTIMATED_HEIGHT[mode], ...allNodes.map((n) => size(n.id).h));
    slot.current = slot.current.key === nodeKey ? { key: nodeKey, h: Math.max(slot.current.h, h) } : { key: nodeKey, h };
    return slot.current.h;
  }, [allNodes, size, mode, nodeKey]);

  // Lay out with every edge so toggling which links show never moves nodes.
  // Keyed on structure, so live traffic updates do not recompute it.
  const structureKey = allEdges.map((m) => `${m.edge.id}:${m.edge.kind}:${m.edge.from.node}:${m.edge.from.port ?? ''}:${m.edge.to.node}`).join('|');
  const layoutEdges = useMemo(() => allEdges.map((m) => m.edge), [structureKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Columns that fit the canvas at full size; longer main lines wrap into bands.
  const paneRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(Infinity);
  useEffect(() => {
    const el = paneRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setColumns(Math.max(3, Math.floor((el.clientWidth - 2 * PANE_PAD + COL_GAP) / COL_PITCH)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const returns = useMemo(() => backEdges(allNodes, layoutEdges), [allNodes, layoutEdges]);
  const tidyPositions = useMemo(() => {
    const layoutSize = (): Size => ({ w: NODE_WIDTH, h: slotHeight });
    const toRoute = (pos: Map<string, { x: number; y: number }>) =>
      routeEdges(
        allNodes.map((n) => ({ id: n.id, ...pos.get(n.id)!, ...layoutSize() })),
        layoutEdges.map((e) => ({ id: e.id, kind: e.kind, from: e.from.node, to: e.to.node, port: e.from.port, back: returns.has(e.id) })),
      );
    // Twice: the first pass finds how many lanes each gap needs.
    const first = autoLayout(allNodes, layoutEdges, layoutSize, [], columns);
    return autoLayout(allNodes, layoutEdges, layoutSize, toRoute(first).gutterNeeds, columns);
  }, [allNodes, layoutEdges, slotHeight, columns, returns]);

  // Stored positions are kept when they fit at this node size. View and
  // live screens can show the tidy layout over them on request; the editor
  // writes it into the graph instead.
  const usable = useMemo(() => hasUsablePositions(allNodes, size), [allNodes, size]);
  const [tidied, setTidied] = useState(false);
  const [usableAtMount] = useState(() => hasUsablePositions(graph.nodes, () => ({ w: NODE_WIDTH, h: ESTIMATED_HEIGHT[mode] })));
  // In the editor, the tidy layout shows only until the graph carries it;
  // after that, overlapping nodes are the author's choice.
  const [settled, setSettled] = useState(usableAtMount);
  useEffect(() => {
    if (!settled && usable) setSettled(true);
  }, [settled, usable]);
  const auto = mode === 'edit' ? !settled : !usable || tidied;
  const positions = useMemo(() => (auto ? tidyPositions : new Map(allNodes.map((n) => [n.id, n.position]))), [auto, tidyPositions, allNodes]);

  const withPositions = useCallback(
    (pos: Map<string, { x: number; y: number }>): WorkflowGraph => ({ ...graph, nodes: graph.nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })) }),
    [graph],
  );
  // The editor takes the layout of a graph that arrived without usable positions once, unchanged otherwise.
  const { onLayout } = props;
  const laidOut = useRef(false);
  useEffect(() => {
    // Wait for the canvas width, so the layout wraps to it.
    if (mode !== 'edit' || usableAtMount || laidOut.current || !onLayout || !Number.isFinite(columns)) return;
    laidOut.current = true;
    onLayout(withPositions(tidyPositions));
  }, [mode, usableAtMount, onLayout, withPositions, tidyPositions, columns]);
  const tidy = () => {
    if (mode === 'edit') onGraphChange?.(withPositions(tidyPositions));
    else setTidied((t) => !t);
  };

  // Nodes whose inputs did not change keep their object, so React Flow
  // re-renders only what changed (a selection touches two nodes, not all).
  const builtCache = useRef(new Map<string, StepNodeType>());
  const builtNodes = useMemo<StepNodeType[]>(() => {
    const next = new Map<string, StepNodeType>();
    const out = allNodes.map((n): StepNodeType => {
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
      const fresh: StepNodeType = {
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
          large,
        },
      };
      const old = builtCache.current.get(n.id);
      const node = old && sameNode(old, fresh) ? old : fresh;
      next.set(n.id, node);
      return node;
    });
    builtCache.current = next;
    return out;
  }, [allNodes, positions, mode, diff, issuesByNode, metricsByNode, bottlenecks, itemsByNode, selection, focusNodeIds, large]);

  const [nodes, setNodes] = useState<StepNodeType[]>(builtNodes);
  const lastBuilt = useRef(new Map(builtNodes.map((n) => [n.id, n])));
  useEffect(() => {
    const before = lastBuilt.current;
    lastBuilt.current = new Map(builtNodes.map((n) => [n.id, n]));
    setNodes((prev) => {
      const current = new Map(prev.map((p) => [p.id, p]));
      // Unchanged nodes keep their state object, including what React Flow measured.
      return builtNodes.map((n) => {
        const p = current.get(n.id);
        return p && before.get(n.id) === n ? p : { ...n, measured: p?.measured };
      });
    });
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
        back: returns.has(m.edge.id),
      })),
    );
  }, [nodes, visible, size, selection, live, returns]);

  // Like nodes, edges whose route and state did not change keep their object.
  const edgeCache = useRef(new Map<string, { key: string; edge: RuledEdgeType }>());
  const edges = useMemo<RuledEdgeType[]>(() => {
    const next = new Map<string, { key: string; edge: RuledEdgeType }>();
    const out = visible.map(({ edge: e, diff: mark, unplanned, traffic }) => {
      const flowEdge = e.kind === 'flow';
      const highlighted = selection?.kind === 'edge' && selection.id === e.id;
      const removed = mark === 'removed';
      const route = routing.routes.get(e.id);
      const dimmed = mode === 'live' && !!focusNodeIds && !(focusNodeIds.has(e.from.node) || focusNodeIds.has(e.to.node));
      const key = JSON.stringify([e.from, e.to, e.kind, mark, unplanned, traffic, highlighted, dimmed, mode, route]);
      const old = edgeCache.current.get(e.id);
      const edge: RuledEdgeType =
        old?.key === key
          ? old.edge
          : {
              id: e.id,
              type: 'ruled',
              source: e.from.node,
              sourceHandle: flowEdge ? (e.from.port ?? 'out') : 'role-out',
              target: e.to.node,
              targetHandle: flowEdge ? 'in' : 'role-in',
              selectable: !removed,
              selected: highlighted,
              deletable: mode === 'edit' && !removed,
              data: { kind: e.kind, port: e.from.port, route, diff: mark, unplanned, traffic, highlighted, dimmed },
            };
      next.set(e.id, { key, edge });
      return edge;
    });
    edgeCache.current = next;
    return out;
  }, [visible, routing, selection, mode, focusNodeIds]);

  // Refit once the measured layout settles, so a re-laid graph is framed,
  // including the return channel and lanes outside the node boxes.
  const layoutKey = useMemo(() => [...positions.entries()].map(([id, p]) => `${id}:${p.x}:${p.y}`).join('|'), [positions]);
  const [narrow] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 600px)').matches);
  const routingRef = useRef(routing);
  routingRef.current = routing;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  // Read through a ref: a node measured late must not refit a view the user has zoomed.
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const fit = useCallback(
    (duration = 0, whole = false) => {
      let x1 = Infinity;
      let y1 = Infinity;
      let x2 = -Infinity;
      let y2 = -Infinity;
      const add = (x: number, y: number) => {
        x1 = Math.min(x1, x);
        y1 = Math.min(y1, y);
        x2 = Math.max(x2, x);
        y2 = Math.max(y2, y);
      };
      for (const n of nodesRef.current) {
        const { w, h } = sizeRef.current(n.id);
        add(n.position.x, n.position.y);
        add(n.position.x + w, n.position.y + h);
      }
      for (const r of routingRef.current.routes.values()) for (const [x, y] of r.points) add(x, y);
      if (!Number.isFinite(x1)) return;
      const pane = paneRef.current?.getBoundingClientRect();
      const fitted = pane ? Math.min(pane.width / ((x2 - x1) * 1.12), pane.height / ((y2 - y1) * 1.12), 1) : 1;
      // The editor needs readable nodes more than the whole graph at once: open at
      // the start of the flow instead of shrinking a long main line out of reach.
      if (pane && mode === 'edit' && !whole && fitted < EDIT_MIN_ZOOM) {
        const zoom = EDIT_MIN_ZOOM;
        const top = Math.max(GRID * 6, (pane.height - (y2 - y1) * zoom) / 2);
        void flow.setViewport({ x: GRID * 6 - x1 * zoom, y: top - y1 * zoom, zoom }, { duration });
        return;
      }
      if (!pane) return void flow.fitBounds({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, { padding: 0.06, duration });
      // Never above 100 %: a small graph sits centred at full size. Room is kept below for the legend and toolbar.
      const room = { w: pane.width - 2 * PANE_PAD, h: pane.height - FIT_BOTTOM - PANE_PAD };
      const zoom = Math.max(0.3, Math.min(1, room.w / (x2 - x1), room.h / (y2 - y1)));
      void flow.setViewport({ x: (pane.width - (x2 - x1) * zoom) / 2 - x1 * zoom, y: PANE_PAD + Math.max(0, (room.h - (y2 - y1) * zoom) / 2) - y1 * zoom, zoom }, { duration });
    },
    [flow, mode],
  );
  // The editor frames the graph once, after any layout on open.
  const editorFramed = useRef(false);
  useEffect(() => {
    if (narrow || (mode === 'edit' && editorFramed.current)) return;
    // After React Flow has taken the new positions from the nodes effect.
    const timer = setTimeout(() => {
      fit();
      editorFramed.current = true;
    }, 80);
    return () => clearTimeout(timer);
  }, [layoutKey, mode, narrow, fit]);

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
  // View and live canvases are as tall as the graph at full size (within
  // limits), with room below for the legend and toolbar.
  const height = useMemo(() => {
    if (mode === 'edit' || narrow) return undefined;
    let y1 = Infinity;
    let y2 = -Infinity;
    for (const n of nodes) {
      y1 = Math.min(y1, n.position.y);
      y2 = Math.max(y2, n.position.y + size(n.id).h);
    }
    for (const r of routing.routes.values()) for (const [, y] of r.points) (y1 = Math.min(y1, y)), (y2 = Math.max(y2, y));
    return Number.isFinite(y1) ? Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, y2 - y1 + CANVAS_CHROME))) : undefined;
  }, [mode, narrow, nodes, routing, size]);
  const showToggle = mode !== 'edit' && roleCount > 0;
  const legend = {
    flowing: mode === 'live' && edges.some((e) => e.data?.kind === 'flow' && (e.data.traffic ?? 0) > 0),
    unreached: mode === 'live' && edges.some((e) => e.data?.kind === 'flow' && e.data.traffic === 0),
    delegates: edges.some((e) => e.data?.kind === 'delegates' && !e.data.unplanned),
    messages: edges.some((e) => e.data?.kind === 'messages' && !e.data.unplanned),
    unplanned: edges.some((e) => e.data?.unplanned),
    live: mode === 'live' && nodes.some((n) => (n.data.metrics?.active ?? 0) > 0),
    diff: !!diff,
  };

  return (
    <div ref={paneRef} className={`graph ${props.className ?? ''} graph-${mode}`} style={height ? { height } : undefined} role="group" aria-label={label}>
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
            x: Math.round((p.x - NODE_WIDTH / 2) / GRID) * GRID,
            y: Math.round((p.y - 32) / GRID) * GRID,
          });
        }}
        nodesDraggable={mode === 'edit'}
        nodesConnectable={mode === 'edit'}
        elementsSelectable
        deleteKeyCode={mode === 'edit' ? ['Backspace', 'Delete'] : null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        fitView={!narrow && mode !== 'edit'}
        onlyRenderVisibleElements={large}
        defaultViewport={narrow ? { x: 16, y: 48, zoom: 0.62 } : undefined}
        fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.6}
        snapToGrid
        snapGrid={[GRID, GRID]}
        connectionLineStyle={{ strokeWidth: 1.5 }}
        proOptions={{ hideAttribution: false }}
        ariaLabelConfig={{
          'node.a11yDescription.default': 'Press Enter to select this node. Use arrow keys to move a selected node in the editor.',
        }}
      >
        <Background id="dots" variant={BackgroundVariant.Dots} gap={24} size={1.5} className="graph-dots" />
      </ReactFlow>
      {mode !== 'edit' && <EdgeLegend {...legend} />}
      <div className="map-tools" role="toolbar" aria-label="Map">
        {showToggle && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-pressed={connections === 'all'}
            onClick={() => setConnections((c) => (c === 'all' ? 'selected' : 'all'))}
            title={connections === 'all' ? 'Show only the selected node’s delegates and messages' : 'Show every delegate and message'}
          >
            {connections === 'all' ? 'All links' : 'Selected links'}
          </button>
        )}
        {(mode === 'edit' || usable) && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={tidy}
            aria-pressed={mode === 'edit' ? undefined : tidied}
            title={mode === 'edit' ? 'Arrange nodes along the main flow' : 'Show the automatic layout instead of the saved positions'}
          >
            Tidy layout
          </button>
        )}
        {(showToggle || mode === 'edit' || usable) && <span className="map-tools-rule" aria-hidden="true" />}
        <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Zoom out" onClick={() => flow.zoomOut({ duration: reduced ? 0 : 140 })}>
          <IconMinus />
        </button>
        <ZoomLevel />
        <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Zoom in" onClick={() => flow.zoomIn({ duration: reduced ? 0 : 140 })}>
          <IconPlus />
        </button>
        <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Fit graph to view" onClick={() => fit(reduced ? 0 : 220, true)}>
          <IconFit />
        </button>
      </div>
    </div>
  );
}

/** The zoom level, subscribed on its own so the canvas does not re-render as it changes. */
function ZoomLevel() {
  const zoom = useStore((s: ReactFlowState) => Math.round(s.transform[2] * 100));
  return (
    <span className="map-zoom" aria-live="off">
      {zoom}%
    </span>
  );
}

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

/** Only the styles on screen, bottom left in 12 px muted. */
export function EdgeLegend({ flowing, unreached, delegates, messages, unplanned, live, diff }: { flowing?: boolean; unreached?: boolean; delegates?: boolean; messages?: boolean; unplanned?: boolean; live?: boolean; diff?: boolean }) {
  const line = (cls: string) => (
    <svg width="20" height="8" aria-hidden="true">
      <path d="M1 4h18" className={`gedge ${cls}`} />
    </svg>
  );
  return (
    <ul className="map-legend" aria-label="Legend">
      <li>{line('gedge-flow')}Flow</li>
      {flowing && <li>{line('gedge-flow gedge-active')}Flowing now</li>}
      {unreached && <li>{line('gedge-flow gedge-unreached')}Not reached</li>}
      {delegates && <li>{line('gedge-delegates')}Delegates</li>}
      {messages && <li>{line('gedge-messages')}Messages</li>}
      {unplanned && <li>{line('gedge-messages gedge-unplanned')}Unplanned</li>}
      {diff && <li>{line('gedge-flow gedge-added')}Added</li>}
      {diff && <li>{line('gedge-flow gedge-removed')}Removed</li>}
      {live && (
        <li>
          <span className="dot dot-legend" aria-hidden="true" />
          Live
        </li>
      )}
    </ul>
  );
}

export { NODE_WIDTH };
