import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'config/upstream-files.json'), 'utf8'));
let failed = 0;
for (const [name, expected] of Object.entries(manifest)) {
  try {
    const actual = createHash('sha256').update(readFileSync(resolve(root, 'vendor/t3code', name))).digest('hex');
    if (actual !== expected) throw new Error('source differs from recorded import');
  } catch (error) { console.error(`${name}: ${error.message}`); failed++; }
}
if (failed) process.exitCode = 1;
else console.log(`Verified ${Object.keys(manifest).length} pinned upstream source files.`);
