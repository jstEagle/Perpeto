import { DeliveryError } from './errors.js';

/**
 * Project merge queue configuration: several named queues per project, each covering target branches, with a
 * strategy, lanes, freeze windows, retry and timeout policy. `normalizeMergeQueueConfig` never throws; it returns
 * every problem with a JSON path so editors can show them inline. The queue machine consumes the narrower `policy`
 * produced by `queuePolicy`.
 */

export const CONFIG_VERSION = 1;
export const REPO_CONFIG_PATH = '.perpeto/merge-queue.json';
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const STRATEGIES = ['serial', 'batch', 'speculative'];
const METHODS = ['squash', 'merge', 'rebase'];
const PUBLICATIONS = ['fast-forward-push', 'github-merge-queue'];
const MAX_FREEZE_MINUTES = 14 * 24 * 60;
const QUEUE_KEYS = ['name', 'branches', 'strategy', 'maxBatchSize', 'depth', 'requiredChecks', 'method', 'publication', 'lanes', 'defaultLane',
  'freeze', 'maxInFlight', 'flakyRetries', 'bisectOnBatchFailure', 'autoRebaseOnConflict', 'ejectAfterMinutes', 'requiredApprovals'];
export const QUEUE_DEFAULTS = Object.freeze({ strategy: 'serial', maxBatchSize: 8, depth: 3, requiredChecks: [], method: 'squash',
  publication: 'fast-forward-push', lanes: [], freeze: { windows: [] }, maxInFlight: null, flakyRetries: 0, bisectOnBatchFailure: true,
  autoRebaseOnConflict: true, ejectAfterMinutes: null, requiredApprovals: 0 });

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 200) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
const int = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

/** Branch globs: `*` stays inside one path segment, `**` crosses segments, `?` is one character. */
export function branchPattern(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') { source += '.*'; index++; }
    else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}
export const matchBranch = (pattern, branch) => typeof branch === 'string' && branchPattern(pattern).test(branch);
const validPattern = value => text(value, 200) && !/\s|\.\.|^\/|\/$|\/\//.test(value);

const CRON_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
/** Five-field UTC cron: lists, ranges, steps and `*`. Day-of-month and day-of-week match either when both are set. */
export function parseCron(expression) {
  if (typeof expression !== 'string') return null;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets = [];
  for (const [index, field] of fields.entries()) {
    const [low, high] = CRON_RANGES[index]; const values = new Set();
    for (const part of field.split(',')) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      if (!match) return null;
      const step = match[2] === undefined ? 1 : Number(match[2]);
      let [from, to] = match[1] === '*' ? [low, high] : match[1].split('-').map(Number);
      if (to === undefined) to = match[2] === undefined ? from : high;
      if (step < 1 || from < low || to > high || from > to) return null;
      for (let value = from; value <= to; value += step) values.add(index === 4 && value === 7 ? 0 : value);
    }
    sets.push(values);
  }
  return { minute: sets[0], hour: sets[1], day: sets[2], month: sets[3], weekday: sets[4], anyDay: fields[2] === '*', anyWeekday: fields[4] === '*' };
}
function cronMatches(cron, ms) {
  const date = new Date(ms);
  if (!cron.minute.has(date.getUTCMinutes()) || !cron.hour.has(date.getUTCHours()) || !cron.month.has(date.getUTCMonth() + 1)) return false;
  const day = cron.day.has(date.getUTCDate()); const weekday = cron.weekday.has(date.getUTCDay());
  if (cron.anyDay && cron.anyWeekday) return true;
  if (cron.anyDay) return weekday;
  if (cron.anyWeekday) return day;
  return day || weekday;
}

/** The freeze in force at `at` (ms), or null. Manual freezes have no end; windows end at their range or cron duration. */
export function freezeAt({ manual, windows = [] }, at) {
  if (manual) return { kind: 'manual', reason: manual.reason ?? 'Frozen manually.', ...(manual.at !== undefined ? { since: manual.at } : {}) };
  if (!Number.isFinite(at)) return null;
  for (const window of windows) {
    if (window.start !== undefined) {
      const start = Date.parse(window.start); const end = Date.parse(window.end);
      if (at >= start && at < end) return { kind: 'window', reason: window.reason ?? 'Scheduled freeze.', since: start, until: end };
      continue;
    }
    const cron = parseCron(window.cron); if (!cron) continue;
    const minute = Math.floor(at / 60000) * 60000;
    // The most recent fire inside the duration ends last, so the first match walking back is the one in force.
    for (let back = 0; back < window.durationMinutes; back++) {
      const fire = minute - back * 60000;
      if (cronMatches(cron, fire)) {
        const until = fire + window.durationMinutes * 60000;
        if (at < until) return { kind: 'window', reason: window.reason ?? 'Scheduled freeze.', since: fire, until };
        break;
      }
    }
  }
  return null;
}

