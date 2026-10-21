import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { generate, parseTokensCss, packageRoot, repoRoot, BRAND_COLORS, REQUIRED_BRAND_TOKENS } from '../scripts/build.mjs';
import { readPngSize } from '../scripts/lib/raster.mjs';

const files = new Map(generate());
const onDisk = (path) => readFileSync(resolve(packageRoot, path));
const brand = parseTokensCss(readFileSync(resolve(repoRoot, 'brand/tokens.css'), 'utf8'));

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
  for (const size of [12, 14, 16, 20, 24, 32]) assert.match(css, new RegExp(`--text-${size}: ${size}px;`));
  for (const size of [40, 48, 56, 64, 72]) assert.match(css, new RegExp(`--display-${size}: ${size}px;`));
  for (let step = 1; step <= 16; step += 1) assert.match(css, new RegExp(`--space-${step}: ${step * 4}px;`));
  assert.match(css, /--leading-body: 1\.55;/);
  assert.match(css, /--leading-heading: 1\.15;/);
});

test('tokens.json and tokens.ts agree with the CSS', () => {
  const json = JSON.parse(files.get('dist/tokens.json'));
  for (const [name, value] of brand) assert.equal(json.cssVariables[`--${name}`], value);
  for (const name of BRAND_COLORS) assert.equal(json.color[name], brand.find(([n]) => n === name)[1].toLowerCase());
  const ts = files.get('dist/tokens.ts');
  assert.match(ts, /export const tokens = \{/);
  assert.ok(ts.includes(`"sourceSha256": "${json.sourceSha256}"`));
});

test('Swift tokens expose the agreed API and brand colours', () => {
  const swift = files.get('swift/PerpetoTokens.swift');
  for (const name of ['canvas', 'surface', 'ink', 'muted', 'border', 'controlBorder', 'accent', 'action', 'onAction', 'focus', 'success', 'warning', 'error']) {
    const hex = brand.find(([n]) => n.replace(/-(\w)/g, (_, c) => c.toUpperCase()) === name)[1].toLowerCase();
    assert.match(swift, new RegExp(`public static let ${name} = Color\\(\\.sRGB, [^\\n]+ // ${hex}`));
  }
  assert.match(swift, /public static let unit: CGFloat = 4/);
  assert.match(swift, /public static func x\(_ n: CGFloat\) -> CGFloat/);
  assert.match(swift, /public static let control: CGFloat = 6/);
  assert.match(swift, /public static let panel: CGFloat = 12/);
  for (const size of [12, 14, 16, 20, 24, 32]) assert.match(swift, new RegExp(`text${size}: CGFloat = ${size}`));
  assert.match(swift, /public static func display\(/);
});

test('every listed colour pair meets WCAG contrast', () => {
  const { contrast } = JSON.parse(files.get('dist/tokens.json'));
  for (const { fg, bg, ratio } of contrast.text) assert.ok(ratio >= 4.5, `${fg} on ${bg} is ${ratio}`);
  for (const { fg, bg, ratio } of contrast.nonText) assert.ok(ratio >= 3, `${fg} on ${bg} is ${ratio}`);
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
  assert.ok(!/<link\b|<script\b|src="http|@import/.test(html), 'specimen must not load external resources');
  assert.ok(!/text-transform:\s*uppercase/.test(html), 'no uppercase microcopy');
  assert.ok(!/letter-spacing:\s*0?\.\d+em|letter-spacing:\s*[1-9]/.test(html), 'no tracked-out text');
  assert.ok(!/(linear|radial|conic)-gradient/.test(html), 'no gradients');
});
