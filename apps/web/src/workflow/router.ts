import type { EdgeKind } from '../api/types';

/**
 * Orthogonal edge routing for workflow graphs.
 *
 * Flow edges run along the main line: straight between neighbours in a row,
 * and through a gap between rows (a gutter) otherwise. Returns along the top
 * row run in one channel above it, so loops read as arcs over the line they
 * repeat; returns from lower rows run below their row. An edge into another
 * row takes one elbow through the column gap when that gap is clear.
 * Delegates and messages never share the main line. They leave from the top
 * or bottom of a node and run in their own lanes: below a row when both ends
 * share it, straight down when one node sits over the other, otherwise
 * through the gutter above the lower node. Edges between the same two nodes are bundled into one cable with a
 * single label. Every horizontal run gets its own lane, and labels are
 * placed where they collide with no node, label or other edge; a label that
 * cannot be placed is dropped and kept as the edge's tooltip.
 */

export type Pt = [number, number];

export interface RouteNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RouteEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  port?: string;
  /** Label text. Bundled edges share one label made from their texts. */
  label?: string;
  /** Placed before lower priorities when labels compete for room. */
  priority?: number;
}

export interface PlacedLabel {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

export interface Route {
  points: Pt[];
  label?: PlacedLabel;
  /** Text of a label that found no free room; shown as a tooltip instead. */
  tooltip?: string;
  /** Attachment points of delegates and messages on node tops and bottoms. */
  ends?: { x: number; y: number; end: 'source' | 'target' }[];
}

export interface Routing {
  routes: Map<string, Route>;
  /** Minimum height of the gap above row k so its lanes fit; 0 when unused. For row 0, the height of the return channel above it. */
  gutterNeeds: number[];
}

export const PORT_Y: Record<string, number> = { in: 20, out: 20, pass: 20, fail: 56 };
export const LANE = 20;
export const STUB = 12;
const CLEAR = 24;
const LABEL_H = 18;
const BUNDLE_STEP = 5;
const SLOTS = [0, -32, 32, -64, 64, -96, 96];

/** Approximate rendered width of a 12 px label with 6 px padding. */
export function labelWidth(text: string): number {
  return Math.ceil(text.length * 7 + 14);
}

interface Row {
  top: number;
  bottom: number;
}

function clusterRows(nodes: RouteNode[]): { rows: Row[]; rowOf: Map<string, number> } {
  const sorted = [...nodes].sort((a, b) => a.y - b.y);
  const rows: (Row & { ids: string[] })[] = [];
  for (const n of sorted) {
    const last = rows.at(-1);
    if (last && n.y < last.bottom - 8) {
      last.ids.push(n.id);
      last.bottom = Math.max(last.bottom, n.y + n.h);
    } else rows.push({ top: n.y, bottom: n.y + n.h, ids: [n.id] });
  }
  const rowOf = new Map<string, number>();
  rows.forEach((r, i) => r.ids.forEach((id) => rowOf.set(id, i)));
  return { rows, rowOf };
}

/**
 * Lanes in a gutter stack away from one of its rows: `down` from the row
 * above, `up` from the row below. Gutters outside the outermost rows have
 * only one neighbour, and all their lanes stack away from it.
 */
type Plan =
  | { type: 'fixed'; points: Pt[] }
  | { type: 'lane'; gutter: number; dir: 'down' | 'up'; span: [number, number]; build(y: number): Pt[] };

type Box = { x1: number; y1: number; x2: number; y2: number };

interface Bundle {
  key: string;
  a: string;
  b: string;
  edges: RouteEdge[];
}

export function routeEdges(nodes: RouteNode[], edges: RouteEdge[]): Routing {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const { rows, rowOf } = clusterRows(nodes);
  const valid = edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);

  const plans = new Map<string, Plan>();
  const port = (n: RouteNode, name: string, side: 'in' | 'out'): Pt => [side === 'in' ? n.x : n.x + n.w, n.y + (PORT_Y[name] ?? PORT_Y.out)];

