import { join, basename } from 'node:path';
import { diskState, retention } from './policy.js';
import { displayPath, expandHome, isInside, itemId } from './paths.js';
import { createBudget } from './size.js';
import { findStaleProcesses } from './processes.js';

export const KINDS = Object.freeze(['perpeto-workspace', 'ci-workspace', 'ci-cache', 'perpeto-worktree', 't3-worktree', 'build-artifact', 'global-cache']);
const HOUR = 3_600_000;
const MAX_WORKTREES_PER_ROOT = 500;
const MAX_WORKSPACES = 1000;

/** `<assignmentId>--a<attempt>--<suffix>`: how the node names an assignment workspace, so its owner survives a crash. */
export function parseWorkspaceName(name) {
  const match = /^([A-Za-z0-9_]{1,120})--a(\d{1,6})--[A-Za-z0-9-]{4,64}$/.exec(name);
  return match ? { assignmentId: match[1], attempt: Number(match[2]) } : null;
}
export const workspaceName = (assignmentId, attempt, suffix) => `${String(assignmentId).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 120)}--a${attempt}--${suffix}`;

const hours = ms => Math.round(ms / HOUR);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Inventory reclaimable storage. Pure apart from the injected `fs` and `exec`; nothing is deleted here.
 * @param {object} options
 * @param {{dataDir?: string, assignments?: string, ciTemp?: string, ciCache?: string, perpetoWorktrees?: string[], foreignWorktrees?: string[], diskPath: string}} options.roots
 * @param {object} options.policy merged policy (see policy.js)
 * @param {{workspaces?: {path:string, assignmentId?:string, runId?:string, workItemId?:string}[], branches?: {branch:string, runId?:string, workItemId?:string, assignmentId?:string}[], ciWorkspaces?: {path:string, jobId?:string}[]}} [options.active]
 * @returns {Promise<{report: object, locations: Map<string, object>}>} `report` is safe to send to the hub; `locations` keeps real paths on the machine.
 */