function freezeWindow(value, path, errors) {
  const error = message => errors.push({ path, message });
  if (!plain(value)) return error('must be an object with cron and durationMinutes, or start and end.');
  const extra = Object.keys(value).find(key => !['cron', 'durationMinutes', 'start', 'end', 'reason'].includes(key));
  if (extra) return error(`has unknown key "${extra}".`);
  if (value.reason !== undefined && !text(value.reason, 300)) errors.push({ path: `${path}.reason`, message: 'must be a short single-line text.' });
  if (value.cron !== undefined) {
    if (value.start !== undefined || value.end !== undefined) return error('uses either cron with durationMinutes or start and end, not both.');
    if (!parseCron(value.cron)) errors.push({ path: `${path}.cron`, message: 'must be a five-field UTC cron expression.' });
    if (!int(value.durationMinutes, 1, MAX_FREEZE_MINUTES)) errors.push({ path: `${path}.durationMinutes`, message: `must be an integer from 1 to ${MAX_FREEZE_MINUTES}.` });
    return { cron: value.cron.trim().split(/\s+/).join(' '), durationMinutes: value.durationMinutes, ...(value.reason ? { reason: value.reason } : {}) };
  }
  const start = Date.parse(value.start); const end = Date.parse(value.end);
  if (typeof value.start !== 'string' || !Number.isFinite(start)) errors.push({ path: `${path}.start`, message: 'must be an ISO 8601 time.' });
  if (typeof value.end !== 'string' || !Number.isFinite(end)) errors.push({ path: `${path}.end`, message: 'must be an ISO 8601 time.' });
  else if (Number.isFinite(start) && end <= start) errors.push({ path: `${path}.end`, message: 'must be after start.' });
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), ...(value.reason ? { reason: value.reason } : {}) };
}

function lanes(value, path, errors) {
  if (!Array.isArray(value) || value.length > 20) { errors.push({ path, message: 'must be an array of at most 20 lanes.' }); return []; }
  const names = new Set();
  return value.map((lane, index) => {
    const at = `${path}[${index}]`;
    if (!plain(lane)) { errors.push({ path: at, message: 'must be an object.' }); return null; }
    const extra = Object.keys(lane).find(key => !['name', 'priority', 'labels', 'branches'].includes(key));
    if (extra) errors.push({ path: at, message: `has unknown key "${extra}".` });
    if (typeof lane.name !== 'string' || !NAME.test(lane.name)) errors.push({ path: `${at}.name`, message: 'must be letters, digits, ".", "_" or "-".' });
    else if (names.has(lane.name)) errors.push({ path: `${at}.name`, message: `repeats lane "${lane.name}".` });
    names.add(lane.name);
    if (!int(lane.priority, 0, 1000)) errors.push({ path: `${at}.priority`, message: 'must be an integer from 0 to 1000.' });
    const list = (key, check, message) => {
      if (lane[key] === undefined) return [];
      if (!Array.isArray(lane[key]) || lane[key].length > 50 || !lane[key].every(check)) { errors.push({ path: `${at}.${key}`, message }); return []; }
      return [...new Set(lane[key])];
    };
    return { name: lane.name, priority: lane.priority, labels: list('labels', item => text(item, 100), 'must be an array of label names.'),
      branches: list('branches', validPattern, 'must be an array of branch patterns.') };
  }).filter(Boolean);
}

