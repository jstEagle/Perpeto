// Captures key screens in the light and dark appearance at desktop width
// from a running dev server (default http://localhost:5180), demo data.
// Usage: node scripts/theme-screenshots.mjs [baseUrl]
// Writes apps/web/screenshots/themes/{light,dark}-<screen>.png, or to OUT
// (relative to apps/web). ONLY=accounts,pacing limits the screens.
// DEMO=observe uses the observe-only demo (no projects) and captures Home,
// Sessions, Accounts, Pacing and Usage into screenshots/observe/.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const base = process.argv[2] ?? 'http://localhost:5180';
const observe = process.env.DEMO === 'observe';
const out = new URL(process.env.OUT ? `../${process.env.OUT.replace(/\/?$/, '/')}` : observe ? '../screenshots/observe/' : '../screenshots/themes/', import.meta.url).pathname;
await mkdir(out, { recursive: true });

const P = '/projects/prj_perpeto';
const observeScreens = [
  ['home', '/'],
  ['sessions', '/sessions'],
  ['accounts', '/accounts'],
  ['pacing', '/pacing'],
  ['usage', '/usage'],
];
const fullScreens = [
  ['overview', P],
  ['workflows', `${P}/workflows`],
  ['workflow', `${P}/workflows/wf_k3build?version=3`],
  ['editor', `${P}/workflows/wf_k3build/edit`],
  ['run-live-map', `${P}/runs/run_7q4m2x`],
  ['runs', `${P}/runs`],
  ['work', `${P}/work`],
  ['messages', `${P}/messages`],
  ['accounts', '/accounts'],
  ['pacing', '/pacing'],
  ['usage', '/usage'],
  ['settings', '/settings'],
];
const screens = observe ? observeScreens : fullScreens;
const only = process.env.ONLY?.split(',');

const browser = await chromium.launch();
const errors = [];
for (const theme of ['light', 'dark']) {
  // The opposite system scheme proves the saved choice wins over the system.
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: Number(process.env.DPR ?? 1),
    reducedMotion: 'reduce',
    colorScheme: theme === 'dark' ? 'light' : 'dark',
  });
  await context.addInitScript(
    ([t, demo]) => {
      localStorage.setItem('perpeto.appearance', t);
      localStorage.setItem('perpeto.demo', demo);
    },
    [theme, observe ? 'observe' : 'full'],
  );
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${theme} ${page.url()}: ${e.message}`));
  for (const [name, path] of screens) {
    if (only && !only.includes(name)) continue;
    await page.goto(base + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: 1440, height: Math.max(960, Math.min(height, 2400)) });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${out}${theme}-${name}.png` });
    await page.setViewportSize({ width: 1440, height: 960 });
    console.log(`${theme}-${name}.png`);
  }
  await context.close();
}
await browser.close();
if (errors.length) {
  console.error(`\n${errors.length} browser errors:\n${errors.join('\n')}`);
  process.exitCode = 1;
}
