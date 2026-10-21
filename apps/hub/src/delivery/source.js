import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { checked, commandRunner } from '@perpeto/delivery/commands';
import { HubError } from '../errors.js';

/**
 * Stream a git bundle holding exactly `revision` and its history. A bundle needs a ref, so a per-request ref in the
 * hub's refs/perpeto namespace points at the revision while the bundle is written to a private temporary file; the
 * response starts only once the bundle is complete, with its length.
 */
export async function sendBundle(response, { repository, revision, jobId }) {
  const git = args => checked(commandRunner, 'git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repository, env: { GIT_TERMINAL_PROMPT: '0' } });
  const ref = `refs/perpeto/bundles/${jobId}/${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), 'perpeto-bundle-'));
  try {
    const file = join(directory, 'source.bundle');
    try {
      await git(['update-ref', ref, `${revision}^{commit}`]);
      if (await git(['rev-parse', '--verify', ref]) !== revision.toLowerCase()) throw new Error('Bundle ref does not match the job revision.');
      await git(['bundle', 'create', '--quiet', file, ref]);
    } catch { throw new HubError(409, 'SOURCE_UNAVAILABLE', 'The hub repository does not hold this job revision.'); }
    response.writeHead(200, { 'Content-Type': 'application/x-git-bundle', 'Content-Length': (await stat(file)).size, 'Cache-Control': 'no-store' });
    await pipeline(createReadStream(file), response);
  } finally {
    await git(['update-ref', '-d', ref]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
