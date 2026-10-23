import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { HubError } from '../errors.js';

/** Stream a stored CI artifact file as an attachment, outside the request serializer. */
export async function sendFile(response, { path, name, size }) {
  let info;
  try { info = await stat(path); } catch { throw new HubError(404, 'NOT_FOUND', 'Artifact not found.'); }
  if (!info.isFile() || info.size !== size) throw new HubError(409, 'ARTIFACT_UNAVAILABLE', 'The stored artifact does not match its record.');
  const filename = name.replace(/[^A-Za-z0-9._-]/g, '_') || 'artifact';
  response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${filename}"`, 'X-Content-Type-Options': 'nosniff' });
  await pipeline(createReadStream(path), response);
}
