export class HubError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function fail(status, code, message) { throw new HubError(status, code, message); }
export function requireValue(condition, message) {
  if (!condition) fail(400, 'INVALID_INPUT', message);
}
export function nonblank(value, name, max = 1000) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0'), `Invalid ${name}.`);
  return value;
}
export function object(value, name = 'body') {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `${name} must be an object.`);
  return value;
}
export function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  requireValue(Number.isSafeInteger(value) && value >= min && value <= max, `Invalid ${name}.`);
  return value;
}
export function strings(value, name) {
  requireValue(Array.isArray(value) && value.length <= 100, `${name} must be an array of strings.`);
  value.forEach(item => nonblank(item, name, 200));
  return value;
}
// Mirrors the executor's check (t3-executor isolation.js), so a project identity the hub accepts is one agents can commit with.
const IDENTITY_NAME = /^[^\0\r\n<>]{1,200}$/;
const IDENTITY_EMAIL = /^[^\s@<>]{1,200}@[^\s@<>]{1,200}$/;
export function gitIdentity(value) {
  object(value, 'gitIdentity');
  requireValue(Object.keys(value).every(key => key === 'name' || key === 'email') && typeof value.name === 'string' && IDENTITY_NAME.test(value.name) && value.name.trim() === value.name
    && typeof value.email === 'string' && IDENTITY_EMAIL.test(value.email), 'gitIdentity must be { name, email } with a single-line name and an email address.');
  return { name: value.name, email: value.email };
}
