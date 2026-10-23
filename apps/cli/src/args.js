import { resolve } from 'node:path';
import { defaultDir } from './config.js';

const commands = {
  hub: { init: ['host', 'port', 'tls', 'show-owner-token'], start: [], run: [], stop: [], status: [], 'enroll-code': ['labels', 'show-code', 'url'], decide: ['note'],
    tls: [], expose: ['tailscale', 'https-port', 'off'] },
  node: { join: ['code', 'code-file', 'labels', 'name', 'observe', 't3-dir', 'no-titles'], start: [], run: [], stop: [], status: [], drain: [], 'rotate-token': [], repin: [] },
  machines: { revoke: [] },
  service: { install: ['dry-run'], uninstall: ['dry-run'] },
  storage: { clean: ['machine', 'dry-run', 'items'] },
};
const booleans = new Set(['show-owner-token', 'show-code', 'dry-run', 'help', 'tls', 'tailscale', 'off', 'observe', 'no-titles']);
export function parseArgs(args) {
  const words = []; const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    const [key, ...parts] = arg.slice(2).split('=');
    if (Object.hasOwn(flags, key)) throw new Error('Duplicate option.');
    if (booleans.has(key)) {
      if (parts.length) throw new Error('Boolean options take no value.');
      flags[key] = true;
    } else {
      const value = parts.length ? parts.join('=') : args[++i];
      if (!value || value.startsWith('--')) throw new Error('Option requires a value.');
      flags[key] = value;
    }
  }
  if (flags.help || words.length === 0) return { help: true };
  const [group, action, ...positionals] = words;
  const simple = ['doctor', 'status', 'sessions'].includes(group) || (group === 'machines' || group === 'storage') && action === undefined;
  const allowed = group === 'storage' && action === undefined ? ['machine'] : simple ? [] : commands[group]?.[action];
  if (!allowed || Object.keys(flags).some(key => !['dir', ...allowed].includes(key))) throw new Error('Unknown command or option. Use perpeto --help.');
  if (simple && words.length !== 1) throw new Error('Unexpected argument.');
  if (!simple) {
    if (group === 'node' && action === 'join' && (flags['t3-dir'] || flags['no-titles']) && !flags.observe) throw new Error('--t3-dir and --no-titles need --observe.');
    if (group === 'node' && action === 'join') {
      // Either a join code from perpeto hub enroll-code, or a hub URL with --code or --code-file.
      const joinCode = positionals.length === 1 && positionals[0].startsWith('pj1_');
      if (positionals.length !== 1 || (joinCode ? Boolean(flags.code || flags['code-file']) : Boolean(flags.code) === Boolean(flags['code-file']))) {
        throw new Error('Join needs a join code, or a hub URL and exactly one of --code or --code-file.');
      }
    } else if (group === 'node' && action === 'repin') {
      if (positionals.length !== 1) throw new Error('Repin needs the new fingerprint or a join code.');
    } else if (group === 'hub' && action === 'tls') {
      if (positionals.length !== 1 || !['status', 'rotate', 'activate'].includes(positionals[0])) throw new Error('Use hub tls status, rotate or activate.');
    } else if (group === 'hub' && action === 'expose') {
      if (positionals.length || !flags.tailscale) throw new Error('Use hub expose --tailscale [--https-port <port>] [--off].');
    } else if (group === 'machines' || group === 'hub' && action === 'decide') {
      if (positionals.length !== (group === 'machines' ? 1 : 2) || !/^[a-zA-Z0-9_-]+$/.test(positionals[0]) ||
        (group === 'hub' && !['pass', 'fail'].includes(positionals[1]))) throw new Error('Provide an ID and, for hub decide, pass or fail.');
    } else if (group === 'service') {
      if (positionals.length > 1 || (positionals[0] && !['hub', 'node'].includes(positionals[0]))) throw new Error('Service role must be hub or node.');
    } else if (group === 'storage') {
      if (positionals.length) throw new Error('Unexpected argument.');
      if (flags.items !== undefined && !flags.items.split(',').every(item => /^sti_[a-f0-9]{20}$/.test(item.trim()))) throw new Error('--items takes storage item ids separated by commas.');
    } else if (positionals.length) throw new Error('Unexpected argument.');
  }
  if (flags.machine !== undefined && !/^[a-zA-Z0-9_-]{1,200}$/.test(flags.machine)) throw new Error('Invalid machine ID.');
  for (const key of ['port', 'https-port']) if (flags[key] !== undefined && (!/^\d+$/.test(flags[key]) || Number(flags[key]) > 65535)) throw new Error('Invalid port.');
  return { group, action, positionals, flags, dir: resolve(flags.dir ?? defaultDir()) };
}
