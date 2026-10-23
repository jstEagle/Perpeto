import { stableHash } from './common.js';

/**
 * Repository-defined CI pipelines: `.perpeto/ci.json`. Validation is pure and total: it returns every problem with a
 * JSON path instead of throwing on the first, so `perpeto ci validate`, the hub and the editor show the same list.
 * The documented schema is in docs/guides/ci.md.
 */

export const PIPELINE_FILE = '.perpeto/ci.json';
export const TRIGGERS = Object.freeze(['manual', 'merge-queue', 'pull-request', 'schedule']);
export const PIPELINE_LIMITS = Object.freeze({
  pipelines: 50, jobs: 100, steps: 50, matrixKeys: 4, matrixValues: 16, combinations: 64, cache: 4, cachePaths: 16, artifacts: 8,
  artifactPaths: 16, env: 64, labels: 16, maxAttempts: 5, timeoutSec: 86400, artifactMaxBytes: 1024 ** 3, configBytes: 256 * 1024,
});
const DEFAULT_TIMEOUT_SEC = 3600;
const DEFAULT_ARTIFACT_BYTES = 50 * 1024 ** 2;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// The runner owns these; a pipeline cannot point a step's HOME, PATH or temp directory elsewhere.
const RESERVED_ENV = /^(?:PATH|HOME|TMPDIR|TMP|TEMP|LANG|LC_ALL|GIT_CONFIG_.*|GIT_TERMINAL_PROMPT|PERPETO_.*)$/;
const TEMPLATE = /\{\{\s*([^}]*?)\s*\}\}/g;
const MATRIX_REF = /^matrix\.([A-Za-z_][A-Za-z0-9_]*)$/;
const HASH_FILES = /^hashFiles\(\s*('[^']+'(?:\s*,\s*'[^']+')*)\s*\)$/;

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 4096) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');
/** Relative paths and globs inside the checkout: no absolute paths, no `..` segments, no NUL. */
export const relativePath = value => text(value, 1024) && !value.startsWith('/') && !value.startsWith('~') && !/^[A-Za-z]:/.test(value) &&
  !value.split(/[\\/]/).includes('..') && !value.includes('\\');

/** Parse JSON text or a value; returns `{ config, errors }`, with `config` normalized when there are no errors. */
export function parsePipelineConfig(input) {
  let raw = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > PIPELINE_LIMITS.configBytes) return failed('$', `Pipeline configuration exceeds ${PIPELINE_LIMITS.configBytes} bytes.`);
    try { raw = JSON.parse(input); } catch (error) { return failed('$', `Invalid JSON: ${error.message}`); }
  }
  const errors = [];
  const error = (path, message) => { if (errors.length < 200) errors.push({ path, message }); };
  const config = normalize(raw, error);
  return errors.length ? { config: null, errors } : { config, errors };
}
const failed = (path, message) => ({ config: null, errors: [{ path, message }] });