/** Validate one queue, filling defaults. Returns null when the queue is not an object at all. */
function queue(value, path, errors) {
  if (!plain(value)) { errors.push({ path, message: 'must be an object.' }); return null; }
  for (const key of Object.keys(value)) if (!QUEUE_KEYS.includes(key)) errors.push({ path: `${path}.${key}`, message: 'is not a merge queue setting.' });
  const field = (key, ok, message) => { if (value[key] !== undefined && !ok(value[key])) errors.push({ path: `${path}.${key}`, message }); };
  if (typeof value.name !== 'string' || !NAME.test(value.name)) errors.push({ path: `${path}.name`, message: 'must be 1 to 64 letters, digits, ".", "_" or "-".' });
  field('branches', item => Array.isArray(item) && item.length > 0 && item.length <= 20 && item.every(validPattern), 'must be a nonempty array of branch patterns such as "main" or "release/*".');
  field('strategy', item => STRATEGIES.includes(item), 'must be serial, batch or speculative.');
  field('maxBatchSize', item => int(item, 1, 100), 'must be an integer from 1 to 100.');
  field('depth', item => int(item, 1, 20), 'must be an integer from 1 to 20.');
  field('requiredChecks', item => Array.isArray(item) && item.length <= 50 && item.every(name => text(name, 200)), 'must be an array of CI pipeline or check names.');
  field('method', item => METHODS.includes(item), 'must be squash, merge or rebase.');
  field('publication', item => PUBLICATIONS.includes(item), 'must be fast-forward-push or github-merge-queue.');
  field('maxInFlight', item => item === null || int(item, 1, 1000), 'must be null or an integer from 1 to 1000.');
  field('flakyRetries', item => int(item, 0, 5), 'must be an integer from 0 to 5.');
  field('bisectOnBatchFailure', item => typeof item === 'boolean', 'must be true or false.');
  field('autoRebaseOnConflict', item => typeof item === 'boolean', 'must be true or false.');
  field('ejectAfterMinutes', item => item === null || int(item, 1, 4 * MAX_FREEZE_MINUTES), `must be null or an integer from 1 to ${4 * MAX_FREEZE_MINUTES}.`);
  field('requiredApprovals', item => int(item, 0, 10), 'must be an integer from 0 to 10.');
  const pick = (key, ok) => value[key] !== undefined && ok(value[key]) ? value[key] : structuredClone(QUEUE_DEFAULTS[key]);
  const result = {
    name: value.name,
    branches: Array.isArray(value.branches) && value.branches.length && value.branches.every(validPattern) ? [...new Set(value.branches)] : [typeof value.name === 'string' ? value.name : 'main'],
    strategy: pick('strategy', item => STRATEGIES.includes(item)),
    maxBatchSize: pick('maxBatchSize', item => int(item, 1, 100)),
    depth: pick('depth', item => int(item, 1, 20)),
    requiredChecks: Array.isArray(value.requiredChecks) && value.requiredChecks.every(name => text(name, 200)) ? [...new Set(value.requiredChecks)] : [],
    method: pick('method', item => METHODS.includes(item)),
    publication: pick('publication', item => PUBLICATIONS.includes(item)),
    lanes: value.lanes === undefined ? [] : lanes(value.lanes, `${path}.lanes`, errors),
    maxInFlight: pick('maxInFlight', item => item === null || int(item, 1, 1000)),
    flakyRetries: pick('flakyRetries', item => int(item, 0, 5)),
    bisectOnBatchFailure: pick('bisectOnBatchFailure', item => typeof item === 'boolean'),
    autoRebaseOnConflict: pick('autoRebaseOnConflict', item => typeof item === 'boolean'),
    ejectAfterMinutes: pick('ejectAfterMinutes', item => item === null || int(item, 1, 4 * MAX_FREEZE_MINUTES)),
    requiredApprovals: pick('requiredApprovals', item => int(item, 0, 10)),
    freeze: { windows: [] },
  };
  if (value.freeze !== undefined) {
    if (!plain(value.freeze) || Object.keys(value.freeze).some(key => key !== 'windows') || !Array.isArray(value.freeze.windows ?? [])) {
      errors.push({ path: `${path}.freeze`, message: 'must be { windows: [...] }.' });
    } else {
      const windows = value.freeze.windows ?? [];
      if (windows.length > 20) errors.push({ path: `${path}.freeze.windows`, message: 'allows at most 20 windows.' });
      result.freeze.windows = windows.slice(0, 20).map((window, index) => freezeWindow(window, `${path}.freeze.windows[${index}]`, errors)).filter(Boolean);
    }
  }
  if (result.lanes.length) {
    const names = result.lanes.map(lane => lane.name);
    if (value.defaultLane !== undefined && !names.includes(value.defaultLane)) errors.push({ path: `${path}.defaultLane`, message: `must name one of the lanes (${names.join(', ')}).` });
    result.defaultLane = names.includes(value.defaultLane) ? value.defaultLane : names.includes('normal') ? 'normal' : [...result.lanes].sort((a, b) => a.priority - b.priority)[0].name;
  } else if (value.defaultLane !== undefined) errors.push({ path: `${path}.defaultLane`, message: 'needs lanes to choose from.' });
  if (result.publication === 'github-merge-queue' && result.strategy !== 'serial') {
    errors.push({ path: `${path}.publication`, message: 'github-merge-queue publication requires strategy serial; GitHub orders the merges itself.' });
  }
  // depth and maxBatchSize are allowed with any strategy (ignored unless it applies), so a repository file can
  // override them without restating the hub's strategy.
  return result;
}

