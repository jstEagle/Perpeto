import { useCallback, useEffect, useMemo, useState } from 'react';
import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow } from '@xyflow/react';
import type { Connection, EdgeChange, IsValidConnection, NodeChange } from '@xyflow/react';
import type { Bottleneck, EdgeKind, GraphDiff, GraphEdge, MetricsSnapshot, NodeType, WorkItem, WorkflowGraph } from '../api/types';
import { StepNode, NODE_WIDTH } from './step-node';
import type { StepData, StepNodeType } from './step-node';
import { RuledEdge } from './ruled-edge';
import type { RuledEdgeType } from './ruled-edge';
import { changedKeys } from './diff';
import { graphPort } from './registry';
import { IconFit, IconMinus, IconPlus } from '../components/icons';

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
  /** Palette drops in the editor. */
  onDropNode?(type: NodeType, position: { x: number; y: number }): void;
  className?: string;
}

export const DRAG_MIME = 'application/x-perpeto-node';

const nodeTypes = { step: StepNode };
const edgeTypes = { ruled: RuledEdge };

const MARKERS: { id: string; tone: string; shape: 'arrow' | 'open' | 'dot' }[] = [
  { id: 'pp-arrow-ink', tone: 'ink', shape: 'arrow' },
  { id: 'pp-arrow-muted', tone: 'muted', shape: 'arrow' },
  { id: 'pp-arrow-success', tone: 'success', shape: 'arrow' },
  { id: 'pp-arrow-error', tone: 'error', shape: 'arrow' },
  { id: 'pp-open-ink', tone: 'ink', shape: 'open' },
  { id: 'pp-open-success', tone: 'success', shape: 'open' },
  { id: 'pp-open-error', tone: 'error', shape: 'open' },
  { id: 'pp-dot-muted', tone: 'muted', shape: 'dot' },
  { id: 'pp-dot-warning', tone: 'warning', shape: 'dot' },
  { id: 'pp-dot-success', tone: 'success', shape: 'dot' },
  { id: 'pp-dot-error', tone: 'error', shape: 'dot' },
];

function MarkerDefs() {
  return (
    <svg className="marker-defs" aria-hidden="true" width="0" height="0">
      <defs>
        {MARKERS.map((m) => (
          <marker key={m.id} id={m.id} viewBox="0 0 10 10" refX={m.shape === 'dot' ? 5 : 9} refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
            {m.shape === 'arrow' && <path d="M0 0 10 5 0 10z" className={`mk mk-fill-${m.tone}`} />}
            {m.shape === 'open' && <path d="M1 1 9 5 1 9" className={`mk mk-stroke-${m.tone}`} fill="none" strokeWidth="1.5" />}
            {m.shape === 'dot' && <circle cx="5" cy="5" r="3" className={`mk mk-fill-${m.tone}`} />}
          </marker>
        ))}
      </defs>
    </svg>
  );
}

function markerFor(kind: EdgeKind, opts: { diff?: 'added' | 'removed'; unplanned?: boolean; fail?: boolean }) {
  const tone = opts.diff === 'added' ? 'success' : opts.diff === 'removed' ? 'error' : opts.unplanned ? 'warning' : kind === 'messages' || opts.fail ? 'muted' : 'ink';
  if (kind === 'flow') return { end: `url(#pp-arrow-${tone})` };
  if (kind === 'delegates') return { end: `url(#pp-open-${tone === 'muted' || tone === 'warning' ? 'ink' : tone})` };
  return { start: `url(#pp-dot-${tone})`, end: `url(#pp-dot-${tone})` };
}

type Positions = Map<string, { x: number; y: number }>;

const sameRow = (pos: Positions, a: string, b: string) => Math.abs((pos.get(a)?.y ?? 0) - (pos.get(b)?.y ?? 0)) < 40;

/**
 * Lanes for routed edges. Edges under a row and edges in the channel between
 * rows are numbered separately; shorter spans sit closer to the nodes.
 */
