// Measures the live map with a synthetic graph on the dev server's
// /perf.html page: first render, pan and zoom frame rates, selection and
// live-update latency. Runs each case with and without virtualisation and
// compact nodes.
// Usage: node scripts/perf.mjs [baseUrl] [nodes]   (THROTTLE=1,4 sets CPU slowdowns)
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:5180';
const n = Number(process.argv[3] ?? 200);
const browser = await chromium.launch();

/** Frames painted while `action` runs, as frames per second, plus the longest frame. */
async function fps(page, action) {
  await page.evaluate(() => {
    const run = (window.__run = (window.__run ?? 0) + 1);
    window.__frames = [];
    const loop = (t) => {
      if (window.__run !== run) return;
      window.__frames.push(t);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await action();
  const frames = await page.evaluate(() => {
    window.__run++;
    return window.__frames;
  });
  const gaps = frames.slice(1).map((t, i) => t - frames[i]);
  const total = frames.at(-1) - frames[0];
  return { fps: Math.round(((frames.length - 1) / total) * 1000), worst: Math.round(Math.max(...gaps)) };
}

const results = [];
const throttles = (process.env.THROTTLE ?? '1,4').split(',').map(Number);
for (const throttle of throttles)
for (const large of ['1', '0']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
  // CPU slowdown via the DevTools protocol, to approximate a slower laptop.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  await page.goto(`${base}/perf.html?n=${n}&large=${large}`);
  await page.waitForSelector('.react-flow__node');
  await page.waitForTimeout(300);
  const firstRender = Date.now() - t0;
  const pane = page.locator('.react-flow__pane');
  const box = await pane.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rendered = async () => page.locator('.react-flow__node').count();

  const fitNodes = await rendered();
  // Pan at the fitted zoom: 60 drag steps over about a second.
  const panFit = await fps(page, async () => {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 0; i < 60; i++) await page.mouse.move(cx - i * 8, cy - i * 2);
    await page.mouse.up();
  });
  // Wheel zoom in, then out again to the fitted zoom.
  const zoomIn = await fps(page, async () => {
    for (const dy of [-120, -120, -120, -120, -120, -120, 120, 120, 120, 120, 120, 120]) {
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, dy);
      await page.waitForTimeout(16);
    }
  });
  // Reading size: about 100 %.
  await page.getByRole('button', { name: 'Fit graph to view' }).click();
  for (let i = 0; i < 7; i++) await page.getByRole('button', { name: 'Zoom in' }).click();
  const zoom = await page.evaluate(() => document.querySelector('.react-flow__viewport').style.transform);
  const readNodes = await rendered();
  // Selection: click a node header in view, time from pointer down until it is drawn selected.
  const target = await page.evaluate(() => {
    const pane = document.querySelector('.react-flow').getBoundingClientRect();
    const r = [...document.querySelectorAll('.gnode-head')]
      .map((h) => h.getBoundingClientRect())
      .find((b) => b.left > pane.left + 8 && b.left + 80 < pane.right - 8 && b.top > pane.top + 56 && b.bottom < pane.bottom - 8);
    addEventListener('pointerdown', () => (window.__t0 = performance.now()), { capture: true, once: true });
    return r ? { x: r.left + 30, y: r.top + r.height / 2 } : null;
  });
  let select = NaN;
  if (target) {
    await page.mouse.click(target.x, target.y);
    select = await page.evaluate(async () => {
      for (let i = 0; i < 300 && !document.querySelector('.gnode.is-selected'); i++) await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => requestAnimationFrame(r));
      return document.querySelector('.gnode.is-selected') ? performance.now() - window.__t0 : NaN;
    });
  }
  const panRead = await fps(page, async () => {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 0; i < 60; i++) await page.mouse.move(cx - i * 12, cy);
    await page.mouse.up();
  });
  // Live update: new metrics for every node, until painted. Median of 10.
  const ticks = [];
  for (let i = 0; i < 10; i++) ticks.push(await page.evaluate(() => window.perf.tick()));
  ticks.sort((a, b) => a - b);
  const info = await page.evaluate(() => ({ nodes: window.perf.nodes, edges: window.perf.edges }));
  results.push({
    mode: large === '1' ? 'virtualised + compact' : 'everything rendered',
    cpu: `${throttle}x slower`,
    ...info,
    firstRenderMs: firstRender,
    domNodesAtFit: fitNodes,
    panFitFps: panFit.fps,
    panFitWorstFrameMs: panFit.worst,
    zoomFps: zoomIn.fps,
    zoomWorstFrameMs: zoomIn.worst,
    readingZoom: zoom.match(/scale\(([\d.]+)\)/)?.[1],
    domNodesAtReadingZoom: readNodes,
    panReadFps: panRead.fps,
    panReadWorstFrameMs: panRead.worst,
    selectMs: Math.round(select),
    liveUpdateMedianMs: Math.round(ticks[5]),
    errors: errors.length,
  });
  await page.close();
}
await browser.close();
console.table(results);