  // Flow edges.
  const clear = (box: Box, except: RouteNode[]) =>
    !nodes.some((n) => !except.includes(n) && n.x < Math.max(box.x1, box.x2) && n.x + n.w > Math.min(box.x1, box.x2) && n.y < Math.max(box.y1, box.y2) && n.y + n.h > Math.min(box.y1, box.y2));
  for (const e of valid.filter((x) => x.kind === 'flow')) {
    const s = byId.get(e.from)!;
    const t = byId.get(e.to)!;
    const sp = port(s, e.port ?? 'out', 'out');
    const tp = port(t, 'in', 'in');
    const rs = rowOf.get(s.id)!;
    const rt = rowOf.get(t.id)!;
    const x1 = sp[0] + STUB;
    const x2 = tp[0] - STUB;
    const blocked = nodes.some((n) => n !== s && n !== t && rowOf.get(n.id) === rs && n.x + n.w > sp[0] && n.x < tp[0] && n.y < Math.max(sp[1], tp[1]) && n.y + n.h > Math.min(sp[1], tp[1]));
    if (rs === rt && tp[0] > sp[0] + 2 * STUB && !blocked) {
      const midX = Math.round((sp[0] + tp[0]) / 2);
      plans.set(e.id, { type: 'fixed', points: Math.abs(sp[1] - tp[1]) < 1 ? [sp, tp] : [sp, [midX, sp[1]], [midX, tp[1]], tp] });
      continue;
    }
    // Into another row, forward: one elbow in the column gap just before the target.
    if (rs !== rt && x2 > x1 && clear({ x1: sp[0], y1: sp[1], x2, y2: sp[1] }, [s]) && clear({ x1: x2, y1: sp[1], x2, y2: tp[1] }, [])) {
      plans.set(e.id, { type: 'fixed', points: [sp, [x2, sp[1]], [x2, tp[1]], tp] });
      continue;
    }
    const lane = (gutter: number, dir: 'down' | 'up'): Plan => ({
      type: 'lane',
      gutter,
      dir,
      span: [Math.min(x1, x2), Math.max(x1, x2)],
      build: (y) => [sp, [x1, sp[1]], [x1, y], [x2, y], [x2, tp[1]], tp],
    });
    if (rs === rt) {
      plans.set(e.id, rs === 0 ? lane(0, 'up') : lane(rs + 1, 'down'));
      continue;
    }
    // Back from a lower row: below the source row when both verticals are clear.
    const below = rs + 1 < rows.length ? rows[rs + 1].top : rows[rs].bottom + 2 * CLEAR;
    if (rs > rt && clear({ x1, y1: sp[1], x2: x1, y2: below }, [s]) && clear({ x1: x2, y1: tp[1], x2, y2: below }, [])) {
      plans.set(e.id, lane(rs + 1, 'down'));
      continue;
    }
    plans.set(e.id, rt > rs ? lane(rt, 'up') : lane(rt + 1, 'down'));
  }

  // Delegates and messages, bundled per pair of nodes.
  const bundles = new Map<string, Bundle>();
  for (const e of valid.filter((x) => x.kind !== 'flow')) {
    const key = [e.from, e.to].sort().join('\u0000');
    const bundle = bundles.get(key) ?? { key, a: e.from, b: e.to, edges: [] };
    bundle.edges.push(e);
    bundles.set(key, bundle);
  }

  type Attach = { bundle: Bundle; node: string; side: 'top' | 'bottom'; other: number; fixed?: number };
  const attaches: Attach[] = [];
  const shape = new Map<string, { kind: 'channel' | 'straight' | 'cross'; upper: string; lower: string; x?: number }>();
  for (const bundle of bundles.values()) {
    const a = byId.get(bundle.a)!;
    const b = byId.get(bundle.b)!;
    const ra = rowOf.get(a.id)!;
    const rb = rowOf.get(b.id)!;
    const cx = (n: RouteNode) => n.x + n.w / 2;
    if (ra === rb) {
      shape.set(bundle.key, { kind: 'channel', upper: a.id, lower: b.id });
      attaches.push({ bundle, node: a.id, side: 'bottom', other: cx(b) }, { bundle, node: b.id, side: 'bottom', other: cx(a) });
      continue;
    }
    const [upper, lower] = ra < rb ? [a, b] : [b, a];
    const left = Math.max(upper.x, lower.x) + 16;
    const right = Math.min(upper.x + upper.w, lower.x + lower.w) - 16;
    const between = nodes.some((n) => {
      const r = rowOf.get(n.id)!;
      return r > rowOf.get(upper.id)! && r < rowOf.get(lower.id)! && n.x < right && n.x + n.w > left;
    });
    if (right - left >= 16 && !between) {
      const aligned = Math.abs(cx(upper) - cx(lower)) < 8;
      const x = aligned ? undefined : Math.round((left + right) / 2);
      shape.set(bundle.key, { kind: 'straight', upper: upper.id, lower: lower.id, x });
      attaches.push({ bundle, node: upper.id, side: 'bottom', other: cx(lower), fixed: x }, { bundle, node: lower.id, side: 'top', other: cx(upper), fixed: x });
      continue;
    }
    shape.set(bundle.key, { kind: 'cross', upper: upper.id, lower: lower.id });
    attaches.push({ bundle, node: upper.id, side: 'bottom', other: cx(lower) }, { bundle, node: lower.id, side: 'top', other: cx(upper) });
  }