function keys(value, allowed, path, error) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) error(`${path}.${key}`, 'Unknown field.');
}
function env(value, path, error) {
  if (value === undefined) return {};
  if (!plain(value)) { error(path, 'env must be an object of string values.'); return {}; }
  const entries = Object.entries(value);
  if (entries.length > PIPELINE_LIMITS.env) error(path, `At most ${PIPELINE_LIMITS.env} variables.`);
  const result = {};
  for (const [name, item] of entries) {
    if (!ENV_NAME.test(name)) error(`${path}.${name}`, 'Variable names are letters, digits and underscores.');
    else if (RESERVED_ENV.test(name)) error(`${path}.${name}`, 'This variable is set by the runner.');
    else if (typeof item !== 'string' || item.length > 4096 || item.includes('\0')) error(`${path}.${name}`, 'Values are strings up to 4096 characters.');
    else result[name] = item;
  }
  return result;
}
function stringList(value, path, error, { max = 16, check = item => text(item, 200), message = 'Expected an array of nonblank strings.' } = {}) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > max || !value.every(check)) { error(path, `${message} (at most ${max})`); return []; }
  if (new Set(value).size !== value.length) error(path, 'Values must be distinct.');
  return [...value];
}
function runsOn(value, path, error) {
  if (value === undefined) return {};
  if (!plain(value)) { error(path, 'runsOn must be an object { pool?, os?, labels? }.'); return {}; }
  keys(value, ['pool', 'os', 'labels'], path, error);
  const result = {};
  if (value.pool !== undefined) { if (!text(value.pool, 100)) error(`${path}.pool`, 'pool must be a nonblank string.'); else result.pool = value.pool; }
  if (value.os !== undefined) {
    if (!['darwin', 'linux', 'windows'].includes(value.os) && !(typeof value.os === 'string' && /^\{\{\s*matrix\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}$/.test(value.os))) error(`${path}.os`, 'os must be darwin, linux, windows or a {{ matrix.<key> }} reference.');
    else result.os = value.os;
  }
  const labels = stringList(value.labels, `${path}.labels`, error, { max: PIPELINE_LIMITS.labels });
  if (labels) result.labels = labels;
  return result;
}
function retry(value, path, error) {
  if (value === undefined) return undefined;
  if (!plain(value) || !Number.isSafeInteger(value.maxAttempts) || value.maxAttempts < 1 || value.maxAttempts > PIPELINE_LIMITS.maxAttempts) {
    error(path, `retry must be { maxAttempts: 1..${PIPELINE_LIMITS.maxAttempts} }.`); return undefined;
  }
  keys(value, ['maxAttempts'], path, error);
  return { maxAttempts: value.maxAttempts };
}
function timeout(value, path, error) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > PIPELINE_LIMITS.timeoutSec) { error(path, `timeoutSec must be an integer from 1 to ${PIPELINE_LIMITS.timeoutSec}.`); return undefined; }
  return value;
}

function normalize(raw, error) {
  if (!plain(raw)) { error('$', 'The configuration must be a JSON object.'); return null; }
  keys(raw, ['$schema', 'version', 'defaults', 'pipelines'], '$', error);
  if (raw.version !== 1) error('$.version', 'version must be 1.');
  const defaults = { runsOn: {}, env: {} };
  if (raw.defaults !== undefined) {
    if (!plain(raw.defaults)) error('$.defaults', 'defaults must be an object.');
    else {
      keys(raw.defaults, ['runsOn', 'env', 'timeoutSec', 'retry'], '$.defaults', error);
      defaults.runsOn = runsOn(raw.defaults.runsOn, '$.defaults.runsOn', error);
      defaults.env = env(raw.defaults.env, '$.defaults.env', error);
      defaults.timeoutSec = timeout(raw.defaults.timeoutSec, '$.defaults.timeoutSec', error);
      defaults.retry = retry(raw.defaults.retry, '$.defaults.retry', error);
    }
  }
  if (!plain(raw.pipelines) || !Object.keys(raw.pipelines).length) { error('$.pipelines', 'pipelines must be an object with at least one pipeline.'); return null; }
  const names = Object.keys(raw.pipelines);
  if (names.length > PIPELINE_LIMITS.pipelines) error('$.pipelines', `At most ${PIPELINE_LIMITS.pipelines} pipelines.`);
  const pipelines = {};
  for (const name of names) {
    const path = `$.pipelines.${name}`;
    if (!NAME.test(name)) { error(path, 'Pipeline names are 1 to 64 letters, digits, ".", "_" or "-".'); continue; }
    const pipeline = pipelineOf(raw.pipelines[name], path, defaults, error);
    if (pipeline) pipelines[name] = pipeline;
  }
  return { version: 1, pipelines };
}

