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
await page.getByText('Changed concurrency').first().waitFor();
step('inspector edit saves a new draft version with a diff');

// 4. Run controls and live map selection.
await page.goto(`${base}/projects/prj_perpeto/runs/run_7q4m2x`);
await page.locator('.react-flow__node[data-id="reviewer"]').waitFor();
await page.waitForTimeout(600);
/** Edge labels must not touch each other or any node. */
const labelCollisions = () =>
  page.evaluate(() => {
    const rect = (el) => el.getBoundingClientRect();
    const labels = [...document.querySelectorAll('.gedge-label')].map(rect);
    const nodes = [...document.querySelectorAll('.react-flow__node')].map(rect);
    const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    let n = 0;
    labels.forEach((a, i) => {
      labels.slice(i + 1).forEach((b) => (n += hit(a, b) ? 1 : 0));
      nodes.forEach((b) => (n += hit(a, b) ? 1 : 0));
    });
    return { labels: labels.length, collisions: n };
  });
const roleEdges = () => page.locator('.react-flow__edge .gedge-delegates, .react-flow__edge .gedge-messages:not(.gedge-unplanned)').count();
assert.equal(await roleEdges(), 0, 'live map hides delegates and messages until a node is selected');
const before = await labelCollisions();
assert.ok(before.labels > 5 && before.collisions === 0, `labels collide: ${JSON.stringify(before)}`);
await page.getByRole('button', { name: 'Selected links' }).click();
assert.ok((await roleEdges()) >= 2, 'All shows every delegate and message');
const all = await labelCollisions();
assert.equal(all.collisions, 0, `labels collide with all links shown: ${JSON.stringify(all)}`);
await page.getByRole('button', { name: 'All links' }).click();
step('live map routes labels without collisions and toggles delegates and messages');
await page.locator('.react-flow__node[data-id="reviewer"]').click();
assert.ok((await roleEdges()) >= 1, "selecting the reviewer shows its messages");
await page.getByRole('heading', { name: 'Activity at Reviewer' }).waitFor();
await page.screenshot({ path: `${shots}run-node-selected-desktop.png`, fullPage: false });
step('selecting a node filters the interaction feed and shows its assignments');
// "Show on map" selects the bottleneck step and keeps it inside the visible canvas.
await page.getByRole('button', { name: 'Clear' }).first().click().catch(() => {});
await page.getByRole('button', { name: 'Show on map' }).first().click();
await page.locator('.react-flow__node[data-id="reviewer"] .gnode.is-selected').waitFor();
await page.waitForTimeout(500);
const inView = await page.evaluate(() => {
  const pane = document.querySelector('.graph').getBoundingClientRect();
  const node = document.querySelector('.react-flow__node[data-id="reviewer"]').getBoundingClientRect();
  return node.left >= pane.left && node.right <= pane.right;
});
assert.ok(inView, 'the selected bottleneck is inside the canvas');
const visibleSteps = await page.evaluate(() => {
  const pane = document.querySelector('.graph').getBoundingClientRect();
  return [...document.querySelectorAll('.react-flow__node')].filter((n) => {
    const r = n.getBoundingClientRect();
    return r.left >= pane.left && r.right <= pane.right;
  }).length;
});
assert.equal(visibleSteps, 8, 'every step of the build run is in view at 1440 px');
step('the whole factory is in view and Show on map selects the bottleneck');
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

// 7. Proposal and editor labels stay clear too.
for (const path of ['/projects/prj_perpeto/workflows/wf_k3build?version=4', '/projects/prj_perpeto/workflows/wf_k3build/edit']) {
  await page.goto(`${base}${path}`);
  await page.locator('.react-flow__node').first().waitFor();
  await page.waitForTimeout(600);
  const result = await labelCollisions();
  assert.equal(result.collisions, 0, `${path}: ${JSON.stringify(result)}`);
}
step('proposal and editor labels never overlap');

// 8. Editor: a node dragged onto another stays put until "Tidy layout" lays the graph out again.
page.on('dialog', (d) => d.accept());
await page.goto(`${base}/projects/prj_perpeto/workflows/wf_k3build/edit`);
await page.locator('.react-flow__node').first().waitFor();
await page.waitForTimeout(400);
const boxes = async () => page.locator('.react-flow__node').evaluateAll((els) => els.map((e) => ({ id: e.dataset.id, ...e.getBoundingClientRect().toJSON() })));
const overlapping = (list) => list.some((a, i) => list.some((b, j) => j > i && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
assert.ok(!overlapping(await boxes()), 'the editor opens without overlapping nodes');
const [from, to] = await page.locator('.react-flow__node .gnode-head').evaluateAll((els) => els.slice(0, 2).map((e) => e.getBoundingClientRect().toJSON()));
await page.mouse.move(from.x + 20, from.y + 10);
await page.mouse.down();
await page.mouse.move(to.x + 30, to.y + 20, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
assert.ok(overlapping(await boxes()), 'a dragged node keeps the position it was dropped at');
await page.getByRole('button', { name: 'Tidy layout' }).click();
await page.waitForTimeout(300);
const tidied = await boxes();
assert.ok(!overlapping(tidied), 'tidy layout removes the overlap');
const line = ['input', 'planner', 'loop', 'builder', 'reviewer', 'ci', 'merge', 'done'].map((id) => tidied.find((b) => b.id === id));
// Left to right within a band; a longer line wraps to the next band below.
assert.ok(line.every((b, i) => b && (i === 0 || (Math.abs(b.top - line[i - 1].top) < 1 ? b.left > line[i - 1].left : b.top > line[i - 1].bottom))), 'the main line runs left to right, wrapping into bands');
step('editor keeps moved nodes and tidies on request');

// 9. No owner token in localStorage.
assert.ok(!(await page.evaluate(() => Object.keys(localStorage).some((k) => k === 'perpeto.hub.v1'))), 'legacy token key is gone');
step('owner token is not kept in localStorage');

await browser.close();
if (errors.length) {
  console.error(`browser errors:\n${errors.join('\n')}`);
  process.exit(1);
}
console.log('smoke passed');
