import { createHash } from 'node:crypto';

export class WorkflowError extends Error {
  /**
   * @param {string} code SNAKE_CASE error code.
   * @param {string} message Human-readable message without SQL, stacks or secrets.
   * @param {object} [details] Structured detail, for example validation errors.
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const fail = (code, message, details) => { throw new WorkflowError(code, message, details); };

export const isPlainObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export const isText = (value, max = 200) =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max && !value.includes('\0');

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
export const isIsoTimestamp = value => typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value));

/** JSON with recursively sorted keys and undefined values dropped, so equal values serialise identically. */
export function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!isPlainObject(item)) return item;
    const sorted = {};
    for (const key of Object.keys(item).sort()) if (item[key] !== undefined) sorted[key] = item[key];
    return sorted;
  });
}

export const sha256 = text => createHash('sha256').update(text).digest('hex');