function pipelineOf(value, path, defaults, error) {
  if (!plain(value)) { error(path, 'A pipeline must be an object with jobs.'); return null; }
  keys(value, ['description', 'triggers', 'env', 'jobs'], path, error);
  if (value.description !== undefined && !text(value.description, 1000)) error(`${path}.description`, 'description must be a nonblank string.');
  const triggers = [];
  if (value.triggers !== undefined && (!Array.isArray(value.triggers) || value.triggers.length > 16)) error(`${path}.triggers`, 'triggers must be an array (at most 16).');
  else for (const [index, trigger] of (value.triggers ?? [{ on: 'manual' }]).entries()) {
    const at = `${path}.triggers[${index}]`;
    if (!plain(trigger) || !TRIGGERS.includes(trigger.on)) { error(at, `on must be one of ${TRIGGERS.join(', ')}.`); continue; }
    keys(trigger, trigger.on === 'schedule' ? ['on', 'cron', 'branch'] : trigger.on === 'pull-request' ? ['on', 'branches'] : ['on'], at, error);
    const item = { on: trigger.on };
    if (trigger.on === 'schedule') {
      if (!validCron(trigger.cron)) error(`${at}.cron`, 'cron must be a five-field UTC cron expression.'); else item.cron = trigger.cron;
      if (trigger.branch !== undefined) { if (!text(trigger.branch, 200)) error(`${at}.branch`, 'branch must be a nonblank string.'); else item.branch = trigger.branch; }
    }
    if (trigger.on === 'pull-request') { const branches = stringList(trigger.branches, `${at}.branches`, error); if (branches) item.branches = branches; }
    triggers.push(item);
  }
  const pipelineEnv = env(value.env, `${path}.env`, error);
  if (!plain(value.jobs) || !Object.keys(value.jobs).length) { error(`${path}.jobs`, 'jobs must be an object with at least one job.'); return null; }
  const jobNames = Object.keys(value.jobs);
  if (jobNames.length > PIPELINE_LIMITS.jobs) error(`${path}.jobs`, `At most ${PIPELINE_LIMITS.jobs} jobs.`);
  const jobs = {};
  for (const name of jobNames) {
    const at = `${path}.jobs.${name}`;
    if (!NAME.test(name)) { error(at, 'Job names are 1 to 64 letters, digits, ".", "_" or "-".'); continue; }
    const job = jobOf(value.jobs[name], at, error);
    if (!job) continue;
    job.env = { ...defaults.env, ...pipelineEnv, ...job.env };
    job.runsOn = { ...defaults.runsOn, ...job.runsOn };
    job.timeoutSec ??= defaults.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    job.retry ??= defaults.retry ?? { maxAttempts: 1 };
    jobs[name] = job;
  }
  for (const [name, job] of Object.entries(jobs)) {
    for (const need of job.needs) if (!Object.hasOwn(value.jobs, need)) error(`${path}.jobs.${name}.needs`, `Unknown job "${need}".`);
    if (job.needs.includes(name)) error(`${path}.jobs.${name}.needs`, 'A job cannot need itself.');
  }
  const cycle = findCycle(jobs);
  if (cycle) error(`${path}.jobs`, `needs form a cycle: ${cycle.join(' -> ')}.`);
  return { ...(value.description ? { description: value.description } : {}), triggers, jobs };
}

