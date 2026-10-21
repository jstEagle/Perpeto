/** Orthogonal polyline with small rounded corners, as an SVG path. */
export function roundedPath(points: [number, number][], radius = 6): string {
  if (points.length < 2) return '';
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1];
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    const inLen = Math.hypot(x - px, y - py);
    const outLen = Math.hypot(nx - x, ny - y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 0.5) {
      d += ` L ${x} ${y}`;
      continue;
    }
    const ax = x - ((x - px) / inLen) * r;
    const ay = y - ((y - py) / inLen) * r;
    const bx = x + ((nx - x) / outLen) * r;
    const by = y + ((ny - y) / outLen) * r;
    d += ` L ${ax} ${ay} Q ${x} ${y} ${bx} ${by}`;
  }
  const [lx, ly] = points[points.length - 1];
  return `${d} L ${lx} ${ly}`;
}

/** Midpoint along a polyline, for labels. */
export function polylineMidpoint(points: [number, number][]): [number, number] {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1]));
  const total = lengths.reduce((a, b) => a + b, 0);
  let walked = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (walked + lengths[i] >= total / 2) {
      const t = (total / 2 - walked) / (lengths[i] || 1);
      return [points[i][0] + (points[i + 1][0] - points[i][0]) * t, points[i][1] + (points[i + 1][1] - points[i][1]) * t];
    }
    walked += lengths[i];
  }
  return points[0];
}

/** Longest horizontal segment midpoint: steadier label placement for routed edges. */
export function longestHorizontalMid(points: [number, number][]): [number, number] {
  let best: [number, number] = polylineMidpoint(points);
  let bestLen = -1;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    if (Math.abs(ay - by) < 0.5 && Math.abs(bx - ax) > bestLen) {
      bestLen = Math.abs(bx - ax);
      best = [(ax + bx) / 2, ay];
    }
  }
  return best;
}
