import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { T3Client, T3HttpError } from './client.js';
import { issueSessionToken, readCredentialFile } from './credentials.js';
import { assignmentContext, buildPrompt } from './prompt.js';
import { outputInstructions, outputKind, parseRoleResult } from './results.js';
import { ThreadTracker, TERMINAL_RUN_STATUSES } from './thread-state.js';
import { keepAccountReservation } from './account-lease.js';
import { factoryInstance, gitIdentity, resolveIsolation } from './isolation.js';
import { prepareMessaging, waitingSection, liveText } from './inbox.js';
import { branchName, isDirty, localPullRequestUrl, prepareWorkspace, publishBranch, pullRequestUrl, revisionOf } from './workspace.js';

/** Harness option keys the executor consumes instead of forwarding as model options. */
const RESERVED_OPTIONS = new Set(['runtimeMode', 'interactionMode']);
const RUNTIME_MODES = new Set(['approval-required', 'auto-accept-edits', 'auto', 'full-access']);

const DEFAULTS = Object.freeze({
  runtimeMode: 'full-access',
  interactionMode: 'default',
  onRuntimeRequest: 'interrupt',
  onNativeSubagentViolation: 'interrupt',
  settleMs: 2000,
  pollMs: 1000,
  turnTimeoutMs: 4 * 60 * 60 * 1000,
  interruptGraceMs: 30000,
  maxSummaryChars: 4000,
  branchPrefix: 'perpeto/',
  tokenTtl: '12h',
  requestTimeoutMs: 30000,
  accountReadyTimeoutMs: 60000,
  publishBranch: true,
});

const sleep = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});
const stableId = (prefix, ...parts) => `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)}`;
export const threadRef = threadId => `t3-thread://v1/${threadId}`;

/** Merge node runtime config (`config.runtime` in @perpeto/node) with executor settings in `t3`. */
export function resolveSettings(config = {}, runtimeUrl) {
  const merged = { ...DEFAULTS, ...config, ...(config.t3 ?? {}) };
  let runtime = null;
  if (merged.repoRoot) {
    try { runtime = JSON.parse(readFileSync(resolve(merged.repoRoot, 'config/perpeto.json'), 'utf8')).runtime ?? null; }
    catch { runtime = null; }
  }
  const url = merged.baseUrl ?? merged.url ?? runtimeUrl ?? (runtime ? `http://${runtime.host}:${runtime.port}` : undefined);
  const serverEntry = merged.serverEntry ?? (merged.repoRoot ? resolve(merged.repoRoot, runtime?.directory ?? 'vendor/t3code', 'apps/server/dist/bin.mjs') : undefined);
  const baseDir = merged.baseDir ?? (merged.repoRoot && runtime?.dataDirectory ? resolve(merged.repoRoot, runtime.dataDirectory) : undefined);
  if (!RUNTIME_MODES.has(merged.runtimeMode)) throw new Error('Invalid T3 runtimeMode in executor configuration.');
  if (!['interrupt', 'leave'].includes(merged.onRuntimeRequest)) throw new Error('onRuntimeRequest must be interrupt or leave.');
  if (!['interrupt', 'report'].includes(merged.onNativeSubagentViolation)) throw new Error('onNativeSubagentViolation must be interrupt or report.');
  return { ...merged, url, serverEntry, baseDir };
}

function usageRecord(turn, { provider, model, accountId, thread }) {
  const usage = turn.turnTokenUsage;
  const input = usage.inputTokens ?? 0;
  const cacheRead = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationTokens ?? 0;
  return {
    provider, model, ...(accountId ? { accountId } : {}),
    // T3 counts cache reads and writes inside inputTokens; report them separately.
    inputTokens: Math.max(0, input - cacheRead - cacheWrite),
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: usage.reasoningTokens ?? 0,
    usageStatus: usage.usageStatus,
    hasSubagents: usage.hasSubagents === true,
    threadRef: threadRef(thread),
    providerTurnId: turn.id,
    at: turn.completedAt ?? new Date().toISOString(),
  };
}

function harnessTarget(assignment) {
  const harness = assignment?.harness ?? {};
  const options = Object.entries(harness.options ?? {})
    .filter(([key]) => !RESERVED_OPTIONS.has(key))
    .map(([id, value]) => ({ id, value }));
  return { provider: harness.provider, model: harness.model, options, overrides: harness.options ?? {} };
}

/** Pick a ready, enabled T3 provider instance for the harness's driver kind. */
export function chooseInstance(providers, provider, preferredInstanceId, { exclude = () => false } = {}) {
  const candidates = (providers ?? []).filter(item => item.enabled !== false && (item.driver === provider || item.instanceId === provider) && !exclude(item));
  const ready = candidates.filter(item => item.status === 'ready');
  return ready.find(item => item.instanceId === preferredInstanceId) ?? ready.find(item => item.instanceId === provider) ?? ready[0] ?? null;
}

