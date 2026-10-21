import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { git } from './workspace.js';

/**
 * Evidence for a `step: 'rebase'` assignment, derived from Git rather than from the agent's reply.
 *
 * The reference is Git's own three-way merge of the reviewed head onto the new base
 * (`git merge-tree --write-tree --merge-base=<fork point> <base> <reviewed head>`). A rebase that only
 * resolved conflicts produces exactly that tree, except inside the conflict hunks it left behind. Anything
 * else (another edit in a conflicted file, a change to a cleanly merged file, a new or deleted file) is
 * beyond the conflicts. When Git cannot answer, the result is left out so the engine repeats review.
 */

const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };

/** Run git, resolving `{ code, stdout }` for the exit codes in `ok` and rejecting otherwise. */
function run(cwd, args, { signal, ok = [0], timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, signal, timeout: timeoutMs, encoding: 'utf8', maxBuffer: MAX_BLOB_BYTES, env: { ...process.env, ...GIT_ENV } }, (error, stdout) => {
      const code = error ? error.code : 0;
      if (typeof code === 'number' && ok.includes(code)) resolve({ code, stdout });
      else reject(Object.assign(new Error(`git ${args[0]} failed.`), { code: 'GIT_FAILED' }));
    });
  });
}
const isAncestor = (cwd, ancestor, commit, signal) => run(cwd, ['merge-base', '--is-ancestor', ancestor, commit], { signal, ok: [0, 1] }).then(result => result.code === 0);
const resolveCommit = (cwd, ref, signal) => git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { signal }).catch(() => null);

/** True while a rebase, merge or cherry-pick is unfinished in the checkout. */
async function operationInProgress(checkout, signal) {
  for (const name of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
    const path = await git(checkout, ['rev-parse', '--git-path', name], { signal });
    try { await access(isAbsolute(path) ? path : join(checkout, path)); return true; } catch { /* absent */ }
  }
  return false;
}

/** Blob content at `<tree>:<path>`, or null when the path is absent there. */
async function blob(checkout, tree, path, signal) {
  try { return (await run(checkout, ['cat-file', 'blob', `${tree}:${path}`], { signal })).stdout; } catch { return null; }
}

/**
 * The parts of a merge result outside its conflict hunks, as line lists in order, or null when the file
 * has no conflict markers Git's default style would write (binary files, custom marker sizes).
 */
function cleanSegments(content) {
  const lines = content.split('\n');
  const segments = [[]];
  let inside = false;
  let conflicts = 0;
  for (const line of lines) {
    if (!inside && /^<{7}(?: |$)/.test(line)) { inside = true; conflicts++; continue; }
    if (inside) { if (/^>{7}(?: |$)/.test(line)) { inside = false; segments.push([]); } continue; }
    segments.at(-1).push(line);
  }
  return conflicts && !inside ? segments : null;
}

const matchesAt = (lines, segment, at) => segment.every((line, index) => lines[at + index] === line);

/** True when `content` is the clean segments in order, with anything in place of each conflict hunk. */
function onlyConflictsResolved(segments, content) {
  const lines = content.split('\n');
  const first = segments[0], last = segments.at(-1);
  if (first.length + last.length > lines.length) return false;
  if (!matchesAt(lines, first, 0) || !matchesAt(lines, last, lines.length - last.length)) return false;
  let at = first.length;
  const end = lines.length - last.length;
  for (const segment of segments.slice(1, -1)) {
    let found = -1;
    for (let start = at; start + segment.length <= end; start++) if (matchesAt(lines, segment, start)) { found = start; break; }
    if (found === -1) return false;
    at = found + segment.length;
  }
  return true;
}

/**
 * Check a finished rebase and work out whether it changed anything outside the conflict hunks.
 * @param {string} checkout
 * @param {{ baseRef: string, baseHead: string, previousHead: string, headSha: string, signal?: AbortSignal }} options
 *   `baseHead` is the base commit when the step started; the agent may have fetched a newer one into `baseRef`.
 * @returns {Promise<{ ok: false, reason: string } | { ok: true, base: string, conflicted: string[], beyondConflicts?: string[], touchedBeyondConflicts?: boolean }>}
 */
export async function verifyRebase(checkout, { baseRef, baseHead, previousHead, headSha, signal }) {
  if (await operationInProgress(checkout, signal)) return { ok: false, reason: 'The rebase is still in progress; conflicts were not resolved and committed.' };
  const latest = await resolveCommit(checkout, baseRef, signal);
  const candidates = [...new Set([latest, baseHead].filter(Boolean))];
  let base = null;
  for (const candidate of candidates) if (await isAncestor(checkout, candidate, headSha, signal)) { base = candidate; break; }
  if (!base) return { ok: false, reason: `The rebased head ${headSha} does not contain ${baseRef}.` };
  if (headSha === previousHead) return { ok: true, base, conflicted: [], beyondConflicts: [], touchedBeyondConflicts: false };
  try {
    const forkPoint = await git(checkout, ['merge-base', previousHead, base], { signal });
    const merged = await run(checkout, ['-c', 'merge.conflictStyle=merge', 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z',
      `--merge-base=${forkPoint}`, base, previousHead], { signal, ok: [0, 1] });
    const [tree, ...names] = merged.stdout.split('\0').filter(Boolean);
    const conflicted = [...new Set(names)];
    const changed = (await run(checkout, ['diff', '--name-only', '--no-renames', '-z', tree, `${headSha}^{tree}`], { signal })).stdout.split('\0').filter(Boolean);
    // Marker labels differ between rebase and merge-tree, so look for markers in every conflicted file.
    for (const path of conflicted) {
      const left = await blob(checkout, headSha, path, signal);
      if (left !== null && cleanSegments(left)) return { ok: false, reason: `The rebased head still has conflict markers in ${path}.` };
    }
    const beyond = [];
    for (const path of changed) {
      if (!conflicted.includes(path)) { beyond.push(path); continue; }
      const segments = cleanSegments(await blob(checkout, tree, path, signal) ?? '');
      if (!segments || !onlyConflictsResolved(segments, await blob(checkout, headSha, path, signal) ?? '')) beyond.push(path);
    }
    return { ok: true, base, conflicted, beyondConflicts: beyond, touchedBeyondConflicts: beyond.length > 0 };
  } catch {
    // An older Git without merge-tree --write-tree, or an unreadable object: no evidence, so review repeats.
    return { ok: true, base, conflicted: [] };
  }
}
