import { parseArgs } from './args.js';
import { initHub } from './config.js';
import { daemon, start, stop, control } from './process.js';
import { enrollCode, join, owner, request } from './api.js';
import { doctor } from './doctor.js';
import { service } from './service.js';

export const help = `Usage: perpeto <command> [--dir <data-directory>]

hub init [--host <address>] [--port <port>] [--show-owner-token]
hub start|stop|status
hub enroll-code [--labels <comma-separated>] [--show-code]
node join <hubUrl> (--code <code> | --code-file <path>) [--name <name>] [--labels <comma-separated>]
node start|stop|status|drain
service install|uninstall [hub|node] [--dry-run]
doctor
status

Default directory: ~/.perpeto. Secrets are saved in owner-only files.
Service --dry-run prints generated files without writing or loading them.
The service manager uses hub/node run internally for foreground execution.`;
export async function main(args, { print = console.log } = {}) {
  const parsed = parseArgs(args);
  if (parsed.help) { print(help); return 0; }
  const { group, action, flags, positionals, dir } = parsed;
  const labels = flags.labels?.split(',').map(label => label.trim()).filter(Boolean);
  if (group === 'hub' && action === 'init') {
    await initHub(dir, { ...(flags.host ? { host: flags.host } : {}), ...(flags.port !== undefined ? { port: Number(flags.port) } : {}) });
    const { url, token } = await owner(dir);
    print(`Hub initialized: ${url}${new URL(url).port === '0' ? ' (ephemeral port assigned on start)' : ''}`);
    if (flags['show-owner-token']) print(token);
  } else if (group === 'hub' && action === 'enroll-code') {
    const result = await enrollCode(dir, labels);
    print(`Enrollment file: ${result.path}\nExpires: ${result.expiresAt}`);
    if (labels?.length) print('Labels in this file are join defaults; the hub does not enforce enrollment label restrictions.');
    if (flags['show-code']) print(result.code);
  } else if (group === 'node' && action === 'join') {
    const result = await join(dir, positionals[0], { code: flags.code, codeFile: flags['code-file'], labels, name: flags.name });
    print(`Joined ${result.hubUrl} as ${result.machineId}. Run perpeto node start with the same --dir.`);
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
  } else if (group === 'status') {
    const { url, token } = await owner(dir);
    const result = await request(url, '/overview', { token });
    print(`${url}\nMachines online: ${result.machinesOnline}\nActive agents: ${result.activeAgents}\nTokens today: ${result.tokensToday}`);
  }
  return 0;
}
