import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { matchFiles } from './ci-cache.js';

const CHUNK = 512 * 1024;
const MAX_FILES = 1000;

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Collect a job's declared artifacts after its steps: `{ name, paths: globs, maxBytes, when }`. Regular files only,
 * inside the checkout, capped per artifact (and by the machine's `artifactMaxBytes`). Files are uploaded in chunks
 * through the job's lease-checked event route. Returns `{ uploaded: ArtifactRef[], notes: string[] }`.
 */
export async function collectArtifacts(specs, { checkout, status, report, maxBytes = Infinity, signal }) {
  const uploaded = []; const notes = [];
  for (const spec of specs ?? []) {
    const when = spec.when ?? 'always';
    if ((when === 'on-success' && status !== 'passed') || (when === 'on-failure' && status === 'passed')) continue;
    let files;
    try { files = await matchFiles(checkout, spec.paths, MAX_FILES); }
    catch (error) { notes.push(`artifact ${spec.name}: ${error.message}`); continue; }
    if (!files.length) { notes.push(`artifact ${spec.name}: no files matched`); continue; }
    const cap = Math.min(spec.maxBytes ?? Infinity, maxBytes);
    let total = 0;
    for (const file of files) {
      signal?.throwIfAborted();
      const path = join(checkout, file);
      const info = await lstat(path);
      if (!info.isFile()) continue;
      if (total + info.size > cap) { notes.push(`artifact ${spec.name}: skipped ${file}, over the ${cap} byte cap`); continue; }
      total += info.size;
      const sha256 = await digest(path);
      const handle = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(CHUNK, Math.max(info.size, 1)));
        for (let offset = 0; offset < info.size || offset === 0;) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset);
          await report({ type: 'artifact', data: { name: spec.name, path: file, size: info.size, sha256, offset, data: buffer.subarray(0, bytesRead).toString('base64') } });
          offset += bytesRead;
          if (!bytesRead) break;
        }
      } finally { await handle.close(); }
      uploaded.push({ name: spec.name, path: file, size: info.size, sha256 });
    }
  }
  return { uploaded, notes };
}
