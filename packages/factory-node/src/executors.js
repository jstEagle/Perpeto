import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { sleep } from './hub.js';

/** @typedef {{ signal: AbortSignal, report: (event: {type: string, data: object}) => Promise<void>, workspace: string, runtimeUrl?: string, accountProvider?: AccountProvider }} ExecContext */
/** @typedef {{ kind: string, canRun: (assignment: object, machine: object) => boolean, run: (assignment: object, ctx: ExecContext) => Promise<object> }} Executor */
/** @typedef {{ list: () => Promise<object[]>, acquire?: (request: object) => Promise<object>, release?: (account: object, result?: object) => Promise<void>, close?: () => Promise<void> }} AccountProvider */

export class ExecutorRegistry {
  #executors = [];
  register(executor) {
    if (!executor?.kind || typeof executor.canRun !== 'function' || typeof executor.run !== 'function') throw new Error('Invalid executor.');
    if (this.#executors.some(item => item.kind === executor.kind)) throw new Error('Duplicate executor kind.');
    this.#executors.push(executor);
    return this;
  }
  find(assignment, machine) { return this.#executors.find(executor => executor.canRun(assignment, machine)); }
}

export function createFakeExecutor(options = {}) {
  return {
    kind: 'fake',
    canRun: assignment => assignment.harness?.provider === 'fake',
    async run(assignment, ctx) {
      const behavior = { delayMs: 0, outcome: 'success', summary: 'Fake executor completed.', ...options };
      await sleep(behavior.delayMs, ctx.signal);
      if (behavior.usage) await ctx.report({ type: 'usage', data: { provider: 'fake', model: assignment.harness.model, ...behavior.usage } });
      ctx.signal.throwIfAborted();
      return { outcome: behavior.outcome, summary: behavior.summary };
    },
  };
}

// Detection only checks executability; it does not start a harness or prove authentication.
export async function detectProviders({ path = process.env.PATH ?? '', platform = process.platform } = {}) {
  const clis = { codex: 'codex', claudeAgent: 'claude', gemini: 'gemini', opencode: 'opencode',
    amp: 'amp', droid: 'droid', cursor: 'agent', copilot: 'copilot', pi: 'pi' };
  const found = await Promise.all(Object.entries(clis).map(async ([provider, cli]) => {
    for (const dir of path.split(delimiter).filter(Boolean)) {
      for (const suffix of platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']) {
        try { await access(join(dir, `${cli}${suffix}`), constants.X_OK); return provider; } catch { /* Keep searching PATH. */ }
      }
    }
  }));
  return found.filter(Boolean);
}

async function optionalPackage(name) {
  try { return await import(name); }
  catch (error) {
    // Ignore only a missing requested package, never a broken installed package/dependency.
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes(`'${name}'`)) return null;
    throw new Error(`Unable to load integration package ${name}.`);
  }
}

export async function loadIntegrations(config, { runtimeUrl, accountProvider, registry } = {}) {
  if (!accountProvider) {
    const name = config.accountProviderPackage ?? '@perpeto/factory-accounts';
    const mod = await optionalPackage(name);
    if (!mod && config.accountProviderPackage) throw new Error('Configured account provider package is unavailable.');
    if (mod) {
      if (typeof mod.createAccountProvider !== 'function') throw new Error('Account package must export createAccountProvider.');
      accountProvider = await mod.createAccountProvider({ config: config.accounts ?? {}, configRoot: config.configRoot });
    }
  }
  accountProvider ??= { async list() { return []; } };
  if (typeof accountProvider.list !== 'function') throw new Error('Account provider must expose list().');
  registry ??= new ExecutorRegistry().register(createFakeExecutor(config.fake));
  for (const name of config.executorPackages ?? ['@perpeto/factory-t3']) {
    const mod = await optionalPackage(name);
    if (!mod) {
      if (config.executorPackages) throw new Error('Configured executor package is unavailable.');
      continue;
    }
    const create = mod.createT3Executor ?? mod.createExecutor;
    if (typeof create !== 'function') throw new Error('Executor package must export createExecutor or createT3Executor.');
    registry.register(await create({ config: config.runtime ?? {}, runtimeUrl, accountProvider }));
  }
  return { registry, accountProvider };
}
