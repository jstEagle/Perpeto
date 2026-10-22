import { basename } from 'node:path';

/**
 * Pure mapping from T3's orchestration v2 read model (packages/contracts/src/orchestrationV2.ts) to the observation
 * contract. Only allowlisted fields are copied; message previews, prompts, plans, tool calls and file contents that
 * arrive on the wire are never kept, stored or forwarded.
 */
const ACTIVE = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
const WINDOW_KINDS = new Set(['session', 'weekly', 'monthly', 'other']);
const WINDOW_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const text = (value, max) => typeof value === 'string' && value.trim() ? value.replace(CONTROL, ' ').trim().slice(0, max) : undefined;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** running | waiting | idle | error, from the shell's run status and pending request summary. */
export function sessionStatus(thread) {
  if (thread.pendingRuntimeRequest) return 'waiting';
  // A `waiting` run without a pending request is checkpoint finalisation, still work in progress.
  if (ACTIVE.has(thread.activityRunStatus) || ACTIVE.has(thread.status) || thread.activeRunId) return 'running';
  if (thread.status === 'failed') return 'error';
  return 'idle';
}

export function lastActivityAt(thread) {
  const times = [thread.latestRunCompletedAt, thread.latestRunStartedAt, thread.activityRunStartedAt, thread.latestRunRequestedAt,
    thread.latestUserMessageAt, thread.createdAt].map(iso).filter(Boolean);
  return times.sort().at(-1) ?? new Date(0).toISOString();
}

/** A live thread in the active shell (not archived, not deleted). */
export const isLive = thread => thread && typeof thread.id === 'string' && !thread.deletedAt && !thread.archivedAt;

/** Session view of one shell thread: ids, labels, provider, status, lineage and times. */
export function sessionOf(thread, { projects, providers, includeTitles = true, turns }) {
  const project = projects.get(thread.projectId);
  const instanceId = typeof thread.providerInstanceId === 'string' ? thread.providerInstanceId : thread.modelSelection?.instanceId;
  const provider = providers.get(instanceId)?.driver ?? instanceId ?? 'unknown';
  const title = includeTitles ? text(thread.title, 500) : undefined;
  const projectName = text(project?.title, 200);
  const projectPath = typeof project?.workspaceRoot === 'string' ? text(basename(project.workspaceRoot), 200) : undefined;
  const worktree = typeof thread.worktreePath === 'string' ? text(basename(thread.worktreePath), 200) : undefined;
  return {
    threadId: thread.id,
    ...(title ? { title } : {}),
    ...(projectName || projectPath ? { project: { name: projectName ?? projectPath, ...(projectPath ? { path: projectPath } : {}) } } : {}),
    ...(text(thread.branch, 200) ? { branch: text(thread.branch, 200) } : {}),
    ...(worktree ? { worktree } : {}),
    provider: text(provider, 100) ?? 'unknown',
    providerInstanceId: text(instanceId, 200) ?? 'unknown',
    ...(text(thread.modelSelection?.model, 200) ? { model: text(thread.modelSelection.model, 200) } : {}),
    status: sessionStatus(thread),
    ...(text(thread.lineage?.parentThreadId, 200) ? { parentThreadId: thread.lineage.parentThreadId } : {}),
    createdAt: iso(thread.createdAt) ?? lastActivityAt(thread),
    lastActivityAt: lastActivityAt(thread),
    turns: count(turns),
  };
}

/**
 * Per-turn billing from a thread projection. T3 counts cache reads and writes inside `inputTokens`
 * (TurnTokenUsage in providerRuntime.ts), so they are subtracted, as the executor does. Only finished turns with
 * usage are returned; the model comes from the turn's run, else the thread.
 */
export function usageOf(projection, thread, providers) {
  const runs = new Map((projection?.runs ?? []).filter(run => typeof run?.id === 'string').map(run => [run.id, run]));
  const attempts = new Map((projection?.attempts ?? []).filter(attempt => typeof attempt?.id === 'string').map(attempt => [attempt.id, attempt]));
  const records = [];
  for (const turn of projection?.providerTurns ?? []) {
    const usage = turn?.turnTokenUsage;
    if (typeof turn?.id !== 'string' || !usage || !['completed', 'interrupted', 'failed', 'cancelled'].includes(turn.status)) continue;
    if (!['complete', 'partial'].includes(usage.usageStatus)) continue;
    const run = runs.get(attempts.get(turn.runAttemptId)?.runId);
    const instanceId = run?.providerInstanceId ?? run?.modelSelection?.instanceId ?? thread.providerInstanceId;
    const input = count(usage.inputTokens); const cacheRead = count(usage.cachedInputTokens); const cacheWrite = count(usage.cacheCreationTokens);
    records.push({
      providerTurnId: turn.id, threadId: thread.id,
      providerInstanceId: text(instanceId, 200) ?? 'unknown',
      provider: text(providers.get(instanceId)?.driver ?? instanceId, 100) ?? 'unknown',
      model: text(run?.modelSelection?.model ?? thread.modelSelection?.model, 200) ?? 'unknown',
      inputTokens: Math.max(0, input - cacheRead - cacheWrite), outputTokens: count(usage.outputTokens),
      cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, reasoningTokens: count(usage.reasoningTokens),
      usageStatus: usage.usageStatus, at: iso(turn.completedAt) ?? iso(turn.startedAt) ?? lastActivityAt(thread),
    });
  }
  const turns = Math.max(0, ...[...runs.values()].map(run => count(run.ordinal)));
  return { records, turns };
}

