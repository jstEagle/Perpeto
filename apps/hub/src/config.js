import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { integer, nonblank, object, requireValue } from './errors.js';

export function loadConfig(filename) {
  const path = resolve(filename);
  const input = object(JSON.parse(readFileSync(path, 'utf8')), 'configuration');
  const defaults = {
    host: '127.0.0.1', port: 4320, databasePath: './hub.sqlite', messagingDatabasePath: './messaging.sqlite', deliveryDatabasePath: './delivery.sqlite', workflowDatabasePath: './workflow.sqlite',
    deliveryRepositoriesPath: './delivery-repositories', deliveryLeaseDurationMs: 60000, deliveryMaxStepFailures: 5, deliveryRetryBackoffMs: 2000, ownerTokenPath: './owner.secret', corsOrigins: [], requestMaxBytes: 1048576,
    heartbeatIntervalMs: 10000, leaseDurationMs: 60000, longPollMs: 25000,
    maintenanceIntervalMs: 1000, enrollmentTtlMs: 600000, architectHarness: { provider: 'codex', model: 'gpt-6.1-sol' },
  };
  requireValue(Object.keys(input).every(key => Object.hasOwn(defaults, key)), 'Unknown hub configuration field.');
  const config = { ...defaults, ...input };
  object(config.architectHarness, 'architectHarness'); nonblank(config.architectHarness.provider, 'architect provider', 200); nonblank(config.architectHarness.model, 'architect model', 200);
  nonblank(config.host, 'host'); integer(config.port, 'port', 0, 65535);
  integer(config.requestMaxBytes, 'requestMaxBytes', 128, 16 * 1024 * 1024);
  for (const key of ['heartbeatIntervalMs', 'leaseDurationMs', 'deliveryLeaseDurationMs', 'maintenanceIntervalMs', 'enrollmentTtlMs']) integer(config[key], key, 1, 86400000);
  integer(config.longPollMs, 'longPollMs', 0, 25000);
  integer(config.deliveryMaxStepFailures, 'deliveryMaxStepFailures', 1, 1000); integer(config.deliveryRetryBackoffMs, 'deliveryRetryBackoffMs', 1, 3600000);
  requireValue(Array.isArray(config.corsOrigins), 'corsOrigins must be an array.');
  config.corsOrigins.forEach(origin => {
    nonblank(origin, 'CORS origin');
    const url = new URL(origin);
    requireValue(['http:', 'https:'].includes(url.protocol) && url.origin === origin, 'CORS origins must be exact HTTP(S) origins.');
  });
  for (const key of ['databasePath', 'messagingDatabasePath', 'deliveryDatabasePath', 'workflowDatabasePath', 'deliveryRepositoriesPath', 'ownerTokenPath']) config[key] = resolve(dirname(path), nonblank(config[key], key, 4096));
  requireValue(new Set([config.databasePath, config.messagingDatabasePath, config.deliveryDatabasePath, config.workflowDatabasePath, config.ownerTokenPath]).size === 5, 'Hub files must have distinct paths.');
  return config;
}
