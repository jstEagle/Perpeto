import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { generate, parseTokensCss, resolveRef, parseShadow, packageRoot, repoRoot, BRAND_COLORS, REQUIRED_BRAND_TOKENS } from '../scripts/build.mjs';
import { readPngSize } from '../scripts/lib/raster.mjs';

const files = new Map(generate());
const onDisk = (path) => readFileSync(resolve(packageRoot, path));
const brand = parseTokensCss(readFileSync(resolve(repoRoot, 'brand/tokens.css'), 'utf8'));
const brandMap = Object.fromEntries(brand);
const literal = (name) => resolveRef(brandMap, name).toLowerCase();

// PNG bytes depend on the zlib build; compare decoded pixel data instead.
const pixels = (buffer) => {
  const chunks = [];
  for (let o = 8; o < buffer.length;) {
    const length = buffer.readUInt32BE(o);
    if (buffer.toString('ascii', o + 4, o + 8) === 'IDAT') chunks.push(buffer.subarray(o + 8, o + 8 + length));
    o += 12 + length;
  }
  return inflateSync(Buffer.concat(chunks));
};

test('committed outputs match a fresh build of brand/tokens.css', () => {
  for (const [path, content] of files) {
    const disk = onDisk(path);
    if (path.endsWith('.png')) assert.deepEqual(pixels(disk), pixels(content), `${path} is stale; run npm run build`);
    else assert.equal(disk.toString('binary'), Buffer.from(content).toString('binary'), `${path} is stale; run npm run build`);
  }
});

test('tokens.css carries every brand variable with its exact value', () => {
  const css = files.get('dist/tokens.css');
  assert.ok(REQUIRED_BRAND_TOKENS.every(name => brand.some(([n]) => n === name)));
  for (const [name, value] of brand) assert.ok(css.includes(`  --${name}: ${value};`), `--${name} missing or changed`);
});

test('tokens.css exposes the agreed scales', () => {
  const css = files.get('dist/tokens.css');
  for (const size of [12, 13, 14, 16, 20, 24, 28, 32]) assert.match(css, new RegExp(`--text-${size}: ${size}px;`));
  for (const size of [40, 48, 56, 64, 72]) assert.match(css, new RegExp(`--display-${size}: ${size}px;`));
  for (let step = 1; step <= 24; step += 1) assert.match(css, new RegExp(`--space-${step}: ${step * 4}px;`));
  assert.match(css, /--leading-body: 1\.5;/);
  assert.match(css, /--leading-heading: 1\.2;/);
  for (const name of ['regular', 'medium', 'semibold']) assert.match(css, new RegExp(`--weight-${name}: \\d+;`));
  for (const name of ['sm', 'md', 'lg']) assert.match(css, new RegExp(`--control-height-${name}: \\d+px;`));
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*--duration-slow: 0ms;/);
});

test('layout, radius and motion tokens keep the Perpeto Mono ranges', () => {
  const value = (name) => Number(literal(name).replace(/px|ms$/g, ''));
  assert.equal(value('space-unit'), 4);
  for (const name of ['page-padding', 'card-padding', 'card-padding-compact', 'page-padding-compact', 'section-gap', 'content-max', 'sidebar-width']) {
    assert.equal(value(name) % 4, 0, `--${name} should sit on the 4 px grid`);
  }
  assert.ok(value('page-padding') >= 32 && value('page-padding') <= 48, 'page padding 32 to 48');
  assert.ok(value('card-padding') >= 24 && value('card-padding') <= 32, 'card padding 24 to 32');
  assert.ok(value('section-gap') >= 32 && value('section-gap') <= 48, 'section gap 32 to 48');
  assert.ok(value('radius-control') >= 10 && value('radius-control') <= 12, 'control radius 10 to 12');
  assert.ok(value('radius-panel') >= 16 && value('radius-panel') <= 20, 'card radius 16 to 20');
  assert.ok(value('radius-pill') >= 999, 'pill radius is full');
  for (const name of ['duration-fast', 'duration-base', 'duration-slow']) assert.ok(value(name) > 0 && value(name) <= 400, `--${name} is short`);
  for (const name of ['shadow-card', 'shadow-raised', 'shadow-overlay']) {
    for (const layer of parseShadow(literal(name))) assert.ok(layer.alpha <= 0.12, `--${name} stays soft`);
  }
});

