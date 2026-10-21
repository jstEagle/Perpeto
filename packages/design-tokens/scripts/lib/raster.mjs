// Minimal, dependency-free SVG rasterizer for the Perpeto identity assets.
// Supports <svg viewBox>, nested <g transform>, <path d> and <rect rx> with
// solid fills. Coverage uses 16 vertical sub-scanlines with exact horizontal
// span coverage, which keeps small renders honest about what the mark does.
import { deflateSync, crc32 } from 'node:zlib';

const SUBSAMPLES = 16;

// ---------- matrices ----------
const identity = () => [1, 0, 0, 1, 0, 0];
const multiply = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

export function parseTransform(text = '') {
  let m = identity();
  for (const [, name, args] of text.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const v = args.trim().split(/[\s,]+/).map(Number);
    if (name === 'translate') m = multiply(m, [1, 0, 0, 1, v[0], v[1] ?? 0]);
    else if (name === 'scale') m = multiply(m, [v[0], 0, 0, v[1] ?? v[0], 0, 0]);
    else if (name === 'matrix') m = multiply(m, v);
    else throw new Error(`Unsupported transform: ${name}`);
  }
  return m;
}

// ---------- path data ----------
function tokenize(d) {
  return d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
}

// Returns subpaths as arrays of [x, y] points in user space, flattened.
export function flattenPath(d, matrix, tolerance = 0.2) {
  const tokens = tokenize(d);
  const subpaths = [];
  let current = null;
  let lastCmd = '';
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, cx = 0, cy = 0, qx = 0, qy = 0;
  const num = () => Number(tokens[i++]);
  const push = (px, py) => current.push(apply(matrix, px, py));
  const segments = (points) => {
    // Estimate on-screen length to choose subdivision count.
    let length = 0;
    for (let k = 1; k < points.length; k += 1) {
      const a = apply(matrix, ...points[k - 1]);
      const b = apply(matrix, ...points[k]);
      length += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return Math.max(2, Math.min(256, Math.ceil(Math.sqrt(length / tolerance))));
  };
  const cubic = (x1, y1, x2, y2, x3, y3) => {
    const n = segments([[x, y], [x1, y1], [x2, y2], [x3, y3]]);
    for (let k = 1; k <= n; k += 1) {
      const t = k / n, u = 1 - t;
      push(u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
    }
    cx = x2; cy = y2; x = x3; y = y3;
  };
  const quad = (x1, y1, x2, y2) => {
    const n = segments([[x, y], [x1, y1], [x2, y2]]);
    for (let k = 1; k <= n; k += 1) {
      const t = k / n, u = 1 - t;
      push(u * u * x + 2 * u * t * x1 + t * t * x2, u * u * y + 2 * u * t * y1 + t * t * y2);
    }
    qx = x1; qy = y1; x = x2; y = y2;
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    const prev = cmd;
    switch (cmd.toUpperCase()) {
      case 'M': {
        x = ox + num(); y = oy + num(); sx = x; sy = y;
        current = []; subpaths.push(current); push(x, y);
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L': x = ox + num(); y = oy + num(); push(x, y); break;
      case 'H': x = (rel ? x : 0) + num(); push(x, y); break;
      case 'V': y = (rel ? y : 0) + num(); push(x, y); break;
      case 'C': { const a = [ox + num(), oy + num(), ox + num(), oy + num(), ox + num(), oy + num()]; cubic(...a); break; }
      case 'S': {
        const rx = /[CcSs]/.test(lastCmd) ? 2 * x - cx : x, ry = /[CcSs]/.test(lastCmd) ? 2 * y - cy : y;
        cubic(rx, ry, ox + num(), oy + num(), ox + num(), oy + num()); break;
      }
      case 'Q': quad(ox + num(), oy + num(), ox + num(), oy + num()); break;
      case 'T': {
        const rx = /[QqTt]/.test(lastCmd) ? 2 * x - qx : x, ry = /[QqTt]/.test(lastCmd) ? 2 * y - qy : y;
        quad(rx, ry, ox + num(), oy + num()); break;
      }
      case 'Z': x = sx; y = sy; break;
      default: throw new Error(`Unsupported path command: ${cmd}`);
    }
    lastCmd = prev;
  }
  return subpaths;
}

function rectPath({ x = 0, y = 0, width, height, rx = 0 }) {
  const r = Math.min(Number(rx), width / 2, height / 2);
  const k = 0.5522847498 * r;
  if (!r) return `M${x} ${y}H${x + width}V${y + height}H${x}Z`;
  return [
    `M${x + r} ${y}H${x + width - r}`,
    `C${x + width - r + k} ${y} ${x + width} ${y + r - k} ${x + width} ${y + r}`,
    `V${y + height - r}`,
    `C${x + width} ${y + height - r + k} ${x + width - r + k} ${y + height} ${x + width - r} ${y + height}`,
    `H${x + r}`,
    `C${x + r - k} ${y + height} ${x} ${y + height - r + k} ${x} ${y + height - r}`,
    `V${y + r}`,
    `C${x} ${y + r - k} ${x + r - k} ${y} ${x + r} ${y}Z`,
  ].join('');
}

// ---------- svg ----------
const attr = (tag, name) => {
  const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match ? match[1] : undefined;
};

// Parses the subset of SVG used by brand/identity into fill shapes.
export function parseSvg(source) {
  const svgTag = source.match(/<svg\b[^>]*>/)?.[0];
  if (!svgTag) throw new Error('No <svg> element');
  const viewBox = (attr(svgTag, 'viewBox') ?? `0 0 ${attr(svgTag, 'width')} ${attr(svgTag, 'height')}`)
    .trim().split(/[\s,]+/).map(Number);
  const shapes = [];
  const stack = [{ matrix: identity(), fill: attr(svgTag, 'fill') ?? '#000000' }];
  const body = source.slice(source.indexOf(svgTag) + svgTag.length);
  for (const [tag] of body.matchAll(/<\/?(?:g|path|rect)\b[^>]*>/g)) {
    if (tag.startsWith('</')) { stack.pop(); continue; }
    const parent = stack.at(-1);
    const matrix = multiply(parent.matrix, parseTransform(attr(tag, 'transform')));
    const fill = attr(tag, 'fill') ?? parent.fill;
    const selfClosing = tag.endsWith('/>');
    if (tag.startsWith('<g')) { if (!selfClosing) stack.push({ matrix, fill }); continue; }
    const d = tag.startsWith('<rect')
      ? rectPath(Object.fromEntries(['x', 'y', 'width', 'height', 'rx'].map(n => [n, Number(attr(tag, n) ?? 0)])))
      : attr(tag, 'd');
    if (fill !== 'none') shapes.push({ d, matrix, fill });
    if (!selfClosing) stack.push({ matrix, fill });
  }
  return { viewBox, shapes };
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map(c => c + c).join('') : h;
  return [0, 2, 4].map(o => parseInt(full.slice(o, o + 2), 16));
}

function coverage(polygons, width, height) {
  const edges = [];
  let minY = Infinity, maxY = -Infinity;
  for (const poly of polygons) {
    for (let k = 0; k < poly.length; k += 1) {
      const [x0, y0] = poly[k];
      const [x1, y1] = poly[(k + 1) % poly.length];
      if (y0 === y1) continue;
      const dir = y1 > y0 ? 1 : -1;
      const top = Math.min(y0, y1), bottom = Math.max(y0, y1);
      edges.push({ top, bottom, x0, y0, slope: (x1 - x0) / (y1 - y0), dir });
      minY = Math.min(minY, top); maxY = Math.max(maxY, bottom);
    }
  }
  const cov = new Float32Array(width * height);
  const startRow = Math.max(0, Math.floor(minY)), endRow = Math.min(height - 1, Math.ceil(maxY));
  edges.sort((a, b) => a.top - b.top);
  const crossings = [];
  for (let row = startRow; row <= endRow; row += 1) {
    const active = edges.filter(e => e.top < row + 1 && e.bottom > row);
    for (let s = 0; s < SUBSAMPLES; s += 1) {
      const sy = row + (s + 0.5) / SUBSAMPLES;
      crossings.length = 0;
      for (const e of active) if (sy >= e.top && sy < e.bottom) crossings.push([e.x0 + (sy - e.y0) * e.slope, e.dir]);
      crossings.sort((a, b) => a[0] - b[0]);
      let winding = 0;
      for (let c = 0; c < crossings.length - 1; c += 1) {
        winding += crossings[c][1];
        if (!winding) continue;
        const xa = Math.max(0, crossings[c][0]), xb = Math.min(width, crossings[c + 1][0]);
        if (xb <= xa) continue;
        const ia = Math.floor(xa), ib = Math.floor(xb), base = row * width, w = 1 / SUBSAMPLES;
        if (ia === ib) { cov[base + ia] += (xb - xa) * w; continue; }
        cov[base + ia] += (ia + 1 - xa) * w;
        for (let p = ia + 1; p < ib; p += 1) cov[base + p] += w;
        if (ib < width) cov[base + ib] += (xb - ib) * w;
      }
    }
  }
  return cov;
}

// Renders SVG source to a straight-alpha RGBA buffer of width × height.
export function renderSvg(source, width, height = width, { background, fit = 'contain', recolor } = {}) {
  const { viewBox: [vx, vy, vw, vh], shapes } = parseSvg(source);
  const scale = fit === 'contain' ? Math.min(width / vw, height / vh) : Math.max(width / vw, height / vh);
  const view = [scale, 0, 0, scale, (width - vw * scale) / 2 - vx * scale, (height - vh * scale) / 2 - vy * scale];
  const rgba = new Float32Array(width * height * 4); // premultiplied, 0..1
  if (background) {
    const [r, g, b] = hexToRgb(background).map(v => v / 255);
    for (let p = 0; p < width * height; p += 1) rgba.set([r, g, b, 1], p * 4);
  }
  for (const shape of shapes) {
    const polys = flattenPath(shape.d, multiply(view, shape.matrix));
    const cov = coverage(polys, width, height);
    const [r, g, b] = hexToRgb(recolor?.(shape.fill) ?? shape.fill).map(v => v / 255);
    for (let p = 0; p < cov.length; p += 1) {
      const a = Math.min(1, cov[p]);
      if (!a) continue;
      const o = p * 4, keep = 1 - a;
      rgba[o] = r * a + rgba[o] * keep;
      rgba[o + 1] = g * a + rgba[o + 1] * keep;
      rgba[o + 2] = b * a + rgba[o + 2] * keep;
      rgba[o + 3] = a + rgba[o + 3] * keep;
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    const o = p * 4, a = rgba[o + 3];
    out[o + 3] = Math.round(a * 255);
    for (let c = 0; c < 3; c += 1) out[o + c] = a ? Math.round(Math.min(1, rgba[o + c] / a) * 255) : 0;
  }
  return { width, height, data: out };
}

// ---------- png ----------
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

export function encodePng({ width, height, data }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function readPngSize(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// ICO container with embedded PNG images (supported by all current browsers).
export function encodeIco(pngs) {
  const header = Buffer.alloc(6 + pngs.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach((png, index) => {
    const { width, height } = readPngSize(png);
    const o = 6 + index * 16;
    header[o] = width >= 256 ? 0 : width;
    header[o + 1] = height >= 256 ? 0 : height;
    header.writeUInt16LE(1, o + 4);
    header.writeUInt16LE(32, o + 6);
    header.writeUInt32LE(png.length, o + 8);
    header.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs]);
}

// Nearest-neighbour enlargement for inspecting small renders.
export function enlarge({ width, height, data }, factor) {
  const out = new Uint8Array(width * factor * height * factor * 4);
  for (let y = 0; y < height * factor; y += 1) {
    for (let x = 0; x < width * factor; x += 1) {
      const src = (Math.floor(y / factor) * width + Math.floor(x / factor)) * 4;
      out.set(data.subarray(src, src + 4), (y * width * factor + x) * 4);
    }
  }
  return { width: width * factor, height: height * factor, data: out };
}