/** A T3 plan label (its subscription auth label), never an API-key login or anything that looks like an email. */
export function planOf(auth) {
  if (!auth || typeof auth.label !== 'string' || !auth.label.trim() || ['apiKey', 'bedrock', 'vertex'].includes(auth.type)) return undefined;
  const label = auth.label.trim();
  return label.length <= 80 && !label.includes("@") && !/[\u0000-\u001f\u007f]/.test(label) ? label : undefined;
}

/** Usage windows: percentages, kinds, labels and resets only. Credential fingerprints and links stay behind. */
export function usageWindows(limits) {
  if (!limits || !Array.isArray(limits.windows) || !iso(limits.checkedAt)) return undefined;
  const windows = limits.windows.slice(0, 16).flatMap(window => window && WINDOW_ID.test(window.id ?? '') && WINDOW_KINDS.has(window.kind)
    && Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100 ? [{
      id: window.id, kind: window.kind, label: text(window.label, 80) ?? window.id, usedPercent: window.usedPercent,
      ...(iso(window.resetsAt) ? { resetsAt: iso(window.resetsAt) } : {}),
      ...(Number.isSafeInteger(window.windowDurationMins) && window.windowDurationMins > 0 ? { windowMins: window.windowDurationMins } : {}) }] : []);
  const unique = [...new Map(windows.map(window => [window.id, window])).values()];
  return unique.length ? { checkedAt: iso(limits.checkedAt), windows: unique } : undefined;
}

/**
 * Provider instances worth an account: enabled ones that report a subscription plan or usage windows. Display name,
 * driver, plan and windows only; emails, workspace ids and credential fingerprints are dropped.
 */
export function providerSnapshots(providers) {
  return (Array.isArray(providers) ? providers : []).flatMap(provider => {
    if (!provider || typeof provider.instanceId !== 'string' || typeof provider.driver !== 'string' || provider.enabled === false) return [];
    const usage = usageWindows(provider.usageLimits); const plan = planOf(provider.auth);
    if (!usage && !plan) return [];
    return [{ instanceId: provider.instanceId.slice(0, 200), driver: provider.driver.slice(0, 100),
      ...(text(provider.displayName, 80) ? { displayName: text(provider.displayName, 80) } : {}),
      ...(plan ? { plan } : {}), ...(typeof provider.status === 'string' ? { status: provider.status.slice(0, 40) } : {}),
      ...(usage ? { usage } : {}) }];
  }).slice(0, 50);
}

/** instanceId → { driver } for every reported instance, enabled or not. */
export function providerDrivers(providers) {
  return new Map((Array.isArray(providers) ? providers : []).filter(item => typeof item?.instanceId === 'string' && typeof item.driver === 'string')
    .map(item => [item.instanceId, { driver: item.driver }]));
}

/** Project shells: id → { title, workspaceRoot }; nothing else (scripts, icons and identities stay behind). */
export function projectOf(project) {
  return typeof project?.id === 'string' ? [project.id, { title: typeof project.title === 'string' ? project.title : undefined,
    workspaceRoot: typeof project.workspaceRoot === 'string' ? project.workspaceRoot : undefined }] : null;
}

/**
 * The allowlisted subset of a shell thread kept in memory. `latestVisibleMessage` (a message preview), goals,
 * errors and pull-request details are not copied.
 */
export function shellThread(thread) {
  const keep = ['id', 'projectId', 'title', 'providerInstanceId', 'branch', 'worktreePath', 'historyOrigin', 'latestRunId', 'latestRunRequestedAt',
    'latestRunStartedAt', 'latestRunCompletedAt', 'activeRunId', 'activityRunStartedAt', 'activityRunStatus', 'status', 'latestUserMessageAt',
    'createdAt', 'updatedAt', 'archivedAt', 'deletedAt'];
  const value = Object.fromEntries(keep.filter(key => thread[key] !== undefined).map(key => [key, thread[key]]));
  if (thread.modelSelection) value.modelSelection = { instanceId: thread.modelSelection.instanceId, model: thread.modelSelection.model };
  if (thread.lineage) value.lineage = { parentThreadId: thread.lineage.parentThreadId ?? null };
  if (thread.pendingRuntimeRequest) value.pendingRuntimeRequest = { kind: thread.pendingRuntimeRequest.kind };
  return value;
}
