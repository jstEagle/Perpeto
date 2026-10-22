import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fail, integer, nonblank, object, requireValue } from './errors.js';

/** Subscription pacing defaults. Burn-rate priors (percent of a window per agent-hour) are uncalibrated starting points. */
export const PACING_CONFIG_DEFAULTS = Object.freeze({
  enabled: true, strategy: 'rotation', targetUsePercent: 95, minAgents: 0, maxAgents: null,
  handoverMins: 15, sprintMins: 90, horizonMins: 600, recomputeMs: 15000, nudgeIntervalMs: 1800000,
  priors: { default: { session: 20, weekly: 2.5, monthly: 0.6, other: 20 }, claudeAgent: { session: 20, weekly: 2.5 }, codex: { session: 15, weekly: 2 } },
});
const WINDOW_KINDS = ['session', 'weekly', 'monthly', 'other'];

/** Validated pacing settings; shared by hub config and `PUT /pacing/settings` so both accept the same values. */
export function pacingFields(value, { partial = false } = {}) {
  object(value, 'pacing');
  const keys = Object.keys(PACING_CONFIG_DEFAULTS);
  requireValue(Object.keys(value).every(key => keys.includes(key)), 'Unknown pacing setting.');
  const has = key => !partial || Object.hasOwn(value, key);
  if (has('enabled')) requireValue(typeof value.enabled === 'boolean', 'pacing.enabled must be a boolean.');
  if (has('strategy')) requireValue(['rotation', 'parallel'].includes(value.strategy), 'pacing.strategy must be rotation or parallel.');
  if (has('targetUsePercent')) integer(value.targetUsePercent, 'pacing.targetUsePercent', 50, 100);
  if (has('minAgents')) integer(value.minAgents, 'pacing.minAgents', 0, 10000);
  if (has('maxAgents') && value.maxAgents !== null) integer(value.maxAgents, 'pacing.maxAgents', 0, 10000);
  if (value.maxAgents !== undefined && value.maxAgents !== null && value.minAgents !== undefined) requireValue(value.minAgents <= value.maxAgents, 'pacing.minAgents cannot exceed maxAgents.');
  for (const [key, min, max] of [['handoverMins', 1, 240], ['sprintMins', 0, 1440], ['horizonMins', 60, 2880], ['recomputeMs', 1000, 3600000], ['nudgeIntervalMs', 60000, 86400000]]) {
    if (has(key)) integer(value[key], `pacing.${key}`, min, max);
  }
  if (has('priors')) {
    object(value.priors, 'pacing.priors');
    for (const [provider, rates] of Object.entries(value.priors)) {
      nonblank(provider, 'pacing.priors provider', 200); object(rates, `pacing.priors.${provider}`);
      for (const [kind, rate] of Object.entries(rates)) requireValue(WINDOW_KINDS.includes(kind) && typeof rate === 'number' && Number.isFinite(rate) && rate > 0 && rate <= 1000,
        'pacing.priors rates are positive percent-per-agent-hour numbers by window kind.');
    }
  }
  return value;
}

export const isLoopback = host => ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(host) || /^127\.\d+\.\d+\.\d+$/.test(host);
/** An http(s) origin machines can reach; plain http only on loopback. */
export function publicOrigin(value) {
  let url; try { url = new URL(value); } catch { fail(400, 'INVALID_INPUT', 'Invalid public URL.'); }
  requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'The public URL must be an http(s) origin.');
  requireValue(url.protocol === 'https:' || isLoopback(url.hostname), 'A public URL other than loopback must use https.');
  return url.origin;
}

