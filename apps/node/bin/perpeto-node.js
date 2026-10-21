#!/usr/bin/env node
import { createNode } from '../src/index.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--config') {
  console.error('Usage: perpeto-node --config <node.json>');
  process.exitCode = 1;
} else {
  let node;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Stop startup retries even if enrollment has not completed.
    node?.stop({ drain: true }).catch(() => { process.exitCode = 1; });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (process.platform !== 'win32') process.on('SIGUSR2', () => {
    if (!node || stopping) return;
    node.rotateToken().catch(() => console.error('Node token rotation failed. The saved credential or pending replay intent is retained.'));
  });
  try {
    node = await createNode({ configPath: args[1], onStatus(status) {
      if (status.state === 'error') {
        if (node?.error?.message.startsWith('Machine revoked;')) console.error('Machine revoked; re-enroll with a new enrollment code.');
        process.exitCode = 1; stop();
      }
    } });
    if (!stopping) await node.start();
  } catch {
    // Never echo errors from adapters or remote responses, which may contain credentials.
    console.error(node?.error?.message.startsWith('Machine revoked;')
      ? 'Machine revoked; re-enroll with a new enrollment code.'
      : 'Node failed to start or lost hub authorization. Check configuration, owner-only credential files, and hub availability.');
    process.exitCode = node?.error ? 1 : stopping ? 0 : 1;
  }
}
