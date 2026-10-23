import { resolve } from 'node:path';
import { integer, nonblank, object, requireValue } from '../errors.js';

/** Hub CI settings (hub config key `ci`). Sizes are bytes, durations milliseconds. All are non-secret. */
export const CI_DEFAULTS = Object.freeze({
  // Log lines past this many bytes per job are dropped and the log is marked truncated.
  logMaxBytesPerJob: 5 * 1024 ** 2,
  logRetentionMs: 14 * 86400000,
  // Uploaded artifact files live here, one directory per job, relative to the hub config file.
  artifactsPath: './ci-artifacts',
  artifactMaxBytesPerJob: 200 * 1024 ** 2,
  artifactRetentionMs: 7 * 86400000,
  // Finished pipeline runs (and their flaky-test history) are forgotten after this.
  runRetentionMs: 30 * 86400000,
  // Extra regular expressions masked in stored CI logs, on top of the node's own redaction.
  redactPatterns: [],
  // Fire `schedule` triggers from repository pipelines once per matching UTC minute.
  scheduleTriggers: true,
  // Fire `pull-request` triggers when an agent reports a new head commit.
  pullRequestTriggers: true,
});

export function ciConfig(input = {}, root = process.cwd()) {
  object(input, 'ci');
  requireValue(Object.keys(input).every(key => Object.hasOwn(CI_DEFAULTS, key)), 'Unknown ci configuration field.');
  const config = { ...CI_DEFAULTS, ...input };
  integer(config.logMaxBytesPerJob, 'ci.logMaxBytesPerJob', 1024, 1024 ** 3);
  integer(config.artifactMaxBytesPerJob, 'ci.artifactMaxBytesPerJob', 0, 64 * 1024 ** 3);
  for (const key of ['logRetentionMs', 'artifactRetentionMs', 'runRetentionMs']) integer(config[key], `ci.${key}`, 60000);
  requireValue(Array.isArray(config.redactPatterns) && config.redactPatterns.every(item => typeof item === 'string' && item.length <= 1000), 'ci.redactPatterns must be an array of regular expressions.');
  for (const pattern of config.redactPatterns) { try { new RegExp(pattern, 'g'); } catch { requireValue(false, 'ci.redactPatterns contains an invalid regular expression.'); } }
  for (const key of ['scheduleTriggers', 'pullRequestTriggers']) requireValue(typeof config[key] === 'boolean', `ci.${key} must be a boolean.`);
  config.artifactsPath = resolve(root, nonblank(config.artifactsPath, 'ci.artifactsPath', 4096));
  return config;
}