/**
 * Validate a project's merge queue configuration file or hub document. Returns `{ok, errors, config}`; `config` holds
 * the normalized queues with defaults filled in, even when there are errors, so a partial file can still be shown.
 * @returns {{ok: boolean, errors: {path: string, message: string}[], config: {version: number, queues: object[]}}}
 */
export function normalizeMergeQueueConfig(input) {
  const errors = [];
  if (!plain(input)) return { ok: false, errors: [{ path: '$', message: 'must be an object { version: 1, queues: [...] }.' }], config: { version: CONFIG_VERSION, queues: [] } };
  for (const key of Object.keys(input)) if (!['version', 'queues', '$schema'].includes(key)) errors.push({ path: `$.${key}`, message: 'is not a merge queue configuration key.' });
  if (input.version !== undefined && input.version !== CONFIG_VERSION) errors.push({ path: '$.version', message: `must be ${CONFIG_VERSION}.` });
  if (!Array.isArray(input.queues) || input.queues.length > 50) {
    errors.push({ path: '$.queues', message: 'must be an array of at most 50 queues.' });
    return { ok: false, errors, config: { version: CONFIG_VERSION, queues: [] } };
  }
  const queues = input.queues.map((item, index) => queue(item, `$.queues[${index}]`, errors)).filter(Boolean);
  const names = new Map(); const patterns = new Map();
  queues.forEach((item, index) => {
    if (typeof item.name === 'string') {
      if (names.has(item.name)) errors.push({ path: `$.queues[${index}].name`, message: `repeats queue "${item.name}".` });
      names.set(item.name, index);
    }
    for (const pattern of item.branches) {
      if (patterns.has(pattern)) errors.push({ path: `$.queues[${index}].branches`, message: `"${pattern}" is already covered by queue "${patterns.get(pattern)}".` });
      else patterns.set(pattern, item.name);
    }
  });
  return { ok: errors.length === 0, errors, config: { version: CONFIG_VERSION, queues } };
}

/** Throwing form for callers that accept only valid configuration. */
export function assertMergeQueueConfig(input) {
  const result = normalizeMergeQueueConfig(input);
  if (!result.ok) {
    const error = new DeliveryError('INVALID_MERGE_QUEUE_CONFIG', `Merge queue configuration is invalid: ${result.errors[0].path} ${result.errors[0].message}`);
    error.details = result.errors; throw error;
  }
  return result.config;
}

/**
 * Precedence: built-in defaults, then the hub's project configuration, then the repository file. Queues are matched by
 * name; for a queue in both, each top-level field set in the repository file replaces the hub's (lanes and freeze
 * windows are replaced whole, never merged item by item). Queues only one side defines are kept. An invalid
 * repository file is ignored as a whole and reported, so a bad commit cannot loosen the hub's queue.
 */
export function mergeQueueConfigs(hub, repo) {
  const hubQueues = Array.isArray(hub?.queues) ? hub.queues : [];
  const sources = {};
  if (!repo) {
    for (const item of hubQueues) if (item?.name) sources[item.name] = 'hub';
    return { ...normalizeMergeQueueConfig({ version: CONFIG_VERSION, queues: hubQueues }), sources };
  }
  const repoQueues = Array.isArray(repo.queues) ? repo.queues : [];
  const merged = hubQueues.map(item => {
    const override = repoQueues.find(other => other?.name === item?.name);
    if (item?.name) sources[item.name] = override ? 'merged' : 'hub';
    return override ? { ...item, ...override } : item;
  });
  for (const item of repoQueues) if (!hubQueues.some(other => other?.name === item?.name)) { merged.push(item); if (item?.name) sources[item.name] = 'repo'; }
  return { ...normalizeMergeQueueConfig({ version: CONFIG_VERSION, queues: merged }), sources };
}

