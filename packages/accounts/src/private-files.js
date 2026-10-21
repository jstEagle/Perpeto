import * as fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class AccountPoolError extends Error {
  constructor(code) {
    super(`Account pool: ${code}.`);
    this.name = 'AccountPoolError';
    this.code = code;
  }
}

export function fail(code) { throw new AccountPoolError(code); }

/** Never attach filesystem errors, source content, or JSON parser excerpts. */
export function guarded(fn) {
  try { return fn(); }
  catch (error) {
    if (error instanceof AccountPoolError) throw error;
    fail('LOCAL_STORAGE_ERROR');
  }
}

export function assertPrivate(target, directory = false) {
  const stat = fs.lstatSync(target);
  if (typeof process.getuid !== 'function') fail('UNSUPPORTED_PERMISSIONS');
  if (stat.uid !== process.getuid() || stat.isSymbolicLink()
      || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
      || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) fail('UNSAFE_PERMISSIONS');
}

export function privateDirectory(target) {
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  assertPrivate(target, true);
}

/** Check every directory below a trusted root; no symlink traversal. */
export function privatePath(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('INVALID_PATH');
  assertPrivate(root, true);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    assertPrivate(current, true);
  }
}

export function readPrivate(target) {
  assertPrivate(target);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
      fail('UNSAFE_PERMISSIONS');
    }
    if (stat.size > 4 * 1024 * 1024) fail('FILE_TOO_LARGE');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

export function readJson(target) { return JSON.parse(readPrivate(target)); }

export function writePrivate(target, content) {
  const temporary = path.join(path.dirname(target), `.write-${randomUUID()}`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, target);
    // Persist the rename as well as the content.
    const parent = fs.openSync(path.dirname(target), 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}
