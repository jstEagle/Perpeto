import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfiguration, runtimeArguments, projectRoot } from './runtime.mjs';

test('launch uses a distinct data directory and explicit file-configured settings', () => {
  const config = readConfiguration();
  assert.equal(config.dataDirectory, join(projectRoot, '.perpeto/runtime'));
  assert.deepEqual(runtimeArguments(config), ['serve', '--base-dir', config.dataDirectory,
    '--host', '127.0.0.1', '--port', '4310', '--auto-bootstrap-project-from-cwd=false', '--no-browser']);
  const interactive = runtimeArguments({...config, openBrowser:true});
  assert.equal(interactive[0], 'start');
  assert.equal(interactive.includes('--no-browser'), false);
});

test('malformed launch configuration fails before spawning a runtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perpeto-config-'));
  try {
    const path = join(dir, 'config.json');
    const valid = {directory:'vendor/t3code',dataDirectory:'.perpeto/runtime',host:'127.0.0.1',port:4310,openBrowser:false};
    for (const change of [{port:0}, {port:65536}, {port:'4310'}, {dataDirectory:''}, {openBrowser:'false'}, {directory:null}]) {
      writeFileSync(path, JSON.stringify({ runtime: {...valid,...change} }));
      assert.throws(() => readConfiguration(path), /Invalid runtime/);
    }
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