export async function scanStorage({ roots, policy, active = {}, home, platform = process.platform, now = Date.now(), fs, exec, git, sizer, clock = Date.now }) {
  const started = clock();
  const budget = createBudget({ maxEntries: policy.maxEntries, timeoutMs: policy.scanTimeoutMs, clock });
  const real = async path => { try { return await fs.realpath(path); } catch { return null; } };
  const labels = [
    ...(roots.ciTemp ? [{ root: roots.ciTemp, label: '$TMPDIR' }] : []),
  ];
  const display = path => displayPath(path, { home, labels });
  const items = [];
  const locations = new Map();
  let truncated = false;

  let disk = null;
  try {
    const stats = await fs.statfs(roots.diskPath);
    disk = { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
  } catch { /* No disk numbers: state stays ok. */ }
  const state = diskState(disk, policy);
  const keep = retention(policy, state);
  const finishedTtl = keep.finishedWorkspaceTtlHours * HOUR;
  const artifactTtl = keep.idleArtifactTtlHours * HOUR;

  const activeWorkspaces = new Map();
  for (const entry of active.workspaces ?? []) { const path = await real(entry.path); if (path) activeWorkspaces.set(path, entry); }
  const activeCi = new Map();
  for (const entry of active.ciWorkspaces ?? []) { const path = await real(entry.path); if (path) activeCi.set(path, entry); }
  const activeBranches = new Map((active.branches ?? []).filter(entry => typeof entry?.branch === 'string').map(entry => [entry.branch, entry]));

  const worktreeRoots = { perpeto: [], foreign: [] };
  for (const [key, list] of [['perpeto', roots.perpetoWorktrees ?? []], ['foreign', roots.foreignWorktrees ?? []]]) {
    for (const value of list) { const path = await real(expandHome(value, home)); if (path && !worktreeRoots[key].includes(path)) worktreeRoots[key].push(path); }
  }
  // Foreign roots that are also Perpeto's are Perpeto's.
  worktreeRoots.foreign = worktreeRoots.foreign.filter(path => !worktreeRoots.perpeto.includes(path));

  const { findings: processes, cwds: busyCwds } = await findStaleProcesses({ exec, fs, platform, staleProcessHours: policy.staleProcessHours, timeoutMs: policy.commandTimeoutMs,
    display }).catch(() => ({ findings: [], cwds: [] }));
  const inUse = path => busyCwds.some(cwd => cwd === path || isInside(path, cwd));

  function push(item, location) {
    items.push(item);
    locations.set(item.id, location);
    return item;
  }
  const base = (kind, path, measured, extra = {}) => ({
    id: itemId(kind, path), kind, path: display(path), bytes: measured.bytes, ...(measured.approximate ? { approximate: true } : {}),
    lastModifiedAt: new Date(measured.activityMs || now).toISOString(), owner: {}, ...extra,
  });

  /** Strip-able artifacts inside a kept worktree or workspace. */
  async function artifacts(parent, gitRoot, measured, { allowed, protectedReason, idle, foreign }) {
    for (const artifact of measured.artifacts) {
      const ignored = gitRoot ? await git.ignored(gitRoot, artifact.path) : false;
      let reclaimable = false; let reason;
      if (protectedReason) reason = protectedReason;
      else if (!allowed) reason = foreign ? 'Inside a foreign worktree; stripForeignArtifacts is off.' : 'Not eligible.';
      else if (!gitRoot) reason = 'Not inside a Git worktree, so it cannot be proven to be a build artifact.';
      else if (!ignored) reason = 'Tracked or not ignored by Git; kept.';
      else if (idle < artifactTtl) reason = `Worktree active ${hours(idle)} h ago; artifacts are stripped after ${keep.idleArtifactTtlHours} h idle.`;
      else { reclaimable = true; reason = `Git-ignored build output in a worktree idle for ${hours(idle)} h.`; }
      push(base('build-artifact', artifact.path, artifact, { parentId: parent.id, owner: parent.owner, reclaimable, ...(reclaimable ? { action: 'strip' } : {}), reason,
        ownedBy: parent.ownedBy, name: artifact.name }),
      { path: artifact.path, kind: 'build-artifact', root: parent.rootPath, gitRoot, parentPath: parent.realPath });
    }
  }

  async function gitStates(paths) {
    const states = [];
    for (const path of paths) if (await git.isWorkTree(path)) states.push({ path, ...(await git.state(path)) });
    return states;
  }
  const combine = states => states.length ? {
    ...(states.find(item => item.branch)?.branch ? { branch: states.find(item => item.branch).branch } : {}),
    dirty: states.some(item => item.dirty), unpushedCommits: states.reduce((sum, item) => sum + item.unpushedCommits, 0),
    ...(states.every(item => item.merged !== undefined) ? { merged: states.every(item => item.merged) } : {}),
  } : undefined;
  const riskReason = gitState => gitState.dirty ? 'Has uncommitted changes' : `Has ${plural(gitState.unpushedCommits, 'unpushed commit')}`;

  // Perpeto assignment workspaces left behind by a crash or an interrupted cleanup.
  if (roots.assignments) {
    const root = await real(roots.assignments);
    const entries = root ? await fs.readdir(root, { withFileTypes: true }).catch(() => []) : [];
    for (const entry of entries.slice(0, MAX_WORKSPACES)) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name);
      const measured = await sizer.measure(path, { budget, artifactNames: policy.artifactNames, maxDepth: policy.maxDepth });
      truncated ||= measured.approximate;
      const parsed = parseWorkspaceName(entry.name);
      const activeEntry = activeWorkspaces.get(path);
      const owner = { ...(parsed ? { assignmentId: parsed.assignmentId } : {}), ...(activeEntry?.assignmentId ? { assignmentId: activeEntry.assignmentId } : {}),
        ...(activeEntry?.runId ? { runId: activeEntry.runId } : {}) };
      const candidates = [path, join(path, 'repo'), join(path, 'worktree')];
      const states = await gitStates((await Promise.all(candidates.map(async candidate => (await fs.lstat(candidate).catch(() => null))?.isDirectory() ? candidate : null))).filter(Boolean));
      const gitState = combine(states);
      const idle = now - measured.activityMs;
      let reclaimable = false; let attention = false; let reason;
      if (activeEntry) reason = 'Workspace of a running assignment.';
      else if (idle < finishedTtl) reason = `Finished or idle ${hours(idle)} h; workspaces are kept ${keep.finishedWorkspaceTtlHours} h.`;
      else if (gitState && (gitState.dirty || gitState.unpushedCommits)) { attention = true; reason = `${riskReason(gitState)}; review before deleting.`; }
      else { reclaimable = true; reason = `No running assignment uses it; idle ${hours(idle)} h.`; }
      const item = push(base('perpeto-workspace', path, measured, { owner, ...(gitState ? { gitState } : {}), reclaimable, ...(reclaimable ? { action: 'delete' } : {}),
        reason, ...(attention ? { attention: true } : {}), ownedBy: 'perpeto' }),
      { path, kind: 'perpeto-workspace', root, gitPaths: states.map(item => item.path) });
      if (!reclaimable && states.length) {
        await artifacts({ ...item, realPath: path, rootPath: root }, states[0].path, measured, { allowed: true, protectedReason: activeEntry ? 'Workspace of a running assignment.' : undefined, idle });
      }
    }
  }

  // CI job workspaces: detached checkouts, never anyone's unique work.
  if (roots.ciTemp) {
    const root = await real(roots.ciTemp);
    const entries = root ? await fs.readdir(root, { withFileTypes: true }).catch(() => []) : [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('perpeto-ci-')) continue;
      const path = join(root, entry.name);
      const measured = await sizer.measure(path, { budget });
      truncated ||= measured.approximate;
      const job = activeCi.get(path);
      const idle = now - measured.activityMs;
      const reclaimable = !job && idle >= finishedTtl;
      push(base('ci-workspace', path, measured, { owner: job?.jobId ? { jobId: job.jobId } : {}, reclaimable, ...(reclaimable ? { action: 'delete' } : {}),
        reason: job ? 'Workspace of a running CI job.' : reclaimable ? `Left by a finished CI job; idle ${hours(idle)} h.` : `Idle ${hours(idle)} h; CI workspaces are kept ${keep.finishedWorkspaceTtlHours} h.`, ownedBy: 'perpeto' }),
      { path, kind: 'ci-workspace', root });
    }
  }

  // CI runner caches (one folder per cache key): rebuilt on demand, so idle ones go after the artifact retention.
  if (roots.ciCache) {
    const root = await real(roots.ciCache);
    const entries = root ? await fs.readdir(root, { withFileTypes: true }).catch(() => []) : [];
    const jobsRunning = activeCi.size > 0;
    for (const entry of entries.slice(0, MAX_WORKSPACES)) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name);
      const measured = await sizer.measure(path, { budget });
      truncated ||= measured.approximate;
      const idle = now - measured.activityMs;
      const reclaimable = !jobsRunning && idle >= artifactTtl;
      push(base('ci-cache', path, measured, { reclaimable, ...(reclaimable ? { action: 'delete' } : {}), ownedBy: 'perpeto', name: entry.name,
        reason: jobsRunning ? 'A CI job is running; caches are kept while jobs run.' : reclaimable ? `CI cache unused for ${hours(idle)} h; rebuilt when next needed.` : `Used ${hours(idle)} h ago; CI caches are kept ${keep.idleArtifactTtlHours} h idle.` }),
      { path, kind: 'ci-cache', root });
    }
  }

  // Worktrees: `<root>/<repo>/<branch>`, as T3 lays them out.
  for (const [owned, list] of [['perpeto', worktreeRoots.perpeto], ['foreign', worktreeRoots.foreign]]) {
    for (const root of list) {
      const repos = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
      let count = 0;
      for (const repo of repos) {
        if (!repo.isDirectory()) continue;
        const branches = await fs.readdir(join(root, repo.name), { withFileTypes: true }).catch(() => []);
        for (const branchEntry of branches) {
          if (!branchEntry.isDirectory() || ++count > MAX_WORKTREES_PER_ROOT) { if (count > MAX_WORKTREES_PER_ROOT) truncated = true; continue; }
          const path = join(root, repo.name, branchEntry.name);
          await worktree({ owned, root, path });
        }
      }
    }
  }
  async function worktree({ owned, root, path }) {
    const kind = owned === 'perpeto' ? 'perpeto-worktree' : 't3-worktree';
    const measured = await sizer.measure(path, { budget, artifactNames: policy.artifactNames, maxDepth: policy.maxDepth });
    truncated ||= measured.approximate;
    const isGit = await git.isWorkTree(path);
    const gitState = isGit ? await git.state(path) : undefined;
    const idle = now - measured.activityMs;
    const activeEntry = gitState?.branch ? activeBranches.get(gitState.branch) : undefined;
    const busy = inUse(path) || [...activeWorkspaces.keys()].some(workspace => workspace === path);
    const owner = { ...(activeEntry?.runId ? { runId: activeEntry.runId } : {}), ...(activeEntry?.workItemId ? { workItemId: activeEntry.workItemId } : {}),
      ...(activeEntry?.assignmentId ? { assignmentId: activeEntry.assignmentId } : {}) };
    let reclaimable = false; let attention = false; let reason; let protectedReason;
    if (!isGit) reason = 'Not a Git worktree; left for a person to inspect.';
    else if (busy) { reason = 'A running process or assignment uses this worktree.'; protectedReason = reason; }
    else if (owned === 'perpeto') {
      if (activeEntry) { reason = 'Its work item is still active.'; protectedReason = reason; }
      else if (idle < finishedTtl) reason = `Idle ${hours(idle)} h; finished worktrees are kept ${keep.finishedWorkspaceTtlHours} h.`;
      else if (gitState.dirty || gitState.unpushedCommits) { attention = true; reason = `${riskReason(gitState)}; review before deleting.`; }
      else { reclaimable = true; reason = `Work is ${gitState.merged ? 'merged' : 'pushed'} and no active work item uses it; idle ${hours(idle)} h.`; }
    } else if (!policy.cleanupForeignWorktrees) reason = 'Not created by Perpeto; inventory only (cleanupForeignWorktrees is off).';
    else if (gitState.dirty || gitState.unpushedCommits) reason = `${riskReason(gitState)}; foreign worktrees are only removed when clean and pushed.`;
    else if (gitState.merged !== true) reason = 'Not merged; foreign worktrees are only removed once merged.';
    else if (idle < policy.foreignWorktreeIdleHours * HOUR) reason = `Merged, but active ${hours(idle)} h ago; removed after ${policy.foreignWorktreeIdleHours} h idle.`;
    else { reclaimable = true; reason = `Merged, clean and idle ${hours(idle)} h (cleanupForeignWorktrees is on).`; }
    const item = push(base(kind, path, measured, { owner, ...(gitState ? { gitState } : {}), reclaimable, ...(reclaimable ? { action: 'delete' } : {}), reason,
      ...(attention ? { attention: true } : {}), ownedBy: owned, repo: basename(join(path, '..')) }),
    { path, kind, root, gitPaths: isGit ? [path] : [] });
    if (!reclaimable && isGit) {
      await artifacts({ ...item, realPath: path, rootPath: root }, path, measured, { allowed: owned === 'perpeto' || policy.stripForeignArtifacts, protectedReason, idle, foreign: owned !== 'perpeto' });
    }
  }

  // Global caches: advisory only. The janitor shows what they hold and the command that clears them; it never runs it.
  if (policy.globalCaches) {
    const caches = [{ key: 'npm', path: join(home, '.npm', '_cacache'), label: 'npm cache', hint: 'npm cache clean --force' }];
    if (platform === 'darwin') {
      caches.push({ key: 'xcode-derived-data', path: join(home, 'Library', 'Developer', 'Xcode', 'DerivedData'), label: 'Xcode DerivedData', hint: 'Remove folders in ~/Library/Developer/Xcode/DerivedData while Xcode is closed' });
    }
    for (const cache of caches) {
      if (!(await fs.lstat(cache.path).catch(() => null))?.isDirectory()) continue;
      const measured = await sizer.measure(cache.path, { budget });
      truncated ||= measured.approximate;
      push(base('global-cache', cache.path, measured, { name: cache.label, reclaimable: false, advisory: true, hint: cache.hint, reason: 'Shared cache; clearing it is your call.', ownedBy: 'system' }),
        { path: cache.path, kind: 'global-cache', advisory: true });
    }
    if (platform === 'darwin') {
      const listed = await exec('xcrun', ['simctl', 'list', 'devices', 'unavailable', '-j'], { timeoutMs: policy.commandTimeoutMs }).catch(() => ({ code: 1 }));
      if (listed.code === 0) {
        let devices = [];
        try { devices = Object.values(JSON.parse(listed.stdout).devices ?? {}).flat().filter(device => device && device.isAvailable === false && typeof device.dataPath === 'string'); } catch { /* Not JSON. */ }
        if (devices.length) {
          let bytes = 0; let activityMs = 0; let approximate = false;
          for (const device of devices.slice(0, 200)) {
            const measured = await sizer.measure(device.dataPath, { budget });
            bytes += measured.bytes; activityMs = Math.max(activityMs, measured.activityMs); approximate ||= measured.approximate;
          }
          truncated ||= approximate;
          const path = join(home, 'Library', 'Developer', 'CoreSimulator', 'Devices');
          push({ ...base('global-cache', `${path}#unavailable`, { bytes, activityMs, approximate }), path: display(path), name: `${plural(devices.length, 'unavailable simulator')}`,
            reclaimable: false, advisory: true, hint: 'xcrun simctl delete unavailable', reason: 'Simulators for runtimes that are no longer installed.', ownedBy: 'system' },
          { path, kind: 'global-cache', advisory: true });
        }
      }
    }
  }

  const report = {
    scannedAt: new Date(now).toISOString(), durationMs: clock() - started, truncated: truncated || budget.exhausted,
    ...(disk ? { disk } : {}), state, aggressive: keep.aggressive,
    retention: { finishedWorkspaceTtlHours: keep.finishedWorkspaceTtlHours, idleArtifactTtlHours: keep.idleArtifactTtlHours, cleanupForeignWorktrees: policy.cleanupForeignWorktrees, autoClean: policy.autoClean },
    items, processes,
  };
  return { report, locations };
}

