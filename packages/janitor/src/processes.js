/**
 * Advisory process findings: long-running dev servers (vite, esbuild, next, webpack) whose working directory is gone or
 * which have run longer than the policy allows, and booted simulators. The janitor reports them and never signals them.
 */

const DEV_SERVER = /(?:^|[\s/])(vite|esbuild|next|webpack(?:-dev-server)?)(?:\.js|\.mjs|\.cjs)?(?:\s|$)|node_modules\/(?:\.bin\/)?(vite|esbuild|next|webpack)(?:[/\s]|$)/;

/** `[[dd-]hh:]mm:ss` from ps to seconds. */
export function parseElapsed(value) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (!match) return null;
  const [, days = 0, hours = 0, minutes, seconds] = match;
  return Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/** Dev-server rows from `ps -axo pid=,etime=,args=`. */
export function parsePs(stdout) {
  const rows = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const name = DEV_SERVER.exec(match[3]);
    const elapsedSec = parseElapsed(match[2]);
    if (!name || elapsedSec === null) continue;
    rows.push({ pid: Number(match[1]), elapsedSec, name: name[1] ?? name[2], command: match[3] });
  }
  return rows;
}

/** pid → cwd from `lsof -a -d cwd -Fpn -p …`. */
export function parseLsof(stdout) {
  const result = new Map();
  let pid = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== null) result.set(pid, line.slice(1));
  }
  return result;
}

/**
 * @param {{exec: Function, fs: object, platform: string, staleProcessHours: number, timeoutMs: number, display: (path:string)=>string}} options
 * @returns {Promise<{findings: object[], cwds: string[]}>} `cwds` are the real working directories of every dev server, stale or
 * not, so the caller never deletes a folder a process still runs in.
 */
export async function findStaleProcesses({ exec, fs, platform, staleProcessHours, timeoutMs, display, self = process.pid }) {
  const findings = [];
  const live = [];
  if (platform === 'win32') return { findings, cwds: live };
  const ps = await exec('ps', ['-axo', 'pid=,etime=,args='], { timeoutMs });
  const servers = ps.code === 0 ? parsePs(ps.stdout).filter(row => row.pid !== self).slice(0, 200) : [];
  let cwds = new Map();
  if (servers.length && platform === 'darwin') {
    const lsof = await exec('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', servers.map(row => row.pid).join(',')], { timeoutMs });
    cwds = parseLsof(lsof.stdout);
  } else if (servers.length) {
    for (const row of servers) {
      try { cwds.set(row.pid, await fs.readlink(`/proc/${row.pid}/cwd`)); } catch { /* Exited or not ours to read. */ }
    }
  }
  for (const row of servers) {
    let cwd = cwds.get(row.pid);
    let gone = false;
    if (cwd?.endsWith(' (deleted)')) { cwd = cwd.slice(0, -' (deleted)'.length); gone = true; }
    if (cwd && !gone) { try { await fs.lstat(cwd); } catch (error) { gone = error?.code === 'ENOENT'; } }
    const old = row.elapsedSec >= staleProcessHours * 3600;
    if (cwd && !gone) live.push(cwd);
    if (!gone && !old) continue;
    findings.push({ pid: row.pid, name: row.name, kind: 'dev-server', elapsedSec: row.elapsedSec,
      ...(cwd ? { cwd: display(cwd) } : {}), cwdMissing: gone,
      reason: gone ? `Its working directory no longer exists; it is likely orphaned.` : `Running for ${Math.round(row.elapsedSec / 3600)} h.`,
      hint: `kill ${row.pid}` });
  }
  if (platform === 'darwin') {
    const sim = await exec('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { timeoutMs });
    if (sim.code === 0) {
      try {
        const devices = Object.values(JSON.parse(sim.stdout).devices ?? {}).flat();
        for (const device of devices.slice(0, 50)) {
          if (device?.state !== 'Booted' || typeof device.udid !== 'string') continue;
          findings.push({ kind: 'simulator', name: String(device.name ?? 'Simulator').slice(0, 120), udid: device.udid,
            reason: 'Booted simulator; each holds memory and disk while running.', hint: `xcrun simctl shutdown ${device.udid}` });
        }
      } catch { /* Not JSON: no simulator finding. */ }
    }
  }
  return { findings, cwds: live };
}
