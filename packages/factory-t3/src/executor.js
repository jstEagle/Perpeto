import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { T3Client, T3HttpError } from './client.js';
import { issueSessionToken, readCredentialFile } from './credentials.js';
import { assignmentContext, buildPrompt } from './prompt.js';
import { ThreadTracker, TERMINAL_RUN_STATUSES } from './thread-state.js';
import { branchName, prepareWorkspace, pullRequestUrl, revisionOf } from './workspace.js';

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
});

const sleep = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});
const stableId = (prefix, ...parts) => `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)}`;
export const threadRef = threadId => `t3-thread://v1/${threadId}`;

/** Merge node runtime config (`config.runtime` in factory-node) with executor settings in `t3`. */
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
export function chooseInstance(providers, provider, preferredInstanceId) {
  const candidates = (providers ?? []).filter(item => item.enabled !== false && (item.driver === provider || item.instanceId === provider));
  const ready = candidates.filter(item => item.status === 'ready');
  return ready.find(item => item.instanceId === preferredInstanceId) ?? ready.find(item => item.instanceId === provider) ?? ready[0] ?? null;
}

/**
 * @param {{ config?: object, runtimeUrl?: string, accountProvider?: object,
 *           createClient?: (settings: object) => Promise<T3Client>|T3Client }} [options]
 */