/** Bytes a cleanup of the reclaimable items would free, without double counting artifacts inside deleted parents. */
export function reclaimableBytes(items) {
  const deleted = new Set(items.filter(item => item.reclaimable && item.action === 'delete').map(item => item.id));
  return items.filter(item => item.reclaimable && !(item.parentId && deleted.has(item.parentId))).reduce((sum, item) => sum + item.bytes, 0);
}

/** The compact summary a node sends with each heartbeat. */
export function summarize(report, { top = 5 } = {}) {
  const byKind = {};
  const deleted = new Set(report.items.filter(item => item.reclaimable && item.action === 'delete').map(item => item.id));
  for (const item of report.items) {
    if (!item.reclaimable || (item.parentId && deleted.has(item.parentId))) continue;
    byKind[item.kind] = (byKind[item.kind] ?? 0) + item.bytes;
  }
  const advisoryBytes = report.items.filter(item => item.advisory).reduce((sum, item) => sum + item.bytes, 0);
  return {
    scannedAt: report.scannedAt, state: report.state, ...(report.disk ? { disk: report.disk } : {}), truncated: report.truncated,
    reclaimableBytes: Object.values(byKind).reduce((sum, value) => sum + value, 0), reclaimableByKind: byKind, advisoryBytes,
    attentionCount: report.items.filter(item => item.attention).length, staleProcesses: report.processes.length, items: report.items.length,
    top: [...report.items].filter(item => item.reclaimable || item.attention).sort((a, b) => b.bytes - a.bytes).slice(0, top)
      .map(item => ({ id: item.id, kind: item.kind, path: item.path, bytes: item.bytes, reclaimable: item.reclaimable, ...(item.attention ? { attention: true } : {}) })),
  };
}