export function loadConfig(filename) {
  const path = resolve(filename);
  const input = object(JSON.parse(readFileSync(path, 'utf8')), 'configuration');
  const defaults = {
    host: '127.0.0.1', port: 4320, ownerName: null, tlsEnabled: false, tlsCertPath: './tls/cert.pem', tlsKeyPath: './tls/key.pem', allowInsecureRemote: false, publicUrl: null, databasePath: './hub.sqlite', messagingDatabasePath: './messaging.sqlite', deliveryDatabasePath: './delivery.sqlite', workflowDatabasePath: './workflow.sqlite',
    deliveryRepositoriesPath: './delivery-repositories', deliveryLeaseDurationMs: 60000, deliveryMaxStepFailures: 5, deliveryRetryBackoffMs: 2000, ownerTokenPath: './owner.secret', credentialKeyPath: './credentials.key', corsOrigins: [], requestMaxBytes: 1048576,
    heartbeatIntervalMs: 10000, leaseDurationMs: 60000, longPollMs: 25000,
    maintenanceIntervalMs: 1000, enrollmentTtlMs: 600000,
    finishedWorkRetentionMs: 604800000, eventRetentionMs: 2592000000, usageRetentionMs: 2592000000, idempotencyRetentionMs: 86400000,
    archiveFinished: true, retentionSweepIntervalMs: 60000, sessionTtlMs: 43200000, messageRatePerMinute: 30, architectHarness: { provider: 'codex', model: 'gpt-6.1-sol' },
    pacing: PACING_CONFIG_DEFAULTS,
  };
  requireValue(Object.keys(input).every(key => Object.hasOwn(defaults, key)), 'Unknown hub configuration field.');
  const config = { ...defaults, ...input };
  // A partial pacing section keeps the other defaults; priors merge per provider.
  const pacing = object(input.pacing ?? {}, 'pacing');
  const priors = structuredClone(PACING_CONFIG_DEFAULTS.priors);
  for (const [provider, rates] of Object.entries(object(pacing.priors ?? {}, 'pacing.priors'))) priors[provider] = { ...(priors[provider] ?? {}), ...object(rates, `pacing.priors.${provider}`) };
  config.pacing = pacingFields({ ...PACING_CONFIG_DEFAULTS, ...pacing, priors });
  object(config.architectHarness, 'architectHarness'); nonblank(config.architectHarness.provider, 'architect provider', 200); nonblank(config.architectHarness.model, 'architect model', 200);
  nonblank(config.host, 'host'); integer(config.port, 'port', 0, 65535);
  integer(config.requestMaxBytes, 'requestMaxBytes', 128, 16 * 1024 * 1024);
  for (const key of ['heartbeatIntervalMs', 'leaseDurationMs', 'deliveryLeaseDurationMs', 'maintenanceIntervalMs', 'enrollmentTtlMs']) integer(config[key], key, 1, 86400000);
  integer(config.longPollMs, 'longPollMs', 0, 25000);
  // Metrics windows reach back 7 days, so events must outlive them; usage stays correct through hourly rollups.
  integer(config.eventRetentionMs, 'eventRetentionMs', 604800000);
  for (const key of ['finishedWorkRetentionMs', 'usageRetentionMs', 'idempotencyRetentionMs']) integer(config[key], key, 60000);
  integer(config.retentionSweepIntervalMs, 'retentionSweepIntervalMs', 1000, 86400000);
  integer(config.sessionTtlMs, 'sessionTtlMs', 1000, 2592000000);
  integer(config.messageRatePerMinute, 'messageRatePerMinute', 1, 10000);
  requireValue(typeof config.archiveFinished === 'boolean', 'archiveFinished must be a boolean.');
  integer(config.deliveryMaxStepFailures, 'deliveryMaxStepFailures', 1, 1000); integer(config.deliveryRetryBackoffMs, 'deliveryRetryBackoffMs', 1, 3600000);
  requireValue(Array.isArray(config.corsOrigins), 'corsOrigins must be an array.');
  config.corsOrigins.forEach(origin => {
    nonblank(origin, 'CORS origin');
    const url = new URL(origin);
    requireValue(['http:', 'https:'].includes(url.protocol) && url.origin === origin, 'CORS origins must be exact HTTP(S) origins.');
  });
  // Plain HTTP carries bearer tokens in the clear, so it stays on loopback unless the operator explicitly accepts that.
  for (const key of ['tlsEnabled', 'allowInsecureRemote']) requireValue(typeof config[key] === 'boolean', `${key} must be a boolean.`);
  if (!config.tlsEnabled && !config.allowInsecureRemote && !isLoopback(config.host)) {
    fail(400, 'INSECURE_BIND', `Binding to ${config.host} without TLS would send tokens in clear text. Set tlsEnabled, expose the hub through tailscale serve, or set allowInsecureRemote.`);
  }
  if (config.publicUrl !== null) config.publicUrl = publicOrigin(nonblank(config.publicUrl, 'publicUrl', 2048));
  if (config.ownerName !== null) config.ownerName = nonblank(config.ownerName, 'ownerName', 80).trim();
  for (const key of ['databasePath', 'messagingDatabasePath', 'deliveryDatabasePath', 'workflowDatabasePath', 'deliveryRepositoriesPath', 'ownerTokenPath', 'credentialKeyPath', 'tlsCertPath', 'tlsKeyPath']) config[key] = resolve(dirname(path), nonblank(config[key], key, 4096));
  requireValue(new Set([config.databasePath, config.messagingDatabasePath, config.deliveryDatabasePath, config.workflowDatabasePath, config.ownerTokenPath, config.credentialKeyPath, config.tlsCertPath, config.tlsKeyPath]).size === 8, 'Hub files must have distinct paths.');
  return config;
}
