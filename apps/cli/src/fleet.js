import { randomUUID } from 'node:crypto';
import { owner, request } from './api.js';

/** A machine by id or exact name; a name two machines share must be given as an id. */
export function findMachine(machines, value) {
  const byId = machines.find(machine => machine.id === value);
  if (byId) return byId;
  const named = machines.filter(machine => machine.name === value);
  if (named.length > 1) throw new Error(`More than one machine is named ${value}; use its id (${named.map(machine => machine.id).join(', ')}).`);
  if (!named.length) throw new Error(`No machine is named ${value}. Run perpeto machines to list them.`);
  return named[0];
}

const SET_FLAGS = { 'max-agents': 'maxAgents', 'max-jobs': 'maxJobs', labels: 'labels', weight: 'weight', battery: 'allowOnBattery' };
/** `machines set` flags as a PATCH body; `default` clears an override. */
export function setBody(flags) {
  const body = {};
  for (const [flag, key] of Object.entries(SET_FLAGS)) {
    const value = flags[flag];
    if (value === undefined) continue;
    if (value === 'default') { body[key] = key === 'weight' ? 1 : null; continue; }
    if (key === 'labels') body[key] = value.split(',').map(label => label.trim()).filter(Boolean);
    else if (key === 'allowOnBattery') {
      if (!['allow', 'deny'].includes(value)) throw new Error('Use --battery allow, deny or default.');
      body[key] = value === 'allow';
    } else if (key === 'weight') {
      const weight = Number(value);
      if (!Number.isFinite(weight) || weight < 0 || weight > 10) throw new Error('--weight must be a number from 0 to 10.');
      body[key] = weight;
    } else {
      if (!/^\d+$/.test(value)) throw new Error(`--${flag} must be a whole number or default.`);
      body[key] = Number(value);
    }
  }
  if (!Object.keys(body).length) throw new Error('Set at least one of --max-agents, --max-jobs, --labels, --weight or --battery.');
  return body;
}

const ACTIONS = { cordon: { cordoned: true }, uncordon: { cordoned: false, drain: false }, drain: { drain: true } };
const gb = bytes => `${Math.round(bytes / 1024 ** 3)} GB`;

/** One line per machine: what it can take now and why it takes less. */
export function formatMachines(machines) {
  if (!machines.length) return ['No machines enrolled. Run perpeto hub invite on the hub.'];
  const rows = machines.map(machine => {
    const placement = machine.placement;
    const health = machine.health;
    const facts = [
      placement ? `agents ${placement.held.agents}/${placement.effective.agents}${placement.effective.agents !== placement.configured.agents ? ` (of ${placement.configured.agents})` : ''}`
        : `agents ${machine.running.agents}/${machine.capacity.maxAgents}`,
      placement ? `jobs ${placement.held.jobs}/${placement.effective.jobs}` : `jobs ${machine.running.jobs}/${machine.capacity.maxJobs}`,
      placement?.loadPerCore !== undefined ? `load ${placement.loadPerCore}/core` : null,
      health?.memory ? `mem ${gb(health.memory.freeBytes)} free` : null,
      health?.disk ? `disk ${gb(health.disk.freeBytes)} free` : null,
      health?.power ? (health.power.source === 'battery' ? `battery ${health.power.percent ?? '?'}%` : 'on AC') : null,
    ].filter(Boolean);
    const reasons = (placement?.reasons ?? []).filter(reason => reason.effect !== 'info' || reason.code === 'full').map(reason => reason.message);
    return { name: machine.name, status: placement?.status ?? machine.status, facts: facts.join(', '), reasons };
  });
  const width = Math.max(...rows.map(row => row.name.length));
  const statusWidth = Math.max(...rows.map(row => row.status.length));
  return rows.flatMap(row => [`${row.name.padEnd(width)}  ${row.status.padEnd(statusWidth)}  ${row.facts}`,
    ...row.reasons.map(reason => `${' '.repeat(width + 2)}${reason}`)]);
}

/** `perpeto machines …` against the local hub. */
export async function machinesCommand(dir, action, positionals, flags, { print, fetchImpl }) {
  const { url, token, pins } = await owner(dir);
  const call = (path, options = {}) => request(url, path, { token, pins, fetchImpl, ...options });
  const { machines } = await call('/machines');
  if (!action) {
    if (flags.json) print(JSON.stringify({ machines }));
    else for (const line of formatMachines(machines)) print(line);
    return;
  }
  const machine = findMachine(machines, positionals[0]);
  const path = `/machines/${encodeURIComponent(machine.id)}`;
  if (action === 'revoke') { print(JSON.stringify(await call(`${path}/revoke`, { body: { idempotencyKey: randomUUID() } }))); return; }
  const body = action === 'set' ? setBody(flags) : ACTIONS[action];
  const result = await call(path, { method: 'PATCH', body: { ...body, idempotencyKey: randomUUID() } });
  for (const line of formatMachines([result])) print(line);
}
