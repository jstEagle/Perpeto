// Captures the Storage screen in the light and dark appearance from a running
// dev server (default http://localhost:5180), demo data: the fleet view, and
// the cleanup preview after "Preview cleanup".
// Usage: node scripts/storage-screenshots.mjs [baseUrl]
// Writes apps/web/screenshots/storage/{light,dark}-{storage,preview,mobile}.png.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const base = process.argv[2] ?? 'http://localhost:5180';
const out = new URL('../screenshots/storage/', import.meta.url).pathname;
await mkdir(out, { recursive: true });

const browser = await chromium.launch();
const errors = [];
async function full(page, file) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const width = page.viewportSize().width;
  await page.setViewportSize({ width, height: Math.max(960, Math.min(height, 3000)) });
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${out}${file}` });
  console.log(file);
}
for (const theme of ['light', 'dark']) {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
      deviceScaleFactor: Number(process.env.DPR ?? 1),
      reducedMotion: 'reduce',
      colorScheme: theme === 'dark' ? 'light' : 'dark',
    });
    await context.addInitScript((t) => {
      localStorage.setItem('perpeto.appearance', t);
      localStorage.setItem('perpeto.demo', 'full');
    }, theme);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${theme} ${page.url()}: ${e.message}`));
    await page.goto(`${base}/storage`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Preview cleanup' }).waitFor();
    await page.waitForTimeout(400);
    if (mobile) {
      await full(page, `${theme}-mobile.png`);
    } else {
      await full(page, `${theme}-storage.png`);
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.getByRole('button', { name: 'Preview cleanup' }).click();
      await page.getByRole('button', { name: /^Clean up / }).waitFor({ timeout: 15000 });
      await page.waitForTimeout(300);
      await full(page, `${theme}-preview.png`);
    }
    await context.close();
  }
}
await browser.close();
if (errors.length) {
  console.error(`\n${errors.length} browser errors:\n${errors.join('\n')}`);
  process.exitCode = 1;
}
