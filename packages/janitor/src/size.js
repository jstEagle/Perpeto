import { join } from 'node:path';

/**
 * Bounded, du-style sizing. Entries are read with lstat and never followed through symlinks; allocated blocks are
 * counted where the platform reports them. Every walk draws from one shared budget (entries and a deadline), so a scan
 * stops early on a huge tree and marks what it measured as approximate instead of grinding the disk. Results are cached
 * per root for `cacheMs` while the root's own mtime is unchanged.
 */
export function createBudget({ maxEntries, timeoutMs, clock = Date.now }) {
  const deadline = clock() + timeoutMs;
  return {
    entries: maxEntries,
    get exhausted() { return this.entries <= 0 || clock() >= deadline; },
    take(count = 1) { this.entries -= count; },
  };
}

const allocated = stat => typeof stat.blocks === 'number' && stat.blocks >= 0 ? stat.blocks * 512 : stat.size;

export function createSizer({ fs, clock = Date.now, cacheMs = 0, concurrency = 32 }) {
  const cache = new Map();
  /**
   * Size `root`. Folders named in `artifactNames`, found at most `maxDepth` levels down (outside `.git`), are measured as
   * separate artifacts and not descended for activity: `activityMs` is the newest mtime outside artifacts.
   * @returns {Promise<{bytes:number, activityMs:number, approximate:boolean, artifacts:{path:string, name:string, bytes:number, activityMs:number, approximate:boolean}[]}>}
   */
  async function measure(root, { budget, artifactNames = [], maxDepth = 0 } = {}) {
    let rootStat;
    try { rootStat = await fs.lstat(root); } catch { return { bytes: 0, activityMs: 0, approximate: false, artifacts: [], missing: true }; }
    const key = `${root}\0${artifactNames.join('/')}\0${maxDepth}`;
    const cached = cache.get(key);
    if (cached && cacheMs > 0 && clock() - cached.at < cacheMs && cached.rootMtimeMs === rootStat.mtimeMs && !cached.result.approximate) return cached.result;
    const names = new Set(artifactNames);
    const result = { bytes: 0, activityMs: rootStat.mtimeMs, approximate: false, artifacts: [] };
    if (!rootStat.isDirectory()) {
      result.bytes = allocated(rootStat);
      return result;
    }
    result.bytes = allocated(rootStat);
    budget?.take();
    // Each stack entry: a directory, its depth, the artifact record it counts into (if any), and whether it is in .git.
    const stack = [{ path: root, depth: 0, artifact: null, git: false }];
    while (stack.length) {
      if (budget?.exhausted) { result.approximate = true; break; }
      const { path, depth, artifact, git } = stack.pop();
      let entries;
      try { entries = await fs.readdir(path, { withFileTypes: true }); } catch { continue; }
      for (let index = 0; index < entries.length; index += concurrency) {
        const slice = entries.slice(index, index + concurrency);
        budget?.take(slice.length);
        const stats = await Promise.all(slice.map(entry => fs.lstat(join(path, entry.name)).then(stat => ({ entry, stat }), () => null)));
        for (const item of stats) {
          if (!item) continue;
          const { entry, stat } = item;
          const child = join(path, entry.name);
          const bytes = allocated(stat);
          result.bytes += bytes;
          if (artifact) { artifact.bytes += bytes; artifact.activityMs = Math.max(artifact.activityMs, stat.mtimeMs); }
          else result.activityMs = Math.max(result.activityMs, stat.mtimeMs);
          if (!stat.isDirectory()) continue; // Symlinks are counted, never followed.
          if (!artifact && !git && depth < maxDepth && names.has(entry.name)) {
            const record = { path: child, name: entry.name, bytes, activityMs: stat.mtimeMs, approximate: false };
            result.artifacts.push(record);
            stack.push({ path: child, depth: depth + 1, artifact: record, git: false });
            continue;
          }
          stack.push({ path: child, depth: depth + 1, artifact, git: git || entry.name === '.git' });
        }
        if (budget?.exhausted && (index + concurrency < entries.length || stack.length)) { result.approximate = true; break; }
      }
    }
    if (result.approximate) for (const artifact of result.artifacts) artifact.approximate = true;
    if (cacheMs > 0) cache.set(key, { at: clock(), rootMtimeMs: rootStat.mtimeMs, result });
    return result;
  }
  return { measure, forget(root) { for (const key of cache.keys()) if (key.startsWith(`${root}\0`)) cache.delete(key); }, cache };
}
