import type { Machine, MachineHealth, MachinePlacement, PlacementReason, PlacementStatus } from '../api/types';
import { count, plural } from './format';

/*
 * Fleet: how each machine is placed and why. Newer hubs send `placement`;
 * older ones send only liveness, capacity and running counts, so the
 * placement is derived from those.
 */

/** The hub's placement, or one derived from legacy fields for older hubs. */
export function placementOf(m: Machine): MachinePlacement {
  if (m.placement) return m.placement;
  const configured = { agents: m.schedule?.maxAgents ?? m.capacity.maxAgents, jobs: m.schedule?.maxJobs ?? m.capacity.maxJobs };
  const held = { agents: m.running.agents, jobs: m.running.jobs };
  const busy = held.agents + held.jobs;
  const reasons: PlacementReason[] = [];
  let status: PlacementStatus = 'online';
  if (m.revokedAt) {
    status = 'offline';
    reasons.push({ code: 'revoked', message: 'The node token was revoked', effect: 'blocks' });
  } else if (m.status === 'offline') {
    status = 'offline';
    reasons.push({ code: 'offline', message: 'No recent heartbeat from the node', effect: 'blocks' });
  } else if (m.schedule?.drain || m.status === 'draining') {
    status = busy > 0 ? 'draining' : 'drained';
    reasons.push({ code: 'draining', message: busy > 0 ? `Draining: ${plural(held.agents, 'agent')} finishing` : 'Drained: nothing left running', effect: 'blocks' });
  } else if (m.schedule?.cordoned) {
    status = 'cordoned';
    reasons.push({ code: 'cordoned', message: 'Cordoned by the owner', effect: 'blocks' });
  } else if (configured.agents > 0 && held.agents >= configured.agents) {
    reasons.push({ code: 'full', message: `All ${plural(configured.agents, 'agent slot')} in use`, effect: 'info' });
  }
  const accepting = status === 'online';
  return {
    status,
    accepting,
    configured,
    effective: accepting ? configured : { agents: 0, jobs: 0 },
    held,
    loadPerCore: loadPerCore(m.health),
    weight: m.schedule?.weight ?? 1,
    reasons,
  };
}

export function loadPerCore(health: MachineHealth | undefined): number | undefined {
  if (!health?.load || !health.cpus) return undefined;
  return health.load[0] / health.cpus;
}

/** Whether the owner has cordoned or drained the machine, so the action is Uncordon. */
export function isHeld(m: Machine): boolean {
  const p = placementOf(m);
  return !!(m.schedule?.cordoned || m.schedule?.drain) || p.status === 'cordoned' || p.status === 'draining' || p.status === 'drained';
}

/** Newer hubs take PATCH /machines/:id; older ones only drain. */
export function canSchedule(m: Machine): boolean {
  return !!(m.schedule || m.placement);
}

export interface FleetSummary {
  total: number;
  accepting: number;
  held: number;
  effective: number;
  configured: number;
  running: number;
  /** Agents still running past the limit health set on an overloaded or limited machine. */
  over: number;
  overloaded: number;
  /** Cordoned, draining or drained by the owner. */
  cordoned: number;
  offline: number;
}

export function fleetSummary(list: Machine[]): FleetSummary {
  const s: FleetSummary = { total: list.length, accepting: 0, held: 0, effective: 0, configured: 0, running: 0, over: 0, overloaded: 0, cordoned: 0, offline: 0 };
  for (const m of list) {
    const p = placementOf(m);
    if (p.accepting) s.accepting++;
    s.held += p.held.agents;
    s.running += p.held.agents + p.held.jobs;
    if (p.status === 'overloaded' || p.status === 'limited') s.over += Math.max(0, p.held.agents - p.effective.agents);
    s.effective += p.effective.agents;
    if (p.status !== 'offline') s.configured += p.configured.agents;
    if (p.status === 'overloaded') s.overloaded++;
    if (p.status === 'cordoned' || p.status === 'draining' || p.status === 'drained') s.cordoned++;
    if (p.status === 'offline') s.offline++;
  }
  return s;
}

export type FleetFilter = 'all' | 'accepting' | 'not-accepting';
export type FleetSort = 'attention' | 'name';

export function filterFleet(list: Machine[], filter: FleetFilter): Machine[] {
  if (filter === 'all') return list;
  return list.filter((m) => placementOf(m).accepting === (filter === 'accepting'));
}

/** Not accepting first (worst first), then accepting with reasons, then the rest; names break ties. */
const RANK: Record<PlacementStatus, number> = { offline: 0, overloaded: 1, limited: 2, cordoned: 3, draining: 4, drained: 5, online: 6 };

export function attentionRank(m: Machine): number {
  const p = placementOf(m);
  const serious = p.reasons.some((r) => r.effect !== 'info');
  const group = !p.accepting ? 0 : serious ? 10 : 20;
  return group + (RANK[p.status] ?? 9);
}

