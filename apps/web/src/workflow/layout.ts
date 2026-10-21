import type { GraphEdge, GraphNode } from '../api/types';

/**
 * Layered layout for workflow graphs, left to right along the main flow.
 *
 * 1. Flow back edges (returns into loops, gate fail edges, triage passes)
 *    are found with a depth-first search that follows primary ports first,
 *    and set aside. What remains is a DAG.
 * 2. The main line is every node reachable from an input along primary
 *    ports (`out`, `pass`). Its nodes are ranked into columns by longest
 *    path, so each step sits one column after the step that feeds it.
 * 3. Side nodes (fail branches, delegate helpers, escalation targets) go in
 *    a lane below the main rows: helpers and escalation targets under the
 *    node they serve, fail branches one column after the gate that feeds them.
 * 4. Nodes sharing a column are ordered by barycenter sweeps to cut
 *    crossings, keeping the main line on the top row.
 *
 * The router (router.ts) then draws returns as one channel above the main
 * line. Hand-written rather than dagre or elkjs: the placement rules are
 * specific to workflows (main line, side lane, return channel), the graphs
 * are small, and the router already owns ports, lanes and labels. dagre
 * would only supply the layering; elkjs adds about 1.4 MB and an async
 * worker for routing the app would then override.
 */

export const NODE_W = 208;
export const COL_GAP = 64;
export const COL_PITCH = NODE_W + COL_GAP;
export const GRID = 8;
/** Minimum space above a side lane; vertical role links run here. */
export const SIDE_GAP = 72;
/** Minimum space between rows of the main line, when it branches. */
export const BAND_GAP = 72;

export type Size = { w: number; h: number };
export type Point = { x: number; y: number };

const snap = (v: number) => Math.round(v / GRID) * GRID;

/** True when any two node boxes are closer than `clearance`. */
export function nodesOverlap(nodes: { id: string; position: Point }[], size: (id: string) => Size, clearance = 32): boolean {
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    const sa = size(a.id);
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      const sb = size(b.id);
      const apart =
        a.position.x + sa.w + clearance <= b.position.x ||
        b.position.x + sb.w + clearance <= a.position.x ||
        a.position.y + sa.h + clearance <= b.position.y ||
        b.position.y + sb.h + clearance <= a.position.y;
      if (!apart) return true;
    }
  }
  return false;
}

/**
 * Whether stored positions can be drawn as they are. Graphs with no
 * positions, or positioned for smaller nodes than the web draws, get the
 * automatic layout instead.
 */
export function hasUsablePositions(nodes: { id: string; position?: Point }[], size: (id: string) => Size): boolean {
  if (nodes.length < 2) return true;
  if (nodes.some((n) => !n.position || !Number.isFinite(n.position.x) || !Number.isFinite(n.position.y))) return false;
  return !nodesOverlap(nodes as { id: string; position: Point }[], size);
}

export const isPrimaryPort = (port?: string) => !port || port === 'out' || port === 'pass';

const byStored = (a: GraphNode, b: GraphNode) => (a.position?.x ?? 0) - (b.position?.x ?? 0) || (a.position?.y ?? 0) - (b.position?.y ?? 0) || a.id.localeCompare(b.id);

/** The ids on the main line: from the first input, following each node's next or pass edge. */
export function mainLine(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const next = new Map<string, string>();
  for (const e of edges) {
    if (e.kind !== 'flow' || !byId.has(e.to.node)) continue;
    if (isPrimaryPort(e.from.port) && !next.has(e.from.node)) next.set(e.from.node, e.to.node);
  }
  const inputs = nodes.filter((n) => n.type === 'input').sort(byStored);
  const start = inputs[0] ?? [...nodes].sort(byStored)[0];
  const line: string[] = [];
  const seen = new Set<string>();
  for (let id: string | undefined = start?.id; id && !seen.has(id); id = next.get(id)) {
    seen.add(id);
    line.push(id);
  }
  return line;
}

function escalationTargets(node: GraphNode): string[] {
  return ['onExhausted', 'onBlocked'].map((k) => node.config?.[k]).filter((v): v is string => typeof v === 'string');
}

