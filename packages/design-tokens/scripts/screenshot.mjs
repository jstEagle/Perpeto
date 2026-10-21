#!/usr/bin/env node
// Screenshots specimen.html and its mock screens for visual review.
// Usage: npm run screenshot -- [output-dir]   (defaults to packages/design-tokens/screenshots)
//
// Each mock screen has an id (overview-desktop, run-mobile, ...). Opening specimen.html#<id>
// shows that frame alone, so any browser can capture it. With Playwright installed the script
// measures each frame; otherwise it falls back to headless Chrome with the heights below.
import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRoot } from './build.mjs';

export const SHOTS = [
  { name: 'specimen-desktop', width: 1440, height: 14480, scale: 1 },
  { name: 'overview-desktop', hash: 'overview-desktop', width: 1440, height: 966, scale: 2 },
  { name: 'overview-mobile', hash: 'overview-mobile', width: 390, height: 1801, scale: 2 },
  { name: 'run-desktop', hash: 'run-desktop', width: 1440, height: 1554, scale: 2 },
  { name: 'run-mobile', hash: 'run-mobile', width: 390, height: 2341, scale: 2 },
];

const outDir = resolve(process.argv[2] ?? resolve(packageRoot, 'screenshots'));
mkdirSync(outDir, { recursive: true });
const url = (hash) => `${pathToFileURL(resolve(packageRoot, 'specimen.html')).href}${hash ? `#${hash}` : ''}`;

async function withPlaywright() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return false;
  }
  const browser = await chromium.launch();
  for (const shot of SHOTS) {
    const page = await browser.newPage({ viewport: { width: shot.width, height: 900 }, deviceScaleFactor: shot.scale });
    await page.goto(url(shot.hash));
    const path = resolve(outDir, `${shot.name}.png`);
    if (shot.hash) {
      const height = await page.evaluate((id) => Math.ceil(document.getElementById(id).scrollHeight), shot.hash);
      await page.setViewportSize({ width: shot.width, height });
      await page.screenshot({ path });
    } else {
      await page.screenshot({ path, fullPage: true });
    }
    console.log(`wrote ${path}`);
    await page.close();
  }
  await browser.close();
  return true;
}

function withChrome() {
  const chrome = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean).find(path => existsSync(path));
  if (!chrome) {
    console.error('Neither Playwright nor Chrome is available. Install Playwright or set CHROME_PATH.');
    process.exit(1);
  }
  for (const shot of SHOTS) {
    const path = resolve(outDir, `${shot.name}.png`);
    const result = spawnSync(chrome, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', `--force-device-scale-factor=${shot.scale}`,
      `--window-size=${shot.width},${shot.height}`, `--screenshot=${path}`, url(shot.hash),
    ], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
    console.log(`wrote ${path}`);
  }
}

if (!(await withPlaywright())) withChrome();
