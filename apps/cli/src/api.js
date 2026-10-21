import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { platform, arch } from 'node:os';
import { unlink } from 'node:fs/promises';
import { configPath, hubUrl, nodeConfig, privateDir, readJson, readSecret, writeNew, writePrivateJson } from './config.js';
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
export async function join(dir, url, { code, codeFile, labels, name, platformName = platform(), fetchImpl = fetch } = {}) {
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
    const config = pending?.config ?? nodeConfig(dir, url, { labels, name });
    if (pending && (pending.body.code !== code || config.hubUrl !== url ||
      (name !== undefined && name !== config.name) || (labels !== undefined && JSON.stringify(labels) !== JSON.stringify(config.labels)))) throw new Error('A different enrollment is pending. Retry its original command.');
    if (!pending) {
      try { await readJson(configPath(dir, 'node')); throw new Error('Node is already configured. Use a different --dir for another identity.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await privateDir(resolve(dir, 'node'));
      pending = { config, body: { code, name: config.name, os: platformName === 'win32' ? 'windows' : platformName, arch: arch(), labels: config.labels,
        providers: [], version: '0.0.1', idempotencyKey: randomUUID() } };
      await writeNew(pendingPath, JSON.stringify(pending));
    }
    const credential = await request(url, '/nodes/enroll', { body: pending.body, fetchImpl });
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

export async function decide(dir, workItemId, decision, note, { fetchImpl = fetch } = {}) {
  const { url, token } = await owner(dir);
  const get = path => request(url, path, { token, fetchImpl });
  // The hub exposes items through runs, not a single-item GET route.
  const { projects } = await get('/projects');
  for (const project of projects) {
    const { runs } = await get(`/projects/${encodeURIComponent(project.id)}/runs?status=running`);
    for (const run of runs) {
      const { workItems } = await get(`/runs/${encodeURIComponent(run.id)}/work-items`);
      const item = workItems.find(item => item.id === workItemId);
      if (!item) continue;
      if (item.status !== 'blocked' || typeof item.decisionId !== 'string' || !item.decisionId) throw new Error('Work item is not awaiting a human decision.');
      return request(url, `/work-items/${encodeURIComponent(workItemId)}/decision`, { token, fetchImpl,
        body: { decision, decisionId: item.decisionId, ...(note !== undefined ? { note } : {}), idempotencyKey: randomUUID() } });
    }
  }
  throw new Error('Work item not found in a running run.');
}

export async function rotateToken(dir, { fetchImpl = fetch } = {}) {
  await privateDir(dir);
  let release;
  try { release = await acquireLock(dir, 'node'); }
  catch { throw new Error('Stop the node before rotating its token.'); }
  let daemonRelease;
  try {
    const config = await readJson(configPath(dir, 'node'));
    try { daemonRelease = await acquireLock(resolve(dir, config.dataDir ?? './node'), 'daemon', { recover: false }); }
    catch { throw new Error('Stop the node before rotating its token.'); }
    const credentialPath = resolve(dir, config.credentialFile ?? `${config.dataDir ?? './node'}/machine.json`);
    const credential = JSON.parse(await readSecret(credentialPath));
    const pendingPath = resolve(dir, 'rotate.secret');
    let pending;
    try { pending = JSON.parse(await readSecret(pendingPath)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pending && (pending.hubUrl !== config.hubUrl || pending.credential.machineId !== credential.machineId ||
      ![pending.credential.token, pending.result?.token].includes(credential.token))) throw new Error('A different token rotation is pending. Inspect rotate.secret.');
    if (!pending) {
      pending = { hubUrl: config.hubUrl, credential, body: { idempotencyKey: randomUUID() } };
      await writeNew(pendingPath, JSON.stringify(pending));
    }
    if (!pending.result) {
      const result = await request(config.hubUrl, '/nodes/token', { token: pending.credential.token, body: pending.body, fetchImpl });
      if (result.machineId !== credential.machineId || typeof result.token !== 'string' || !result.token.trim()) throw new Error('Invalid token rotation response.');
      pending.result = result;
      await writePrivateJson(pendingPath, pending);
    }
    await writePrivateJson(credentialPath, { ...credential, ...pending.result });
    await unlink(pendingPath);
    return { machineId: credential.machineId };
  } finally { await daemonRelease?.(); await release(); }
}
