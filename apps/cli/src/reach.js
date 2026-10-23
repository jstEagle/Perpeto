import { createTransport } from '@perpeto/node';

/**
 * Can this machine reach a hub at `url`, through the same pinned transport the node uses? Returns `{ ok: true }` or a
 * diagnosis `{ ok: false, code, message }` whose message says what to do. Nothing secret is sent: only GET /health.
 */
export async function probeHub(url, { pins, timeoutMs = 3000, transport: make = createTransport } = {}) {
  const target = new URL(url);
  const where = `${target.hostname}:${target.port || (target.protocol === 'https:' ? 443 : 80)}`;
  const transport = make(target.origin, pins?.length ? { pins: () => pins } : {});
  try {
    const response = await transport.request('/health', { signal: AbortSignal.timeout(timeoutMs) });
    let body; try { body = await response.json(); } catch { body = null; }
    if (response.ok && body?.status === 'ok') return { ok: true, url: target.origin };
    return { ok: false, url: target.origin, code: 'not-a-hub', message: `${where} answered HTTP ${response.status}, but not as a Perpeto hub. Check the port: the hub's port is in hub.json on the hub.` };
  } catch (error) {
    return { ok: false, url: target.origin, ...diagnose(error, { where, target, timeoutMs, pinned: Boolean(pins?.length) }) };
  } finally { transport.close?.(); }
}

/** Turn a connection failure into an actionable message. */
export function diagnose(error, { where, target, timeoutMs = 3000, pinned = false }) {
  const code = error?.code ?? error?.cause?.code ?? error?.name;
  if (code === 'HUB_CERTIFICATE_MISMATCH') return { code: 'pin-mismatch', message: `${where} presented certificate ${String(error.fingerprint).slice(0, 16)}…, not the pinned one. `
    + 'Either another server answers at that address (a wrong or reassigned IP), or the hub rotated its certificate. Compare with perpeto hub tls status on the hub; '
    + 'if it is the hub, run perpeto node stop, perpeto node repin <fingerprint> and start again.' };
  if (code === 'ECONNREFUSED') return { code: 'refused', message: `Nothing is listening on ${where}. Check that the hub is running (perpeto hub status) and listens beyond loopback `
    + '(host 0.0.0.0 with TLS in hub.json), or use its Tailscale address.' };
  if (['TimeoutError', 'AbortError', 'ABORT_ERR', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return { code: 'timeout', message: `No answer from ${where} within ${Math.round(timeoutMs / 1000)} s. `
    + 'The IP may be wrong or may have changed (DHCP), a firewall may block the port, or the machines are on different networks. Try the hub\'s Tailscale address.' };
  if (['EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN'].includes(code)) return { code: 'unreachable', message: `No route to ${target.hostname}. This machine is not on the hub's network; `
    + 'join over Tailscale, or check Wi-Fi and VPN.' };
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return { code: 'dns', message: `${target.hostname} does not resolve here. For a tailnet name, check that Tailscale is running with MagicDNS on this machine.` };
  if (['ECONNRESET', 'EPROTO', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PACKET_LENGTH_TOO_LONG', 'HPE_INVALID_CONSTANT'].includes(code) || /wrong version number|socket hang up/i.test(error?.message ?? '')) {
    return { code: 'protocol', message: `${where} did not speak ${target.protocol === 'https:' ? 'HTTPS' : 'HTTP'}. Use https:// for a hub started with --tls, and http:// only on loopback.` };
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(String(code))) return { code: 'untrusted-certificate', message: pinned ? `${where} sent a certificate that could not be checked.`
    : `${where} uses a certificate this machine does not trust. Join with the pj1_ code from perpeto hub invite, which pins the hub's certificate.` };
  return { code: 'failed', message: `Could not reach ${where} (${String(code ?? 'unknown error').slice(0, 60)}).` };
}
