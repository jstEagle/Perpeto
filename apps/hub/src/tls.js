import { X509Certificate, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { fail, requireValue } from './errors.js';

// Minimal DER for one self-signed X.509 v3 certificate: ECDSA P-256 with SHA-256, so the hub needs no dependency.
function length(size) {
  if (size < 0x80) return Buffer.from([size]);
  const bytes = []; for (let rest = size; rest; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), length(body.length), body]); };
const sequence = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const oid = text => {
  const [first, second, ...rest] = text.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const value of rest) { const chunk = [value & 0x7f]; for (let rest = value >> 7; rest; rest >>= 7) chunk.unshift(0x80 | (rest & 0x7f)); bytes.push(...chunk); }
  return tlv(0x06, Buffer.from(bytes));
};
const integer = bytes => tlv(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const utf8 = text => tlv(0x0c, Buffer.from(text, 'utf8'));
const time = date => {
  const text = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${text.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${text}Z`));
};
const extension = (id, value, critical = false) => sequence(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
const ECDSA_SHA256 = sequence(oid('1.2.840.10045.4.3.2'));

/** The names and addresses this machine answers on, for the certificate's subjectAltName (pinning does not need them). */
function localNames() {
  const names = new Set(['localhost', hostname()]); const addresses = new Set(['127.0.0.1', '::1']);
  for (const list of Object.values(networkInterfaces())) for (const entry of list ?? []) if (!entry.internal) addresses.add(entry.address.split('%')[0]);
  return { names: [...names].filter(name => /^[A-Za-z0-9.-]{1,253}$/.test(name)), addresses: [...addresses].filter(address => isIP(address) && !(isIP(address) === 6 && (address.includes('.') || /^fe[89ab]/i.test(address)))) };
}
function ipBytes(address) {
  if (isIP(address) === 4) return Buffer.from(address.split('.').map(Number));
  const [head, tail] = address.split('::');
  const parse = part => part ? part.split(':').map(group => parseInt(group, 16)) : [];
  const left = parse(head); const right = parse(tail);
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  return Buffer.from(groups.flatMap(value => [value >> 8, value & 0xff]));
}

/** A new self-signed certificate and key, as PEM, with the certificate's SHA-256 fingerprint. */
export function generateCertificate({ validDays = 825, names = localNames() } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const now = Date.now();
  const name = sequence(set(sequence(oid('2.5.4.3'), utf8('Perpeto hub'))));
  const alternatives = sequence(...names.names.map(value => tlv(0x82, Buffer.from(value))), ...names.addresses.map(value => tlv(0x87, ipBytes(value))));
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))), integer(randomBytes(16)), ECDSA_SHA256, name,
    sequence(time(new Date(now - 3600000)), time(new Date(now + validDays * 86400000))), name,
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, sequence(
      extension('2.5.29.19', sequence(), true), // basicConstraints: not a CA
      extension('2.5.29.15', tlv(0x03, Buffer.from([0x07, 0x80])), true), // keyUsage: digitalSignature
      extension('2.5.29.37', sequence(oid('1.3.6.1.5.5.7.3.1'))), // extKeyUsage: serverAuth
      extension('2.5.29.17', alternatives),
    )),
  );
  const der = sequence(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  const certificate = new X509Certificate(der);
  requireValue(certificate.verify(publicKey) && certificate.checkPrivateKey(privateKey), 'Generated certificate does not verify.');
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { cert: pem, key: privateKey.export({ type: 'pkcs8', format: 'pem' }), fingerprint: fingerprintOf(der) };
}

/** Lowercase hex SHA-256 of a certificate's DER bytes: what nodes pin. */
export const fingerprintOf = der => createHash('sha256').update(der).digest('hex');

function readPrivate(path) {
  const stat = lstatSync(path);
  requireValue(stat.isFile() && (stat.mode & 0o077) === 0 && (!process.getuid || stat.uid === process.getuid()), 'TLS files must be owner-only regular files.');
  return readFileSync(path, 'utf8');
}
function writePrivate(path, text) {
  const handle = openSync(path, 'wx', 0o600);
  try { writeSync(handle, text); } finally { closeSync(handle); }
}

/**
 * The hub's TLS identity: a self-signed certificate created on first start, kept with an owner-only key. Rotation is
 * two steps so pinned machines never lose the hub: `rotate` creates the next certificate, which the hub then announces
 * to machines over the pinned channel (heartbeat `tls.fingerprints`); `activate` makes it the served one.
 */
export class HubTls {
  constructor({ certPath, keyPath }) {
    this.paths = { cert: certPath, key: keyPath, nextCert: `${certPath}.next`, nextKey: `${keyPath}.next` };
    try { this.current = this.#load(this.paths.cert, this.paths.key); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.#write(this.paths.cert, this.paths.key, generateCertificate());
      this.current = this.#load(this.paths.cert, this.paths.key);
    }
    try { this.next = this.#load(this.paths.nextCert, this.paths.nextKey); } catch (error) { if (error.code !== 'ENOENT') throw error; this.next = null; }
  }
  #load(certPath, keyPath) {
    const cert = readFileSync(certPath, 'utf8'); const key = readPrivate(keyPath);
    const parsed = new X509Certificate(cert);
    return { cert, key, fingerprint: fingerprintOf(parsed.raw), expiresAt: new Date(parsed.validTo).toISOString() };
  }
  #write(certPath, keyPath, { cert, key }) { writePrivate(keyPath, key); writePrivate(certPath, cert); }
  /** Served first, then the announced next one. Machines pin exactly this list. */
  get fingerprints() { return [this.current.fingerprint, ...(this.next ? [this.next.fingerprint] : [])]; }
  status() { return { fingerprint: this.current.fingerprint, expiresAt: this.current.expiresAt, ...(this.next ? { next: this.next.fingerprint } : {}) }; }
  rotate() {
    if (!this.next) { this.#write(this.paths.nextCert, this.paths.nextKey, generateCertificate()); this.next = this.#load(this.paths.nextCert, this.paths.nextKey); }
    return this.status();
  }
  activate() {
    if (!this.next) fail(409, 'NO_PENDING_CERTIFICATE', 'Rotate the certificate first so machines can pin the next one.');
    const previous = this.current.fingerprint;
    renameSync(this.paths.nextKey, this.paths.key); renameSync(this.paths.nextCert, this.paths.cert);
    this.current = this.#load(this.paths.cert, this.paths.key); this.next = null;
    return { ...this.status(), previous };
  }
  discardNext() { if (this.next) { unlinkSync(this.paths.nextCert); unlinkSync(this.paths.nextKey); this.next = null; } }
}
