import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow, useStore } from '@xyflow/react';
import type { Connection, EdgeChange, IsValidConnection, NodeChange, ReactFlowState } from '@xyflow/react';
import type { Bottleneck, EdgeKind, GraphDiff, GraphEdge, GraphNode, MetricsSnapshot, NodeType, WorkItem, WorkflowGraph } from '../api/types';
import { StepNode, NODE_WIDTH } from './step-node';
import type { StepData, StepNodeType } from './step-node';
import { RuledEdge } from './ruled-edge';
import type { RuledEdgeType } from './ruled-edge';
import { changedKeys } from './diff';
import { graphPort, sourcePort } from './registry';
import { IconArrowRight, IconFit, IconMinus, IconPlus } from '../components/icons';
import { autoLayout, backEdges, COL_GAP, COL_PITCH, COMPACT_GAP, COMPACT_W, GRID, hasUsablePositions, layer } from './layout';
import type { Size } from './layout';
import { routeEdges } from './router';
import { byUrgency } from '../run/issues';

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
  /** Bring this node into view, for "Show on map". A new object each time it is asked for. */
  focus?: { id: string };
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
/** Main lines up to this many steps stay on one row. */
const SINGLE_ROW_COLUMNS = 10;
/** The live map shrinks to fit down to this zoom, then scrolls sideways instead. */
export const MIN_FIT = 0.75;
/** Height of a compact card before it is measured. */
const COMPACT_HEIGHT = 100;
/** Height limits for view and live canvases, and the room kept for padding, legend and toolbar. */
const MIN_HEIGHT = 300;
const MAX_HEIGHT = 900;
const CANVAS_CHROME = 160;
/** Space under the graph for the legend and toolbar when fitting. */
const FIT_BOTTOM = 72;
/** Space above and below a single-row drawing, inside the card. */
const ROW_PAD = 28;
const ROW_MIN_HEIGHT = 220;
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

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

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
        if (m.edge.kind === 'flow' || connections === 'all') return true;
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
  // Lay out with every edge so toggling which links show never moves nodes.
  // Keyed on structure, so live traffic updates do not recompute it.
  const structureKey = allEdges.map((m) => `${m.edge.id}:${m.edge.kind}:${m.edge.from.node}:${m.edge.from.port ?? ''}:${m.edge.to.node}`).join('|');
  const layoutEdges = useMemo(() => allEdges.map((m) => m.edge), [structureKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Columns that fit the canvas at full size; longer main lines wrap into bands.
  const paneRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(Infinity);
  const [paneWidth, setPaneWidth] = useState(0);
  useEffect(() => {
    const el = paneRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      setPaneWidth(el.clientWidth);
      setColumns(Math.max(3, Math.floor((el.clientWidth - 2 * PANE_PAD + COL_GAP) / COL_PITCH)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const [narrow] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 600px)').matches);
  const returns = useMemo(() => backEdges(allNodes, layoutEdges), [allNodes, layoutEdges]);
  // Up to SINGLE_ROW_COLUMNS steps stay on one row that scrolls sideways at full size; longer lines wrap into bands.
  const rankCount = useMemo(() => Math.max(0, ...layer(allNodes, layoutEdges).rank.values()) + 1, [allNodes, layoutEdges]);
  const singleRow = mode !== 'edit' && !narrow && rankCount <= SINGLE_ROW_COLUMNS;
  // The live map shows the whole factory: compact cards when full-size ones would not fit at the readable minimum zoom.
  const cards = mode === 'live' && singleRow && paneWidth > 0 && (rankCount * COL_PITCH - COL_GAP) * MIN_FIT > paneWidth - 2 * PANE_PAD;
  const nodeWidth = cards ? COMPACT_W : NODE_WIDTH;
  const estimate = cards ? COMPACT_HEIGHT : ESTIMATED_HEIGHT[mode];
  const size = useMemo(() => {
    const measured = new Map<string, Size>();
    for (const part of sizesKey.split('|')) {
      const [id, w, h] = part.split(':');
      if (id && Number(w) > 0 && Number(h) > 0) measured.set(id, { w: Number(w), h: Number(h) });
    }
    return (id: string): Size => measured.get(id) ?? { w: nodeWidth, h: estimate };
  }, [sizesKey, nodeWidth, estimate]);

  // Automatic layout uses one row height for every node: the tallest seen
  // for this graph. It only grows, so nodes measured late (offscreen ones on
  // large graphs) or drawn compact never move the layout.
  const nodeKey = useMemo(() => allNodes.map((n) => n.id).join('|'), [allNodes]);
  const slot = useRef({ key: '', h: 0 });
  const slotHeight = useMemo(() => {
    const h = Math.max(estimate, ...allNodes.map((n) => size(n.id).h));
    const key = `${nodeKey}|${nodeWidth}`;
    slot.current = slot.current.key === key ? { key, h: Math.max(slot.current.h, h) } : { key, h };
    return slot.current.h;
  }, [allNodes, size, estimate, nodeKey, nodeWidth]);

  const tidyPositions = useMemo(() => {
    const layoutSize = (): Size => ({ w: nodeWidth, h: slotHeight });
    const toRoute = (pos: Map<string, { x: number; y: number }>) =>
      routeEdges(
        allNodes.map((n) => ({ id: n.id, ...pos.get(n.id)!, ...layoutSize() })),
        layoutEdges.map((e) => ({ id: e.id, kind: e.kind, from: e.from.node, to: e.to.node, port: e.from.port, back: returns.has(e.id) })),
        { singleRow },
      );
    // Twice: the first pass finds how many lanes each gap needs.
    const wrapAt = singleRow ? Infinity : columns;
    const gap = cards ? COMPACT_GAP : COL_GAP;
    const first = autoLayout(allNodes, layoutEdges, layoutSize, [], wrapAt, gap);
    return autoLayout(allNodes, layoutEdges, layoutSize, toRoute(first).gutterNeeds, wrapAt, gap);
  }, [allNodes, layoutEdges, slotHeight, columns, returns, singleRow, cards, nodeWidth]);

  // Stored positions are kept when they fit at this node size. View and
  // live screens can show the tidy layout over them on request; the editor
  // writes it into the graph instead.
  // Judged at full card size: compact cards would let positions drawn for smaller nodes pass as a saved layout.
  const usable = useMemo(() => hasUsablePositions(allNodes, (id) => ({ ...size(id), w: Math.max(size(id).w, NODE_WIDTH) })), [allNodes, size]);
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
          card: cards ? 'compact' : undefined,
        },
      };
      const old = builtCache.current.get(n.id);
      const node = old && sameNode(old, fresh) ? old : fresh;
      next.set(n.id, node);
      return node;
    });
    builtCache.current = next;
    return out;
  }, [allNodes, positions, mode, diff, issuesByNode, metricsByNode, bottlenecks, itemsByNode, selection, focusNodeIds, large, cards]);

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

  // One label per step that work returns to, carried by one of its returns.
  const returnLabels = useMemo(() => {
    const out = new Map<string, string | undefined>();
    if (!live) return out;
    const byTarget = new Map<string, EdgeMeta[]>();
    for (const m of visible) if (m.edge.kind === 'flow' && returns.has(m.edge.id)) byTarget.set(m.edge.to.node, [...(byTarget.get(m.edge.to.node) ?? []), m]);
    for (const list of byTarget.values()) {
      const total = list.reduce((sum, m) => sum + (m.traffic ?? 0), 0);
      list.forEach((m, i) => out.set(m.edge.id, i === 0 && total > 0 ? `${total} returned` : undefined));
    }
    return out;
  }, [visible, returns, live]);

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
        label: returnLabels.has(m.edge.id) ? returnLabels.get(m.edge.id) : labelFor(m, !!live),
        priority: priority(m),
        back: returns.has(m.edge.id),
      })),
      { singleRow },
    );
  }, [nodes, visible, size, selection, live, returns, returnLabels, singleRow]);

  const typeOf = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n.type])), [graph.nodes]);
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
              sourceHandle: flowEdge ? sourcePort(typeOf.get(e.from.node), e.from.port) : 'role-out',
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
  }, [visible, routing, selection, mode, focusNodeIds, typeOf]);

  // Refit once the measured layout settles, so a re-laid graph is framed,
  // including the return channel and lanes outside the node boxes.
  const layoutKey = useMemo(() => [...positions.entries()].map(([id, p]) => `${id}:${p.x}:${p.y}`).join('|'), [positions]);
  const scrollRef = useRef(false);
  const scaleRef = useRef(0);
  const boundsRef = useRef<{ x1: number; y1: number; w: number; h: number } | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
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
      // One row: fitted between MIN_FIT and 100 %, scrolling sideways from the left when it is still too wide.
      if (scaleRef.current) {
        const zoom = scaleRef.current;
        const room = pane.height - FIT_BOTTOM - ROW_PAD;
        const x = scrollRef.current ? PANE_PAD - x1 * zoom : (pane.width - (x2 - x1) * zoom) / 2 - x1 * zoom;
        void flow.setViewport({ x, y: ROW_PAD + Math.max(0, (room - ROW_PAD - (y2 - y1) * zoom) / 2) - y1 * zoom, zoom }, { duration });
        return;
      }
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

  /** Bring a node into view: scroll the row to it, or pan to it. */
  const reveal = useCallback(
    (id: string, smooth: boolean) => {
      const n = nodesRef.current.find((x) => x.id === id);
      if (!n) return;
      const { w, h } = sizeRef.current(n.id);
      const el = scrollerRef.current;
      if (scrollRef.current && el && boundsRef.current) {
        const left = PANE_PAD + (n.position.x - boundsRef.current.x1) * scaleRef.current;
        el.scrollTo({ left: left + (w * scaleRef.current) / 2 - el.clientWidth / 2, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
        return;
      }
      if (!scaleRef.current) void flow.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: Math.max(flow.getZoom(), MIN_FIT), duration: smooth && !reducedMotion() ? 360 : 0 });
    },
    [flow],
  );
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
  const bounds = useMemo(() => {
    let x1 = Infinity;
    let x2 = -Infinity;
    let y1 = Infinity;
    let y2 = -Infinity;
    for (const n of nodes) {
      x1 = Math.min(x1, n.position.x);
      x2 = Math.max(x2, n.position.x + size(n.id).w);
      y1 = Math.min(y1, n.position.y);
      y2 = Math.max(y2, n.position.y + size(n.id).h);
    }
    for (const r of routing.routes.values()) for (const [x, y] of r.points) ((x1 = Math.min(x1, x)), (x2 = Math.max(x2, x)), (y1 = Math.min(y1, y)), (y2 = Math.max(y2, y)));
    return Number.isFinite(x1) ? { x1, y1, w: x2 - x1, h: y2 - y1 } : null;
  }, [nodes, routing, size]);
  // One row fits between MIN_FIT and 100 %; below that it stays at MIN_FIT and scrolls sideways.
  const scale = singleRow && bounds && paneWidth ? Math.max(MIN_FIT, Math.min(1, (paneWidth - 2 * PANE_PAD) / bounds.w)) : 1;
  scaleRef.current = singleRow ? scale : 0;
  boundsRef.current = bounds;
  // A single row sizes the card to the drawing: even space above it, and the legend's band below.
  const height =
    mode === 'edit' || narrow || !bounds
      ? undefined
      : singleRow
        ? Math.round(Math.min(MAX_HEIGHT, Math.max(ROW_MIN_HEIGHT, bounds.h * scale + 2 * ROW_PAD + FIT_BOTTOM)))
        : Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, bounds.h * scale + CANVAS_CHROME)));
  // When even MIN_FIT is too wide, the drawing is as wide as the graph and the canvas scrolls.
  const scrollWidth = singleRow && bounds && bounds.w * scale + 2 * PANE_PAD > paneWidth + 1 ? Math.round(bounds.w * scale + 2 * PANE_PAD) : undefined;
  scrollRef.current = !!scrollWidth;
  const overflows = !!scrollWidth && scrollWidth > paneWidth + 1;
  // What the alert is about stays in view: if the row scrolls, start at the first bottleneck.
  const firstBottleneck = useMemo(() => byUrgency((live?.metrics.bottlenecks ?? []).filter((b) => b.severity !== 'info'))[0]?.nodeId, [live]);
  const revealedFor = useRef('');
  useEffect(() => {
    const key = `${layoutKey}|${firstBottleneck}|${!!scrollWidth}`;
    if (!firstBottleneck || !scrollWidth || revealedFor.current === key) return;
    revealedFor.current = key;
    const timer = setTimeout(() => reveal(firstBottleneck, false), 120);
    return () => clearTimeout(timer);
  }, [layoutKey, firstBottleneck, scrollWidth, reveal]);
  // "Show on map": bring the node into view each time it is asked for.
  const { focus } = props;
  useEffect(() => {
    if (!focus) return;
    const timer = setTimeout(() => reveal(focus.id, true), 120);
    return () => clearTimeout(timer);
  }, [focus, reveal]);

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
    <div ref={paneRef} className={`graph ${props.className ?? ''} graph-${mode} ${scrollWidth ? 'graph-scrolls' : ''}`} style={height ? { height } : undefined} role="group" aria-label={label}>
      <div ref={scrollerRef} className="graph-scroll" tabIndex={scrollWidth ? 0 : undefined} aria-label={scrollWidth ? 'Scroll the map sideways' : undefined}>
        <div className="graph-content" style={scrollWidth ? { width: `max(100%, ${scrollWidth}px)` } : undefined}>
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
            panOnDrag={!scrollWidth}
            zoomOnScroll={!scrollWidth}
            zoomOnPinch={!scrollWidth}
            zoomOnDoubleClick={!scrollWidth}
            preventScrolling={!scrollWidth}
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
            proOptions={{ hideAttribution: true }}
            ariaLabelConfig={{
              'node.a11yDescription.default': 'Press Enter to select this node. Use arrow keys to move a selected node in the editor.',
            }}
          >
            <Background id="dots" variant={BackgroundVariant.Dots} gap={24} size={1.5} className="graph-dots" />
          </ReactFlow>
        </div>
      </div>
      {mode !== 'edit' && <EdgeLegend {...legend} scrollHint={overflows ? `Scroll for all ${allNodes.length} steps` : undefined} />}
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
        {!scrollWidth && (showToggle || mode === 'edit' || usable) && <span className="map-tools-rule" aria-hidden="true" />}
        {!scrollWidth && (
          <>
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
          </>
        )}
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
export function EdgeLegend({
  flowing,
  unreached,
  delegates,
  messages,
  unplanned,
  live,
  diff,
  scrollHint,
}: {
  scrollHint?: string;
  flowing?: boolean;
  unreached?: boolean;
  delegates?: boolean;
  messages?: boolean;
  unplanned?: boolean;
  live?: boolean;
  diff?: boolean;
}) {
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
      {scrollHint && (
        <li className="map-legend-hint">
          {scrollHint} <IconArrowRight size={14} />
        </li>
      )}
    </ul>
  );
}

export { NODE_WIDTH };