test('the accent is reserved for the live dot and the brand mark', () => {
  const hex = literal('accent');
  for (const role of ['action', 'focus', 'success', 'warning', 'error', 'ink', 'muted', 'border', 'control-border']) {
    assert.notEqual(literal(role), hex, `--${role} must not use the accent`);
  }
  // Every other brand colour is neutral, apart from the one failure red.
  const saturation = (h) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); return Math.max(r, g, b) - Math.min(r, g, b); };
  for (const name of BRAND_COLORS.filter(n => !['accent', 'error'].includes(n))) assert.ok(saturation(literal(name)) <= 12, `--${name} should be a neutral grey`);
});

test('tokens.json and tokens.ts agree with the CSS', () => {
  const json = JSON.parse(files.get('dist/tokens.json'));
  for (const [name, value] of brand) assert.equal(json.cssVariables[`--${name}`], value);
  for (const name of BRAND_COLORS) assert.equal(json.color[name], literal(name));
  assert.equal(json.system, 'Perpeto Mono');
  const ts = files.get('dist/tokens.ts');
  assert.match(ts, /export const tokens = \{/);
  assert.ok(ts.includes(`"sourceSha256": "${json.sourceSha256}"`));
});

test('Swift tokens expose the agreed API and brand colours', () => {
  const swift = files.get('swift/PerpetoTokens.swift');
  const camel = (n) => n.replace(/-(\w)/g, (_, c) => c.toUpperCase());
  for (const name of BRAND_COLORS) assert.match(swift, new RegExp(`public static let ${camel(name)} = Color\\(perpetoLight: Color\\(\\.sRGB, [^\\n]+ // ${literal(name)}`));
  for (const name of ['action', 'controlBorder', 'onAction', 'success', 'warning', 'surfaceHover', 'gridMinor', 'gridMajor', 'actionPressed']) {
    assert.match(swift, new RegExp(`public static let ${name} = `), `PerpetoColor.${name} is used by the Apple client`);
  }
  assert.match(swift, /@available\(\*, deprecated[^\n]*\n    public static let gridMinor/);
  assert.match(swift, /public static let unit: CGFloat = 4/);
  assert.match(swift, /public static func x\(_ n: CGFloat\) -> CGFloat/);
  assert.match(swift, new RegExp(`public static let control: CGFloat = ${literal('radius-control').replace('px', '')}`));
  assert.match(swift, new RegExp(`public static let panel: CGFloat = ${literal('radius-panel').replace('px', '')}`));
  for (const size of [12, 13, 14, 16, 20, 24, 28, 32]) assert.match(swift, new RegExp(`text${size}: CGFloat = ${size}`));
  for (const api of ['enum PerpetoLayout', 'struct PerpetoElevation: Sendable', 'static let card = PerpetoElevation', 'func perpetoCard(', 'func perpetoElevation(', 'static func easeOut(', 'enum PerpetoIndicator', 'public static func display(', 'func perpetoTitle(']) {
    assert.ok(swift.includes(api), `Swift API missing: ${api}`);
  }
  assert.ok(!/weight: \.bold/.test(swift), 'display type is semibold, not bold');
});

test('every listed colour pair meets WCAG contrast', () => {
  const { contrast } = JSON.parse(files.get('dist/tokens.json'));
  for (const { fg, bg, ratio } of contrast.text) assert.ok(ratio >= 4.5, `${fg} on ${bg} is ${ratio}`);
  for (const { fg, bg, ratio } of contrast.nonText) assert.ok(ratio >= 3, `${fg} on ${bg} is ${ratio}`);
});

test('the dark graphite palette meets the same contrast and stays neutral', () => {
  const { dark } = JSON.parse(files.get('dist/tokens.json'));
  for (const { fg, bg, ratio } of dark.contrast.text) assert.ok(ratio >= 4.5, `dark ${fg} on ${bg} is ${ratio}`);
  for (const { fg, bg, ratio } of dark.contrast.nonText) assert.ok(ratio >= 3, `dark ${fg} on ${bg} is ${ratio}`);
  const saturation = (h) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); return Math.max(r, g, b) - Math.min(r, g, b); };
  for (const name of BRAND_COLORS.filter(n => !['accent', 'error'].includes(n))) assert.ok(saturation(dark.color[name]) <= 12, `dark --${name} should be a neutral grey`);
  assert.equal(dark.color.accent, JSON.parse(files.get('dist/tokens.json')).color.accent, 'one orange in both appearances');
  assert.ok(dark.color.canvas < dark.color.surface, 'dark cards sit lighter than the canvas');
});

