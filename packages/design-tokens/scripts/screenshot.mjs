#!/usr/bin/env node
// Screenshots specimen.html with a locally installed Chrome for visual review.
// Usage: npm run screenshot -- [output.png] [width] [height]
// Output defaults to the ignored .perpeto/ui-validation/ directory at the repo root.
import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRoot, repoRoot } from './build.mjs';

const candidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const chrome = candidates.find(path => existsSync(path));
if (!chrome) {
  console.error('No Chrome or Chromium found. Set CHROME_PATH to take a screenshot.');
  process.exit(1);
}

const [output = resolve(repoRoot, '.perpeto/ui-validation/design-tokens-specimen.png'), width = '1440', height = '9600'] = process.argv.slice(2);
mkdirSync(dirname(resolve(output)), { recursive: true });
const result = spawnSync(chrome, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  `--window-size=${width},${height}`, `--screenshot=${resolve(output)}`,
  pathToFileURL(resolve(packageRoot, 'specimen.html')).href,
], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
