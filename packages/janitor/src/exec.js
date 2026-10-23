import { execFile } from 'node:child_process';

/**
 * Run a command without a shell. Resolves `{ code, stdout }` and never rejects, so a missing tool (no Xcode on Linux,
 * no lsof) reads as an empty answer. Output is bounded.
 * @param {string} command @param {string[]} args @param {{cwd?: string, timeoutMs?: number, env?: object}} [options]
 */
export function defaultExec(command, args, { cwd, timeoutMs = 10_000, env } = {}) {
  return new Promise(resolve => {
    execFile(command, args, { cwd, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...env } },
    (error, stdout) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout ?? '' }));
  });
}
