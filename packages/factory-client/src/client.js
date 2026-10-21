import { readFileSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class ClientError extends Error {
  constructor(message) { super(message); this.name = 'ClientError'; }
}
function nonblank(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new ClientError(`Invalid ${label}.`);
  return value;
}

export function loadConfig(filename) {
  let config;
  try { config = JSON.parse(readFileSync(filename, 'utf8')); }
  catch { throw new ClientError('Cannot read client configuration JSON.'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new ClientError('Invalid client configuration.');
  const allowed = new Set(['baseUrl', 'projectId', 'roleId', 'channelId', 'credentialFile', 'timeoutMs', 'allowInsecureHttp']);
  if (Object.keys(config).some(key => !allowed.has(key))) throw new ClientError('Unknown configuration field. Credentials must stay in the credential file.');
  for (const key of ['baseUrl', 'projectId', 'roleId', 'channelId', 'credentialFile']) nonblank(config[key], key);
  let url;
  try { url = new URL(config.baseUrl); } catch { throw new ClientError('Invalid baseUrl.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ClientError('baseUrl must be an HTTP(S) URL without credentials, query, or fragment.');
  if (config.allowInsecureHttp !== undefined && typeof config.allowInsecureHttp !== 'boolean') throw new ClientError('allowInsecureHttp must be a boolean.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && config.allowInsecureHttp !== true) throw new ClientError('Remote HTTP requires HTTPS or explicit allowInsecureHttp: true in the client config.');
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 300000)) throw new ClientError('timeoutMs must be between 100 and 300000.');
  return { ...config, baseUrl: config.baseUrl.replace(/\/+$/, ''), credentialFile: resolve(dirname(resolve(filename)), config.credentialFile) };
}

export class FactoryClient {
  #token;
  #config;
  constructor(config) {
    this.#config = config;
    try {
      const stat = lstatSync(config.credentialFile);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error();
      this.#token = readFileSync(config.credentialFile, 'utf8').trim();
      if (!this.#token || /[\r\n]/.test(this.#token)) throw new Error();
    } catch { throw new ClientError('Credential file must be a readable owner-only regular file containing one session token.'); }
  }

  async #request(method, path, body, query = {}, retryable = true) {
    const url = new URL(`${this.#config.baseUrl}/api/perpeto${path}`);
    const encodedBody = body === undefined ? undefined : JSON.stringify(body);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const attempts = retryable ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let response;
      try {
        response = await fetch(url, {
          method, redirect: 'error', signal: AbortSignal.timeout(this.#config.timeoutMs ?? 30000),
          headers: { Authorization: `Bearer ${this.#token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(encodedBody === undefined ? {} : { body: encodedBody }),
        });
      } catch {
        if (attempt + 1 < attempts) continue;
        throw new ClientError('Factory request failed or timed out.');
      }
      if ([429, 502, 503, 504].includes(response.status) && attempt + 1 < attempts) {
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ClientError(`Factory request rejected (HTTP ${response.status}).`);
      }
      try { return await response.json(); }
      catch { throw new ClientError('Factory returned an invalid JSON response.'); }
    }
  }

  #project() { return `/projects/${encodeURIComponent(this.#config.projectId)}`; }
  #channel(channelId = this.#config.channelId) { return `${this.#project()}/channels/${encodeURIComponent(nonblank(channelId, 'channelId'))}`; }
  initProject(name) { return this.#request('PUT', this.#project(), { name: nonblank(name, 'name') }); }
  createChannel(id, name) { return this.#request('POST', `${this.#project()}/channels`, { id: nonblank(id, 'id'), name: nonblank(name, 'name') }); }
  channels() { return this.#request('GET', `${this.#project()}/channels`); }
  send({ body, idempotencyKey, recipientRoleId, channelId } = {}) {
    nonblank(body, 'body'); nonblank(idempotencyKey, 'idempotencyKey');
    if (recipientRoleId !== undefined && recipientRoleId !== null) nonblank(recipientRoleId, 'recipientRoleId');
    return this.#request('POST', `${this.#channel(channelId)}/messages`, {
      senderRoleId: this.#config.roleId, body, idempotencyKey, ...(recipientRoleId === undefined ? {} : { recipientRoleId }),
    });
  }
  read({ after, before, latest, limit, recipientRoleId, channelId } = {}) {
    if (after !== undefined) nonblank(after, 'after');
    if (before !== undefined) nonblank(before, 'before');
    if (latest !== undefined && typeof latest !== 'boolean') throw new ClientError('latest must be a boolean.');
    if (Number(after !== undefined) + Number(before !== undefined) + Number(latest === true) > 1) throw new ClientError('after, before and latest are mutually exclusive.');
    if (recipientRoleId !== undefined) nonblank(recipientRoleId, 'recipientRoleId');
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) throw new ClientError('limit must be between 1 and 500.');
    return this.#request('GET', `${this.#channel(channelId)}/messages`, undefined, { after, before, latest, limit, recipientRoleId });
  }

  submitCi(input) {
    const { repositoryId, revision, command, requiredLabels = [], idempotencyKey } = validateCiSubmission(input);
    return this.#request('POST', '/runner/jobs', {
      projectId: this.#config.projectId, repositoryId, revision, command, requiredLabels, idempotencyKey,
    });
  }
  async ciStatus(jobId) {
    const job = await this.#request('GET', `/runner/jobs/${jobPath(jobId)}`);
    if (job?.projectId !== this.#config.projectId) throw new ClientError('CI job does not belong to the configured project.');
    return job;
  }
  async retryCi(jobId) {
    // Verify project scope before mutation. Retrying this POST automatically could
    // retry another failed attempt if a fast runner completes before recovery.
    await this.ciStatus(jobId);
    return this.#request('POST', `/runner/jobs/${jobPath(jobId)}/retry`, {}, {}, false);
  }
  ciJobs({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ClientError('CI job limit must be between 1 and 100.');
    return this.#request('GET', '/runner/jobs', undefined, { projectId: this.#config.projectId, limit });
  }
}

function jobPath(jobId) {
  nonblank(jobId, 'jobId');
  if (jobId.length > 200 || jobId === '.' || jobId === '..') throw new ClientError('Invalid jobId.');
  return encodeURIComponent(jobId);
}

function validateCiSubmission(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['repositoryId', 'revision', 'command', 'requiredLabels', 'idempotencyKey'].includes(key))) throw new ClientError('Invalid CI job fields. Project comes from client configuration.');
  const { repositoryId, revision, command, requiredLabels = [], idempotencyKey } = input;
  for (const [key, value] of Object.entries({ repositoryId, idempotencyKey })) {
    nonblank(value, key);
    if (value.length > 200) throw new ClientError(`Invalid ${key}.`);
  }
  if (typeof revision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new ClientError('revision must be a full lowercase Git commit SHA.');
  if (!Array.isArray(command) || command.length < 1 || command.length > 100 || command.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 8192)) throw new ClientError('command must be an argv array of 1–100 strings.');
  nonblank(command[0], 'executable');
  if (command[0].length > 200) throw new ClientError('Invalid executable.');
  if (!Array.isArray(requiredLabels) || requiredLabels.length > 32 || requiredLabels.some(label => typeof label !== 'string' || !label.trim() || label.includes('\0') || label.length > 200)) throw new ClientError('requiredLabels must be at most 32 nonblank strings.');
  return { repositoryId, revision, command, requiredLabels, idempotencyKey };
}
