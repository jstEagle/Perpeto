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
await page.getByRole('textbox', { name: 'Describe another workflow' }).fill('Nothing merges without my approval. Review with a second model.');
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

// Workflows: active ones side by side, the architect's extra proposal, the template library.
await page.goto(`${base}/projects/prj_perpeto/workflows`);
const cards = page.locator('.wf-grid .wf-card');
await cards.first().waitFor();
const tops = await cards.evaluateAll((els) => els.map((e) => ({ name: e.querySelector('.card-title')?.textContent, top: Math.round(e.getBoundingClientRect().top) })));
const buildTop = tops.find((c) => c.name === 'Build')?.top;
assert.equal(tops.find((c) => c.name === 'Improve')?.top, buildTop, `active workflows share a row: ${JSON.stringify(tops)}`);
await page.getByRole('heading', { name: 'Also suggested' }).waitFor();
assert.ok(await page.locator('.suggested').getByText('Bugfix', { exact: true }).isVisible(), 'the extra proposal is listed');
await page.getByRole('button', { name: 'Start from a template' }).click();
await page.getByText('Security audit').waitFor();
assert.equal(await page.locator('.template-option').count(), 7, 'six library templates and a blank canvas');
await page.getByRole('button', { name: 'Cancel' }).click();
step('workflows: active side by side, also suggested, template library');

// With two live runs, each overview issue opens the run it belongs to.
await page.goto(`${base}/projects/prj_perpeto`);
await page.getByRole('heading', { name: '2 workflows are live' }).waitFor();
assert.match(await page.getByRole('link', { name: 'Show on map' }).first().getAttribute('href'), /runs\/run_7q4m2x\?node=reviewer/);
assert.equal(await page.locator('.live-runs > li').count(), 2, 'each live run lists its intake and budget');
step('overview: live runs side by side, issues open their own run');

// Budget: the exhausted run says when it resumes; raising the limit resumes intake.
await page.goto(`${base}/projects/prj_perpeto/runs/run_8f2k4t`);
await page.getByText('New work is paused. Today’s token budget is used.').waitFor();
assert.match(await page.locator('.callout-intake').innerText(), /Resumes (today|tomorrow) at \d\d:\d\d/);
await page.getByRole('button', { name: 'Change budget' }).click();
await page.getByLabel('Tokens per day').fill('2M');
await page.getByRole('button', { name: 'Save settings' }).click();
await page.locator('.callout-intake').waitFor({ state: 'detached' });
assert.match(await page.locator('.run-intake .budget-text').innerText(), /of 2M tokens/);
step('budget exhausted shows when intake resumes; raising it resumes intake');

// Start a scheduled, continuous run from an active workflow that has none. Demo state lives in the page, so navigate in-app.
await page.getByRole('button', { name: 'Stop' }).click();
await page.getByRole('dialog').getByRole('button', { name: 'Stop run' }).click();
await page.getByText('Stopped', { exact: true }).first().waitFor();
await page.locator('.sidebar').getByRole('link', { name: 'Workflows' }).click();
await page.locator('.wf-card', { hasText: 'Improve' }).getByRole('button', { name: 'Start run' }).click();
await page.getByRole('radio', { name: 'Schedule' }).click();
await page.getByLabel('Repeat').selectOption('daily');
await page.getByLabel('Time').fill('07:30');
assert.ok(await page.getByLabel('Keep running when the work is done').isChecked(), 'scheduled runs keep running by default');
await page.getByText('Daily budget').click();
await page.getByLabel('Items per day').fill('5');
await page.getByRole('dialog').getByRole('button', { name: 'Start run' }).click();
await page.waitForURL(/\/runs\/run_/);
await page.getByText('Keeps running · New work every day at 07:30').waitFor();
await page.getByText('0 of 5 items').waitFor();
step('start a run with a schedule, keep running and a budget');

// Usage by role, and when runs ended.
await page.goto(`${base}/usage`);
await page.getByRole('radio', { name: 'Role' }).click();
await page.getByRole('columnheader', { name: 'Role' }).waitFor();
await page.getByRole('cell', { name: 'Builder' }).waitFor();
await page.goto(`${base}/projects/prj_perpeto/runs`);
await page.getByRole('columnheader', { name: 'Ended' }).waitFor();
assert.ok(await page.locator('tr', { hasText: 'run_3c8w1n' }).locator('[title^="Completed"]').isVisible(), 'completed runs show when they completed');
step('usage by role; runs list shows completed and stopped times');

// Messages: reply in a thread, see the receipt move, acknowledge a message addressed to you.
await page.goto(`${base}/projects/prj_perpeto/messages`);
await page.getByText('Reviews are queueing behind me').waitFor();
await page.getByRole('button', { name: 'Acknowledge' }).click();
await page.getByText('Acknowledged by you').waitFor();
await page.getByRole('button', { name: 'Reply', exact: true }).last().click();
await page.getByPlaceholder('Reply to Reviewer').fill('Yes, review CI-blocked items last.');
await page.locator('.composer-reply').getByRole('button', { name: 'Reply' }).click();
await page.getByText('Yes, review CI-blocked items last.').waitFor();
await page.getByText("Delivered into Reviewer's running turn").last().waitFor({ timeout: 6000 });
assert.ok(await page.getByText('Unplanned').first().isVisible(), 'unplanned agent messages are marked');
step('messages: threaded reply, delivery receipt, acknowledge, unplanned flag');

// The sidebar marks exactly one item current on every section's pages.
for (const [path, label] of [
  ['/projects/prj_perpeto', 'Overview'],
  ['/projects/prj_perpeto/runs/run_7q4m2x', 'Runs'],
  ['/projects/prj_perpeto/messages', 'Messages'],
  ['/projects/prj_perpeto/workflows/wf_k3build?version=3', 'Workflows'],
  ['/machines', 'Machines'],
]) {
  await page.goto(`${base}${path}`);
  await page.locator('.sidebar .nav-link').first().waitFor();
  const currentItems = await page.locator('.sidebar [aria-current="page"]').allInnerTexts();
  assert.deepEqual(currentItems.map((t) => t.trim().split('\n')[0]), [label], `${path}: ${JSON.stringify(currentItems)}`);
}
step('the sidebar marks exactly one current item per page');

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
