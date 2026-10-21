#!/usr/bin/env node
import { main } from '../src/cli.js';
import { supportedNode } from '../src/doctor.js';

if (!supportedNode(process.version)) {
  console.error('Perpeto requires Node >=24.13.1 <25. Select Node 24 with your version manager.');
  process.exitCode = 1;
} else {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) {
    // Do not echo adapter/HTTP/parser errors: those can contain credentials.
    const safe = error instanceof Error && !['SyntaxError', 'TypeError'].includes(error.name)
      && !error.code && !/https?:\/\//.test(error.message);
    console.error(safe ? error.message : 'Command failed. Check configuration, file permissions, and hub availability.');
    process.exitCode = 1;
  }
}
