import { createHash, randomUUID } from 'node:crypto';
import { cp, glob, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

const TEMPLATE = /\{\{\s*hashFiles\(\s*('[^']+'(?:\s*,\s*'[^']+')*)\s*\)\s*\}\}/g;
const KEY = /^[A-Za-z0-9._:+=@-]{1,300}$/;
/** Relative paths inside a checkout: no absolute paths, `..` segments, backslashes or NUL. */
export const insideCheckout = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.startsWith('/') &&
  !value.includes('\\') && !value.includes('\0') && !value.split('/').includes('..');

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Files under `root` matching the globs, sorted, excluding `.git`. Only regular files, never followed symlinks. */
export async function matchFiles(root, patterns, limit = 10000) {
  const found = new Set();
  const base = await realpath(root);
  for (const pattern of patterns) {
    if (!insideCheckout(pattern)) throw new Error('Paths must stay inside the checkout.');
    for await (const entry of glob(pattern, { cwd: root, exclude: name => name === '.git' || name.startsWith('.git/') })) {
      if (!insideCheckout(entry) || entry.split('/')[0] === '.git') continue;
      const info = await lstat(join(root, entry)).catch(() => null);
      // A file reached through a symlinked directory could be anywhere on the machine; only real files inside count.
      const real = info?.isFile() ? await realpath(join(root, entry)).catch(() => null) : null;
      const rel = real && relative(base, real);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) found.add(entry);
      if (found.size > limit) throw new Error('Too many files match.');
    }
  }
  return [...found].sort();
}

/** Resolve `{{ hashFiles('a', 'b/**') }}` in a cache key against the checkout. */
export async function resolveKey(template, checkout) {
  let key = template;
  for (const [whole, list] of [...template.matchAll(TEMPLATE)]) {
    const patterns = [...list.matchAll(/'([^']+)'/g)].map(match => match[1]);
    const hash = createHash('sha256');
    for (const file of await matchFiles(checkout, patterns)) hash.update(`${file}\0${await fileHash(join(checkout, file))}\n`);
    key = key.replace(whole, hash.digest('hex').slice(0, 32));
  }
  key = key.replace(/\s+/g, '-');
  if (!KEY.test(key)) throw new Error('Invalid cache key.');
  return key;
}

/** Whether `path` inside the checkout is reached without leaving it through a symlinked parent directory. */
async function contained(checkout, path) {
  if (!insideCheckout(path)) return false;
  const base = await realpath(checkout).catch(() => null);
  if (!base) return false;
  let parent = dirname(join(checkout, path));
  for (;;) {
    const real = await realpath(parent).catch(() => null);
    if (real) { const rel = relative(base, real); return !rel.startsWith('..') && !isAbsolute(rel); }
    if (parent === checkout || dirname(parent) === parent) return false;
    parent = dirname(parent);
  }
}

async function sizeOf(path) {
  const info = await lstat(path).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(path)) total += await sizeOf(join(path, entry));
  return total;
}

/**
 * Per-machine CI dependency cache with a size cap and least-recently-used eviction. Entries are namespaced by project,
 * so one project's jobs can never restore another's files. Only the daemon reads and writes it: steps run sandboxed
 * away from the cache directory and receive restored copies in their own checkout.
 */
export class CiCache {
  constructor({ root, maxBytes }) {
    this.root = root; this.maxBytes = maxBytes; this.sizeBytes = 0; this.entries = 0; this.lock = Promise.resolve();
  }
  serial(fn) { const result = this.lock.then(fn); this.lock = result.catch(() => {}); return result; }
  entryPath(namespace, key) { return join(this.root, 'entries', createHash('sha256').update(`${namespace}\0${key}`).digest('hex')); }
  async init() {
    await mkdir(join(this.root, 'entries'), { recursive: true, mode: 0o700 });
    await rm(join(this.root, 'tmp'), { recursive: true, force: true });
    await mkdir(join(this.root, 'tmp'), { recursive: true, mode: 0o700 });
    await this.serial(() => this.evict());
    return this;
  }
  stats() { return { sizeBytes: this.sizeBytes, maxBytes: this.maxBytes, entries: this.entries }; }
  async list() {
    const result = [];
    for (const name of await readdir(join(this.root, 'entries')).catch(() => [])) {
      try { result.push({ path: join(this.root, 'entries', name), ...JSON.parse(await readFile(join(this.root, 'entries', name, 'meta.json'), 'utf8')) }); }
      catch { await rm(join(this.root, 'entries', name), { recursive: true, force: true }); }
    }
    return result;
  }
  /** Copy a cached entry's paths into the checkout. Returns whether the key was a hit. */
  restore(namespace, key, paths, checkout) {
    return this.serial(async () => {
      const entry = this.entryPath(namespace, key);
      let meta;
      try { meta = JSON.parse(await readFile(join(entry, 'meta.json'), 'utf8')); } catch { return false; }
      for (const path of paths) {
        if (!(await contained(checkout, path))) continue;
        const source = join(entry, 'files', path);
        if (!(await lstat(source).catch(() => null))) continue;
        await rm(join(checkout, path), { recursive: true, force: true });
        await cp(source, join(checkout, path), { recursive: true, force: true, verbatimSymlinks: true, preserveTimestamps: true });
      }
      meta.lastUsedAt = new Date().toISOString();
      await writeFile(join(entry, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
      return true;
    });
  }
  /** Store the checkout's paths under a key unless it exists; evict least recently used entries over the cap. */
  save(namespace, key, paths, checkout) {
    return this.serial(async () => {
      const entry = this.entryPath(namespace, key);
      if (await lstat(entry).catch(() => null)) return { saved: false, reason: 'exists' };
      const temp = join(this.root, 'tmp', randomUUID());
      try {
        await mkdir(join(temp, 'files'), { recursive: true, mode: 0o700 });
        for (const path of paths) {
          if (!(await contained(checkout, path))) continue;
          const source = join(checkout, path);
          if (!(await lstat(source).catch(() => null))) continue;
          await cp(source, join(temp, 'files', path), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
        }
        const sizeBytes = await sizeOf(join(temp, 'files'));
        if (sizeBytes > this.maxBytes) return { saved: false, reason: 'too-large', sizeBytes };
        const at = new Date().toISOString();
        await writeFile(join(temp, 'meta.json'), JSON.stringify({ key, namespace, sizeBytes, createdAt: at, lastUsedAt: at }), { mode: 0o600 });
        try { await rename(temp, entry); }
        catch (error) { if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) return { saved: false, reason: 'exists' }; throw error; }
        await this.evict();
        return { saved: true, sizeBytes };
      } finally { await rm(temp, { recursive: true, force: true }); }
    });
  }
  async evict() {
    const entries = (await this.list()).sort((a, b) => String(a.lastUsedAt).localeCompare(String(b.lastUsedAt)));
    let total = entries.reduce((sum, item) => sum + (Number(item.sizeBytes) || 0), 0);
    let count = entries.length;
    for (const item of entries) {
      if (total <= this.maxBytes) break;
      await rm(item.path, { recursive: true, force: true });
      total -= Number(item.sizeBytes) || 0; count--;
    }
    this.sizeBytes = total; this.entries = count;
  }
}