/** Flow edges that close a cycle, found by a depth-first search from the inputs that follows primary ports first. */
export function backEdges(nodes: GraphNode[], edges: GraphEdge[]): Set<string> {
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    if (e.kind !== 'flow' || !ids.has(e.from.node) || !ids.has(e.to.node)) continue;
    out.set(e.from.node, [...(out.get(e.from.node) ?? []), e]);
  }
  for (const list of out.values()) list.sort((a, b) => Number(!isPrimaryPort(a.from.port)) - Number(!isPrimaryPort(b.from.port)));
  const hasIncoming = new Set(edges.filter((e) => e.kind === 'flow').map((e) => e.to.node));
  const sorted = [...nodes].sort(byStored);
  const roots = [...sorted.filter((n) => n.type === 'input'), ...sorted.filter((n) => n.type !== 'input' && !hasIncoming.has(n.id)), ...sorted];

  const state = new Map<string, 1 | 2>();
  const back = new Set<string>();
  for (const root of roots) {
    if (state.has(root.id)) continue;
    // Iterative DFS: each frame holds a node and the index of its next edge.
    const stack: [string, number][] = [[root.id, 0]];
    state.set(root.id, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const list = out.get(frame[0]) ?? [];
      if (frame[1] >= list.length) {
        state.set(frame[0], 2);
        stack.pop();
        continue;
      }
      const e = list[frame[1]++];
      const s = state.get(e.to.node);
      if (s === 1) back.add(e.id);
      else if (!s) {
        state.set(e.to.node, 1);
        stack.push([e.to.node, 0]);
      }
    }
  }
  return back;
}

/** Tie strength when anchoring a side node: lower is stronger and sits closer to the main line. */
const TIE = { delegates: 0, flow: 1, escalation: 2, messages: 3 } as const;

export interface Layering {
  rank: Map<string, number>;
  row: Map<string, number>;
  mainRows: number;
  back: Set<string>;
}

