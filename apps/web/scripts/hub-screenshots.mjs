// Captures the main screens against a real hub. Connects through the
// Settings form like a person would (the token goes only into the form),
// then visits the seeded project's screens at desktop and 390 px.
// Usage: node scripts/hub-screenshots.mjs <hubUrl> <owner.secret> [appUrl]
// Seed the hub first with scripts/seed-web-demo-hub.mjs.
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';

const [hubUrl, secretPath, app = 'http://localhost:5180'] = process.argv.slice(2);
const token = (await readFile(secretPath, 'utf8')).trim();
const out = new URL('../screenshots/', import.meta.url).pathname;
await mkdir(out, { recursive: true });

const get = async (path) => (await fetch(`${hubUrl}/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` } })).json();
const { projects } = await get('/projects');
const project = projects.at(-1);
const { runs } = await get(`/projects/${project.id}/runs`);
const { workflows } = await get(`/projects/${project.id}/workflows`);
const run = runs[0];
const workflow = workflows[0];
const P = `/projects/${project.id}`;
const screens = [
  ['hub-overview', P],
  ['hub-run-live-map', `${P}/runs/${run.id}`],
  ['hub-workflow-proposal', `${P}/workflows/${workflow.id}?version=${workflow.version}`],
  ['hub-machines', '/machines'],
  ['hub-usage', '/usage'],
];

const browser = await chromium.launch();
const errors = [];
for (const [size, viewport] of [
  ['desktop', { width: 1440, height: 960 }],
  ['mobile', { width: 390, height: 844 }],
]) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${size} ${page.url()}: ${e.message}`));
  // The session feature check expects a 404 from hubs without the session route; Chrome logs it.
  let connecting = true;
  page.on('console', (m) => m.type() === 'error' && !(connecting && m.text().includes('404')) && errors.push(`${size} ${page.url()}: ${m.text()}`));
  await page.goto(`${app}/settings`);
  await page.getByLabel('Hub URL').fill(hubUrl);
  await page.getByLabel('Owner token').fill(token);
  await page.getByRole('button', { name: 'Save and connect' }).click();
  await page.getByText('The token is kept in this tab only.').waitFor();
  connecting = false;
  if (size === 'desktop') await page.screenshot({ path: `${out}hub-settings-${size}.png`, fullPage: true });
  const stored = await page.evaluate(() => ({ local: JSON.stringify(localStorage), session: Object.keys(sessionStorage) }));
  if (stored.local.includes(token)) errors.push('The owner token was written to localStorage.');
  for (const [name, path] of screens) {
    // The live event stream keeps a request open, so wait for content rather than network idle.
    await page.goto(app + path, { waitUntil: 'load' });
    await page.locator('main h1').first().waitFor();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${out}${name}-${size}.png`, fullPage: true });
    console.log(`${name}-${size}.png`);
  }
  await context.close();
}
await browser.close();
if (errors.length) {
  console.error(`\n${errors.length} problems:\n${errors.join('\n')}`);
  process.exitCode = 1;
}
