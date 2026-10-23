import * as nodeFs from 'node:fs/promises';
import { homedir } from 'node:os';
import { defaultExec } from './exec.js';
import { createGit } from './git.js';
import { createSizer } from './size.js';
import { scanStorage, summarize, reclaimableBytes } from './inventory.js';
import { planCleanup, executeCleanup, createJournal } from './execute.js';

export { POLICY_DEFAULTS, POLICY_KEYS, PolicyError, validatePolicy, mergePolicy, diskState, retention, DEFAULT_ARTIFACT_NAMES } from './policy.js';
export { KINDS, scanStorage, summarize, reclaimableBytes, parseWorkspaceName, workspaceName } from './inventory.js';
export { planCleanup, executeCleanup, createJournal } from './execute.js';
export { displayPath, expandHome, isInside, itemId } from './paths.js';
export { createSizer, createBudget } from './size.js';
export { createGit } from './git.js';
export { findStaleProcesses, parsePs, parseLsof, parseElapsed } from './processes.js';
export { defaultExec } from './exec.js';

/**
 * A janitor bound to one machine's filesystem and process table. `fs` and `exec` are injectable so tests run against
 * temporary folders and fake commands. The sizing cache lives as long as the janitor.
 */
export function createJanitor({ fs = nodeFs, exec = defaultExec, home = homedir(), platform = process.platform, clock = Date.now, cacheMs } = {}) {
  let sizer;
  const gitFor = policy => createGit({ exec, timeoutMs: policy.commandTimeoutMs, realpath: path => fs.realpath(path) });
  return {
    async scan({ roots, policy, active }) {
      sizer ??= createSizer({ fs, clock, cacheMs: cacheMs ?? policy.sizeCacheMs });
      return scanStorage({ roots, policy, active, home, platform, now: clock(), fs, exec, git: gitFor(policy), sizer, clock });
    },
    plan: planCleanup,
    execute(options) {
      const result = executeCleanup({ ...options, fs, git: gitFor(options.policy), clock });
      return result.then(value => {
        for (const action of value.actions) {
          if (!['deleted', 'stripped'].includes(action.status)) continue;
          const location = options.locations.get(action.itemId);
          for (const path of [location?.path, location?.parentPath]) if (path) sizer?.forget(path);
        }
        return value;
      });
    },
    journal: path => createJournal({ fs, path }),
    summarize, reclaimableBytes,
  };
}
