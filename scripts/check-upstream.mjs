import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'config/upstream-files.json'), 'utf8'));
const patches = JSON.parse(readFileSync(resolve(root, 'config/upstream-patches.json'), 'utf8'));
let failed = 0;
for (const [name, patch] of Object.entries(patches)) {
  if (patch.upstreamHash !== (manifest[name] ?? null) || !patch.reason?.trim() ||
      !/^[a-f0-9]{64}$/.test(patch.sha256) || name.split('/').includes('..') || name.startsWith('/')) {
    console.error(`${name}: invalid patch provenance`); failed++;
  }
}
for (const name of new Set([...Object.keys(manifest), ...Object.keys(patches)])) {
  try {
    const expected = patches[name]?.sha256 ?? manifest[name];
    const actual = createHash('sha256').update(readFileSync(resolve(root, 'vendor/t3code', name))).digest('hex');
    if (actual !== expected) throw new Error('source differs from recorded import or deliberate patch');
  } catch (error) { console.error(`${name}: ${error.message}`); failed++; }
}
if (failed) process.exitCode = 1;
else console.log(`Verified ${Object.keys(manifest).length} pinned source files and ${Object.keys(patches).length} deliberate Perpeto patches/additions.`);
