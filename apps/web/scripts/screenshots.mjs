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
  ['run-intake-paused', `${P}/runs/run_8f2k4t`],
  ['run-settings', `${P}/runs/run_8f2k4t`, async (page) => {
    await page.getByRole('region', { name: 'Intake and budget' }).getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('radio', { name: 'Schedule' }).click();
  }],
  ['template-picker', `${P}/workflows`, (page) => page.getByRole('button', { name: 'Start from a template' }).click()],
  ['work', `${P}/work`],
  ['messages', `${P}/messages`],
  ['merge-queue', `${P}/merge-queue`],
  ['machines', '/machines'],
  ['accounts', '/accounts'],
  ['usage', '/usage'],
  ['usage-role', '/usage', (page) => page.getByRole('radio', { name: 'Role' }).click()],
  ['settings', '/settings'],
  ['empty-project', '/projects/prj_fieldnotes'],
  ['empty-workflows', '/projects/prj_fieldnotes/workflows'],
];
const sizes = [
  ['desktop', { width: 1440, height: 960 }],
  ['mobile', { width: 390, height: 844 }],
];

const only = process.env.ONLY?.split(',');
/**
 * Full-page capture with the viewport grown to the page, so sticky elements
 * (the sidebar, the floating tab bar) sit where a person scrolling would see them.
 */
async function fullPage(page, path) {
  const size = page.viewportSize();
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: size.width, height: Math.max(size.height, height) });
  await page.waitForTimeout(150);
  await page.screenshot({ path });
  await page.setViewportSize(size);
}

const browser = await chromium.launch();
const errors = [];
for (const [size, viewport] of sizes) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: Number(process.env.DPR ?? 1), reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${size} ${page.url()}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${size} ${page.url()}: ${m.text()}`));
  for (const [name, path, action] of screens) {
    if (only && !only.includes(name)) continue;
    await page.goto(base + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    if (action) {
      await action(page);
      await page.waitForTimeout(600);
    }
    await fullPage(page, `${out}${name}-${size}.png`);
    console.log(`${name}-${size}.png`);
  }
  await context.close();
}
await browser.close();
if (errors.length) {
  console.error(`\n${errors.length} browser errors:\n${errors.join('\n')}`);
  process.exitCode = 1;
}
