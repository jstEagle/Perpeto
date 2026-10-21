// Drives the main flows in a real browser against the dev server (demo data).
// Usage: node scripts/smoke.mjs [baseUrl]
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const base = process.argv[2] ?? 'http://localhost:5180';
const shots = new URL('../screenshots/', import.meta.url).pathname;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const step = (name) => console.log(`ok  ${name}`);

// 1. Architect: describe, follow progress, review the draft, activate it.
await page.goto(`${base}/projects/prj_perpeto/workflows`);
await page.getByRole('textbox', { name: 'Describe a new workflow' }).fill('Nothing merges without my approval. Review with a second model.');
await page.getByRole('button', { name: 'Draft workflow' }).click();
await page.getByRole('heading', { name: 'Workflow architect' }).waitFor();
await page.getByText('Checking 2 online machines').waitFor({ timeout: 10000 });
await page.screenshot({ path: `${shots}architect-progress-desktop.png` });
await page.waitForURL(/version=/, { timeout: 15000 });
await page.getByRole('heading', { name: /proposed version/ }).waitFor();
step('architect drafts a workflow and opens the proposal');
await page.getByRole('button', { name: /Activate version/ }).click();
await page.getByText('Active', { exact: true }).first().waitFor();
await page.getByRole('button', { name: 'Start run' }).waitFor();
step('activating the draft makes it the active version');

// 2. Ask for changes on the active Build workflow shows a diff.
await page.goto(`${base}/projects/prj_perpeto/workflows/wf_k3build?version=4`);
await page.getByRole('heading', { name: 'Changes from version 3' }).waitFor();
const added = await page.locator('.diff-summary dd').first().innerText();
assert.equal(added.trim(), '4');
step('proposal diff counts added items');

// 3. Editor: add a node from the palette with the keyboard, see validation, save.
await page.goto(`${base}/projects/prj_perpeto/workflows/wf_k3build/edit`);
await page.getByRole('button', { name: 'Human' }).focus();
await page.keyboard.press('Enter');
await page.getByRole('heading', { name: 'Human' }).waitFor();
await page.getByText(/does not pass work anywhere|port is not connected/).first().waitFor();
const saveDisabled = await page.getByRole('button', { name: 'Save draft' }).isDisabled();
assert.equal(saveDisabled, true, 'save is blocked while the graph has errors');
step('adding an unconnected node shows live validation errors and blocks save');
await page.getByRole('button', { name: 'Delete node' }).click();
await page.getByText('Graph is valid.').waitFor();
await page.getByLabel('Label').first().waitFor({ state: 'detached' }).catch(() => {});
// Change reviewer concurrency through the inspector, then save.
await page.locator('.react-flow__node[data-id="reviewer"]').click();
await page.getByLabel('Concurrency').fill('2');
await page.getByRole('button', { name: 'Save draft' }).click();
await page.waitForURL(/version=5/);
await page.getByText('Changed: concurrency').first().waitFor();
step('inspector edit saves a new draft version with a diff');

// 4. Run controls and live map selection.
await page.goto(`${base}/projects/prj_perpeto/runs/run_7q4m2x`);
await page.locator('.react-flow__node[data-id="reviewer"]').click();
await page.getByRole('heading', { name: 'Interactions: Reviewer' }).waitFor();
await page.screenshot({ path: `${shots}run-node-selected-desktop.png`, fullPage: false });
step('selecting a node filters the interaction feed and shows its assignments');
await page.getByRole('button', { name: 'Pause' }).click();
await page.getByText('Paused. No new assignments start until you resume.').waitFor();
await page.getByRole('button', { name: 'Resume' }).click();
await page.getByRole('button', { name: 'Pause' }).waitFor();
step('pause and resume');

// 5. Keyboard: skip link and visible focus.
await page.goto(`${base}/`);
await page.getByRole('heading', { name: 'Projects' }).waitFor();
const first = await page.evaluate(() => document.querySelector('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')?.textContent);
assert.equal(first, 'Skip to content');
await page.focus('.skip-link');
await page.keyboard.press('Tab');
await page.keyboard.press('Tab');
const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
assert.equal(outline, 'solid');
await page.screenshot({ path: `${shots}focus-ring-desktop.png`, clip: { x: 0, y: 0, width: 720, height: 80 } });
step('skip link first, visible focus ring');

// 6. Settings rejects plain HTTP to a remote host.
await page.goto(`${base}/settings`);
await page.getByLabel('Hub URL').fill('http://hub.example.com');
await page.getByLabel('Owner token').fill('x');
await page.getByRole('button', { name: 'Test connection' }).click();
await page.getByText('Use HTTPS for a hub that is not on this machine').waitFor();
step('settings refuses remote plain HTTP');

await browser.close();
if (errors.length) {
  console.error(`browser errors:\n${errors.join('\n')}`);
  process.exit(1);
}
console.log('smoke passed');