/**
 * @param {{ config?: object, runtimeUrl?: string, accountProvider?: object,
 *           createClient?: (settings: object) => Promise<T3Client>|T3Client,
 *           claudeKeychain?: { has(home: string): boolean|Promise<boolean>, read(configDir: string|null): Promise<object|null> } }} [options]
 *   `claudeKeychain` replaces macOS keychain access for factory Claude homes; tests use it to stay off real logins.
 */
export function createT3Executor({ config = {}, runtimeUrl, accountProvider, createClient, claudeKeychain } = {}) {
  const settings = resolveSettings(config, runtimeUrl);
  const isolation = { ...resolveIsolation(settings), ...(claudeKeychain ? { claudeKeychain } : {}) };
  /** Factory instances this executor registered, by id, with the mutation it sent. */
  const registered = new Map();
  let clientPromise = null;

  async function makeClient() {
    if (createClient) return createClient(settings);
    if (!settings.url) throw new Error('T3 runtime URL is not configured.');
    const token = settings.credentialFile
      ? await readCredentialFile(settings.credentialFile)
      : settings.serverEntry && settings.baseDir
        ? await issueSessionToken({ serverEntry: settings.serverEntry, baseDir: settings.baseDir, ttl: settings.tokenTtl })
        : null;
    if (!token) throw new Error('Configure credentialFile, or repoRoot/serverEntry and baseDir, so the executor can authenticate to T3.');
    return new T3Client({ baseUrl: settings.url, token, timeoutMs: settings.requestTimeoutMs });
  }
  async function client({ fresh = false } = {}) {
    if (fresh && clientPromise) { (await clientPromise.catch(() => null))?.close(); clientPromise = null; }
    clientPromise ??= Promise.resolve(makeClient()).catch(error => { clientPromise = null; throw error; });
    return clientPromise;
  }

  /** Register a provider instance with T3 (unless this executor already sent the same one) and wait until it is ready. */
  async function ensureInstance(t3, mutation, { signal, force = false, label }) {
    const key = JSON.stringify(mutation);
    if (force || registered.get(mutation.instanceId) !== key) {
      await t3.upsertProviderInstance(mutation, { signal });
      registered.set(mutation.instanceId, key);
    }
    const deadline = Date.now() + settings.accountReadyTimeoutMs;
    let refreshed = false;
    while (Date.now() < deadline) {
      const providers = (await t3.getConfig({ signal }))?.providers ?? [];
      const found = providers.find(item => item.instanceId === mutation.instanceId);
      if (found && found.enabled !== false && found.status === 'ready') return { ok: true, instance: found };
      if (found?.auth?.status === 'unauthenticated') {
        return { ok: false, authFailure: true, summary: `${label} is not signed in to ${found.driver ?? 'its provider'} on this machine.` };
      }
      if (!refreshed) { refreshed = true; await t3.refreshProvider(mutation.instanceId, { signal }).catch(() => {}); }
      await sleep(settings.pollMs, signal);
      signal.throwIfAborted();
    }
    registered.delete(mutation.instanceId);
    return { ok: false, summary: `${label}'s T3 provider instance did not become ready.` };
  }

  /** Register the account's provider instance with T3, isolated for factory work, and wait until it is ready. */
  async function registerAccountInstance(t3, accounts, selection, { signal, identity }) {
    const accountId = selection.account?.id ?? selection.binding.accountId;
    let binding = selection.binding;
    if (typeof accounts.bindingFor === 'function') {
      try { binding = await accounts.bindingFor(accountId, { reservationId: selection.reservation?.id }); }
      catch (error) { return { ok: false, summary: `Account ${accountId} is not eligible (${error?.code ?? 'unavailable'}).` }; }
    }
    let mutation = binding.mutation;
    if (isolation.mode === 'factory') {
      ({ mutation } = await factoryInstance({ instanceId: binding.mutation.instanceId, ...binding.mutation.instance }, isolation, { pooled: true, identity }));
    }
    return ensureInstance(t3, mutation, { signal, force: true, label: `Account ${accountId}` });
  }

  /** The factory instance derived from a ready operator instance: project settings only, factory Git identity. */
  async function registerFactoryInstance(t3, base, { signal, identity, report }) {
    const settingsSnapshot = await t3.getSettings({ signal }).catch(() => null);
    const configured = settingsSnapshot?.providerInstances?.[base.instanceId] ?? {};
    let derived;
    try {
      derived = await factoryInstance({ instanceId: base.instanceId, driver: base.driver, displayName: configured.displayName ?? base.displayName,
        config: configured.config, environment: configured.environment }, isolation, { identity });
    } catch (error) {
      if (['ISOLATION_AUTH_DIVERGED', 'ISOLATION_LOGIN_MISSING', 'ISOLATION_HOME_UNSAFE'].includes(error?.code)) return { ok: false, summary: error.message };
      throw error;
    }
    const ready = await ensureInstance(t3, derived.mutation, { signal, label: `Factory instance ${derived.instanceId}` });
    if (ready.ok) {
      await report({ type: 'progress', data: { interaction: 'isolation.bound', providerInstanceId: derived.instanceId, baseInstanceId: base.instanceId,
        gitIdentity: identity, ...(derived.dropped.length ? { droppedEnvironment: derived.dropped } : {}),
        ...(derived.claudeLogin ? { claudeLogin: derived.claudeLogin } : {}) } });
    }
    return ready;
  }

  return {
    kind: 't3',
    canRun(assignment, machine) {
      const provider = assignment?.harness?.provider;
      if (typeof provider !== 'string' || !provider || provider === 'fake' || typeof assignment?.harness?.model !== 'string') return false;
      return !Array.isArray(machine?.providers) || machine.providers.includes(provider);
    },
    /** Driver kinds T3 reports enabled and ready, so the node can advertise harnesses its PATH does not show. */
    async providers({ signal } = {}) {
      const providers = (await (await client()).getConfig({ signal }))?.providers ?? [];
      return [...new Set(providers.filter(item => item.enabled !== false && item.status === 'ready' && typeof item.driver === 'string').map(item => item.driver))];
    },
    async run(assignment, ctx) {
      try { return await runAssignment(await client(), assignment, ctx); }
      catch (error) {
        // A session minted earlier may have expired or been revoked: retry once with a new one.
        if (error instanceof T3HttpError && error.status === 401 && !ctx.signal?.aborted) {
          return runAssignment(await client({ fresh: true }), assignment, ctx);
        }
        throw error;
      }
    },
    async close() { (await clientPromise?.catch(() => null))?.close(); clientPromise = null; },
  };

  async function runAssignment(t3, assignment, ctx) {
    const callerSignal = ctx.signal ?? new AbortController().signal;
    callerSignal.throwIfAborted();
    const report = event => Promise.resolve(ctx.report?.(event)).catch(() => {});
    const target = harnessTarget(assignment);
    const policy = assignment.policy ?? { maxSubagents: 0, allowedSubagentProviders: [] };
    const attempt = Number.isSafeInteger(assignment.attempt) ? assignment.attempt : 0;

    const kind = outputKind(assignment);
    // Account selection is executor-owned: reserve, register the account's T3
    // instance, run on it, report limits and auth failures, release in finally.
    const accounts = ctx.accountProvider ?? accountProvider;
    const attemptKey = { assignmentId: assignment.id, attempt: Number.isSafeInteger(assignment.attempt) ? assignment.attempt : 1 };
    let selection = null;
    if (typeof accounts?.acquire === 'function') {
      try { selection = await accounts.acquire({ provider: target.provider, model: target.model, ...attemptKey }) ?? null; }
      catch (error) {
        callerSignal.throwIfAborted();
        if (error?.code === 'ACCOUNT_POOL_EXHAUSTED') {
          return { outcome: 'failure', summary: `ACCOUNT_POOL_EXHAUSTED: no eligible pooled ${target.provider} account has capacity. Retry with backoff.` };
        }
        throw error;
      }
    }
    const lease = selection ? keepAccountReservation(accounts, selection, attemptKey) : null;
    const signal = lease ? AbortSignal.any([callerSignal, lease.signal]) : callerSignal;
    const reservationId = selection?.reservation?.id;
    const accountId = selection?.account?.id ?? selection?.binding?.accountId ?? null;
    const observe = async (message, key) => {
      if (!accountId || typeof accounts?.observe !== 'function') return;
      await Promise.resolve(accounts.observe({ accountId, reservationId, ...attemptKey, message, idempotencyKey: stableId('observe', assignment.id, String(attemptKey.attempt), key) })).catch(() => {});
    };
    let result;
    let messagingSetup = null;
    try {
      result = await execute();
      callerSignal.throwIfAborted();
      if (lease?.signal.aborted) result = { ...result, outcome: 'failure', summary: lease.signal.reason.message };
      return result;
    } catch (error) {
      callerSignal.throwIfAborted();
      if (!lease?.signal.aborted) throw error;
      result = { outcome: 'failure', summary: lease.signal.reason.message };
      return result;
    } finally {
      await messagingSetup?.remove().catch(() => {});
      lease?.stop();
      if (selection && typeof accounts?.release === 'function') await Promise.resolve(accounts.release(selection, { ...attemptKey, reservationId, result })).catch(() => {});
    }

    async function execute() {
      signal.throwIfAborted();
      if (selection && !selection.binding) return { outcome: 'failure', summary: 'The account pool returned no provider binding. Retry with backoff.' };
      let identity;
      try { identity = gitIdentity(assignment.gitIdentity ?? assignmentContext(assignment).project?.gitIdentity) ?? isolation.identity; }
      catch (error) { return { outcome: 'blocked', summary: `Invalid project ${error.message}` }; }
      let instance;
      if (selection?.binding) {
        const registered = await registerAccountInstance(t3, accounts, selection, { signal, identity });
        if (!registered.ok) {
          if (registered.authFailure) await observe({ failure: { code: 'auth_required', message: 'Not logged in' } }, 'auth');
          return { outcome: 'blocked', summary: registered.summary };
        }
        instance = registered.instance;
        await report({ type: 'progress', data: { interaction: 'account.bound', accountId, provider: target.provider, providerInstanceId: instance.instanceId } });
      } else {
        const serverConfig = await t3.getConfig({ signal });
        // Factory instances are derived from operator instances, never from each other or from pooled accounts.
        instance = chooseInstance(serverConfig?.providers, target.provider, undefined, { exclude: item => /^(?:perpeto|factory)_/.test(item.instanceId) });
        if (!instance) return { outcome: 'blocked', summary: `No ready T3 provider instance for ${target.provider} on this machine.` };
        if (isolation.mode === 'factory') {
          const isolated = await registerFactoryInstance(t3, instance, { signal, identity, report });
          if (!isolated.ok) return { outcome: 'blocked', summary: isolated.summary };
          instance = isolated.instance;
        }
      }

      const { repo, workItem } = assignmentContext(assignment);
      const branch = branchName(assignment.branch ?? workItem?.branch ?? `${settings.branchPrefix}${assignment.workItemId ?? assignment.id}`);
      const workspace = await prepareWorkspace({ repo, workspace: ctx.workspace, branch, signal });
      const project = await t3.ensureProject({
        workspaceRoot: workspace.workspaceRoot,
        title: assignmentContext(assignment).project?.name ?? workspace.workspaceRoot.split('/').at(-1) ?? 'Perpeto work',
        projectId: stableId('perpeto-prj', workspace.workspaceRoot),
        commandId: stableId('perpeto-cmd-prj', workspace.workspaceRoot),
      }, { signal });

      const threadId = stableId('perpeto-thr', assignment.id, String(attempt));
      // Attach the policy before the first turn so no delegation can precede it.
      let policyEnforced = true;
      try {
        await t3.setPolicy(threadId, { t3Tools: 'policy', maxSubagents: policy.maxSubagents ?? 0, allowedSubagentProviders: policy.allowedSubagentProviders ?? [] }, { signal });
      } catch (error) {
        if (error instanceof T3HttpError && (error.status === 404 || error.status === 503)) {
          policyEnforced = false;
          await report({ type: 'progress', data: { interaction: 'policy.unenforced', reason: 'This T3 runtime has no Perpeto agent-policy routes; app-owned subagents are only observed.' } });
        } else throw error;
      }

      if (selection && typeof accounts?.bindingFor === 'function') {
        // Recheck eligibility immediately before launch; a concurrent disable or cooldown wins.
        try { await accounts.bindingFor(accountId, { reservationId }); }
        catch (error) { return { outcome: 'blocked', summary: `Account ${accountId} is no longer eligible (${error?.code ?? 'unavailable'}).` }; }
      }
      const extra = [outputInstructions(kind)];
      if (kind === 'work' && workspace.mode !== 'workspace') {
        extra.push(`Work on branch ${branch} and commit your changes there. ${settings.publishBranch ? 'The factory pushes the branch to origin when you finish; do not push other branches.' : ''}`.trim());
      }
      // Messaging: the agent's run-scoped commands, and messages that waited in its role's inbox for this assignment.
      messagingSetup = await prepareMessaging(assignment, { workspace: ctx.workspace, messaging: ctx.messaging }).catch(() => null);
      if (messagingSetup) extra.push(messagingSetup.prompt);
      const waiting = (Array.isArray(assignment.inbox) ? assignment.inbox : []).filter(item => typeof item?.id === 'string' && typeof item.body === 'string');
      const waitingText = waitingSection(waiting);
      if (waitingText) extra.push(waitingText);
      const delivery = settings.publishBranch && localPullRequestUrl(assignment.repo, branch) ? 'local' : 'forge';
      const runtimeMode = RUNTIME_MODES.has(target.overrides.runtimeMode) ? target.overrides.runtimeMode : settings.runtimeMode;
      const interactionMode = target.overrides.interactionMode === 'plan' ? 'plan' : settings.interactionMode;
      signal.throwIfAborted();
      let launch;
      try {
        launch = await t3.launchThread({
          commandId: stableId('perpeto-cmd-launch', assignment.id, String(attempt)),
          threadId, creationSource: 'server', projectId: project.id,
          title: (workItem?.title ?? assignment.role ?? 'Perpeto assignment').slice(0, 120),
          modelSelection: { instanceId: instance.instanceId, model: target.model, ...(target.options.length ? { options: target.options } : {}) },
          runtimeMode, interactionMode, workspaceStrategy: workspace.workspaceStrategy,
          initialMessage: { messageId: stableId('perpeto-msg', assignment.id, String(attempt)), text: buildPrompt(assignment, { extra, kind, delivery }), attachments: [] },
        }, { signal, timeoutMs: 300000 });
      } catch (error) {
        // Launch can have reached T3 before cancellation rejects its reply.
        if (!signal.aborted) throw error;
        launch = await t3.getThread(threadId).catch(() => null);
        if (!launch) throw error;
      }
      await report({ type: 'progress', data: {
        interaction: 'thread.started', threadRef: threadRef(threadId), threadId, projectId: project.id,
        provider: instance.driver ?? target.provider, providerInstanceId: instance.instanceId, model: target.model,
        resumed: launch?.resumed === true, workspaceMode: workspace.mode, at: new Date().toISOString(),
      } });
      if (waiting.length) await report({ type: 'delivered', data: { messageIds: waiting.map(item => item.id), via: 'prompt', threadRef: threadRef(threadId) } });

      return follow({ t3, assignment, signal, report, policy, policyEnforced, threadId, instance, target, accountId, observe, kind, branch, workspace, launch,
        inbox: ctx.inbox, delivered: new Set(waiting.map(item => item.id)) });
    }
  }

  async function follow({ t3, assignment, signal, report, policy, policyEnforced, threadId, instance, target, accountId, observe, kind, branch, workspace, launch, inbox, delivered }) {
    // Keep observing while cancellation interrupts and drains active runs.
    const observation = new AbortController();
    const trackers = new Map();
    const reportedTurns = new Set();
    const reportedUsage = new Set();
    const reportedDelegations = new Set();
    const reportedRequests = new Set();
    const reportedFailures = new Set();
    const subscriptions = [];
    const interruptedRuns = new Set();
    let decisionsCursor = 0;
    let tokens = 0;
    let stop = null; // { outcome, summary, interrupt }
    let fatal = null;
    let wake = () => {};
    const deadline = Date.now() + settings.turnTimeoutMs;
    const providerName = instance.driver ?? target.provider;

    const requestStop = (outcome, summary) => { if (!stop) { stop = { outcome, summary }; wake(); } };
    let steered = 0;
    let pendingRun = null;

    /**
     * Messages the node relays from lease renewals while this assignment runs. Each batch goes into the root thread
     * once, with T3's `auto` delivery: it steers the active run when the provider supports steering, otherwise queues
     * it as the next turn, or starts a turn when the thread is idle. Failed dispatches stay pending for the next renewal.
     */
    async function deliverInbox() {
      if (!inbox || stop || signal.aborted) return false;
      const fresh = [...new Map(inbox.take().filter(item => typeof item?.id === 'string' && typeof item.body === 'string' && !delivered.has(item.id))
        .map(item => [item.id, item])).values()];
      if (!fresh.length) return false;
      const ids = fresh.map(item => item.id);
      const key = stableId('inbox', threadId, ...ids);
      // Into an idle thread T3 starts a new turn; until it appears the thread is not settled.
      const expectRun = root.isIdle() ? { after: root.runs.size, until: Date.now() + Math.max(10000, settings.settleMs * 5) } : null;
      try {
        await t3.dispatch({ type: 'message.dispatch', commandId: `perpeto-cmd-${key}`, threadId, messageId: `perpeto-msg-${key}`,
          text: liveText(fresh, assignment.role ?? 'this role'), attachments: [], deliveryIntent: 'auto', dispatchMode: { type: 'queue_after_active' } }, { signal });
      } catch { return false; }
      for (const id of ids) delivered.add(id);
      steered++;
      if (expectRun) pendingRun = expectRun;
      await report({ type: 'delivered', data: { messageIds: ids, via: 'steer', threadRef: threadRef(threadId) } });
      return true;
    }
    const unsubscribeInbox = inbox?.subscribe?.(() => wake());

    function watch(childThreadId, meta) {
      if (trackers.has(childThreadId)) return;
      const tracker = new ThreadTracker(childThreadId);
      tracker.meta = meta;
      trackers.set(childThreadId, tracker);
      subscribe(tracker).catch(error => { fatal ??= error; wake(); });
    }

    async function subscribe(tracker) {
      let failures = 0;
      while (!observation.signal.aborted && !tracker.closed) {
        let handle;
        try {
          handle = await t3.subscribeThread({ threadId: tracker.threadId, afterSequence: tracker.lastSequence }, async items => {
            failures = 0;
            const changes = tracker.applyItems(items);
            await handleChanges(tracker, changes);
            wake();
          }, { signal: observation.signal });
          subscriptions.push(handle);
          await handle.done;
          if (tracker.closed || observation.signal.aborted) return;
        } catch (error) {
          if (observation.signal.aborted || tracker.closed) return;
          if (++failures > 5) throw error;
        }
        await sleep(Math.min(250 * 2 ** failures, 5000), observation.signal);
      }
    }

    async function handleChanges(tracker, changes) {
      const isRoot = tracker.threadId === threadId;
      for (const { collection, value } of changes) {
        if (collection === 'runs' && isRoot) await onRun(tracker, value);
        else if (collection === 'providerTurns') await onProviderTurn(tracker, value);
        else if (collection === 'subagents') await onSubagent(tracker, value);
        else if (collection === 'turnItems' && value.type === 'error') await onFailure(tracker, value);
      }
      if (isRoot) await onRequests(tracker);
      if (isRoot && Number.isSafeInteger(policy.maxTurns) && tracker.runs.size > policy.maxTurns) {
        requestStop('failure', `Stopped: the assignment exceeded its policy of ${policy.maxTurns} turns.`);
      }
    }

    async function onRun(tracker, run) {
      const startedKey = `start:${run.id}`;
      if (run.startedAt && !reportedTurns.has(startedKey)) {
        reportedTurns.add(startedKey);
        await report({ type: 'progress', data: { interaction: 'turn.started', threadRef: threadRef(tracker.threadId), runId: run.id, ordinal: run.ordinal, startedAt: run.startedAt } });
      }
      const finishedKey = `finish:${run.id}`;
      if (TERMINAL_RUN_STATUSES.has(run.status) && !reportedTurns.has(finishedKey)) {
        reportedTurns.add(finishedKey);
        const finishedAt = run.completedAt ?? new Date().toISOString();
        const durationMs = run.startedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(run.startedAt)) : undefined;
        await report({ type: 'progress', data: { interaction: 'turn.finished', threadRef: threadRef(tracker.threadId), runId: run.id, ordinal: run.ordinal, status: run.status, startedAt: run.startedAt ?? null, finishedAt, ...(durationMs === undefined ? {} : { durationMs }) } });
      }
    }

    async function onProviderTurn(tracker, turn) {
      if (!turn.turnTokenUsage || reportedUsage.has(turn.id)) return;
      reportedUsage.add(turn.id);
      const meta = tracker.meta ?? { provider: providerName, model: target.model };
      const record = usageRecord(turn, { provider: meta.provider, model: meta.model, accountId: tracker.threadId === threadId ? accountId : undefined, thread: tracker.threadId });
      tokens += record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens;
      await report({ type: 'usage', data: record });
      if (Number.isSafeInteger(policy.maxTokens) && tokens > policy.maxTokens) {
        requestStop('failure', `Stopped: the assignment used ${tokens} tokens, above its policy limit of ${policy.maxTokens}.`);
      }
    }

    async function delegated({ key, allowed, kind, provider, model, childThreadId, reason, from }) {
      if (reportedDelegations.has(key)) return;
      reportedDelegations.add(key);
      await report({ type: 'progress', data: {
        interaction: 'agent.delegated', kind, allowed,
        target: { provider: provider ?? null, model: model ?? null, threadRef: childThreadId ? threadRef(childThreadId) : null },
        from: { threadRef: threadRef(from) }, ...(reason ? { reason } : {}), at: new Date().toISOString(),
      } });
    }

    async function onSubagent(tracker, subagent) {
      if (subagent.origin === 'app_owned') {
        // T3 records the task before it creates the child thread; report once the child is known.
        if (!subagent.childThreadId && !['completed', 'failed', 'cancelled', 'interrupted'].includes(subagent.status)) return;
        await delegated({ key: subagent.id, allowed: true, kind: 'delegated_task', provider: subagent.driver, model: subagent.model ?? subagent.modelSelection?.model, childThreadId: subagent.childThreadId, from: tracker.threadId });
        if (subagent.childThreadId) watch(subagent.childThreadId, { provider: subagent.driver, model: subagent.model ?? subagent.modelSelection?.model });
        return;
      }
      if (subagent.origin !== 'provider_native' || reportedDelegations.has(subagent.id)) return;
      let decision;
      if (policyEnforced) {
        try {
          decision = await t3.reportNativeSubagent(threadId, { subagentId: subagent.id, callerThreadId: tracker.threadId, driver: subagent.driver, providerInstanceId: subagent.providerInstanceId, model: subagent.model ?? subagent.modelSelection?.model ?? null }, { signal });
        } catch { decision = null; }
      }
      if (!decision) {
        const used = [...trackers.values()].reduce((sum, item) => sum + item.subagents.size, 0);
        const allowedProvider = (policy.allowedSubagentProviders ?? []).some(name => name === subagent.driver || name === subagent.providerInstanceId);
        decision = allowedProvider && used <= (policy.maxSubagents ?? 0)
          ? { allowed: true }
          : { allowed: false, reason: allowedProvider ? `This agent's policy allows at most ${policy.maxSubagents ?? 0} subagents.` : `Provider ${subagent.driver} is not in this agent's allowed subagent providers.` };
      }
      await delegated({ key: subagent.id, allowed: decision.allowed, kind: 'provider_native', provider: subagent.driver, model: subagent.model, childThreadId: subagent.childThreadId, reason: decision.reason, from: tracker.threadId });
      if (!decision.allowed && settings.onNativeSubagentViolation === 'interrupt') {
        requestStop('failure', `Stopped: the agent started a provider-native subagent its policy does not allow. ${decision.reason ?? ''}`.trim());
      }
    }

    async function onFailure(tracker, item) {
      if (reportedFailures.has(item.id)) return;
      reportedFailures.add(item.id);
      const failure = item.failure ?? {};
      // The account pool decides whether this is a rate limit or an auth failure.
      if (tracker.threadId === threadId) await observe({ failure }, item.id);
      await report({ type: 'progress', data: { interaction: 'provider.failure', threadRef: threadRef(tracker.threadId), runId: item.runId ?? null, class: failure.class ?? 'unknown', code: failure.code ?? null, retryable: failure.retryable === true, ...(failure.resetAt ? { resetAt: failure.resetAt } : {}), message: typeof failure.message === 'string' ? failure.message.slice(0, 500) : null } });
    }

    async function onRequests(tracker) {
      for (const request of tracker.pendingRequests()) {
        if (reportedRequests.has(request.id)) continue;
        reportedRequests.add(request.id);
        await report({ type: 'progress', data: { interaction: 'runtime.request', threadRef: threadRef(tracker.threadId), requestId: request.id, kind: request.kind, ...(request.prompt ? { prompt: request.prompt.slice(0, 2000) } : {}), ...(request.questions ? { questions: request.questions } : {}) } });
        if (settings.onRuntimeRequest === 'interrupt') {
          const question = request.questions?.map(item => item.question).filter(Boolean).join(' ') || request.prompt || request.kind;
          requestStop('blocked', `Blocked: the agent asked for ${request.kind === 'user_input' ? 'input' : 'approval'} (${String(question).slice(0, 500)}). Continue in T3 at ${threadRef(tracker.threadId)}.`);
        }
      }
    }

    async function pollDecisions() {
      if (!policyEnforced) return;
      let page;
      try { page = await t3.policyDecisions(threadId, decisionsCursor, { signal: observation.signal }); } catch { return; }
      for (const decision of page?.decisions ?? []) {
        decisionsCursor = Math.max(decisionsCursor, decision.seq);
        // Native subagents and accepted delegated tasks are reported from the thread's subagent events.
        if (decision.kind === 'provider_native' || (decision.kind === 'delegated_task' && decision.outcome === 'created')) continue;
        if (decision.outcome === 'refused') {
          await delegated({ key: `refused:${decision.seq}`, allowed: false, kind: decision.kind, provider: decision.driver ?? decision.providerInstanceId, model: decision.model, reason: decision.reason, from: decision.callerThreadId });
        } else if (decision.outcome === 'created' && decision.childRef) {
          await delegated({ key: decision.childRef, allowed: true, kind: decision.kind, provider: decision.driver ?? decision.providerInstanceId, model: decision.model, childThreadId: decision.childRef, from: decision.callerThreadId });
          watch(decision.childRef, { provider: decision.driver ?? decision.providerInstanceId, model: decision.model });
        }
      }
      if (page?.hasMore) await pollDecisions();
    }

    async function interruptAll(reason) {
      for (const tracker of trackers.values()) {
        for (const run of tracker.activeRuns()) {
          if (interruptedRuns.has(run.id)) continue;
          await t3.dispatch({ type: 'run.interrupt', commandId: stableId('perpeto-cmd-interrupt', run.id, reason), threadId: tracker.threadId, runId: run.id, holdQueue: true })
            .then(() => interruptedRuns.add(run.id)).catch(() => {});
        }
      }
    }

    const allIdle = () => {
      if (pendingRun && root.runs.size <= pendingRun.after && Date.now() < pendingRun.until) return false;
      pendingRun = null;
      return [...trackers.values()].every(tracker => tracker.isIdle());
    };
    /** Resolve true once every followed thread has stayed idle for `settleMs`. */
    async function waitIdle(timeoutMs, { signal: waitSignal, honorStop = true } = {}) {
      const until = Date.now() + timeoutMs;
      let idleSince = null;
      while (Date.now() < until) {
        if (fatal && !signal.aborted) throw fatal;
        await pollDecisions();
        // A delivered message makes a turn: the thread is not settled until T3 reports it.
        if (honorStop) await deliverInbox();
        if (!honorStop) await interruptAll('cancel');
        if (waitSignal?.aborted || (honorStop && stop)) return false;
        if (allIdle()) { idleSince ??= Date.now(); if (Date.now() - idleSince >= settings.settleMs) return true; }
        else idleSince = null;
        await new Promise(resolve => {
          const timer = setTimeout(done, Math.min(settings.pollMs, Math.max(1, until - Date.now())));
          function done() { clearTimeout(timer); waitSignal?.removeEventListener('abort', done); wake = () => {}; resolve(); }
          wake = done;
          waitSignal?.addEventListener('abort', done, { once: true });
        });
      }
      return false;
    }

    const root = new ThreadTracker(threadId);
    root.meta = { provider: providerName, model: target.model };
    trackers.set(threadId, root);
    if (launch?.projection) await handleChanges(root, root.applySnapshot(launch.projection));
    subscribe(root).catch(error => { fatal ??= error; wake(); });

    try {
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { requestStop('failure', `Stopped: the assignment ran longer than ${Math.round(settings.turnTimeoutMs / 60000)} minutes.`); }
        if (stop || signal.aborted) break;
        if (await waitIdle(remaining, { signal })) break;
      }
      if (signal.aborted || stop) {
        if (signal.reason?.code === 'ACCOUNT_RESERVATION_LOST') requestStop('failure', signal.reason.message);
        await interruptAll(signal.aborted ? 'cancel' : 'policy');
        await waitIdle(settings.interruptGraceMs, { honorStop: false });
        if (signal.aborted && signal.reason?.code !== 'ACCOUNT_RESERVATION_LOST') throw signal.reason ?? new Error('Assignment was cancelled.');
      }
      await pollDecisions();
      return await finish();
    } finally {
      unsubscribeInbox?.();
      for (const tracker of trackers.values()) tracker.closed = true;
      observation.abort();
      for (const handle of subscriptions) handle.cancel();
    }

    async function finish() {
      const latest = root.latestRun();
      // Worktree provisioning updates the thread after launch; read its final state.
      const snapshot = await t3.getThread(threadId).catch(() => null);
      const thread = snapshot?.projection?.thread ?? root.thread ?? {};
      const checkout = thread.worktreePath ?? (workspace.mode === 'worktree' ? null : workspace.workspaceRoot);
      const revision = await revisionOf(checkout);
      const text = latest ? root.assistantText(latest.id) : '';
      const prUrl = pullRequestUrl(root.allAssistantText());
      const evidence = {
        ...(revision.branch ?? thread.branch ? { branch: revision.branch ?? thread.branch } : {}),
        ...(revision.headSha ? { headSha: revision.headSha } : {}),
        ...(prUrl ? { prUrl } : {}),
        threadRef: threadRef(threadId),
      };
      const clip = value => value.length > settings.maxSummaryChars ? `${value.slice(0, settings.maxSummaryChars - 1)}…` : value;
      if (stop) return { outcome: stop.outcome, summary: clip(stop.summary), ...evidence };
      if (latest?.status !== 'completed') {
        const failure = latest ? root.failures(latest.id).at(-1) : null;
        const reason = failure?.message ? `${failure.class ?? 'error'}: ${failure.message}` : `Turn ended with status ${latest?.status ?? 'unknown'}.`;
        return { outcome: 'failure', summary: clip(text ? `${reason}\n\n${text}` : reason), ...evidence };
      }
      let parsed = parseRoleResult(kind, text);
      // A message can add a turn after a structured answer; the answer stands unless a later turn gives a new one.
      if (steered && kind !== 'work' && (parsed.error || (kind === 'review' && !parsed.fields.verdict))) {
        const earlier = root.orderedRuns().filter(run => run.status === 'completed').map(run => root.assistantText(run.id)).join('\n\n');
        const fallback = parseRoleResult(kind, earlier);
        if (!fallback.error && (kind !== 'review' || fallback.fields.verdict)) parsed = fallback;
      }
      if (parsed.error) return { outcome: 'failure', summary: clip(`${parsed.error}\n\n${text}`), ...evidence };
      const summary = parsed.summary ?? (text || 'The agent finished without a written summary.');
      signal.throwIfAborted();
      if (kind === 'work' && checkout && revision.headSha) {
        if (await isDirty(checkout)) await report({ type: 'progress', data: { interaction: 'workspace.dirty', threadRef: threadRef(threadId), branch: evidence.branch ?? branch } });
        if (settings.publishBranch && workspace.startHead && revision.headSha !== workspace.startHead && evidence.branch) {
          signal.throwIfAborted();
          const published = await publishBranch(checkout, evidence.branch);
          await report({ type: 'progress', data: { interaction: 'branch.published', branch: evidence.branch, headSha: revision.headSha, published: published.published, ...(published.reason ? { reason: published.reason } : {}) } });
          if (published.failed) return { outcome: 'failure', summary: clip(`${published.reason}\n\n${summary}`), ...evidence };
          // Without a forge the merge queue needs the published branch as `local:<branch>`.
          const localPr = published.published && !evidence.prUrl ? localPullRequestUrl(assignment.repo, evidence.branch) : undefined;
          if (localPr) evidence.prUrl = localPr;
        }
      }
      return { outcome: 'success', summary: parsed.unclipped ? summary : clip(summary), ...parsed.fields, ...evidence };
    }
  }
}
