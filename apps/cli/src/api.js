import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { platform, arch } from 'node:os';
import { readFile, unlink } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { createTransport, fingerprintOf } from '@perpeto/node';
import { configPath, decodeJoinCode, hubUrl, nodeConfig, privateDir, readJson, readSecret, writeNew, writePrivateJson } from './config.js';
import { acquireLock, control } from './process.js';

/**
 * A hub request. HTTPS hubs with `pins` trust only those certificate fingerprints (the hub's self-signed certificate);
 * without pins, HTTPS uses the system CAs (for example a tailnet URL). `fetchImpl` lets tests stand in for the hub.
 */
export async function request(url, path, { token, body, pins, fetchImpl = fetch } = {}) {
  let response;
  const init = { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(5000), headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) };
  const transport = fetchImpl === fetch ? createTransport(hubUrl(url), pins ? { pins: () => pins } : {}) : null;
  try {
    try { response = transport ? await transport.request(path, init) : await fetchImpl(`${hubUrl(url)}/api/v1${path}`, { ...init, redirect: 'error' }); }
    catch (error) {
      if (error.code === 'HUB_CERTIFICATE_MISMATCH') throw new Error(`The hub's certificate (${error.fingerprint}) does not match the pinned fingerprint. Do not continue unless the hub owner confirms a new certificate.`);
      throw new Error('Hub request failed. Check the URL and network connection.');
    }
    return await read(response);
  } finally { transport?.close(); }
}
async function read(response) {
  if (!response.ok) { if (response.body?.cancel) await response.body.cancel(); else response.body?.resume?.(); throw new Error(`Hub rejected the request (HTTP ${response.status}).`); }
  try { return await response.json(); } catch { throw new Error('Hub returned invalid JSON.'); }
}
/** The fingerprints of the hub's own certificate files (served, and next during a rotation), read on the hub host. */
export async function ownCertificatePins(dir, config) {
  if (!config.tlsEnabled) return undefined;
  const pins = [];
  for (const path of [config.tlsCertPath, `${config.tlsCertPath}.next`]) {
    try { pins.push(fingerprintOf(new X509Certificate(await readFile(resolve(dir, path))).raw)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return pins;
}
export async function owner(dir) {
  const config = await readJson(configPath(dir, 'hub'));
  const running = await control(dir, 'hub').catch(() => null);
  const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
  const port = running?.url ? new URL(running.url).port : config.port;
  const url = `${config.tlsEnabled ? 'https' : 'http'}://${host.includes(':') ? `[${host}]` : host}:${port}`;
  return { url, config, pins: await ownCertificatePins(dir, config), token: (await readSecret(resolve(dir, config.ownerTokenPath))).trim() };
}
/** One-time enrollment: a secret file for --code-file, and a join code for perpeto node join. */
export async function enrollCode(dir, labels = [], { url: joinUrl } = {}) {
  const { url, token, pins, config } = await owner(dir);
  // An explicit URL is the hub's own HTTPS address on the network, so it is pinned; an exposed tailnet URL is
  // served by tailscale with a CA certificate, so it is not.
  const target = joinUrl ? { url: hubUrl(joinUrl), pin: true } : config.publicUrl ? { url: config.publicUrl, pin: false } : {};
  const result = await request(url, '/machines/enrollment-codes', { token, pins, body: { ...target, idempotencyKey: randomUUID() } });
  if (typeof result.code !== 'string' || typeof result.id !== 'string' || !/^enr_[a-zA-Z0-9_-]+$/.test(result.id) || typeof result.joinCode !== 'string') throw new Error('Invalid enrollment response.');
  const path = resolve(dir, `${result.id}.secret`);
  await writeNew(path, JSON.stringify({ code: result.code, labels, expiresAt: result.expiresAt }));
  return { ...result, path };
}
export async function join(dir, url, { code, codeFile, joinCode, labels, name, observe, platformName = platform(), fetchImpl = fetch } = {}) {
  let fingerprint;
  if (joinCode) ({ url, code, fingerprint } = decodeJoinCode(joinCode));
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
    const config = pending?.config ?? nodeConfig(dir, url, { labels, name, fingerprint, observe });
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
    // With a pinned fingerprint the enrollment only reaches the hub whose certificate matches it.
    const credential = await request(url, '/nodes/enroll', { body: pending.body, fetchImpl, ...(config.hubFingerprint ? { pins: [config.hubFingerprint] } : {}) });
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
    return { machineId: credential.machineId, hubUrl: url, ...(config.hubFingerprint ? { fingerprint: config.hubFingerprint } : {}) };
  } finally { await release(); }
}

export async function decide(dir, workItemId, decision, note, { fetchImpl = fetch } = {}) {
  const { url, token, pins } = await owner(dir);
  const get = path => request(url, path, { token, pins, fetchImpl });
  // The hub exposes items through runs, not a single-item GET route.
  const { projects } = await get('/projects');
  for (const project of projects) {
    const { runs } = await get(`/projects/${encodeURIComponent(project.id)}/runs?status=running`);
    for (const run of runs) {
      const { workItems } = await get(`/runs/${encodeURIComponent(run.id)}/work-items`);
      const item = workItems.find(item => item.id === workItemId);
      if (!item) continue;
      if (item.status !== 'blocked' || typeof item.decisionId !== 'string' || !item.decisionId) throw new Error('Work item is not awaiting a human decision.');
      return request(url, `/work-items/${encodeURIComponent(workItemId)}/decision`, { token, pins, fetchImpl,
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
      const result = await request(config.hubUrl, '/nodes/token', { token: pending.credential.token, body: pending.body, fetchImpl, pins: await nodePins(dir, config) });
      if (result.machineId !== credential.machineId || typeof result.token !== 'string' || !result.token.trim()) throw new Error('Invalid token rotation response.');
      pending.result = result;
      await writePrivateJson(pendingPath, pending);
    }
    await writePrivateJson(credentialPath, { ...credential, ...pending.result });
    await unlink(pendingPath);
    return { machineId: credential.machineId };
  } finally { await daemonRelease?.(); await release(); }
}

/** The fingerprints a node trusts: its pins file after a rotation, else the one it joined with. */
export async function nodePins(dir, config) {
  try { return JSON.parse(await readSecret(resolve(dir, config.dataDir ?? './node', 'hub-pins.json'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return config.hubFingerprint ? [config.hubFingerprint] : undefined; }
}

/** Re-pin a stopped node to a new hub certificate (one that missed a rotation), from a fingerprint or a join code. */
export async function repin(dir, value) {
  const fingerprint = /^[a-f0-9]{64}$/.test(value) ? value : decodeJoinCode(value).fingerprint;
  if (!fingerprint) throw new Error('That join code has no fingerprint to pin; the hub uses a CA certificate.');
  await privateDir(dir);
  let release;
  try { release = await acquireLock(dir, 'node'); } catch { throw new Error('Stop the node before re-pinning.'); }
  try {
    const config = await readJson(configPath(dir, 'node'));
    if (!config.hubUrl?.startsWith('https:')) throw new Error('Only an https hub can be pinned.');
    await writePrivateJson(resolve(dir, config.dataDir ?? './node', 'hub-pins.json'), [fingerprint]);
    return { fingerprint };
  } finally { await release(); }
}

/** The hub's certificate: status, announce the next one to pinned machines, or serve it. */
export async function hubTls(dir, action) {
  const { url, token, pins } = await owner(dir);
  return request(url, action === 'status' ? '/tls' : `/tls/${action}`, { token, pins, ...(action === 'status' ? {} : { body: { idempotencyKey: randomUUID() } }) });
}