  // Spread attachments along each node side, ordered by where the other end
  // lies, so cables leaving one node do not cross each other.
  const attachX = new Map<string, number>();
  const sides = new Map<string, Attach[]>();
  for (const at of attaches) sides.set(`${at.node}|${at.side}`, [...(sides.get(`${at.node}|${at.side}`) ?? []), at]);
  for (const list of sides.values()) {
    const n = byId.get(list[0].node)!;
    const center = n.x + n.w / 2;
    const used = new Set<number>();
    const ordered = [...list].sort((p, q) => Number(q.fixed !== undefined || shape.get(q.bundle.key)?.kind === 'straight') - Number(p.fixed !== undefined || shape.get(p.bundle.key)?.kind === 'straight'));
    const free: Attach[] = [];
    for (const at of ordered) {
      if (shape.get(at.bundle.key)?.kind === 'straight' && !used.has(0) && at.fixed === undefined) {
        used.add(0);
        attachX.set(`${at.bundle.key}|${at.node}`, center);
      } else if (at.fixed !== undefined) attachX.set(`${at.bundle.key}|${at.node}`, at.fixed);
      else free.push(at);
    }
    const slots = SLOTS.filter((s) => !used.has(s) && Math.abs(s) <= n.w / 2 - 16).slice(0, free.length).sort((p, q) => p - q);
    free.sort((p, q) => p.other - q.other).forEach((at, i) => attachX.set(`${at.bundle.key}|${at.node}`, center + (slots[i] ?? 0)));
  }

  const bundlePlan = new Map<string, Plan>();
  for (const bundle of bundles.values()) {
    const s = shape.get(bundle.key)!;
    const upper = byId.get(s.upper)!;
    const lower = byId.get(s.lower)!;
    const ux = attachX.get(`${bundle.key}|${upper.id}`)!;
    const lx = attachX.get(`${bundle.key}|${lower.id}`)!;
    if (s.kind === 'straight') {
      bundlePlan.set(bundle.key, { type: 'fixed', points: [[ux, upper.y + upper.h], [ux, lower.y]] });
    } else if (s.kind === 'channel') {
      bundlePlan.set(bundle.key, {
        type: 'lane',
        gutter: rowOf.get(upper.id)! + 1,
        dir: 'down',
        span: [Math.min(ux, lx), Math.max(ux, lx)],
        build: (y) => [[ux, upper.y + upper.h], [ux, y], [lx, y], [lx, lower.y + lower.h]],
      });
    } else {
      bundlePlan.set(bundle.key, {
        type: 'lane',
        gutter: rowOf.get(lower.id)!,
        dir: 'up',
        span: [Math.min(ux, lx), Math.max(ux, lx)],
        build: (y) => [[ux, upper.y + upper.h], [ux, y], [lx, y], [lx, lower.y]],
      });
    }
  }

  // Lanes stack away from their row. Shorter runs sit closer to the nodes,
  // so nested returns never cross; runs that do not overlap share a lane.
  const laneOf = new Map<string, number>();
  const counts = new Map<string, number>();
  const groups = new Map<string, { id: string; span: [number, number] }[]>();
  const lanePlans: [string, Extract<Plan, { type: 'lane' }>][] = [];
  for (const [id, p] of plans) if (p.type === 'lane') lanePlans.push([id, p]);
  for (const [key, p] of bundlePlan) if (p.type === 'lane') lanePlans.push([`bundle:${key}`, p]);
  for (const [id, p] of lanePlans) {
    const g = `${p.gutter}|${p.gutter === 0 || p.gutter >= rows.length ? 'edge' : p.dir}`;
    groups.set(g, [...(groups.get(g) ?? []), { id, span: p.span }]);
  }
  for (const [g, list] of groups) {
    list.sort((p, q) => p.span[1] - p.span[0] - (q.span[1] - q.span[0]) || p.span[0] - q.span[0]);
    const lanes: [number, number][][] = [];
    for (const item of list) {
      let lane = lanes.findIndex((spans) => spans.every(([x1, x2]) => item.span[1] + 12 < x1 || item.span[0] - 12 > x2));
      if (lane === -1) lane = lanes.push([]) - 1;
      lanes[lane].push(item.span);
      laneOf.set(item.id, lane);
    }
    counts.set(g, lanes.length);
  }

