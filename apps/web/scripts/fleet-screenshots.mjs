// Captures the Fleet screen from a running dev server (default
// http://localhost:5180) with demo data: the two demo Macs and a generated
// 50-machine fleet (?fleet=50), light and dark, desktop and 390 px.
// Usage: node scripts/fleet-screenshots.mjs [baseUrl]
// Writes apps/web/screenshots/fleet/{light,dark}-fleet[-50]-{desktop,mobile}.png.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const base = process.argv[2] ?? 'http://localhost:5180';
const out = new URL('../screenshots/fleet/', import.meta.url).pathname;
await mkdir(out, { recursive: true });

const screens = [
  ['fleet', '/machines'],
  ['fleet-50', '/machines?fleet=50'],
];
const sizes = [
  ['desktop', { width: 1440, height: 960 }],
  ['mobile', { width: 390, height: 844 }],
];

const browser = await chromium.launch();
const errors = [];
for (const theme of ['light', 'dark']) {
  for (const [size, viewport] of sizes) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: Number(process.env.DPR ?? 1), reducedMotion: 'reduce', colorScheme: theme === 'dark' ? 'light' : 'dark' });
    await context.addInitScript((t) => {
      localStorage.setItem('perpeto.appearance', t);
      localStorage.setItem('perpeto.demo', 'full');
      localStorage.removeItem('perpeto.hub.v2');
    }, theme);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${theme} ${size} ${page.url()}: ${e.message}`));
    for (const [name, path] of screens) {
      await page.goto(base + path, { waitUntil: 'load' });
      await page.locator('.fleet-list').first().waitFor();
      await page.waitForTimeout(600);
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, height) });
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
