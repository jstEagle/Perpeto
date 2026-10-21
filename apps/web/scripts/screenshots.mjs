// Captures every screen at desktop and mobile widths from a running dev
// server (default http://localhost:5180) using demo data.
// Usage: node scripts/screenshots.mjs [baseUrl]
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const base = process.argv[2] ?? 'http://localhost:5180';
const out = new URL('../screenshots/', import.meta.url).pathname;
await mkdir(out, { recursive: true });

const P = '/projects/prj_perpeto';
const screens = [
  ['projects', '/'],
  ['overview', P],
  ['workflows', `${P}/workflows`],
  ['workflow-proposal', `${P}/workflows/wf_k3build?version=4`],
  ['workflow-active', `${P}/workflows/wf_k3build?version=3`],
  ['editor', `${P}/workflows/wf_k3build/edit`],
  ['runs', `${P}/runs`],
  ['run-live-map', `${P}/runs/run_7q4m2x`],
  ['work', `${P}/work`],
  ['messages', `${P}/messages`],
  ['merge-queue', `${P}/merge-queue`],
  ['machines', '/machines'],
  ['accounts', '/accounts'],
  ['usage', '/usage'],
  ['settings', '/settings'],
  ['empty-project', '/projects/prj_fieldnotes'],
  ['empty-workflows', '/projects/prj_fieldnotes/workflows'],
];
const sizes = [
  ['desktop', { width: 1440, height: 960 }],
  ['mobile', { width: 390, height: 844 }],
];

const only = process.env.ONLY?.split(',');
const browser = await chromium.launch();
const errors = [];
for (const [size, viewport] of sizes) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${size} ${page.url()}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${size} ${page.url()}: ${m.text()}`));
  for (const [name, path] of screens) {
    if (only && !only.includes(name)) continue;
    await page.goto(base + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${out}${name}-${size}.png`, fullPage: true });
    console.log(`${name}-${size}.png`);
  }
  await context.close();
}
await browser.close();
if (errors.length) {
  console.error(`\n${errors.length} browser errors:\n${errors.join('\n')}`);
  process.exitCode = 1;
}