function jobOf(value, path, error) {
  if (!plain(value)) { error(path, 'A job must be an object with steps.'); return null; }
  keys(value, ['steps', 'needs', 'matrix', 'runsOn', 'timeoutSec', 'env', 'cache', 'artifacts', 'retry'], path, error);
  const steps = [];
  if (!Array.isArray(value.steps) || !value.steps.length || value.steps.length > PIPELINE_LIMITS.steps) error(`${path}.steps`, `steps must be an array of 1 to ${PIPELINE_LIMITS.steps} steps.`);
  else {
    const names = new Set();
    for (const [index, step] of value.steps.entries()) {
      const at = `${path}.steps[${index}]`;
      if (!plain(step) || !text(step.name, 100) || !text(step.run, 10000)) { error(at, 'Each step is { name, run, timeoutSec? } with a nonblank name and command.'); continue; }
      keys(step, ['name', 'run', 'timeoutSec'], at, error);
      if (names.has(step.name)) error(at, `Step name "${step.name}" is repeated.`);
      names.add(step.name);
      const stepTimeout = timeout(step.timeoutSec, `${at}.timeoutSec`, error);
      steps.push({ name: step.name, run: step.run, ...(stepTimeout ? { timeoutSec: stepTimeout } : {}) });
    }
  }
  const needs = stringList(value.needs, `${path}.needs`, error, { max: PIPELINE_LIMITS.jobs, check: item => typeof item === 'string' && NAME.test(item) }) ?? [];
  let matrix;
  if (value.matrix !== undefined) {
    if (!plain(value.matrix) || !Object.keys(value.matrix).length || Object.keys(value.matrix).length > PIPELINE_LIMITS.matrixKeys) error(`${path}.matrix`, `matrix must be an object of 1 to ${PIPELINE_LIMITS.matrixKeys} keys.`);
    else {
      matrix = {};
      let combinations = 1;
      for (const [key, values] of Object.entries(value.matrix)) {
        const at = `${path}.matrix.${key}`;
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(key)) { error(at, 'Matrix keys are letters, digits and underscores.'); continue; }
        if (!Array.isArray(values) || !values.length || values.length > PIPELINE_LIMITS.matrixValues ||
            !values.every(item => ['string', 'number', 'boolean'].includes(typeof item) && String(item).length <= 100 && /^[^{}\n]+$/.test(String(item)))) {
          error(at, `Each matrix key lists 1 to ${PIPELINE_LIMITS.matrixValues} strings, numbers or booleans.`); continue;
        }
        const strings = values.map(String);
        if (new Set(strings).size !== strings.length) error(at, 'Matrix values must be distinct.');
        matrix[key] = strings; combinations *= strings.length;
      }
      if (combinations > PIPELINE_LIMITS.combinations) error(`${path}.matrix`, `A matrix expands to at most ${PIPELINE_LIMITS.combinations} jobs.`);
    }
  }
  const cache = [];
  if (value.cache !== undefined) {
    if (!Array.isArray(value.cache) || value.cache.length > PIPELINE_LIMITS.cache) error(`${path}.cache`, `cache must be an array of at most ${PIPELINE_LIMITS.cache} entries.`);
    else for (const [index, item] of value.cache.entries()) {
      const at = `${path}.cache[${index}]`;
      if (!plain(item) || !text(item.key, 300)) { error(at, 'Each cache is { key, paths }.'); continue; }
      keys(item, ['key', 'paths'], at, error);
      const paths = stringList(item.paths, `${at}.paths`, error, { max: PIPELINE_LIMITS.cachePaths, check: relativePath, message: 'paths must be relative paths inside the checkout' });
      if (!paths?.length) { error(`${at}.paths`, 'At least one path is required.'); continue; }
      cache.push({ key: item.key, paths });
    }
  }
  const artifacts = [];
  if (value.artifacts !== undefined) {
    if (!Array.isArray(value.artifacts) || value.artifacts.length > PIPELINE_LIMITS.artifacts) error(`${path}.artifacts`, `artifacts must be an array of at most ${PIPELINE_LIMITS.artifacts} entries.`);
    else for (const [index, item] of value.artifacts.entries()) {
      const at = `${path}.artifacts[${index}]`;
      if (!plain(item) || !text(item.name, 100) || /[/\\]/.test(item.name)) { error(at, 'Each artifact is { name, paths, maxBytes?, when? } with a name without slashes.'); continue; }
      keys(item, ['name', 'paths', 'maxBytes', 'when'], at, error);
      const paths = stringList(item.paths, `${at}.paths`, error, { max: PIPELINE_LIMITS.artifactPaths, check: relativePath, message: 'paths must be relative globs inside the checkout' });
      if (!paths?.length) { error(`${at}.paths`, 'At least one path is required.'); continue; }
      if (item.maxBytes !== undefined && (!Number.isSafeInteger(item.maxBytes) || item.maxBytes < 1 || item.maxBytes > PIPELINE_LIMITS.artifactMaxBytes)) error(`${at}.maxBytes`, `maxBytes must be 1 to ${PIPELINE_LIMITS.artifactMaxBytes}.`);
      if (item.when !== undefined && !['always', 'on-success', 'on-failure'].includes(item.when)) error(`${at}.when`, 'when must be always, on-success or on-failure.');
      artifacts.push({ name: item.name, paths, maxBytes: item.maxBytes ?? DEFAULT_ARTIFACT_BYTES, when: item.when ?? 'always' });
    }
    if (new Set(artifacts.map(item => item.name)).size !== artifacts.length) error(`${path}.artifacts`, 'Artifact names must be distinct.');
  }
  const job = { steps, needs, env: env(value.env, `${path}.env`, error), runsOn: runsOn(value.runsOn, `${path}.runsOn`, error), cache, artifacts };
  if (matrix) job.matrix = matrix;
  const jobTimeout = timeout(value.timeoutSec, `${path}.timeoutSec`, error); if (jobTimeout) job.timeoutSec = jobTimeout;
  const jobRetry = retry(value.retry, `${path}.retry`, error); if (jobRetry) job.retry = jobRetry;
  // Templates may only name this job's matrix keys; hashFiles is resolved by the runner, in cache keys only.
  const known = new Set(Object.keys(matrix ?? {}));
  const check = (input, at, allowHash = false) => {
    for (const [, expression] of input.matchAll(TEMPLATE)) {
      const reference = MATRIX_REF.exec(expression);
      if (reference && known.has(reference[1])) continue;
      if (allowHash && HASH_FILES.test(expression) && [...expression.matchAll(/'([^']+)'/g)].every(([, item]) => relativePath(item))) continue;
      error(at, `Unknown template {{ ${expression} }}.`);
    }
  };
  for (const [index, step] of steps.entries()) check(step.run, `${path}.steps[${index}].run`);
  for (const [name, item] of Object.entries(job.env)) check(item, `${path}.env.${name}`);
  if (typeof job.runsOn.os === 'string') {
    check(job.runsOn.os, `${path}.runsOn.os`);
    const key = /matrix\.([A-Za-z_][A-Za-z0-9_]*)/.exec(job.runsOn.os)?.[1];
    if (key && matrix?.[key] && !matrix[key].every(item => ['darwin', 'linux', 'windows'].includes(item))) error(`${path}.matrix.${key}`, 'Values used as runsOn.os must be darwin, linux or windows.');
  }
  if (job.runsOn.pool) check(job.runsOn.pool, `${path}.runsOn.pool`);
  for (const label of job.runsOn.labels ?? []) check(label, `${path}.runsOn.labels`);
  for (const [index, item] of cache.entries()) check(item.key, `${path}.cache[${index}].key`, true);
  for (const [index, item] of artifacts.entries()) check(item.name, `${path}.artifacts[${index}].name`);
  return job;
}

