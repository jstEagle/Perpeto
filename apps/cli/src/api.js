import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { platform, arch } from 'node:os';
import { unlink } from 'node:fs/promises';
import { configPath, hubUrl, nodeConfig, privateDir, readJson, readSecret, writeNew } from './config.js';
import { acquireLock, control } from './process.js';

export async function request(url, path, { token, body, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(`${hubUrl(url)}/api/v1${path}`, { method: body ? 'POST' : 'GET', redirect: 'error',
      signal: AbortSignal.timeout(5000), headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch { throw new Error('Hub request failed. Check the URL and network connection.'); }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Hub rejected the request (HTTP ${response.status}).`); }
  try { return await response.json(); } catch { throw new Error('Hub returned invalid JSON.'); }
}
export async function owner(dir) {
  const config = await readJson(configPath(dir, 'hub'));
  const running = await control(dir, 'hub').catch(() => null);
  const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
  const port = running?.url ? new URL(running.url).port : config.port;
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  return { url, token: (await readSecret(resolve(dir, config.ownerTokenPath))).trim() };
}
export async function enrollCode(dir, labels = []) {
  const { url, token } = await owner(dir);
  const result = await request(url, '/machines/enrollment-codes', { token, body: { idempotencyKey: randomUUID() } });
  if (typeof result.code !== 'string' || typeof result.id !== 'string' || !/^enr_[a-zA-Z0-9_-]+$/.test(result.id)) throw new Error('Invalid enrollment response.');
  const path = resolve(dir, `${result.id}.secret`);
  await writeNew(path, JSON.stringify({ code: result.code, labels, expiresAt: result.expiresAt }));
  return { ...result, path };
}
export async function join(dir, url, { code, codeFile, labels, name } = {}) {
  await privateDir(dir); url = hubUrl(url);
  if (codeFile) {
    const content = (await readSecret(resolve(codeFile))).trim();
    if (content.startsWith('{')) {
      const input = JSON.parse(content);
      code = input.code; labels ??= input.labels;
    } else code = content;
  }
  if (typeof code !== 'string' || !code.trim()) throw new Error('Enrollment code is required.');
  const release = await acquireLock(dir, 'join');
  const pendingPath = resolve(dir, 'join.secret');
  try {
    let pending;
    try { pending = JSON.parse(await readSecret(pendingPath)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const config = nodeConfig(dir, url, { labels, name });
    if (pending && (pending.body.code !== code || JSON.stringify(pending.config) !== JSON.stringify(config))) throw new Error('A different enrollment is pending. Retry its original command.');
    if (!pending) {
      try { await readJson(configPath(dir, 'node')); throw new Error('Node is already configured. Use a different --dir for another identity.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await privateDir(resolve(dir, 'node'));
      pending = { config, body: { code, name: config.name, os: platform(), arch: arch(), labels: config.labels,
        providers: [], version: '0.0.1', idempotencyKey: randomUUID() } };
      await writeNew(pendingPath, JSON.stringify(pending));
    }
    const credential = await request(url, '/nodes/enroll', { body: pending.body });
    if (typeof credential.token !== 'string' || typeof credential.machineId !== 'string') throw new Error('Invalid enrollment response.');
    const credentialPath = resolve(dir, config.credentialFile);
    // A retry after a successful write verifies the same identity instead of replacing it.
    try { await writeNew(credentialPath, JSON.stringify(credential)); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = JSON.parse(await readSecret(credentialPath));
      if (existing.token !== credential.token || existing.machineId !== credential.machineId) throw new Error('Machine credential already exists with a different identity.');
    }
    try { await writeNew(configPath(dir, 'node'), `${JSON.stringify(config, null, 2)}\n`); }
    catch (error) { if (error.code !== 'EEXIST' || JSON.stringify(await readJson(configPath(dir, 'node'))) !== JSON.stringify(config)) throw error; }
    await unlink(pendingPath);
    return { machineId: credential.machineId, hubUrl: url };
  } finally { await release(); }
}