  const laneY = (gutter: number, dir: 'down' | 'up', lane: number) => {
    if (gutter === 0) return rows[0].top - CLEAR - lane * LANE;
    if (gutter >= rows.length) return rows[rows.length - 1].bottom + CLEAR + lane * LANE;
    return dir === 'down' ? rows[gutter - 1].bottom + CLEAR + lane * LANE : rows[gutter].top - CLEAR - lane * LANE;
  };
  const laneOfPlan = (id: string, p: Extract<Plan, { type: 'lane' }>) => laneY(p.gutter, p.dir, laneOf.get(id)!);

  const gutterNeeds = rows.map((_, k) => {
    if (k === 0) {
      const lanes = counts.get('0|edge') ?? 0;
      return lanes ? CLEAR + (lanes - 1) * LANE + CLEAR : 0;
    }
    const down = counts.get(`${k}|down`) ?? 0;
    const up = counts.get(`${k}|up`) ?? 0;
    const lanes = down + up;
    return lanes === 0 ? 0 : 2 * CLEAR + (lanes - 1) * LANE + (down && up ? LANE : 0);
  });

  // Final points.
  const routes = new Map<string, Route>();
  for (const e of valid.filter((x) => x.kind === 'flow')) {
    const p = plans.get(e.id)!;
    routes.set(e.id, { points: p.type === 'fixed' ? p.points : p.build(laneOfPlan(e.id, p)) });
  }
  for (const bundle of bundles.values()) {
    const p = bundlePlan.get(bundle.key)!;
    const base = p.type === 'fixed' ? p.points : p.build(laneOfPlan(`bundle:${bundle.key}`, p));
    const upperId = shape.get(bundle.key)!.upper;
    bundle.edges.forEach((e, i) => {
      const d = (i - (bundle.edges.length - 1) / 2) * BUNDLE_STEP;
      // Offset perpendicular to each segment: x for vertical runs, y for horizontal ones.
      const shifted = base.map(([x, y], j): Pt => {
        const prev = base[j - 1];
        const next = base[j + 1];
        const vertical = (q?: Pt) => q && Math.abs(q[0] - x) < 0.5;
        const horizontal = (q?: Pt) => q && Math.abs(q[1] - y) < 0.5;
        const dx = vertical(prev) || vertical(next) ? d : 0;
        const dy = (j > 0 && j < base.length - 1) && (horizontal(prev) || horizontal(next)) ? d : 0;
        return [x + dx, y + dy];
      });
      const points = e.from === upperId || (shape.get(bundle.key)!.kind === 'channel' && e.from === bundle.a) ? shifted : [...shifted].reverse();
      routes.set(e.id, {
        points,
        ends: [
          { x: points[0][0], y: points[0][1], end: 'source' },
          { x: points.at(-1)![0], y: points.at(-1)![1], end: 'target' },
        ],
      });
    });
  }

  placeLabels(nodes, valid, bundles, routes);
  return { routes, gutterNeeds };
}

type Rect = { x1: number; y1: number; x2: number; y2: number };
const hit = (a: Rect, b: Rect) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

function segmentRects(points: Pt[], pad: number): Rect[] {
  return points.slice(1).map((p, i) => {
    const q = points[i];
    return { x1: Math.min(p[0], q[0]) - pad, y1: Math.min(p[1], q[1]) - pad, x2: Math.max(p[0], q[0]) + pad, y2: Math.max(p[1], q[1]) + pad };
  });
}

