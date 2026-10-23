import { dirname } from 'node:path';
import { isInside } from './paths.js';

/**
 * Which inventory items a cleanup would touch. With `itemIds`, only those (each must still be reclaimable); without,
 * every reclaimable item. Artifacts inside a folder that is being deleted are folded into it.
 */
export function planCleanup(report, { itemIds } = {}) {
  const byId = new Map(report.items.map(item => [item.id, item]));
  const requested = itemIds ? [...new Set(itemIds)] : report.items.filter(item => item.reclaimable).map(item => item.id);
  const actions = []; const skipped = [];
  for (const id of requested) {
    const item = byId.get(id);
    if (!item) { skipped.push({ itemId: id, status: 'skipped', reason: 'Not in the latest inventory; scan again.' }); continue; }
    if (!item.reclaimable || !item.action) { skipped.push({ itemId: id, kind: item.kind, path: item.path, bytes: item.bytes, status: 'skipped', reason: item.reason }); continue; }
    actions.push({ itemId: id, kind: item.kind, path: item.path, action: item.action, bytes: item.bytes, ...(item.parentId ? { parentId: item.parentId } : {}) });
  }
  const deleting = new Set(actions.filter(action => action.action === 'delete').map(action => action.itemId));
  return { actions: actions.filter(action => !(action.parentId && deleting.has(action.parentId))), skipped };
}

/** Append-only JSON-lines journal of every deletion intent and outcome, rotated at `maxBytes` (one previous file kept). */
export function createJournal({ fs, path, maxBytes = 1024 * 1024 }) {
  let writes = Promise.resolve();
  return {
    path,
    write(entry) {
      const line = `${JSON.stringify(entry)}\n`;
      const next = writes.then(async () => {
        await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const size = await fs.stat(path).then(stat => stat.size, () => 0);
        if (size + line.length > maxBytes) await fs.rename(path, `${path}.1`).catch(() => {});
        await fs.appendFile(path, line, { mode: 0o600 });
      });
      writes = next.catch(() => {});
      return next;
    },
  };
}

/**
 * Execute (or dry-run) a plan against the real paths the node kept from its own scan. Each action is re-checked right
 * before it runs: the path must still be a real directory (not a symlink) inside an allowed root, unused by running
 * work, and its Git state must still be clean and pushed (artifacts: still ignored). Every deletion is journaled
 * before and after. Nothing outside `locations` can be addressed: the hub sends item ids, never paths.
 *
 * @param {{plan: {actions: object[], skipped: object[]}, locations: Map<string, object>, allowedRoots: string[], fs: object, git: object,
 *   journal?: {write: (entry: object) => Promise<void>}, dryRun?: boolean, cleanupId: string, isActive?: (path: string) => boolean,
 *   policy: object, clock?: () => number}} options
 */
export async function executeCleanup({ plan, locations, allowedRoots, fs, git, journal, dryRun = false, cleanupId, isActive = () => false, policy, clock = Date.now }) {
  const startedAt = new Date(clock()).toISOString();
  const roots = [];
  for (const root of allowedRoots) { try { roots.push(await fs.realpath(root)); } catch { /* Missing roots allow nothing. */ } }
  const results = [...plan.skipped];
  let freedBytes = 0;
  for (const action of plan.actions) {
    const location = locations.get(action.itemId);
    const outcome = await check(action, location);
    if (outcome) { results.push({ ...action, status: outcome.status, reason: outcome.reason }); continue; }
    if (dryRun) { results.push({ ...action, status: action.action === 'strip' ? 'would-strip' : 'would-delete' }); freedBytes += action.bytes; continue; }
    const entry = { cleanupId, itemId: action.itemId, kind: action.kind, action: action.action, path: location.path, bytes: action.bytes };
    try {
      // A linked worktree's metadata lives in its main repository; note it before the folder (and its .git file) goes.
      const commons = [];
      for (const path of action.action === 'delete' ? location.gitPaths ?? [] : []) {
        const common = await git.commonDir(path).catch(() => null);
        if (common && !isInside(location.path, common) && !commons.includes(common)) commons.push(common);
      }
      await journal?.write({ at: new Date(clock()).toISOString(), phase: 'intent', ...entry });
      // rm never follows symlinks inside the tree: links are unlinked, not traversed.
      await fs.rm(location.path, { recursive: true, force: true, maxRetries: 2 });
      for (const common of commons) await git.prune(common).catch(() => {});
      await journal?.write({ at: new Date(clock()).toISOString(), phase: 'done', ...entry });
      results.push({ ...action, status: action.action === 'strip' ? 'stripped' : 'deleted' });
      freedBytes += action.bytes;
    } catch (error) {
      await journal?.write({ at: new Date(clock()).toISOString(), phase: 'failed', ...entry, error: String(error?.code ?? 'ERROR') }).catch(() => {});
      results.push({ ...action, status: 'failed', reason: `Deletion failed (${error?.code ?? 'error'}).` });
    }
  }
  return { cleanupId, dryRun, startedAt, finishedAt: new Date(clock()).toISOString(), freedBytes, actions: results };

  async function check(action, location) {
    if (!location || location.advisory) return { status: 'skipped', reason: 'Advisory or unknown item; the janitor never deletes it.' };
    let stat;
    try { stat = await fs.lstat(location.path); } catch { return { status: 'skipped', reason: 'Already gone.' }; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { status: 'skipped', reason: 'No longer a plain folder.' };
    let realPath;
    try { realPath = await fs.realpath(location.path); } catch { return { status: 'skipped', reason: 'Already gone.' }; }
    if (realPath !== location.path) return { status: 'skipped', reason: 'The path now resolves through a symlink.' };
    let root;
    try { root = await fs.realpath(location.root); } catch { return { status: 'skipped', reason: 'Its root is gone.' }; }
    if (!roots.includes(root) || !isInside(root, realPath)) return { status: 'skipped', reason: 'Outside the roots this machine may clean.' };
    if (location.parentPath && !isInside(location.parentPath, realPath)) return { status: 'skipped', reason: 'Outside its worktree.' };
    if (isActive(realPath) || (location.parentPath && isActive(location.parentPath))) return { status: 'skipped', reason: 'Running work uses it now.' };
    if (action.action === 'strip') {
      if (!location.gitRoot || !(await git.ignored(location.gitRoot, realPath))) return { status: 'skipped', reason: 'No longer ignored by Git.' };
      return null;
    }
    for (const path of location.gitPaths ?? []) {
      const state = await git.state(path).catch(() => ({ dirty: true, unpushedCommits: 0 }));
      if (state.dirty || state.unpushedCommits) return { status: 'needs-attention', reason: state.dirty ? 'Changed since the scan: uncommitted changes.' : `Changed since the scan: ${state.unpushedCommits} unpushed commit(s).` };
      if (location.kind === 't3-worktree' && (!policy?.cleanupForeignWorktrees || state.merged !== true)) return { status: 'skipped', reason: 'Foreign worktree is no longer merged, or foreign cleanup is off.' };
    }
    if (location.kind === 't3-worktree' && !policy?.cleanupForeignWorktrees) return { status: 'skipped', reason: 'cleanupForeignWorktrees is off.' };
    return null;
  }
}
