import { createHash } from 'node:crypto';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { connect } from 'node:tls';

export const FINGERPRINT = /^[a-f0-9]{64}$/;
/** Lowercase hex SHA-256 of a certificate's DER bytes. */
export const fingerprintOf = der => createHash('sha256').update(der).digest('hex');

/** The hub presented a certificate this machine has not pinned. Nothing was sent to it. */
export class HubIdentityError extends Error {
  constructor(fingerprint) {
    super(`The hub presented certificate ${fingerprint}, which this machine has not pinned. Re-pin only after confirming the new fingerprint with the hub owner.`);
    this.code = 'HUB_CERTIFICATE_MISMATCH'; this.fingerprint = fingerprint;
  }
}

/**
 * HTTPS agent that trusts exactly the pinned certificate fingerprints, with no CA. The TLS handshake completes and the
 * certificate is checked before the socket is handed to HTTP, so no request byte (and no token) reaches an
 * unpinned peer. Host names are not checked: the pin is the identity.
 */
export class PinnedAgent extends HttpsAgent {
  #pins;
  constructor(pins) { super({ keepAlive: true }); this.#pins = pins; }
  createConnection(options, callback) {
    const socket = connect({ host: options.host, port: options.port, rejectUnauthorized: false,
      ...(options.servername && !isIP(options.servername) ? { servername: options.servername } : {}) });
    const failed = error => { socket.destroy(); callback(error); };
    socket.once('error', failed);
    socket.once('secureConnect', () => {
      const fingerprint = fingerprintOf(socket.getPeerCertificate(true).raw);
      if (!this.#pins().includes(fingerprint)) { failed(new HubIdentityError(fingerprint)); return; }
      socket.off('error', failed);
      callback(null, socket);
    });
  }
}

/**
 * Requests to a hub. `https` with pins trusts only those certificates; `https` without pins uses the system CAs (for
 * example a tailnet URL from `tailscale serve`); `http` is for loopback. Responses expose status, JSON and a stream.
 */
export function createTransport(hubUrl, { pins } = {}) {
  const url = new URL(hubUrl);
  const pinned = url.protocol === 'https:' && pins;
  const agent = pinned ? new PinnedAgent(() => pins()) : url.protocol === 'https:' ? new HttpsAgent({ keepAlive: true }) : new HttpAgent({ keepAlive: true });
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return {
    pinned: Boolean(pinned),
    request(path, { method = 'GET', headers = {}, body, signal } = {}) {
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : Buffer.from(body);
        const outgoing = send(new URL(`/api/v1${path}`, url), { method, agent, signal,
          headers: { ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) } }, response => {
          resolve({
            status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, headers: response.headers, body: response,
            async text() { let text = ''; response.setEncoding('utf8'); for await (const chunk of response) text += chunk; return text; },
            async json() { return JSON.parse(await this.text()); },
          });
        });
        outgoing.once('error', reject);
        outgoing.end(payload);
      });
    },
    close() { agent.destroy(); },
  };
}