function assignLanes(edges: GraphEdge[], pos: Positions): Map<string, number> {
  const x = (id: string) => pos.get(id)?.x ?? 0;
  const lanes = new Map<string, number>();
  const groups = new Map<string, { id: string; span: number; role: boolean }[]>();
  for (const e of edges) {
    const same = sameRow(pos, e.from.node, e.to.node);
    if (e.kind === 'flow' && same && x(e.to.node) > x(e.from.node)) continue;
    const rowKey = same ? `below:${pos.get(e.from.node)?.y ?? 0}` : `channel:${Math.max(pos.get(e.from.node)?.y ?? 0, pos.get(e.to.node)?.y ?? 0)}`;
    groups.set(rowKey, [...(groups.get(rowKey) ?? []), { id: e.id, span: Math.abs(x(e.to.node) - x(e.from.node)), role: e.kind !== 'flow' }]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => Number(a.role) - Number(b.role) || a.span - b.span);
    list.forEach((e, i) => lanes.set(e.id, i));
  }
  return lanes;
}

function roleHandles(pos: Positions, from: string, to: string) {
  if (sameRow(pos, from, to)) return { sourceHandle: 'role-out', targetHandle: 'role-in' };
  return (pos.get(to)?.y ?? 0) > (pos.get(from)?.y ?? 0) ? { sourceHandle: 'role-out', targetHandle: 'role-in-top' } : { sourceHandle: 'role-out-top', targetHandle: 'role-in' };
}

function toRfEdge(e: GraphEdge, lane: number, pos: Positions, extra: Partial<RuledEdgeType['data']> = {}): RuledEdgeType {
  const flow = e.kind === 'flow';
  const role = roleHandles(pos, e.from.node, e.to.node);
  const markers = markerFor(e.kind, { diff: extra.diff, unplanned: extra.unplanned, fail: e.from.port === 'fail' });
  return {
    id: e.id,
    type: 'ruled',
    source: e.from.node,
    sourceHandle: flow ? (e.from.port ?? 'out') : role.sourceHandle,
    target: e.to.node,
    targetHandle: flow ? 'in' : role.targetHandle,
    markerEnd: markers.end,
    markerStart: markers.start,
    data: { kind: e.kind, port: e.from.port, lane, ...extra },
  };
}

