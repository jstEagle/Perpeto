import { createHash } from 'node:crypto';
import { DeliveryError } from './errors.js';

export { DeliveryError };

export function requireValue(condition, message, code = 'INVALID_INPUT') {
  if (!condition) throw new DeliveryError(code, message);
}

export function string(value, name) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && !value.includes('\0'), `${name} must be a nonempty string without NUL.`);
  return value;
}

export function sha(value) {
  requireValue(typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value), 'A full lowercase commit SHA is required.');
  return value;
}

/** Stable JSON: object key order is irrelevant, array order remains significant. */
export function stableJSON(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  requireValue(value && Object.getPrototypeOf(value) === Object.prototype, 'Only JSON values are supported.');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(',')}}`;
}

export const stableHash = value => createHash('sha256').update(stableJSON(value)).digest('hex');
