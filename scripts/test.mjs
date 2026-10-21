import { readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Node workspaces with tests run by this script. The web app uses Vitest (`npm test -w @perpeto/web`).
const workspaces = ['apps/hub', 'apps/node', 'apps/cli', 'packages', 'tests', 'scripts'];
function testsIn(directory) {
  return readdirSync(directory, {withFileTypes:true}).flatMap(entry => {
    if (entry.name === 'node_modules') return [];
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? testsIn(path) : /\.test\.(?:m?js|ts)$/.test(entry.name) ? [path] : [];
  });
}
const files = workspaces.flatMap(directory => testsIn(resolve(root, directory))).sort();
if (!files.length) throw new Error('No Perpeto tests found.');
const result = spawnSync(process.execPath, ['--test', ...files], {cwd:root, stdio:'inherit'});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