function CanvasInner(props: GraphCanvasProps) {
  const { graph, mode, diff, live, issuesByNode, selection, onSelect, onGraphChange, roleKind = 'delegates', label } = props;
  const flow = useReactFlow();

  const bottlenecks = useMemo(() => new Map<string, Bottleneck>((live?.metrics.bottlenecks ?? []).map((b) => [b.nodeId, b])), [live]);
  const metricsByNode = useMemo(() => new Map((live?.metrics.nodes ?? []).map((m) => [m.nodeId, m])), [live]);
  const itemsByNode = useMemo(() => {
    const map = new Map<string, WorkItem[]>();
    for (const item of live?.items ?? []) map.set(item.nodeId, [...(map.get(item.nodeId) ?? []), item]);
    return map;
  }, [live]);

  const focusNodeIds = useMemo(() => {
    if (!selection || mode !== 'live') return null;
    if (selection.kind === 'node') return new Set([selection.id]);
    const e = graph.edges.find((x) => x.id === selection.id);
    const u = live?.metrics.edges.find((x) => x.edgeId === selection.id);
    return new Set([e?.from.node ?? u?.from, e?.to.node ?? u?.to].filter(Boolean) as string[]);
  }, [selection, mode, graph, live]);

  const builtNodes = useMemo<StepNodeType[]>(() => {
    const out: StepNodeType[] = graph.nodes.map((n) => {
      let mark: StepData['diff'];
      let keys: string[] | undefined;
      if (diff) {
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
        position: n.position,
        draggable: mode === 'edit',
        selectable: true,
        deletable: mode === 'edit',
        selected: selection?.kind === 'node' && selection.id === n.id,
        data: {
          node: n,
          mode,
          issues: issuesByNode?.get(n.id),
          diff: mark,
          changedKeys: keys,
          metrics: metricsByNode.get(n.id),
          bottleneck: bottlenecks.get(n.id),
          items: itemsByNode.get(n.id),
          dimmed: !!focusNodeIds && !focusNodeIds.has(n.id) && selection?.kind === 'edge',
        },
      };
    });
    if (diff)
      for (const id of diff.diff.nodes.removed) {
        const n = diff.base.nodes.find((b) => b.id === id);
        if (n)
          out.push({
            id: `removed:${n.id}`,
            type: 'step',
            position: n.position,
            zIndex: -1,
            draggable: false,
            selectable: false,
            deletable: false,
            data: { node: n, mode: 'view', diff: 'removed' },
          });
      }
    return out;
  }, [graph, mode, diff, issuesByNode, metricsByNode, bottlenecks, itemsByNode, selection, focusNodeIds]);

  const [nodes, setNodes] = useState<StepNodeType[]>(builtNodes);
  useEffect(() => {
    setNodes((prev) => builtNodes.map((n) => ({ ...n, measured: prev.find((p) => p.id === n.id)?.measured })));
  }, [builtNodes]);

  const edges = useMemo<RuledEdgeType[]>(() => {
    const pos: Positions = new Map(graph.nodes.map((n) => [n.id, n.position]));
    if (diff) for (const n of diff.base.nodes) if (!pos.has(n.id)) pos.set(`removed:${n.id}`, n.position);
    const unplanned = (live?.metrics.edges ?? []).filter((m) => m.unplanned && m.from && m.to);
    const lanes = assignLanes([...graph.edges, ...unplanned.map((m) => ({ id: m.edgeId, kind: m.kind, from: { node: m.from! }, to: { node: m.to! } }))], pos);
    const traffic = new Map((live?.metrics.edges ?? []).map((m) => [m.edgeId, m]));
    const out = graph.edges.map((e) =>
      toRfEdge(e, lanes.get(e.id) ?? 0, pos, {
        diff: diff?.diff.edges.added.includes(e.id) ? 'added' : undefined,
        traffic: live ? (traffic.get(e.id)?.count ?? 0) : undefined,
        highlighted: selection?.kind === 'edge' && selection.id === e.id,
        dimmed: mode === 'live' && !!focusNodeIds && !(focusNodeIds.has(e.from.node) || focusNodeIds.has(e.to.node)),
      }),
    );
    if (diff)
      for (const id of diff.diff.edges.removed) {
        const e = diff.base.edges.find((b) => b.id === id);
        if (!e) continue;
        const exists = (nid: string) => graph.nodes.some((n) => n.id === nid);
        const ghost: GraphEdge = {
          ...e,
          id: `removed:${e.id}`,
          from: { ...e.from, node: exists(e.from.node) ? e.from.node : `removed:${e.from.node}` },
          to: { ...e.to, node: exists(e.to.node) ? e.to.node : `removed:${e.to.node}` },
        };
        out.push({ ...toRfEdge(ghost, lanes.get(e.id) ?? 0, pos, { diff: 'removed' }), selectable: false });
      }
    if (live)
      unplanned.forEach((m) => {
          const ghost: GraphEdge = { id: m.edgeId, kind: m.kind, from: { node: m.from! }, to: { node: m.to! } };
          out.push(
            toRfEdge(ghost, lanes.get(m.edgeId) ?? 0, pos, {
              unplanned: true,
              traffic: m.count,
              highlighted: selection?.kind === 'edge' && selection.id === m.edgeId,
              dimmed: !!focusNodeIds && !(focusNodeIds.has(m.from!) || focusNodeIds.has(m.to!)),
            }),
          );
        });
    return out.map((e) => ({ ...e, selected: selection?.kind === 'edge' && selection.id === e.id, deletable: mode === 'edit' }));
  }, [graph, diff, live, selection, mode, focusNodeIds]);

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
            return c ? { ...n, position: { x: Math.round(c.position.x), y: Math.round(c.position.y) } } : n;
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
          return d ? { ...n, position: { x: Math.round(d.position.x), y: Math.round(d.position.y) } } : n;
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
        onGraphChange({ ...graph, edges: graph.edges.filter((e) => !removed.includes(e.id)) });
        onSelect?.(null);
      }
    },
    [graph, mode, onGraphChange, onSelect],
  );

  const isValidConnection = useCallback<IsValidConnection>(
    (c) => {
      if (c.source === c.target) return false;
      const role = c.sourceHandle?.startsWith('role-out');
      return role ? !!c.targetHandle?.startsWith('role-in') : c.targetHandle === 'in';
    },
    [],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!onGraphChange) return;
      const kind: EdgeKind = c.sourceHandle?.startsWith('role-out') ? roleKind : 'flow';
      const port = kind === 'flow' ? graphPort(c.sourceHandle) : undefined;
      const id = `${kind === 'flow' ? 'e' : kind === 'delegates' ? 'd' : 'm'}-${c.source}-${port ?? (kind === 'flow' ? 'out' : '')}-${c.target}`.replace(/--/g, '-');
      if (graph.edges.some((e) => e.id === id)) return;
      onGraphChange({ ...graph, edges: [...graph.edges, { id, kind, from: { node: c.source, ...(port ? { port } : {}) }, to: { node: c.target } }] });
      onSelect?.({ kind: 'edge', id });
    },
    [graph, onGraphChange, onSelect, roleKind],
  );

  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  return (
    <div className={`graph ${props.className ?? ''} graph-${mode}`} role="group" aria-label={label}>
      <MarkerDefs />
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
          props.onDropNode(type, { x: Math.round((p.x - NODE_WIDTH / 2) / 8) * 8, y: Math.round((p.y - 30) / 8) * 8 });
        }}
        nodesDraggable={mode === 'edit'}
        nodesConnectable={mode === 'edit'}
        elementsSelectable
        deleteKeyCode={mode === 'edit' ? ['Backspace', 'Delete'] : null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.6}
        snapToGrid
        snapGrid={[8, 8]}
        connectionLineStyle={{ strokeWidth: 1.5 }}
        proOptions={{ hideAttribution: false }}
        ariaLabelConfig={{ 'node.a11yDescription.default': 'Press Enter to select this node. Use arrow keys to move a selected node in the editor.' }}
      >
        <Background variant={BackgroundVariant.Lines} gap={24} lineWidth={1} className="graph-grid" />
      </ReactFlow>
      <div className="graph-controls" role="toolbar" aria-label="Canvas zoom">
        <button className="icon-btn" aria-label="Zoom in" onClick={() => flow.zoomIn({ duration: reduced ? 0 : 120 })}>
          <IconPlus />
        </button>
        <button className="icon-btn" aria-label="Zoom out" onClick={() => flow.zoomOut({ duration: reduced ? 0 : 120 })}>
          <IconMinus />
        </button>
        <button className="icon-btn" aria-label="Fit graph to view" onClick={() => flow.fitView({ padding: 0.12, maxZoom: 1, duration: reduced ? 0 : 160 })}>
          <IconFit />
        </button>
      </div>
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

