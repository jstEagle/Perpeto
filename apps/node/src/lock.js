import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// Compare start identity as well as PID: service managers can recycle a crashed daemon's PID.
export async function processIdentity(pid) {
  const command = process.platform === 'win32' ? 'powershell.exe' : '/bin/ps';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`]
    : ['-p', String(pid), '-o', 'lstart='];
  const { stdout } = await exec(command, args, { env: { ...process.env, LC_ALL: 'C' }, timeout: 5000 });
  if (!stdout.trim()) throw new Error('Cannot determine daemon process identity.');
  return stdout.trim();
}
