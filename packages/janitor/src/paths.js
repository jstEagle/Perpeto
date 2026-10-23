import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** `~/x` to `<home>/x`; absolute paths unchanged. */
export function expandHome(path, home) {
  if (path === '~') return home;
  return path.startsWith('~/') ? resolve(home, path.slice(2)) : resolve(path);
}

/** True when `path` is strictly inside `root` (never the root itself). Both must already be real, resolved paths. */
export function isInside(root, path) {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/**
 * A path safe to show off the machine: labelled roots first (`<node-data>/assignments/…`), then the home directory as
 * `~`. Node never sends real paths it would act on; the hub refers to items only by id.
 */
export function displayPath(path, { home, labels = [] } = {}) {
  for (const { root, label } of labels) {
    if (path === root) return label;
    if (isInside(root, path)) return `${label}/${relative(root, path).split(sep).join('/')}`;
  }
  if (home && (path === home || isInside(home, path))) return path === home ? '~' : `~/${relative(home, path).split(sep).join('/')}`;
  return path;
}

/** Stable id for an item: the same kind and path keep their id across scans, so the hub can request it later. */
export function itemId(kind, path) {
  return `sti_${createHash('sha256').update(`${kind}\0${path}`).digest('hex').slice(0, 20)}`;
}