export function createT3Executor({ config = {}, runtimeUrl, accountProvider, createClient } = {}) {
  const settings = resolveSettings(config, runtimeUrl);
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

  return {
    kind: 't3',
    canRun(assignment, machine) {
      const provider = assignment?.harness?.provider;
      if (typeof provider !== 'string' || !provider || provider === 'fake' || typeof assignment?.harness?.model !== 'string') return false;
      return !Array.isArray(machine?.providers) || machine.providers.includes(provider);
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
    const signal = ctx.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const report = event => Promise.resolve(ctx.report?.(event)).catch(() => {});
    const target = harnessTarget(assignment);
    const policy = assignment.policy ?? { maxSubagents: 0, allowedSubagentProviders: [] };
    const attempt = Number.isSafeInteger(assignment.attempt) ? assignment.attempt : 0;

    // Account selection belongs to factory-accounts; it may pin a provider instance.
    let account = null;
    if (typeof (ctx.accountProvider ?? accountProvider)?.acquire === 'function') {
      account = await (ctx.accountProvider ?? accountProvider).acquire({ provider: target.provider, model: target.model, assignmentId: assignment.id }) ?? null;
    }
    const accounts = ctx.accountProvider ?? accountProvider;
    let result;
    try {
      result = await execute();
      return result;
    } finally {
      if (account && typeof accounts?.release === 'function') await Promise.resolve(accounts.release(account, result)).catch(() => {});
    }

    async function execute() {
      const serverConfig = await t3.getConfig({ signal });
      const instance = chooseInstance(serverConfig?.providers, target.provider, account?.providerInstanceId ?? account?.instanceId);
      if (!instance) return { outcome: 'blocked', summary: `No ready T3 provider instance for ${target.provider} on this machine.` };

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
        await t3.setPolicy(threadId, { maxSubagents: policy.maxSubagents ?? 0, allowedSubagentProviders: policy.allowedSubagentProviders ?? [] }, { signal });
      } catch (error) {
        if (error instanceof T3HttpError && (error.status === 404 || error.status === 503)) {
          policyEnforced = false;
          await report({ type: 'progress', data: { interaction: 'policy.unenforced', reason: 'This T3 runtime has no Perpeto agent-policy routes; app-owned subagents are only observed.' } });
        } else throw error;
      }

      const runtimeMode = RUNTIME_MODES.has(target.overrides.runtimeMode) ? target.overrides.runtimeMode : settings.runtimeMode;
      const interactionMode = target.overrides.interactionMode === 'plan' ? 'plan' : settings.interactionMode;
      const launch = await t3.launchThread({
        commandId: stableId('perpeto-cmd-launch', assignment.id, String(attempt)),
        threadId, creationSource: 'server', projectId: project.id,
        title: (workItem?.title ?? assignment.role ?? 'Perpeto assignment').slice(0, 120),
        modelSelection: { instanceId: instance.instanceId, model: target.model, ...(target.options.length ? { options: target.options } : {}) },
        runtimeMode, interactionMode, workspaceStrategy: workspace.workspaceStrategy,
        initialMessage: { messageId: stableId('perpeto-msg', assignment.id, String(attempt)), text: buildPrompt(assignment), attachments: [] },
      }, { signal, timeoutMs: 300000 });
      await report({ type: 'progress', data: {
        interaction: 'thread.started', threadRef: threadRef(threadId), threadId, projectId: project.id,
        provider: instance.driver ?? target.provider, providerInstanceId: instance.instanceId, model: target.model,
        resumed: launch?.resumed === true, workspaceMode: workspace.mode, at: new Date().toISOString(),
      } });

      return follow({ t3, assignment, signal, report, policy, policyEnforced, threadId, instance, target, account, workspace, launch });
    }
  }

  async function follow({ t3, assignment, signal, report, policy, policyEnforced, threadId, instance, target, account, workspace, launch }) {
    const trackers = new Map();
    const reportedTurns = new Set();
    const reportedUsage = new Set();
    const reportedDelegations = new Set();
    const reportedRequests = new Set();
    const reportedFailures = new Set();
    const subscriptions = [];
    let decisionsCursor = 0;
    let tokens = 0;
    let stop = null; // { outcome, summary, interrupt }
    let fatal = null;
    let wake = () => {};
    const deadline = Date.now() + settings.turnTimeoutMs;
    const accountId = account?.accountId ?? account?.id;
    const providerName = instance.driver ?? target.provider;

    const requestStop = (outcome, summary) => { if (!stop) { stop = { outcome, summary }; wake(); } };

    function watch(childThreadId, meta) {
      if (trackers.has(childThreadId)) return;
      const tracker = new ThreadTracker(childThreadId);
      tracker.meta = meta;
      trackers.set(childThreadId, tracker);
      subscribe(tracker).catch(error => { fatal ??= error; wake(); });
    }

    async function subscribe(tracker) {
      let failures = 0;
      while (!signal.aborted && !tracker.closed) {
        let handle;
        try {
          handle = await t3.subscribeThread({ threadId: tracker.threadId, afterSequence: tracker.lastSequence }, async items => {
            failures = 0;
            const changes = tracker.applyItems(items);
            await handleChanges(tracker, changes);
            wake();
          }, { signal });
          subscriptions.push(handle);
          await handle.done;
          if (tracker.closed || signal.aborted) return;
        } catch (error) {
          if (signal.aborted || tracker.closed) return;
          if (++failures > 5) throw error;
        }
        await sleep(Math.min(250 * 2 ** failures, 5000), signal);
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
      try { page = await t3.policyDecisions(threadId, decisionsCursor, { signal }); } catch { return; }
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
          await t3.dispatch({ type: 'run.interrupt', commandId: stableId('perpeto-cmd-interrupt', run.id, reason), threadId: tracker.threadId, runId: run.id, holdQueue: true }).catch(() => {});
        }
      }
    }

    const allIdle = () => [...trackers.values()].every(tracker => tracker.isIdle());
    /** Resolve true once every followed thread has stayed idle for `settleMs`. */
    async function waitIdle(timeoutMs, { signal: waitSignal, honorStop = true } = {}) {
      const until = Date.now() + timeoutMs;
      let idleSince = null;
      while (Date.now() < until) {
        if (fatal) throw fatal;
        await pollDecisions();
        if (allIdle()) { idleSince ??= Date.now(); if (Date.now() - idleSince >= settings.settleMs) return true; }
        else idleSince = null;
        if (waitSignal?.aborted || (honorStop && stop)) return false;
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
        await interruptAll(signal.aborted ? 'cancel' : 'policy');
        await waitIdle(settings.interruptGraceMs, { honorStop: false });
        if (signal.aborted) throw signal.reason ?? new Error('Assignment was cancelled.');
      }
      await pollDecisions();
      return await finish();
    } finally {
      for (const tracker of trackers.values()) tracker.closed = true;
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
      if (latest?.status === 'completed') return { outcome: 'success', summary: clip(text || 'The agent finished without a written summary.'), ...evidence };
      const failure = latest ? root.failures(latest.id).at(-1) : null;
      const reason = failure?.message ? `${failure.class ?? 'error'}: ${failure.message}` : `Turn ended with status ${latest?.status ?? 'unknown'}.`;
      return { outcome: 'failure', summary: clip(text ? `${reason}\n\n${text}` : reason), ...evidence };
    }
  }
}
