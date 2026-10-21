import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { integer, nonblank, object, requireValue } from './errors.js';

export function loadConfig(filename) {
  const path = resolve(filename);
  const input = object(JSON.parse(readFileSync(path, 'utf8')), 'configuration');
  const defaults = {
    host: '127.0.0.1', port: 4320, databasePath: './hub.sqlite', messagingDatabasePath: './messaging.sqlite',
    ownerTokenPath: './owner.secret', corsOrigins: [], requestMaxBytes: 1048576,
    heartbeatIntervalMs: 10000, leaseDurationMs: 60000, longPollMs: 25000,
    maintenanceIntervalMs: 1000, enrollmentTtlMs: 600000,
  };
  requireValue(Object.keys(input).every(key => Object.hasOwn(defaults, key)), 'Unknown hub configuration field.');
  const config = { ...defaults, ...input };
  nonblank(config.host, 'host'); integer(config.port, 'port', 0, 65535);
  integer(config.requestMaxBytes, 'requestMaxBytes', 128, 16 * 1024 * 1024);
  for (const key of ['heartbeatIntervalMs', 'leaseDurationMs', 'maintenanceIntervalMs', 'enrollmentTtlMs']) integer(config[key], key, 1, 86400000);
  integer(config.longPollMs, 'longPollMs', 0, 25000);
  requireValue(Array.isArray(config.corsOrigins), 'corsOrigins must be an array.');
  config.corsOrigins.forEach(origin => {
    nonblank(origin, 'CORS origin');
    const url = new URL(origin);
    requireValue(['http:', 'https:'].includes(url.protocol) && url.origin === origin, 'CORS origins must be exact HTTP(S) origins.');
  });
  for (const key of ['databasePath', 'messagingDatabasePath', 'ownerTokenPath']) config[key] = resolve(dirname(path), nonblank(config[key], key, 4096));
  requireValue(new Set([config.databasePath, config.messagingDatabasePath, config.ownerTokenPath]).size === 3, 'Hub files must have distinct paths.');
  return config;
}