export function sortFleet(list: Machine[], sort: FleetSort): Machine[] {
  const byName = (a: Machine, b: Machine) => a.name.localeCompare(b.name, 'en', { numeric: true });
  return [...list].sort(sort === 'name' ? byName : (a, b) => attentionRank(a) - attentionRank(b) || byName(a, b));
}

const GB = 1e9;

/** Bytes as "4.1 GB", "494 GB" or "1.2 TB". */
export function bytes(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1).replace(/\.0$/, '')} TB`;
  const gb = n / GB;
  return `${gb < 10 ? gb.toFixed(1).replace(/\.0$/, '') : Math.round(gb)} GB`;
}

const loadAvg = (n: number) => (n < 10 ? n.toFixed(1) : String(Math.round(n)));

export interface HealthCell {
  value: string;
  sub?: string;
  /** Worth a look: shown in ink and medium weight. */
  strong?: boolean;
  title?: string;
}

const NONE: HealthCell = { value: '—', sub: 'Not reported' };

export function loadCell(m: Machine): HealthCell {
  const h = m.health;
  const perCore = placementOf(m).loadPerCore ?? loadPerCore(h);
  if (perCore === undefined || !h?.load) return NONE;
  const strong = placementOf(m).reasons.some((r) => r.code === 'overloaded') || perCore > 1.5;
  return {
    value: `${perCore.toFixed(1)} per core`,
    sub: h.load.map(loadAvg).join(' · '),
    strong,
    title: `Load averages over 1, 5 and 15 minutes on ${plural(h.cpus ?? 0, 'core')}`,
  };
}

const PRESSURE = { normal: '', warn: 'high', critical: 'critical' } as const;

export function memoryCell(m: Machine): HealthCell {
  const mem = m.health?.memory;
  if (!mem) return NONE;
  const pressure = mem.pressure ? PRESSURE[mem.pressure] : '';
  return { value: `${bytes(mem.freeBytes)} free`, sub: `of ${bytes(mem.totalBytes)}${pressure ? ` · ${pressure}` : ''}`, strong: mem.pressure === 'warn' || mem.pressure === 'critical', title: pressure ? `Memory pressure ${pressure}` : undefined };
}

export function diskCell(m: Machine): HealthCell {
  const disk = m.health?.disk;
  if (!disk) return NONE;
  const state = m.health?.storage?.state;
  return {
    value: `${bytes(disk.freeBytes)} free`,
    sub: `of ${bytes(disk.totalBytes)}${state === 'low' ? ' · low' : state === 'critical' ? ' · critical' : ''}`,
    strong: state === 'low' || state === 'critical',
    title: 'Free space on the disk that holds the workspaces',
  };
}

export function powerCell(m: Machine): HealthCell {
  const power = m.health?.power;
  if (!power) return { value: '—' };
  if (power.source === 'ac') return { value: 'AC', sub: power.percent !== undefined ? `${power.percent}%${power.charging ? ' · charging' : ''}` : undefined };
  return { value: 'Battery', sub: power.percent !== undefined ? `${power.percent}%${power.charging ? ' · charging' : ''}` : undefined, strong: placementOf(m).reasons.some((r) => r.code === 'on-battery') };
}

/** Agents held against the effective limit: "3 of 4", or "4 running · limit 0" when over it. */
export function slotsText(p: MachinePlacement): string {
  if (p.held.agents > p.effective.agents) return `${count(p.held.agents)} running · limit ${count(p.effective.agents)}`;
  return `${count(p.held.agents)} of ${count(p.effective.agents)}`;
}

export function slotsSub(p: MachinePlacement): string {
  const jobs = `${count(p.held.jobs)} of ${count(p.effective.jobs)} jobs`;
  return p.configured.agents !== p.effective.agents ? `${jobs} · ${count(p.configured.agents)} configured` : jobs;
}

/** A one-line health summary for narrow screens. */
export function healthLine(m: Machine): string {
  const parts: string[] = [];
  const load = loadCell(m);
  if (load !== NONE) parts.push(`Load ${load.value}`);
  const mem = m.health?.memory;
  if (mem) parts.push(`${bytes(mem.freeBytes)} memory free`);
  const disk = m.health?.disk;
  if (disk) parts.push(`${bytes(disk.freeBytes)} disk free`);
  const power = powerCell(m);
  if (m.health?.power) parts.push(power.value === 'AC' ? 'AC' : `Battery ${power.sub ?? ''}`.trim());
  return parts.join(' · ');
}

const OS: Record<string, string> = { darwin: 'macOS', linux: 'Linux', windows: 'Windows', win32: 'Windows' };
export const osLabel = (os: string) => OS[os] ?? os;
