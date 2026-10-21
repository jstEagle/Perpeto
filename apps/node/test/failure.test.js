import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFailure } from '../src/failure.js';

test('diagnostics redact configured and common credentials without serializing adapter objects', () => {
  const message = 'EACCES: auth link failed. opaque-value token=abc "api_key":"def" password=ghi ' +
    'Bearer jkl Basic bW5v https://user:pass@example.com?token=pqr ghp_stu eyJheader.payload.signature\n\x1b[31m';
  const reason = sanitizeFailure(Object.assign(new Error(message), { cause: new Error('hidden cause'), secret: 'hidden property' }),
    { literals: ['opaque-value'], patterns: ['EACCES'] });
  assert.match(reason, /auth link failed/);
  assert.doesNotMatch(reason, /opaque-value|abc|def|ghi|jkl|bW5v|pqr|stu|eyJ|hidden|[\n\x1b]/);
  assert.equal(sanitizeFailure({ code: 'SECRET', message: 'Failed.' }, { literals: ['SECRET'] }), '[REDACTED]: Failed.');
});

test('diagnostics bound large messages and tolerate non-Error throws', () => {
  assert.ok(sanitizeFailure(new Error('x'.repeat(2000))).length <= 1000);
  assert.equal(sanitizeFailure(new Error('x'.repeat(20000))), 'Executor error message exceeded the diagnostic limit.');
  assert.equal(sanitizeFailure(null), 'Executor threw an unknown error.');
  assert.equal(sanitizeFailure({ secret: 'never stringify me' }), 'Executor threw an unknown error.');
  assert.equal(sanitizeFailure('token=private'), 'token=[REDACTED]');
  assert.doesNotMatch(sanitizeFailure(new Error('Failed\n-----BEGIN PRIVATE KEY-----\nraw-key\n-----END PRIVATE KEY-----')), /raw-key/);
});
