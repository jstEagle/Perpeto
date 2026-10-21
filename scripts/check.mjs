import { spawnSync } from 'node:child_process';
import { projectRoot } from './runtime.mjs';

const checks = [
  ['npm', ['test']],
  ['npm', ['run', 'verify:upstream']],
  ['npm', ['run', 'typecheck', '-w', '@perpeto/web']],
  ['npm', ['test', '-w', '@perpeto/web']],
  ['npm', ['run', 'build:web']],
  ['npm', ['run', 'typecheck:upstream']],
  ['npm', ['run', 'test:upstream']],
  ['npm', ['run', 'build']],
  ['npm', ['run', 'smoke:messaging']],
  ...(process.platform === 'darwin' ? [
    ['swift', ['build', '--package-path', 'apps/apple']],
    ['swift', ['test', '--package-path', 'apps/apple']],
  ] : []),
];

for (const [command, args] of checks) {
  console.log(`\nChecking: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (process.platform !== 'darwin') console.log('Apple checks skipped: macOS and Xcode are required.');