function findCycle(jobs) {
  const state = new Map();
  const visit = (name, trail) => {
    if (state.get(name) === 'done' || !jobs[name]) return null;
    if (state.get(name) === 'open') return [...trail.slice(trail.indexOf(name)), name];
    state.set(name, 'open');
    for (const need of jobs[name].needs) { const found = visit(need, [...trail, name]); if (found) return found; }
    state.set(name, 'done');
    return null;
  };
  for (const name of Object.keys(jobs)) { const found = visit(name, []); if (found) return found; }
  return null;
}

/** Same five-field UTC cron as workflow schedules: numeric lists, ranges and steps. */
function validCron(value) {
  if (typeof value !== 'string' || value.length > 200) return false;
  const fields = value.trim().split(/\s+/);
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  return fields.length === 5 && fields.every((field, index) => field.split(',').every(part => {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) return false;
    const [min, max] = bounds[index];
    const [from, to = from] = match[1] === '*' ? [min, max] : match[1].split('-').map(Number);
    return from >= min && to <= max && from <= to && (match[2] === undefined || Number(match[2]) >= 1);
  }));
}

const substitute = (input, matrix) => input.replace(TEMPLATE, (whole, expression) => {
  const reference = MATRIX_REF.exec(expression);
  return reference && Object.hasOwn(matrix, reference[1]) ? matrix[reference[1]] : whole;
});
function combinations(matrix) {
  let result = [{}];
  for (const [key, values] of Object.entries(matrix ?? {})) result = result.flatMap(base => values.map(value => ({ ...base, [key]: value })));
  return result;
}
export const jobKey = (name, matrix) => matrix && Object.keys(matrix).length ? `${name} (${Object.entries(matrix).map(([key, value]) => `${key}=${value}`).join(', ')})` : name;