test('the CSS switches to dark by attribute and by system preference', () => {
  const css = files.get('dist/tokens.css');
  assert.match(css, /:root\[data-theme="dark"\] \{\n  color-scheme: dark;[\s\S]*--canvas: #1a1b1d;/);
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\n  :root:not\(\[data-theme="light"\]\) \{[\s\S]*--surface-hover: #/);
});

test('Swift colours follow the colour scheme', () => {
  const swift = files.get('swift/PerpetoTokens.swift');
  assert.match(swift, /init\(perpetoLight light: Color, dark: Color\)/);
  assert.match(swift, /public static let canvas = Color\(perpetoLight: Color\(\.sRGB[^\n]+, dark: Color\(\.sRGB/);
});

test('identity SVGs keep the master geometry', () => {
  const paths = (svg) => [...svg.matchAll(/\sd="([^"]+)"/g)].map(m => m[1]);
  for (const kind of ['symbol', 'wordmark', 'lockup']) {
    const source = readFileSync(resolve(repoRoot, `brand/identity/perpeto-${kind}.svg`), 'utf8');
    assert.equal(files.get(`assets/perpeto-${kind}.svg`), source);
    for (const colour of ['black', 'ink', 'paper', 'orange']) assert.deepEqual(paths(files.get(`assets/perpeto-${kind}-${colour}.svg`)), paths(source));
  }
});

test('app icons and favicons have the expected pixel sizes', () => {
  for (const size of [1024, 512, 256, 180, 128, 64]) assert.deepEqual(readPngSize(files.get(`assets/app-icon/perpeto-app-icon-${size}.png`)), { width: size, height: size });
  for (const size of [1024, 512, 256, 128, 64, 32, 16]) assert.deepEqual(readPngSize(files.get(`assets/app-icon/macos/perpeto-app-icon-macos-${size}.png`)), { width: size, height: size });
  for (const size of [16, 32, 48]) assert.deepEqual(readPngSize(files.get(`assets/favicon/favicon-${size}.png`)), { width: size, height: size });
  const ico = files.get('assets/favicon/favicon.ico');
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 3);
});

test('specimen is self-contained and avoids banned treatments', () => {
  const html = files.get('specimen.html');
  assert.ok(!html.includes('<!-- @'), 'every specimen marker is replaced');
  for (const id of ['overview-desktop', 'overview-mobile', 'run-desktop', 'run-mobile']) assert.ok(html.includes(`id="${id}"`), `specimen shows ${id}`);
  assert.ok(!/<link\b|<script\b|src="http|@import/.test(html), 'specimen must not load external resources');
  assert.ok(!/text-transform:\s*uppercase/.test(html), 'no uppercase microcopy');
  assert.ok(!/letter-spacing:\s*0?\.\d+em|letter-spacing:\s*[1-9]/.test(html), 'no tracked-out text');
  assert.ok(!/(linear|radial|conic)-gradient/.test(html), 'no gradients');
});
