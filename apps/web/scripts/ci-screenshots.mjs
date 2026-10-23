// Captures the CI screens in light and dark, desktop and mobile, from a
// running dev server (default http://localhost:5180) with demo data.
// Usage: node scripts/ci-screenshots.mjs [baseUrl]
// Writes apps/web/screenshots/ci/{light,dark}-<screen>-{desktop,mobile}.png.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const base = process.argv[2] ?? 'http://localhost:5180';
const out = new URL('../screenshots/ci/', import.meta.url).pathname;
await mkdir(out, { recursive: true });

const P = '/projects/prj_perpeto';
const screens = [
  ['ci', `${P}/ci`],
  ['ci-run-live', `${P}/ci/plr_live01`],
  ['ci-run-flaky', `${P}/ci/plr_flk02`, (page) => page.getByRole('button', { name: /test.*node 24/ }).click()],
  ['ci-run-failed', `${P}/ci/plr_fail03`],
  ['ci-start', `${P}/ci`, (page) => page.getByRole('button', { name: 'Run pipeline' }).click()],
];
const sizes = [
  ['desktop', { width: 1440, height: 960 }],
  ['mobile', { width: 390, height: 844 }],
];
const only = process.env.ONLY?.split(',');

const browser = await chromium.launch();
const errors = [];
for (const theme of ['light', 'dark']) {
  for (const [size, viewport] of sizes) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: Number(process.env.DPR ?? 1), reducedMotion: 'reduce', colorScheme: theme === 'dark' ? 'light' : 'dark' });
    await context.addInitScript((t) => {
      localStorage.setItem('perpeto.appearance', t);
      localStorage.setItem('perpeto.demo', 'full');
    }, theme);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${theme} ${size} ${page.url()}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${theme} ${size} ${page.url()}: ${m.text()}`));
    for (const [name, path, action] of screens) {
      if (only && !only.includes(name)) continue;
      await page.goto(base + path, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1200);
      if (action) {
        await action(page);
        await page.waitForTimeout(800);
      }
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, Math.min(height, 3200)) });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${out}${theme}-${name}-${size}.png` });
      await page.setViewportSize(viewport);
      console.log(`${theme}-${name}-${size}.png`);
    }
    await context.close();
  }
}
await browser.close();
if (errors.length) {
  console.error(`\n${errors.length} browser errors:\n${errors.join('\n')}`);
  process.exitCode = 1;
}
