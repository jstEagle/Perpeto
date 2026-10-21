import type { GraphEdge, GraphNode } from '../api/types';

/**
 * Display layout for workflow graphs. Graphs drafted by the architect or the
 * hub templates are positioned for smaller nodes than the web draws, so
 * view and live screens lay them out again when nodes would overlap: the
 * main line (input to output along pass edges) wraps into rows, and side
 * roles (delegate helpers, escalation targets) sit in a band under the row
 * of the node they serve.
 */

export const NODE_W = 240;
export const COL_GAP = 64;
export const COL_PITCH = NODE_W + COL_GAP;
export const GRID = 16;
/** Space between a main row and its side band; vertical role links run here. */
export const SIDE_GAP = 64;
/** Default space between bands; widened when routing needs more lanes. */
export const BAND_GAP = 112;
export const MAX_PER_ROW = 4;

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

/** The ids on the main line: from the first input, following each node's next or pass edge. */
export function mainLine(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const next = new Map<string, string>();
  for (const e of edges) {
    if (e.kind !== 'flow' || !byId.has(e.to.node)) continue;
    const primary = !e.from.port || e.from.port === 'out' || e.from.port === 'pass';
    if (primary && !next.has(e.from.node)) next.set(e.from.node, e.to.node);
  }
  const inputs = nodes.filter((n) => n.type === 'input').sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
  const start = inputs[0] ?? [...nodes].sort((a, b) => a.position.x - b.position.x)[0];
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

/**
 * Wraps the main line into balanced rows of at most MAX_PER_ROW columns and
 * places side nodes under their anchor. `gaps[k]` is the minimum space above
 * row k (rows counted top to bottom), so routed lanes fit.
 */
export function autoLayout(nodes: GraphNode[], edges: GraphEdge[], size: (id: string) => Size, gaps: number[] = []): Map<string, Point> {
  const line = mainLine(nodes, edges);
  const onLine = new Set(line);
  const perRow = Math.max(1, Math.ceil(line.length / Math.max(1, Math.ceil(line.length / MAX_PER_ROW))));
  const slot = new Map<string, { band: number; col: number; side: boolean }>();
  line.forEach((id, i) => slot.set(id, { band: Math.floor(i / perRow), col: i % perRow, side: false }));

  // Anchor each remaining node to a placed neighbour: delegate source, flow
  // neighbour or the node that escalates to it. Repeat so chains settle.
  const rest = nodes.filter((n) => !onLine.has(n.id)).sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
  };
  for (const e of edges) link(e.from.node, e.to.node);
  for (const n of nodes) for (const t of escalationTargets(n)) link(n.id, t);

  const taken = new Set<string>();
  const key = (band: number, col: number) => `${band}:${col}`;
  let pending = rest;
  for (let round = 0; pending.length && round < nodes.length + 1; round++) {
    const later: GraphNode[] = [];
    for (const n of pending) {
      const anchor = (neighbours.get(n.id) ?? []).map((id) => slot.get(id)).find(Boolean);
      if (!anchor) {
        later.push(n);
        continue;
      }
      const band = anchor.band;
      const order = [0, 1, -1, 2, -2, 3, 4, 5, 6];
      const col = order.map((d) => anchor.col + d).find((c) => c >= 0 && !taken.has(key(band, c))) ?? anchor.col + 7;
      taken.add(key(band, col));
      slot.set(n.id, { band, col, side: true });
    }
    if (later.length === pending.length) {
      // Disconnected nodes: a side band under the last row.
      const band = line.length ? Math.floor((line.length - 1) / perRow) : 0;
      for (const n of later) {
        let col = 0;
        while (taken.has(key(band, col))) col++;
        taken.add(key(band, col));
        slot.set(n.id, { band, col, side: true });
      }
      break;
    }
    pending = later;
  }

  // Rows top to bottom: each band's main row, then its side row if any.
  const bands = Math.max(0, ...[...slot.values()].map((s) => s.band)) + 1;
  const rows: { ids: string[]; side: boolean }[] = [];
  for (let band = 0; band < bands; band++)
    for (const side of [false, true]) {
      const ids = [...slot.entries()].filter(([, s]) => s.band === band && s.side === side).map(([id]) => id);
      if (ids.length) rows.push({ ids, side });
    }
  const out = new Map<string, Point>();
  let y = 0;
  rows.forEach((row, k) => {
    if (k > 0) y = snap(y + Math.max(gaps[k] ?? 0, row.side ? SIDE_GAP : BAND_GAP));
    for (const id of row.ids) out.set(id, { x: slot.get(id)!.col * COL_PITCH, y });
    y += Math.max(...row.ids.map((id) => size(id).h));
  });
  return out;
}
