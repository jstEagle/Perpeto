import { spawn } from 'node:child_process';
import { readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { configPath, isLoopback, writeNew } from './config.js';
import { control } from './process.js';

// Follows vendor/t3code/packages/tailscale: read the MagicDNS name from `tailscale status --json`, then map an HTTPS
// port on the tailnet to the local hub with `tailscale serve --bg`. Tailscale terminates TLS with a certificate
// browsers and nodes already trust, so nothing is pinned and nothing listens beyond loopback.
const DIAGNOSTICS = [
  [/not logged in|logged out|needs? login/i, 'Tailscale is not logged in. Run tailscale up first.'],
  [/permission denied|access denied|must be root|operation not permitted/i, 'Tailscale refused the change. On Linux, run tailscale set --operator=$USER once.'],
  [/serve config|funnel|HTTPS.*(disabled|not enabled)|enable https/i, 'Tailscale HTTPS is off for this tailnet. Enable HTTPS certificates in the Tailscale admin console.'],
];

/** Run the tailscale CLI. Its stderr can hold auth keys and node names, so it is matched, never printed. */
export function runTailscale(args, { timeoutMs = 10000, executable = process.platform === 'win32' ? 'tailscale.exe' : 'tailscale' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Tailscale is not installed or not on PATH.')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(DIAGNOSTICS.find(([pattern]) => pattern.test(stderr))?.[1] ?? `tailscale ${args[0]} failed (exit ${code}).`));
    });
  });
}

/** This machine's MagicDNS name, without the trailing dot. */
export async function tailnetName(run = runTailscale) {
  let status;
  try { status = JSON.parse(await run(['status', '--json'])); } catch (error) { throw error instanceof SyntaxError ? new Error('Could not read tailscale status.') : error; }
  const name = typeof status?.Self?.DNSName === 'string' ? status.Self.DNSName.trim().replace(/\.$/, '') : '';
  if (!/^[A-Za-z0-9.-]+$/.test(name) || !name.includes('.')) throw new Error('Tailscale is running without a MagicDNS name. Enable MagicDNS for this tailnet.');
  return name;
}

/** Rewrite the CLI-owned hub config in place, owner-only, without a window where it is missing. */
async function writeHubConfig(dir, config) {
  const path = configPath(dir, 'hub'); const temp = `${path}.${randomUUID()}.tmp`;
  await writeNew(temp, `${JSON.stringify(config, null, 2)}\n`); await rename(temp, path);
}

/**
 * Serve the hub on the tailnet at https://<machine>.<tailnet>.ts.net (port 443 unless given) and record that URL as
 * the hub's publicUrl, which join codes then carry. `off` removes the mapping.
 */
export async function exposeTailscale(dir, { httpsPort = 443, off = false, run = runTailscale } = {}) {
  if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535) throw new Error('Invalid --https-port.');
  const config = JSON.parse(await readFile(configPath(dir, 'hub'), 'utf8'));
  if (off) {
    await run(['serve', `--https=${httpsPort}`, 'off']);
    delete config.publicUrl; await writeHubConfig(dir, config);
    return { url: null };
  }
  if (!isLoopback(config.host)) throw new Error('Keep the hub on loopback (the default) when tailscale serve exposes it.');
  const running = await control(dir, 'hub').catch(() => null);
  const port = running?.url ? Number(new URL(running.url).port) : config.port;
  if (!port) throw new Error('Start the hub first so its port is known.');
  const name = await tailnetName(run);
  // A hub with its own self-signed certificate is proxied as https+insecure: tailscale itself is the trust boundary.
  await run(['serve', '--bg', `--https=${httpsPort}`, `${config.tlsEnabled ? 'https+insecure' : 'http'}://127.0.0.1:${port}`]);
  const url = `https://${name}${httpsPort === 443 ? '' : `:${httpsPort}`}`;
  config.publicUrl = url; await writeHubConfig(dir, config);
  return { url };
}
