import { spawn } from 'node:child_process';
import { DeliveryError } from './common.js';

/** Argv only, never a shell. Output stays internal and is not placed in public errors. */
export function commandRunner(command, args, { cwd, env, input, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0;
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    for (const [stream, append] of [[child.stdout, text => { stdout += text; }], [child.stderr, text => { stderr += text; }]]) {
      stream.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) child.kill('SIGKILL'); else append(chunk.toString()); });
    }
    child.on('error', () => { clearTimeout(timer); reject(new DeliveryError('COMMAND_FAILED', 'Command could not be started.')); });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (signal) reject(new DeliveryError('COMMAND_FAILED', 'Command exceeded its time or output limit.'));
      else resolve({ stdout, stderr, exitCode });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function checked(runner, command, args, options) {
  const result = await runner(command, args, options);
  if (result.exitCode !== 0) throw new DeliveryError('COMMAND_FAILED', `${command === 'gh' ? 'GitHub' : 'Git'} command failed.`);
  return result.stdout.trim();
}