/** Columns (ranks) and rows for every node; see the module comment. */
export function layer(nodes: GraphNode[], edges: GraphEdge[]): Layering {
  const ids = new Set(nodes.map((n) => n.id));
  const sorted = [...nodes].sort(byStored);
  const back = backEdges(nodes, edges);
  const dag = edges.filter((e) => e.kind === 'flow' && !back.has(e.id) && ids.has(e.from.node) && ids.has(e.to.node) && e.from.node !== e.to.node);

  // Main line: reachable from inputs along primary ports.
  const primaryNext = new Map<string, string[]>();
  for (const e of dag) if (isPrimaryPort(e.from.port)) primaryNext.set(e.from.node, [...(primaryNext.get(e.from.node) ?? []), e.to.node]);
  const inputs = sorted.filter((n) => n.type === 'input');
  const incoming = new Set(dag.map((e) => e.to.node));
  const starts = inputs.length ? inputs : sorted.filter((n) => !incoming.has(n.id)).slice(0, 1);
  const main = new Set<string>();
  const queue = starts.map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    if (main.has(id)) continue;
    main.add(id);
    queue.push(...(primaryNext.get(id) ?? []));
  }

  // Longest path over the DAG restricted to the main line (Kahn order).
  const rank = new Map<string, number>();
  const mainEdges = dag.filter((e) => main.has(e.from.node) && main.has(e.to.node));
  const indeg = new Map([...main].map((id) => [id, 0]));
  for (const e of mainEdges) indeg.set(e.to.node, indeg.get(e.to.node)! + 1);
  const ready = sorted.filter((n) => main.has(n.id) && indeg.get(n.id) === 0).map((n) => n.id);
  for (const id of ready) rank.set(id, 0);
  while (ready.length) {
    const id = ready.shift()!;
    for (const e of mainEdges)
      if (e.from.node === id) {
        rank.set(e.to.node, Math.max(rank.get(e.to.node) ?? 0, rank.get(id)! + 1));
        indeg.set(e.to.node, indeg.get(e.to.node)! - 1);
        if (indeg.get(e.to.node) === 0) ready.push(e.to.node);
      }
  }

  // Side nodes: anchored to whatever feeds, delegates to or escalates to them.
  type Tie = { from: string; kind: keyof typeof TIE };
  const ties = new Map<string, Tie[]>();
  const tie = (to: string, from: string, kind: Tie['kind']) => {
    if (main.has(to) || to === from || !ids.has(from) || !ids.has(to)) return;
    ties.set(to, [...(ties.get(to) ?? []), { from, kind }]);
  };
  for (const e of dag) tie(e.to.node, e.from.node, 'flow');
  for (const e of edges) if (e.kind === 'delegates') tie(e.to.node, e.from.node, 'delegates');
  for (const n of nodes) for (const t of escalationTargets(n)) tie(t, n.id, 'escalation');
  for (const e of edges)
    if (e.kind === 'messages') {
      tie(e.to.node, e.from.node, 'messages');
      tie(e.from.node, e.to.node, 'messages');
    }

  const side = sorted.filter((n) => !main.has(n.id)).map((n) => n.id);
  const strongest = new Map<string, number>();
  const sideRank = (id: string, partial: boolean): number | undefined => {
    const list = (ties.get(id) ?? []).filter((t) => t.kind !== 'messages' || !(ties.get(id) ?? []).some((u) => u.kind !== 'messages'));
    if (!list.length) return undefined;
    if (!partial && list.some((t) => !rank.has(t.from))) return undefined;
    const known = list.filter((t) => rank.has(t.from));
    if (!known.length) return undefined;
    strongest.set(id, Math.min(...known.map((t) => TIE[t.kind])));
    // A fail branch starts one column after its gate; helpers and escalation targets sit under their source.
    return Math.max(...known.map((t) => rank.get(t.from)! + (t.kind === 'flow' ? 1 : 0)));
  };
  // Place a side node once everything that feeds it is placed; a cycle
  // among side nodes falls back to the sources placed so far.
  let pending = side;
  while (pending.length) {
    const ready = pending.find((id) => sideRank(id, false) !== undefined);
    const next = ready ?? pending.find((id) => sideRank(id, true) !== undefined);
    if (next === undefined) {
      // Nothing ties these to the graph: start them in the first column.
      for (const id of pending) {
        rank.set(id, 0);
        strongest.set(id, 9);
      }
      break;
    }
    rank.set(next, sideRank(next, ready === undefined)!);
    pending = pending.filter((id) => id !== next);
  }

  // Order nodes within each column. Groups keep their order (main line
  // first, other main nodes, then side nodes by tie strength); barycenter
  // sweeps sort within a group.
  const line = new Set(mainLine(nodes, edges));
  const columns = new Map<number, string[]>();
  for (const n of sorted) columns.set(rank.get(n.id)!, [...(columns.get(rank.get(n.id)!) ?? []), n.id]);
  const group = (id: string) => (line.has(id) ? 0 : main.has(id) ? 1 : 2 + (strongest.get(id) ?? 9));
  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
  };
  for (const e of edges) if (ids.has(e.from.node) && ids.has(e.to.node) && e.from.node !== e.to.node) link(e.from.node, e.to.node);
  for (const n of nodes) for (const t of escalationTargets(n)) if (ids.has(t)) link(n.id, t);

  const rowOf = () => {
    const row = new Map<string, number>();
    let mainRows = 1;
    for (const ids of columns.values()) mainRows = Math.max(mainRows, ids.filter((id) => main.has(id)).length);
    for (const list of columns.values()) {
      let m = 0;
      let s = 0;
      for (const id of list) row.set(id, main.has(id) ? m++ : mainRows + s++);
    }
    return { row, mainRows };
  };
  const crossings = (row: Map<string, number>) => {
    const segs = dag.filter((e) => rank.get(e.to.node)! - rank.get(e.from.node)! === 1).map((e) => [rank.get(e.from.node)!, row.get(e.from.node)!, row.get(e.to.node)!]);
    let c = 0;
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if (segs[i][0] === segs[j][0] && (segs[i][1] - segs[j][1]) * (segs[i][2] - segs[j][2]) < 0) c++;
    return c;
  };
  const ranks = [...columns.keys()].sort((a, b) => a - b);
  let best = new Map([...columns].map(([r, list]) => [r, [...list].sort((a, b) => group(a) - group(b))]));
  for (const [r, list] of best) columns.set(r, [...list]);
  let bestCount = crossings(rowOf().row);
  for (let sweep = 0; sweep < 6 && bestCount > 0; sweep++) {
    const order = sweep % 2 === 0 ? ranks : [...ranks].reverse();
    const { row } = rowOf();
    for (const r of order) {
      const list = columns.get(r)!;
      const bary = (id: string) => {
        const near = (neighbours.get(id) ?? []).filter((o) => rank.get(o) === r + (sweep % 2 === 0 ? -1 : 1));
        return near.length ? near.reduce((sum, o) => sum + row.get(o)!, 0) / near.length : row.get(id)!;
      };
      const keyed = list.map((id, i) => ({ id, g: group(id), b: bary(id), i }));
      keyed.sort((a, b) => a.g - b.g || a.b - b.b || a.i - b.i);
      columns.set(
        r,
        keyed.map((k) => k.id),
      );
      keyed.forEach((k, i) => row.set(k.id, i));
    }
    const count = crossings(rowOf().row);
    if (count < bestCount) {
      bestCount = count;
      best = new Map([...columns].map(([r, list]) => [r, [...list]]));
    }
  }
  for (const [r, list] of best) columns.set(r, list);
  const { row, mainRows } = rowOf();
  return { rank, row, mainRows, back };
}