export function EdgeLegend({ unplanned }: { unplanned?: boolean }) {
  return (
    <ul className="edge-legend" aria-label="Connection kinds">
      <li>
        <svg width="28" height="8" aria-hidden="true"><path d="M0 4h22" className="gedge gedge-flow" /><path d="M21 0.5 28 4 21 7.5z" className="mk mk-fill-ink" /></svg>
        Flow
      </li>
      <li>
        <svg width="28" height="8" aria-hidden="true"><path d="M0 4h26" className="gedge gedge-delegates" /><path d="M21 0.5 27 4 21 7.5" className="mk mk-stroke-ink" fill="none" strokeWidth="1.5" /></svg>
        Delegates
      </li>
      <li>
        <svg width="28" height="8" aria-hidden="true"><circle cx="3" cy="4" r="2.5" className="mk mk-fill-muted" /><path d="M3 4h22" className="gedge gedge-messages" /><circle cx="25" cy="4" r="2.5" className="mk mk-fill-muted" /></svg>
        Messages
      </li>
      {unplanned && (
        <li>
          <svg width="28" height="8" aria-hidden="true"><path d="M0 4h28" className="gedge gedge-messages gedge-unplanned" /></svg>
          Unplanned
        </li>
      )}
    </ul>
  );
}

export { NODE_WIDTH };
