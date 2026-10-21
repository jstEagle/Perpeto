import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import { fail, requireValue } from './errors.js';

const fingerprint = key => createHash('sha256').update(key).digest('hex');

/**
 * Machine tokens, enrollment codes and session tokens are random, so neither the owner secret nor the database can
 * mint one. Only their SHA-256 hashes authenticate. An idempotent replay must return the credential it first issued,
 * so the replayed response holds it sealed with AES-256-GCM under a separate owner-only key file, and only until
 * idempotency retention drops the record. The database pins the key's fingerprint, so a lost or swapped key file
 * stops the hub instead of silently breaking replays.
 */
export class Credentials {
  #key;
  constructor(path, store) {
    let text;
    try {
      const stat = lstatSync(path);
      requireValue(stat.isFile() && (stat.mode & 0o077) === 0 && (!process.getuid || stat.uid === process.getuid()), 'Credential key file must be an owner-only regular file.');
      text = readFileSync(path, 'utf8').trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (store.keyFingerprint('credentials')) fail(500, 'CREDENTIAL_KEY_MISSING', 'Restore the credential key file before starting this hub.');
      text = randomBytes(32).toString('base64url');
      const handle = openSync(path, 'wx', 0o600);
      try { writeSync(handle, `${text}\n`); } finally { closeSync(handle); }
    }
    const key = Buffer.from(text, 'base64url');
    requireValue(key.length === 32 && /^[A-Za-z0-9_-]{43}$/.test(text), 'Invalid credential key file.');
    const known = store.keyFingerprint('credentials');
    if (known && known !== fingerprint(key)) fail(500, 'CREDENTIAL_KEY_MISMATCH', 'Credential key file does not match this hub.');
    if (!known) store.setKeyFingerprint('credentials', fingerprint(key));
    this.#key = key;
  }
  /** A new random credential: 256 bits, URL-safe. */
  issue() { return randomBytes(32).toString('base64url'); }
  seal(text) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const sealed = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), sealed.toString('base64url')].join('.');
  }
  open(value) {
    const [version, iv, tag, sealed] = String(value).split('.');
    requireValue(version === 'v1' && iv && tag && sealed, 'Invalid sealed credential.');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(sealed, 'base64url')), decipher.final()]).toString('utf8');
  }
}
