import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, statfs } from 'node:fs/promises';
import * as os from 'node:os';

/** The key a repository is known by in workspace reports; the hub computes the same (apps/hub/src/placement.js). */
export const repoKey = url => createHash('sha256').update(String(url)).digest('hex').slice(0, 32);

/** Run a probe command with a hard timeout; resolves to stdout or null. Never throws. */
function command(file, args, timeoutMs) {
  return new Promise(resolve => {
    try {
      execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' } },
        (error, stdout) => resolve(error ? null : String(stdout)));
    } catch { resolve(null); }
  });
}

/** `pmset -g batt`: "Now drawing from 'Battery Power'" and " -InternalBattery-0 (id=…)	42%; discharging; …". */
export function parsePower(text) {
  if (!text) return undefined;
  const source = /drawing from '([^']+)'/.exec(text)?.[1];
  if (!source) return undefined;
  const battery = /(\d{1,3})%;\s*([a-z ]+);/i.exec(text);
  if (!battery && /AC Power/i.test(source)) return undefined; // A desktop Mac: no battery to report.
  return { source: /Battery/i.test(source) ? 'battery' : 'ac', ...(battery ? { percent: Number(battery[1]), charging: battery[2].trim().toLowerCase() === 'charging' } : {}) };
}

/** `pmset -g therm`: a recorded thermal warning or a CPU speed limit below 100 means the Mac is throttling. */
export function parseThermal(text) {
  if (!text) return undefined;
  const limit = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(text);
  const warning = /thermal warning level (?:set to|is)\s*(\d+)/i.exec(text);
  if (warning && Number(warning[1]) > 0) return Number(warning[1]) >= 2 ? 'critical' : 'serious';
  if (limit && Number(limit[1]) < 100) return Number(limit[1]) < 50 ? 'serious' : 'fair';
  return 'nominal';
}

/** macOS `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export function parsePressure(text) {
  const level = Number(String(text ?? '').trim());
  return level === 4 ? 'critical' : level === 2 ? 'warn' : level === 1 ? 'normal' : undefined;
}

/** Linux PSI `/proc/pressure/memory`: "some avg10=…". Above 10 % stalled is warn, above 40 % critical. */
function linuxPressure(text) {
  const some = /some avg10=([\d.]+)/.exec(text ?? '');
  if (!some) return undefined;
  const value = Number(some[1]);
  return value > 40 ? 'critical' : value > 10 ? 'warn' : 'normal';
}

/**
 * Cheap machine telemetry for heartbeats. Load, CPUs, memory and uptime come from `os` on every call; probes that
 * spawn a process or touch the disk (process count, power, thermal state, memory pressure, disk space, T3 runtime)
 * run concurrently, each bounded by `probeTimeoutMs`, and are cached for `slowProbeMs`. Everything is injectable for
 * tests; a failed probe leaves its field out and never fails the heartbeat.
 */
export function createHealthCollector({ dataDir, runtimeUrl, platform = process.platform, system = os, run = command, filesystem = { statfs, readFile, readdir },
  fetchImpl = fetch, clock = Date.now, slowProbeMs = 30000, probeTimeoutMs = 2000, storageState, nodeVersion = process.version } = {}) {
  let slow = {}; let slowAt = -Infinity; let pending;
  async function probeSlow() {
    const probes = {
      processes: async () => {
        if (platform === 'linux') {
          const total = /\d+\/(\d+)/.exec(await filesystem.readFile('/proc/loadavg', 'utf8'))?.[1];
          return total ? Number(total) : undefined;
        }
        if (platform === 'win32') return undefined;
        const text = await run('ps', ['-A', '-o', 'pid='], probeTimeoutMs);
        return text ? text.split('\n').filter(line => line.trim()).length : undefined;
      },
      pressure: async () => platform === 'darwin' ? parsePressure(await run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], probeTimeoutMs))
        : platform === 'linux' ? linuxPressure(await filesystem.readFile('/proc/pressure/memory', 'utf8')) : undefined,
      power: async () => {
        if (platform === 'darwin') return parsePower(await run('pmset', ['-g', 'batt'], probeTimeoutMs));
        if (platform !== 'linux') return undefined;
        const supplies = await filesystem.readdir('/sys/class/power_supply');
        const battery = supplies.find(name => /^BAT/.test(name));
        if (!battery) return undefined;
        const read = async (name, file) => (await filesystem.readFile(`/sys/class/power_supply/${name}/${file}`, 'utf8').catch(() => '')).trim();
        const status = await read(battery, 'status'); const capacity = Number(await read(battery, 'capacity'));
        return { source: status === 'Discharging' ? 'battery' : 'ac', ...(Number.isFinite(capacity) ? { percent: capacity } : {}), charging: status === 'Charging' };
      },
      thermal: async () => platform === 'darwin' ? parseThermal(await run('pmset', ['-g', 'therm'], probeTimeoutMs)) : undefined,
      disk: async () => {
        const stat = await filesystem.statfs(dataDir);
        return { totalBytes: Number(stat.blocks) * Number(stat.bsize), freeBytes: Number(stat.bavail) * Number(stat.bsize) };
      },
      runtime: async () => {
        if (!runtimeUrl) return undefined;
        try {
          const response = await fetchImpl(runtimeUrl, { redirect: 'manual', signal: AbortSignal.timeout(probeTimeoutMs) });
          await response.body?.cancel?.();
          return { reachable: true };
        } catch { return { reachable: false }; }
      },
      storage: async () => {
        const state = await storageState?.();
        return ['ok', 'low', 'critical'].includes(state) ? { state } : undefined;
      },
    };
    const entries = await Promise.all(Object.entries(probes).map(async ([key, probe]) => {
      try {
        let timer;
        const value = await Promise.race([probe(), new Promise(resolve => { timer = setTimeout(resolve, probeTimeoutMs + 500); })]);
        clearTimeout(timer);
        return [key, value];
      } catch { return [key, undefined]; }
    }));
    return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
  }
  return {
    /** One telemetry sample in the shape of the hub's MachineHealth (without reportedAt, which the hub stamps). */
    async collect() {
      if (clock() - slowAt >= slowProbeMs) {
        pending ??= probeSlow().then(value => { slow = value; slowAt = clock(); }).finally(() => { pending = undefined; });
        await pending;
      }
      const cpus = system.availableParallelism?.() ?? system.cpus().length;
      const { pressure, ...rest } = slow;
      return {
        // Windows reports no load average (always zeros), so it sends none rather than a misleading idle machine.
        cpus, ...(platform === 'win32' ? {} : { load: system.loadavg().map(value => Math.round(value * 100) / 100) }),
        memory: { totalBytes: system.totalmem(), freeBytes: system.freemem(), ...(pressure ? { pressure } : {}) },
        uptimeSec: Math.round(system.uptime()), nodeVersion, ...rest,
      };
    },
  };
}
