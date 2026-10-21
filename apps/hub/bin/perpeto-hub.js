#!/usr/bin/env node
import { resolve } from 'node:path';
import { createHub } from '../src/index.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--config') {
  console.error('Usage: perpeto-hub --config <hub.json>'); process.exitCode = 1;
} else {
  try {
    const hub = await createHub({ configPath: resolve(args[1]) });
    const url = await hub.listen();
    console.log(`Perpeto hub listening at ${url}`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await hub.close(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch { console.error('Hub startup failed. Check configuration, file permissions, and workflow integration.'); process.exitCode = 1; }
}
