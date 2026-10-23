import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthCollector, parsePower, parsePressure, parseThermal, repoKey } from '../src/health.js';

const system = { availableParallelism: () => 10, cpus: () => [], loadavg: () => [130.123, 120, 90], totalmem: () => 32 * 1024 ** 3, freemem: () => 2 * 1024 ** 3, uptime: () => 3600.4 };
const filesystem = { statfs: async () => ({ blocks: 1000, bsize: 4096, bavail: 250 }), readFile: async () => { throw new Error('none'); }, readdir: async () => [] };

test('macOS probe output parses into power, thermal state and memory pressure', () => {
  assert.equal(parsePower("Now drawing from 'AC Power'\n"), undefined, 'a desktop Mac has no battery to report');
  assert.deepEqual(parsePower("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true"), { source: 'ac', percent: 100, charging: false });
  assert.deepEqual(parsePower("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t42%; discharging; 3:10 remaining present: true"), { source: 'battery', percent: 42, charging: false });
  assert.deepEqual(parsePower("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; charging; 0:40 remaining"), { source: 'ac', percent: 80, charging: true });
  assert.equal(parseThermal('Note: No thermal warning level has been recorded'), 'nominal');
  assert.equal(parseThermal('CPU_Speed_Limit \t= 70'), 'fair');
  assert.equal(parseThermal('Thermal warning level set to 1.'), 'serious');
  assert.equal(parsePressure('1\n'), 'normal'); assert.equal(parsePressure('2'), 'warn'); assert.equal(parsePressure('4'), 'critical'); assert.equal(parsePressure('x'), undefined);
  assert.equal(repoKey('https://example.com/a.git'), repoKey('https://example.com/a.git')); assert.equal(repoKey('x').length, 32);
});

test('the collector reports cheap metrics every time and caches the spawned probes', async () => {
  const calls = []; let now = 0;
  const run = async (file, args) => { calls.push(file); return { ps: '1\n2\n3\n', sysctl: '4', pmset: args[1] === 'batt' ? "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t42%; discharging;" : 'No thermal warning' }[file]; };
  const collector = createHealthCollector({ dataDir: '/data', platform: 'darwin', system, run, filesystem, clock: () => now, slowProbeMs: 30000,
    runtimeUrl: 'http://127.0.0.1:1', fetchImpl: async () => { throw new Error('refused'); }, storageState: async () => 'low', nodeVersion: 'v24.13.1' });
  const first = await collector.collect();
  assert.deepEqual(first, { cpus: 10, load: [130.12, 120, 90], memory: { totalBytes: 32 * 1024 ** 3, freeBytes: 2 * 1024 ** 3, pressure: 'critical' }, uptimeSec: 3600,
    nodeVersion: 'v24.13.1', processes: 3, power: { source: 'battery', percent: 42, charging: false }, thermal: 'nominal',
    disk: { totalBytes: 4096000, freeBytes: 1024000 }, runtime: { reachable: false }, storage: { state: 'low' } });
  const spawned = calls.length;
  now = 10000; await collector.collect(); assert.equal(calls.length, spawned, 'cached inside slowProbeMs');
  now = 40000; await collector.collect(); assert.equal(calls.length, spawned * 2);
});

test('failed or hanging probes leave their fields out instead of failing', async () => {
  const collector = createHealthCollector({ dataDir: '/data', platform: 'darwin', system, probeTimeoutMs: 20,
    run: () => new Promise(() => {}), filesystem: { ...filesystem, statfs: async () => { throw new Error('gone'); } } });
  const sample = await collector.collect();
  assert.deepEqual(Object.keys(sample).sort(), ['cpus', 'load', 'memory', 'nodeVersion', 'uptimeSec']);
  const windows = await createHealthCollector({ dataDir: '/data', platform: 'win32', system, run: async () => null, filesystem }).collect();
  assert.equal(windows.load, undefined, 'Windows has no load average');
});
