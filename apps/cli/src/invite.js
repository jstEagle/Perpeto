import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { owner, request } from './api.js';
import { control } from './process.js';
import { decodeJoinCode, isLoopback } from './config.js';
import { runTailscale } from './tailscale.js';

const ipv4 = text => text.split('.').map(Number);
const tailnetIp = address => { const [a, b] = ipv4(address); return a === 100 && b >= 64 && b <= 127; };
const privateIp = address => { const [a, b] = ipv4(address); return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); };

/** This machine's Tailscale identity, if Tailscale is running: its IPv4 addresses and MagicDNS name. */
export async function tailnetIdentity(run = runTailscale) {
  try {
    const status = JSON.parse(await run(['status', '--json'], { timeoutMs: 3000 }));
    const name = typeof status?.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '') : '';
    const ips = (status?.Self?.TailscaleIPs ?? []).filter(ip => typeof ip === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(ip));
    return { ...(/^[A-Za-z0-9.-]+\.[A-Za-z0-9-]+$/.test(name) ? { name } : {}), ips };
  } catch { return null; }
}

/**
 * Addresses another machine could use to reach this hub, best first. An exposed tailnet URL (tailscale serve) is the
 * whole answer. Otherwise a TLS hub bound beyond loopback is offered at its Tailscale name and addresses (stable as a
 * laptop moves between networks) and then its LAN addresses; these all serve the hub's own pinned certificate.
 */
export function candidateUrls({ config, port, interfaces = networkInterfaces(), tailnet }) {
  if (config.publicUrl) return { urls: [{ url: config.publicUrl, via: 'Tailscale serve' }], pin: false };
  if (!config.tlsEnabled) return { urls: [], pin: true, problem: 'This hub serves plain HTTP on loopback, so other machines cannot reach it. Run perpeto hub expose --tailscale, or re-initialize it with --host 0.0.0.0 --tls.' };
  const host = config.host ?? '127.0.0.1';
  if (isLoopback(host)) return { urls: [], pin: true, problem: `This hub only listens on ${host}. Set "host": "0.0.0.0" in hub.json and restart it, or run perpeto hub expose --tailscale.` };
  const at = address => `https://${address.includes(':') ? `[${address}]` : address}:${port}`;
  if (!['0.0.0.0', '::'].includes(host)) return { urls: [{ url: at(host), via: 'configured host' }], pin: true };
  const urls = [];
  if (tailnet?.name) urls.push({ url: at(tailnet.name), via: 'Tailscale name' });
  const seen = new Set();
  const local = Object.entries(interfaces).flatMap(([name, list]) => (list ?? []).filter(item => item.family === 'IPv4' && !item.internal).map(item => ({ name, address: item.address })));
  for (const ip of tailnet?.ips ?? []) if (!seen.has(ip)) { seen.add(ip); urls.push({ url: at(ip), via: 'Tailscale' }); }
  for (const { name, address } of local) if (tailnetIp(address) && !seen.has(address)) { seen.add(address); urls.push({ url: at(address), via: 'Tailscale' }); }
  for (const { name, address } of local) if (privateIp(address) && !seen.has(address)) { seen.add(address); urls.push({ url: at(address), via: `LAN (${name})` }); }
  return urls.length ? { urls, pin: true } : { urls, pin: true, problem: 'No LAN or Tailscale address found on this machine. Connect it to a network or start Tailscale.' };
}

/** `pj1_` with the alternative addresses a node tries in order. Older CLIs read only `url`. */
const encode = value => `pj1_${Buffer.from(JSON.stringify(value)).toString('base64url')}`;

const TTL = /^(\d{1,4})(m|h)$/;
/** One-time invite for another machine: a join code carrying every reachable hub address, its pin and an expiry. */
export async function invite(dir, { ttl, labels, tailnet, interfaces, fetchImpl } = {}) {
  const { url, token, pins, config } = await owner(dir);
  const running = await control(dir, 'hub').catch(() => null);
  const port = running?.url ? Number(new URL(running.url).port) : config.port;
  if (!port) throw new Error('Start the hub first so its port is known.');
  const found = candidateUrls({ config, port, interfaces, tailnet: tailnet === undefined ? await tailnetIdentity() : tailnet });
  if (!found.urls.length) throw new Error(found.problem);
  let ttlMs;
  if (ttl !== undefined) {
    const match = TTL.exec(ttl);
    if (!match) throw new Error('Use --ttl like 10m or 2h.');
    ttlMs = Number(match[1]) * (match[2] === 'h' ? 3600000 : 60000);
    if (ttlMs > config.enrollmentTtlMs) throw new Error(`--ttl can be at most ${Math.round(config.enrollmentTtlMs / 60000)} minutes (enrollmentTtlMs in hub.json).`);
  }
  const [primary, ...rest] = found.urls;
  const result = await request(url, '/machines/enrollment-codes', { token, pins, fetchImpl,
    body: { url: primary.url, pin: found.pin, ...(ttlMs ? { ttlMs } : {}), idempotencyKey: randomUUID() } });
  if (typeof result.joinCode !== 'string') throw new Error('Invalid enrollment response.');
  const decoded = decodeJoinCode(result.joinCode);
  const joinCode = encode({ url: decoded.url, ...(decoded.fingerprint ? { fingerprint: decoded.fingerprint } : {}), code: decoded.code, ...(rest.length ? { alts: rest.map(item => item.url) } : {}) });
  return { joinCode, expiresAt: result.expiresAt, urls: found.urls, fingerprint: decoded.fingerprint, labels };
}

/** The lines `perpeto hub invite` prints. The join code is the one secret, shown once, as with hub enroll-code. */
export function inviteLines({ joinCode, expiresAt, urls, fingerprint, labels }, now = Date.now()) {
  const minutes = Math.max(1, Math.round((Date.parse(expiresAt) - now) / 60000));
  const width = Math.max(...urls.map(item => item.url.length));
  return [`Run this on the machine to join (one-time, expires ${expiresAt}, in ${minutes} min):`, '',
    `perpeto node join ${joinCode}${labels?.length ? ` --labels ${labels.join(',')}` : ''}`, '',
    urls.length > 1 ? 'The node tries these hub addresses in order and keeps the first that answers:' : 'Hub address:',
    ...urls.map(item => `  ${item.url.padEnd(width)}  ${item.via}`),
    ...(fingerprint ? [`Pinned certificate (SHA-256): ${fingerprint}`] : [])];
}
