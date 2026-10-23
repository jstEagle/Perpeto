import { parseArgs } from './args.js';
import { initHub, observeSettings } from './config.js';
import { daemon, start, stop, control } from './process.js';
import { enrollCode, join, owner, request, decide, rotateToken, repin, hubTls } from './api.js';
import { exposeTailscale } from './tailscale.js';
import { doctor } from './doctor.js';
import { service } from './service.js';
import { machinesCommand } from './fleet.js';
import { invite, inviteLines } from './invite.js';

export const help = `Usage: perpeto <command> [--dir <data-directory>]

hub init [--host <address>] [--port <port>] [--tls] [--show-owner-token]
hub start|stop|status
hub expose --tailscale [--https-port <port>] [--off]
hub enroll-code [--url <https-origin>] [--labels <comma-separated>] [--show-code]
hub invite [--ttl <10m|2h>] [--labels <comma-separated>]
hub tls status|rotate|activate
hub decide <workItemId> pass|fail [--note <text>]
node join <join-code> [--name <name>] [--labels <comma-separated>] [--observe [--t3-dir <dir>] [--no-titles]]
node join <hubUrl> (--code <code> | --code-file <path>) [--name <name>] [--labels <comma-separated>] [--observe]
node start|stop|status|drain
node rotate-token
node repin <fingerprint | join-code>
machines [--json]
machines cordon|uncordon|drain <name>
machines set <name> [--max-agents N|default] [--max-jobs N|default] [--labels a,b|default] [--weight 0-10] [--battery allow|deny|default]
machines revoke <name>
service install|uninstall [hub|node] [--dry-run]
sessions
doctor
status

Default directory: ~/.perpeto. Secrets are saved in owner-only files.
A hub stays on loopback unless --tls gives it HTTPS; hub expose --tailscale is the recommended way to reach it.
The join command printed by hub enroll-code or hub invite is a one-time secret that expires; it pins the hub's certificate.
hub invite lists every address the hub answers on (Tailscale, then LAN); node join keeps the first that works.
Cordon stops new work on a machine; drain also lets its running work finish; uncordon undoes both.
--observe joins an observe-only node: it watches this Mac's running T3 Code read-only (default ~/.t3/userdata) and runs no agents or CI.
Service --dry-run prints generated files without writing or loading them.
The service manager uses hub/node run internally for foreground execution.`;
export async function main(args, { print = console.log, fetchImpl = fetch } = {}) {
  const parsed = parseArgs(args);
  if (parsed.help) { print(help); return 0; }
  const { group, action, flags, positionals, dir } = parsed;
  const labels = flags.labels?.split(',').map(label => label.trim()).filter(Boolean);
  if (group === 'hub' && action === 'init') {
    await initHub(dir, { ...(flags.host ? { host: flags.host } : {}), ...(flags.port !== undefined ? { port: Number(flags.port) } : {}), tls: Boolean(flags.tls) });
    const { url, token, pins } = await owner(dir);
    print(`Hub initialized: ${url}${new URL(url).port === '0' ? ' (ephemeral port assigned on start)' : ''}`);
    if (pins?.length) print(`Certificate fingerprint (SHA-256): ${pins[0]}`);
    if (flags['show-owner-token']) print(token);
  } else if (group === 'hub' && action === 'expose') {
    const result = await exposeTailscale(dir, { httpsPort: flags['https-port'] !== undefined ? Number(flags['https-port']) : 443, off: Boolean(flags.off) });
    print(result.url ? `Hub on your tailnet: ${result.url}\nJoin codes from perpeto hub enroll-code now use this URL.` : 'Tailscale serve mapping removed.');
  } else if (group === 'hub' && action === 'enroll-code') {
    const result = await enrollCode(dir, labels, { url: flags.url });
    print(`Run this on the machine to join (one-time, expires ${result.expiresAt}):\n\nperpeto node join ${result.joinCode}${labels?.length ? ` --labels ${labels.join(',')}` : ''}\n`);
    print(`Enrollment file: ${result.path}`);
    if (flags['show-code']) print(result.code);
  } else if (group === 'hub' && action === 'tls') {
    print(JSON.stringify(await hubTls(dir, positionals[0])));
  } else if (group === 'node' && action === 'join') {
    const joinCode = positionals[0].startsWith('pj1_') ? positionals[0] : undefined;
    const observe = flags.observe ? observeSettings({ t3Dir: flags['t3-dir'], titles: !flags['no-titles'] }) : undefined;
    const result = await join(dir, joinCode ? undefined : positionals[0], { joinCode, code: flags.code, codeFile: flags['code-file'], labels, name: flags.name, observe });
    print(`Joined ${result.hubUrl} as ${result.machineId}${result.fingerprint ? `, pinned to certificate ${result.fingerprint}` : ''}${observe ? ' (observe-only)' : ''}. Run perpeto node start with the same --dir.`);
  } else if (group === 'node' && action === 'repin') {
    const result = await repin(dir, positionals[0]);
    print(`Pinned hub certificate ${result.fingerprint}. Run perpeto node start with the same --dir.`);
  } else if (group === 'hub' && action === 'invite') {
    for (const line of inviteLines(await invite(dir, { ttl: flags.ttl, labels, fetchImpl }))) print(line);
  } else if (group === 'machines') {
    await machinesCommand(dir, action, positionals, flags, { print, fetchImpl });
  } else if (group === 'hub' && action === 'decide') {
    print(JSON.stringify(await decide(dir, positionals[0], positionals[1], flags.note, { fetchImpl })));
  } else if (group === 'node' && action === 'rotate-token') {
    const result = await rotateToken(dir, { fetchImpl });
    print(`Token rotated for ${result.machineId}. Run perpeto node start with the same --dir.`);
  } else if (['hub', 'node'].includes(group)) {
    if (action === 'run') { await daemon(dir, group); return process.exitCode ?? 0; }
    let result;
    if (action === 'start') result = await start(dir, group);
    else if (action === 'stop') result = await stop(dir, group);
    else result = await control(dir, group, action === 'drain' ? 'drain' : 'status').catch(error => {
      if (action === 'status' && ['ENOENT', 'ECONNREFUSED'].includes(error.code)) return { role: group, state: 'stopped' };
      throw error;
    });
    print(JSON.stringify(result));
  } else if (group === 'service') {
    const results = await service(action, dir, positionals[0], { dryRun: flags['dry-run'] });
    for (const result of results) print(flags['dry-run'] ? `${result.file}\n${result.contents}` : `${result.state}: ${result.file}`);
  } else if (group === 'doctor') {
    const checks = await doctor(dir);
    for (const check of checks) print(`${check.status.toUpperCase()} ${check.name}: ${check.detail}`);
    return checks.some(check => check.status === 'fail') ? 1 : 0;
  } else if (group === 'sessions') {
    const { url, token, pins } = await owner(dir);
    const summary = await request(url, '/sessions/summary?window=24h', { token, pins, fetchImpl });
    for (const machine of summary.machines) print(`${machine.name}: ${machine.observing ? 'observing' : machine.online ? 'online, not observing' : 'offline'}; ${machine.running} running, ${machine.waiting} waiting`);
    const tokens = summary.tokens.byProvider.map(item => `${item.provider} ${item.input + item.output} in+out`).join(', ');
    print(`Active sessions (24 h): ${summary.totals.sessionsActive}. Tokens (24 h): ${tokens || 'none'}`);
  } else if (group === 'status') {
    const { url, token, pins } = await owner(dir);
    const result = await request(url, '/overview', { token, pins });
    print(`${url}\nMachines online: ${result.machinesOnline}\nActive agents: ${result.activeAgents}\nTokens today: ${result.tokensToday}`);
  }
  return 0;
}
