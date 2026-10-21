import { spawn } from 'node:child_process';

/** Run a child with bounded output delivery and cancellation of its process group. */
export function runProcess(command, args, { cwd, signal, timeoutMs, onOutput = async () => {}, env = process.env } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    let outputError;
    let spawnError;
    let killTimer;
    let pipeTimer;
    let closingPipes = false;
    let stopping = false;
    const kill = sig => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, sig);
        else if (sig === 'SIGKILL') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
        else child.kill(sig);
      } catch { /* The child may already have exited. */ }
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 300);
    };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, timeoutMs) : undefined;
    const streams = [child.stdout, child.stderr].map((stream, index) => (async () => {
      try {
        for await (const chunk of stream) await onOutput(index ? 'stderr' : 'stdout', chunk);
      } catch (error) {
        if (!(closingPipes && error.code === 'ERR_STREAM_PREMATURE_CLOSE')) outputError = error;
        stop();
      }
    })());
    child.once('error', () => { spawnError = new Error('Unable to start child process.'); });
    child.once('exit', () => {
      // The shell's lifetime ends here, even if a background descendant still owns a pipe.
      clearTimeout(timer);
      stop();
      pipeTimer = setTimeout(() => {
        closingPipes = true;
        kill('SIGKILL');
        child.stdout.destroy(); child.stderr.destroy();
      }, 350);
    });
    child.once('close', async (code, exitSignal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(pipeTimer);
      // Reap any background processes left in this job's process group.
      kill('SIGKILL');
      signal?.removeEventListener('abort', stop);
      await Promise.all(streams);
      if (outputError) return reject(outputError);
      if (spawnError) return reject(spawnError);
      resolve({ code, signal: exitSignal, timedOut, cancelled: signal?.aborted === true });
    });
  });
}