/**
 * Expand one pipeline into concrete jobs: every matrix combination becomes a job whose key names its values, a need
 * on a matrix job waits for all of its combinations, and templates are substituted (hashFiles stays for the runner).
 * Jobs come back in a topological order. Each carries the `configHash` that binds its evidence.
 */
export function expandPipeline(config, name) {
  const pipeline = config?.pipelines?.[name];
  if (!pipeline) return null;
  const keysByName = new Map();
  const expanded = [];
  for (const jobName of order(pipeline.jobs)) {
    const job = pipeline.jobs[jobName];
    const keys = [];
    for (const matrix of combinations(job.matrix)) {
      const values = job.matrix ? matrix : undefined;
      const key = jobKey(jobName, values);
      keys.push(key);
      const sub = item => values ? substitute(item, values) : item;
      const os = job.runsOn.os ? sub(job.runsOn.os) : undefined;
      const definition = {
        key, name: jobName, ...(values ? { matrix: values } : {}),
        needs: job.needs.flatMap(need => keysByName.get(need) ?? []),
        runsOn: { ...(job.runsOn.pool ? { pool: sub(job.runsOn.pool) } : {}), ...(['darwin', 'linux', 'windows'].includes(os) ? { os } : {}), labels: (job.runsOn.labels ?? []).map(sub) },
        timeoutSec: job.timeoutSec, maxAttempts: job.retry.maxAttempts,
        steps: job.steps.map(step => ({ ...step, run: sub(step.run) })),
        env: { ...Object.fromEntries(Object.entries(job.env).map(([key, value]) => [key, sub(value)])),
          ...Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [`MATRIX_${key.toUpperCase()}`, value])) },
        cache: job.cache.map(item => ({ key: sub(item.key), paths: [...item.paths] })),
        artifacts: job.artifacts.map(item => ({ ...item, name: sub(item.name), paths: [...item.paths] })),
      };
      definition.configHash = stableHash({ pipeline: name, key, steps: definition.steps, env: definition.env, runsOn: definition.runsOn,
        timeoutSec: definition.timeoutSec, cache: definition.cache, artifacts: definition.artifacts });
      expanded.push(definition);
    }
    keysByName.set(jobName, keys);
  }
  return { name, ...(pipeline.description ? { description: pipeline.description } : {}), triggers: pipeline.triggers, jobs: expanded };
}

function order(jobs) {
  const result = []; const done = new Set();
  const visit = name => { if (done.has(name)) return; done.add(name); for (const need of jobs[name].needs) visit(need); result.push(name); };
  for (const name of Object.keys(jobs)) visit(name);
  return result;
}

/** All pipelines of a configuration, expanded, for listings. */
export function describePipelines(config) {
  return Object.keys(config?.pipelines ?? {}).map(name => expandPipeline(config, name));
}

/** Stable identity of a whole configuration, recorded on each run. */
export const pipelineConfigHash = config => stableHash(config);

/** Whether a valid five-field UTC cron expression matches the minute of `at` (cron OR semantics for days). */
export function cronMatches(expression, at) {
  if (!validCron(expression)) return false;
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  const fields = expression.trim().split(/\s+/).map((field, index) => {
    const values = new Set();
    for (const part of field.split(',')) {
      const [, range, step] = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      const [min, max] = bounds[index];
      const [from, to = step ? max : from] = range === '*' ? [min, max] : range.split('-').map(Number);
      for (let value = from; value <= to; value += Number(step ?? 1)) values.add(value);
    }
    return { values, wildcard: field === '*' };
  });
  const date = new Date(at);
  const actual = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()];
  const match = fields.map((field, index) => field.values.has(actual[index]));
  const days = fields[2].wildcard || fields[4].wildcard ? match[2] && match[4] : match[2] || match[4];
  return match[0] && match[1] && match[3] && days;
}
