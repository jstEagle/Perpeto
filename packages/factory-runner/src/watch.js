import configuration from '../config/limits.json' with { type: 'json' };

/** One job at a time, bounded idle/error cadence, interruptible even during sleep. */
export async function watchRunner(config, runOnce, { signal, onOutcome = () => {}, onError = () => {} } = {}) {
  const pollIntervalMs = config.pollIntervalMs ?? configuration.worker.pollIntervalMs;
  const retryIntervalMs = config.retryIntervalMs ?? configuration.worker.retryIntervalMs;
  for (const [name, interval] of Object.entries({ pollIntervalMs, retryIntervalMs })) {
    const [minimum, maximum] = configuration.worker.validationRanges[name];
    if (!Number.isSafeInteger(interval) || interval < minimum || interval > maximum) throw new Error('Invalid watch interval configuration.');
  }
  while (!signal?.aborted) {
    try {
      const result = await runOnce(config, signal);
      if (signal?.aborted) break;
      if (result.claimed) onOutcome(result);
      else await wait(pollIntervalMs, signal);
    } catch {
      if (signal?.aborted) break;
      onError(new Error('Runner cycle failed. Check connection, credentials and job status; retrying after configured backoff.'));
      await wait(retryIntervalMs, signal);
    }
  }
  return { stopped: true };
}

function wait(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