/** The queue covering a base branch: an exact branch beats a pattern, then the first queue in file order. */
export function queueForBranch(config, branch) {
  const exact = config.queues.find(item => item.branches.includes(branch));
  return exact ?? config.queues.find(item => item.branches.some(pattern => matchBranch(pattern, branch))) ?? null;
}

/** Queue machine policy derived from a named queue. Omitted fields keep the machine's defaults. */
export function queuePolicy(item) {
  return normalizePolicy({
    ...(item.lanes.length ? { lanes: item.lanes, defaultLane: item.defaultLane } : {}),
    ...(item.strategy === 'speculative' ? { depth: item.depth } : {}),
    ...(item.maxInFlight ? { maxInFlight: item.maxInFlight } : {}),
    ...(item.flakyRetries ? { flakyRetries: item.flakyRetries } : {}),
    ...(item.bisectOnBatchFailure === false ? { bisect: false } : {}),
    ...(item.ejectAfterMinutes ? { ejectAfterMs: item.ejectAfterMinutes * 60000 } : {}),
    ...(item.requiredApprovals ? { requiredApprovals: item.requiredApprovals } : {}),
    ...(item.freeze.windows.length ? { freezeWindows: item.freeze.windows } : {}),
  });
}

/** Validate the machine policy. Only set fields are kept, so an empty policy hashes like no policy at all. */
export function normalizePolicy(policy) {
  const fail = message => { throw new DeliveryError('INVALID_INPUT', message); };
  if (!plain(policy)) fail('policy must be an object.');
  const known = ['lanes', 'defaultLane', 'depth', 'maxInFlight', 'flakyRetries', 'bisect', 'ejectAfterMs', 'requiredApprovals', 'freezeWindows'];
  const extra = Object.keys(policy).find(key => !known.includes(key));
  if (extra) fail(`Unknown queue policy field "${extra}".`);
  const result = {};
  if (policy.lanes !== undefined) {
    const errors = []; const list = lanes(policy.lanes, 'lanes', errors);
    if (errors.length) fail(`policy.${errors[0].path} ${errors[0].message}`);
    if (list.length) {
      result.lanes = list;
      if (!list.some(lane => lane.name === policy.defaultLane)) fail('policy.defaultLane must name a lane.');
      result.defaultLane = policy.defaultLane;
    }
  } else if (policy.defaultLane !== undefined) fail('policy.defaultLane needs lanes.');
  const number = (key, min, max) => {
    if (policy[key] === undefined) return;
    if (!int(policy[key], min, max)) fail(`policy.${key} must be an integer from ${min} to ${max}.`);
    result[key] = policy[key];
  };
  number('depth', 1, 20); number('maxInFlight', 1, 1000); number('flakyRetries', 0, 5);
  number('ejectAfterMs', 1, 4 * MAX_FREEZE_MINUTES * 60000); number('requiredApprovals', 0, 10);
  if (policy.bisect !== undefined) { if (typeof policy.bisect !== 'boolean') fail('policy.bisect must be a boolean.'); result.bisect = policy.bisect; }
  if (policy.freezeWindows !== undefined) {
    if (!Array.isArray(policy.freezeWindows) || policy.freezeWindows.length > 20) fail('policy.freezeWindows must be an array of at most 20 windows.');
    const errors = []; const windows = policy.freezeWindows.map((window, index) => freezeWindow(window, `freezeWindows[${index}]`, errors));
    if (errors.length) fail(`policy.${errors[0].path} ${errors[0].message}`);
    if (windows.length) result.freezeWindows = windows;
  }
  return result;
}

/** The lane an entry joins: the highest-priority lane whose labels or branch patterns match, else the default lane. */
export function laneFor(policy, { labels = [], headBranch } = {}) {
  if (!policy?.lanes?.length) return null;
  const ordered = [...policy.lanes].sort((a, b) => b.priority - a.priority);
  const match = ordered.find(lane => lane.labels.some(label => labels.includes(label)) || lane.branches.some(pattern => matchBranch(pattern, headBranch)));
  return match ?? policy.lanes.find(lane => lane.name === policy.defaultLane);
}