/**
 * Positions for every node. `gaps[k]` is the minimum space above row k
 * (rows counted top to bottom, as the router clusters them), so routed lanes
 * fit; see Routing.gutterNeeds. Each row is as tall as its tallest node.
 *
 * `maxColumns` keeps the map readable at full size: a main line with more
 * columns wraps into balanced bands, each with its own side lane, and the
 * last band is right-aligned so the wrap runs back under the end of the
 * band above, as one short connector.
 */
export function autoLayout(nodes: GraphNode[], edges: GraphEdge[], size: (id: string) => Size, gaps: number[] = [], maxColumns = Infinity): Map<string, Point> {
  const { rank, row, mainRows } = layer(nodes, edges);
  const columns = Math.max(0, ...rank.values()) + 1;
  const bands = Math.max(1, Math.ceil(columns / Math.max(2, maxColumns)));
  const perBand = Math.ceil(columns / bands);
  const bandOf = (id: string) => Math.floor(rank.get(id)! / perBand);
  const lastBandColumns = columns - (bands - 1) * perBand;
  const column = (id: string) => {
    const band = bandOf(id);
    return rank.get(id)! - band * perBand + (bands > 1 && band === bands - 1 ? perBand - lastBandColumns : 0);
  };

  // Rows in use, top to bottom: each band's main rows, then its side rows.
  const used = [...new Set(nodes.map((n) => bandOf(n.id) * 1000 + row.get(n.id)!))].sort((a, b) => a - b);
  const index = new Map(used.map((key, i) => [key, i]));
  const top: number[] = [];
  let y = 0;
  used.forEach((key, k) => {
    if (k > 0) {
      const newBand = Math.floor(key / 1000) !== Math.floor(used[k - 1] / 1000);
      y = snap(y + Math.max(gaps[k] ?? 0, newBand ? BAND_GAP : key % 1000 >= mainRows ? SIDE_GAP : BAND_GAP));
    }
    top.push(y);
    y += Math.max(0, ...nodes.filter((n) => bandOf(n.id) * 1000 + row.get(n.id)! === key).map((n) => size(n.id).h));
  });
  return new Map(nodes.map((n) => [n.id, { x: column(n.id) * COL_PITCH, y: top[index.get(bandOf(n.id) * 1000 + row.get(n.id)!)!] }]));
}