/** Label positions along a route: horizontal runs first, longest first, sliding out from the middle in 4 px steps. */
function candidates(points: Pt[], w: number): [number, number][] {
  const segs = points.slice(1).map((p, i) => [points[i], p] as [Pt, Pt]);
  const out: [number, number][] = [];
  const horizontal = segs.filter(([a, b]) => Math.abs(a[1] - b[1]) < 0.5).sort(([a, b], [c, d]) => Math.abs(d[0] - c[0]) - Math.abs(b[0] - a[0]));
  for (const [a, b] of horizontal) {
    const lo = Math.min(a[0], b[0]);
    const hi = Math.max(a[0], b[0]);
    const mid = (lo + hi) / 2;
    const room = Math.max(0, (hi - lo - w) / 2);
    for (let d = 0; d <= room; d += 4) {
      out.push([mid - d, a[1]]);
      if (d) out.push([mid + d, a[1]]);
    }
    if (hi - lo < w) out.push([mid, a[1]]);
  }
  const vertical = segs.filter(([a, b]) => Math.abs(a[0] - b[0]) < 0.5).sort(([a, b], [c, d]) => Math.abs(d[1] - c[1]) - Math.abs(b[1] - a[1]));
  for (const [a, b] of vertical) {
    const lo = Math.min(a[1], b[1]);
    const hi = Math.max(a[1], b[1]);
    const mid = (lo + hi) / 2;
    const room = Math.max(0, (hi - lo - LABEL_H) / 2 - 4);
    for (let d = 0; d <= room; d += 4) {
      out.push([a[0], mid - d]);
      if (d) out.push([a[0], mid + d]);
    }
  }
  return out;
}

/** Rectangles bucketed in a coarse grid, so a lookup only tests nearby ones. */
class RectIndex {
  readonly #cells = new Map<string, { rect: Rect; owner?: string }[]>();
  static readonly CELL = 128;
  #keys(r: Rect): string[] {
    const c = RectIndex.CELL;
    const keys: string[] = [];
    for (let i = Math.floor(r.x1 / c); i <= Math.floor(r.x2 / c); i++) for (let j = Math.floor(r.y1 / c); j <= Math.floor(r.y2 / c); j++) keys.push(`${i}:${j}`);
    return keys;
  }
  add(rect: Rect, owner?: string) {
    const entry = { rect, owner };
    for (const k of this.#keys(rect)) {
      const list = this.#cells.get(k);
      if (list) list.push(entry);
      else this.#cells.set(k, [entry]);
    }
  }
  /** True when `r` hits any rectangle not owned by `ignore`. */
  hits(r: Rect, ignore?: string): boolean {
    for (const k of this.#keys(r)) for (const e of this.#cells.get(k) ?? []) if ((ignore === undefined || e.owner !== ignore) && hit(r, e.rect)) return true;
    return false;
  }
}

function placeLabels(nodes: RouteNode[], edges: RouteEdge[], bundles: Map<string, Bundle>, routes: Map<string, Route>) {
  const blocked = new RectIndex();
  for (const n of nodes) blocked.add({ x1: n.x - 4, y1: n.y - 4, x2: n.x + n.w + 4, y2: n.y + n.h + 4 });
  const ownerOf = new Map<string, string>();
  for (const b of bundles.values()) for (const e of b.edges) ownerOf.set(e.id, b.key);
  const lines = new RectIndex();
  for (const [id, r] of routes) for (const rect of segmentRects(r.points, 3)) lines.add(rect, ownerOf.get(id) ?? id);

  // One label per flow edge and per bundle.
  const jobs: { owner: string; carrier: string; text: string; priority: number }[] = [];
  for (const e of edges) {
    if (e.kind === 'flow' && e.label) jobs.push({ owner: e.id, carrier: e.id, text: e.label, priority: e.priority ?? 0 });
  }
  for (const b of bundles.values()) {
    const texts = b.edges.map((e) => e.label).filter((t): t is string => !!t);
    if (texts.length) jobs.push({ owner: b.key, carrier: b.edges[0].id, text: [...new Set(texts)].join(' · '), priority: Math.max(...b.edges.map((e) => e.priority ?? 0)) });
  }
  jobs.sort((a, b) => b.priority - a.priority);

  for (const job of jobs) {
    const route = routes.get(job.carrier)!;
    const w = labelWidth(job.text);
    const spot = candidates(route.points, w).find(([x, y]) => {
      const r = { x1: x - w / 2 - 2, y1: y - LABEL_H / 2 - 2, x2: x + w / 2 + 2, y2: y + LABEL_H / 2 + 2 };
      return !blocked.hits(r) && !lines.hits(r, job.owner);
    });
    if (!spot) {
      route.tooltip = job.text;
      continue;
    }
    route.label = { x: spot[0], y: spot[1], w, h: LABEL_H, text: job.text };
    blocked.add({ x1: spot[0] - w / 2 - 2, y1: spot[1] - LABEL_H / 2 - 2, x2: spot[0] + w / 2 + 2, y2: spot[1] + LABEL_H / 2 + 2 });
  }
}
