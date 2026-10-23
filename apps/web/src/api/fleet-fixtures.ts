import type { Machine, MachineHealth, MachinePatch, MachinePlacement, MachineSchedule, PlacementReason, PlacementStatus } from './types';
import { count, plural } from '../lib/format';

/*
 * Demo fleet. A small version of the hub's placement rules turns each
 * machine's reported health and the owner's schedule into the placement the
 * Fleet screen shows, so the demo can cordon, drain and uncordon in memory.
 * Every time is relative to `now`, so screens look the same whenever the
 * demo opens.
 */

const GB = 1e9;
const iso = (t: number) => new Date(t).toISOString();

/** The demo's limits; the hub reads its own from config. */
export const FLEET_LIMITS = { loadPerCore: 1.5, processes: 2_000, diskFreeBytes: 10 * GB } as const;

export function defaultSchedule(at: string): MachineSchedule {
  return { cordoned: false, drain: false, weight: 1, maxAgents: null, maxJobs: null, labels: null, allowOnBattery: null, updatedAt: at };
}

/** Placement from health, schedule and running work, as the hub computes it. */
export function fleetPlacement(m: Machine): MachinePlacement {
  const s = m.schedule ?? defaultSchedule(m.lastHeartbeatAt);
  const h = m.health;
  const configured = { agents: s.maxAgents ?? m.capacity.maxAgents, jobs: s.maxJobs ?? m.capacity.maxJobs };
  const held = { ...m.running };
  const busy = held.agents + held.jobs;
  const perCore = h?.load && h.cpus ? h.load[0] / h.cpus : undefined;
  const reasons: PlacementReason[] = [];
  const add = (code: PlacementReason['code'], message: string, effect: PlacementReason['effect']) => reasons.push({ code, message, effect });

  if (m.revokedAt) add('revoked', 'The node token was revoked', 'blocks');
  else if (m.status === 'offline') add('offline', 'No heartbeat from the node for over 2 minutes', 'blocks');
  if (s.drain) add('draining', busy > 0 ? `Draining: ${plural(held.agents, 'agent')} finishing` : 'Drained: nothing left running', 'blocks');
  else if (s.cordoned) add('cordoned', 'Cordoned by the owner', 'blocks');
  const online = !m.revokedAt && m.status !== 'offline';
  if (online) {
    if (!h) add('no-telemetry', 'The node reports no health; placing on capacity alone', 'info');
    if (perCore !== undefined && perCore > FLEET_LIMITS.loadPerCore) add('overloaded', `Load ${perCore.toFixed(1)} per core (limit ${FLEET_LIMITS.loadPerCore})`, 'blocks');
    if (h?.processes !== undefined && h.processes > FLEET_LIMITS.processes) add('too-many-processes', `${count(h.processes)} processes (limit ${count(FLEET_LIMITS.processes)})`, 'blocks');
    if (h?.memory?.pressure === 'critical') add('memory-pressure', 'Memory pressure is critical', 'blocks-agents');
    else if (h?.memory?.pressure === 'warn') add('memory-pressure', 'Memory pressure is high; fewer agents', 'reduces');
    if (h?.disk && h.disk.freeBytes < FLEET_LIMITS.diskFreeBytes)
      add('low-disk', `${(h.disk.freeBytes / GB).toFixed(1)} GB free on the workspace disk (needs ${FLEET_LIMITS.diskFreeBytes / GB} GB)`, 'blocks');
    if (h?.power?.source === 'battery' && !s.allowOnBattery) add('on-battery', `On battery${h.power.percent !== undefined ? ` (${h.power.percent}%)` : ''}; battery work is off`, 'blocks');
    if (h?.thermal === 'critical') add('thermal', 'Thermal state is critical', 'blocks');
    else if (h?.thermal === 'serious') add('thermal', 'Running hot; fewer agents', 'reduces');
    if (h?.runtime && !h.runtime.reachable) add('runtime-unreachable', 'The agent runtime is not reachable', 'blocks-agents');
    if (!m.providers.length) add('no-provider', 'No harness providers detected', 'blocks-agents');
  }

  const blocks = reasons.some((r) => r.effect === 'blocks');
  const effective = { ...configured };
  if (blocks) Object.assign(effective, { agents: 0, jobs: 0 });
  if (reasons.some((r) => r.effect === 'blocks-agents')) effective.agents = 0;
  if (reasons.some((r) => r.effect === 'blocks-jobs')) effective.jobs = 0;
  if (reasons.some((r) => r.effect === 'reduces')) effective.agents = Math.min(effective.agents, Math.max(1, Math.floor(configured.agents / 2)));
  if (effective.agents > 0 && held.agents >= effective.agents) {
    add(effective.agents < configured.agents ? 'capped-by-node' : 'full', `All ${plural(effective.agents, 'agent slot')} in use`, 'info');
  }

  const has = (code: PlacementReason['code']) => reasons.some((r) => r.code === code);
  let status: PlacementStatus;
  if (!online) status = 'offline';
  else if (s.drain) status = busy > 0 ? 'draining' : 'drained';
  else if (s.cordoned) status = 'cordoned';
  else if (has('overloaded') || has('too-many-processes')) status = 'overloaded';
  else if (reasons.some((r) => r.effect !== 'info')) status = 'limited';
  else status = 'online';
  const accepting = online && !blocks && effective.agents + effective.jobs > 0;
  return { status, accepting, configured, effective, held, loadPerCore: perCore, weight: s.weight, reasons };
}

/** Applies an owner's patch the way the hub does; throws a message on invalid input. */
export function applyMachinePatch(m: Machine, patch: MachinePatch, at: string): Machine {
  const keys = (Object.keys(patch) as (keyof MachinePatch)[]).filter((k) => k !== ('idempotencyKey' as never));
  if (!keys.length) throw new Error('Send at least one field to change.');
  if (patch.weight !== undefined && !(patch.weight >= 0 && patch.weight <= 10)) throw new Error('Weight must be between 0 and 10.');
  for (const k of ['maxAgents', 'maxJobs'] as const) {
    const v = patch[k];
    if (v !== undefined && v !== null && !(Number.isInteger(v) && v >= 0)) throw new Error(`${k} must be a whole number of at least 0, or null.`);
  }
  const schedule: MachineSchedule = { ...(m.schedule ?? defaultSchedule(at)), updatedAt: at };
  for (const k of keys) (schedule as unknown as Record<string, unknown>)[k] = patch[k];
  const next: Machine = { ...m, schedule };
  if ('labels' in patch) next.labels = patch.labels ?? m.reportedLabels ?? m.labels;
  next.placement = fleetPlacement(next);
  next.status = next.placement.status === 'offline' ? 'offline' : schedule.drain ? 'draining' : 'online';
  return next;
}

interface Spec {
  id: string;
  name: string;
  os?: string;
  model?: string;
  cpus: number;
  load: [number, number, number];
  memGb: number;
  memFreeGb: number;
  pressure?: 'normal' | 'warn' | 'critical';
  processes: number;
  diskGb: number;
  diskFreeGb: number;
  power?: MachineHealth['power'];
  thermal?: MachineHealth['thermal'];
  agents: number;
  jobs: number;
  maxAgents: number;
  maxJobs: number;
  labels?: string[];
  providers?: string[];
  status?: Machine['status'];
  schedule?: Partial<MachineSchedule>;
  /** Seconds since the last heartbeat. */
  seen?: number;
  noHealth?: boolean;
}

function build(spec: Spec, now: number): Machine {
  const at = iso(now - (spec.seen ?? 5) * 1000);
  const storage = spec.diskFreeGb < 10 ? (spec.diskFreeGb < 3 ? 'critical' : 'low') : 'ok';
  const health: MachineHealth | undefined = spec.noHealth
    ? undefined
    : {
        reportedAt: at,
        cpus: spec.cpus,
        load: spec.load,
        memory: { totalBytes: spec.memGb * GB, freeBytes: spec.memFreeGb * GB, pressure: spec.pressure ?? 'normal' },
        processes: spec.processes,
        power: spec.power,
        thermal: spec.thermal ?? 'nominal',
        uptimeSec: 3 * 86_400 + 4_200,
        nodeVersion: '24.13.1',
        runtime: { reachable: true },
        disk: { totalBytes: spec.diskGb * GB, freeBytes: spec.diskFreeGb * GB },
        storage: { state: storage },
      };
  const labels = spec.labels ?? [];
  const m: Machine = {
    id: spec.id,
    name: spec.name,
    os: spec.os ?? 'darwin',
    arch: spec.os === 'linux' ? 'x64' : 'arm64',
    labels,
    reportedLabels: labels,
    providers: spec.providers ?? ['claudeAgent', 'codex'],
    capacity: { maxAgents: spec.maxAgents, maxJobs: spec.maxJobs },
    running: { agents: spec.agents, jobs: spec.jobs },
    status: spec.status ?? (spec.schedule?.drain ? 'draining' : 'online'),
    lastHeartbeatAt: at,
    version: '0.5.0',
    health,
    schedule: { ...defaultSchedule(iso(now - 3_600_000)), ...spec.schedule },
  };
  m.placement = fleetPlacement(m);
  return m;
}

/**
 * The owner's two Macs: a Mac mini buried under a runaway build (load 130 on
 * 10 cores, 2,700 processes) that the hub has stopped placing on, and a
 * MacBook Pro on AC taking the work instead.
 */
export function fleetMachines(now: number, ids: { studio: string; mbp: string } = { studio: 'mch_studio', mbp: 'mch_mbp' }): Machine[] {
  return [
    build(
      {
        id: ids.studio,
        name: 'studio-mini',
        cpus: 10,
        load: [130.4, 118.2, 96.7],
        memGb: 32,
        memFreeGb: 2.4,
        pressure: 'warn',
        processes: 2_700,
        diskGb: 994,
        diskFreeGb: 212,
        power: { source: 'ac' },
        agents: 4,
        jobs: 1,
        maxAgents: 6,
        maxJobs: 2,
        labels: ['macos', 'xcode', 'ci'],
        seen: 4,
      },
      now,
    ),
    build(
      {
        id: ids.mbp,
        name: 'justus-mbp',
        cpus: 14,
        load: [5.8, 6.4, 5.1],
        memGb: 48,
        memFreeGb: 19.6,
        processes: 812,
        diskGb: 1_995,
        diskFreeGb: 684,
        power: { source: 'ac', percent: 100, charging: false },
        agents: 2,
        jobs: 0,
        maxAgents: 4,
        maxJobs: 1,
        labels: ['macos', 'xcode'],
        seen: 7,
      },
      now,
    ),
  ];
}

/** A deterministic pseudo-random sequence so generated fleets are stable. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

type Kind = 'healthy' | 'busy' | 'idle' | 'overloaded' | 'memory' | 'low-disk' | 'battery' | 'cordoned' | 'draining' | 'drained' | 'offline' | 'no-provider' | 'legacy';

/** How many of each kind in a 50-machine fleet; the rest are healthy. */
const MIX: [Kind, number][] = [
  ['overloaded', 3],
  ['memory', 3],
  ['low-disk', 2],
  ['battery', 2],
  ['cordoned', 3],
  ['draining', 2],
  ['drained', 1],
  ['offline', 2],
  ['no-provider', 1],
  ['legacy', 1],
  ['busy', 10],
  ['idle', 6],
];

const FAMILIES = [
  { prefix: 'ci-linux', os: 'linux', cpus: 32, memGb: 128, diskGb: 1_920, maxAgents: 8, maxJobs: 6, labels: ['linux', 'docker', 'ci'] },
  { prefix: 'build-mini', os: 'darwin', cpus: 12, memGb: 64, diskGb: 994, maxAgents: 6, maxJobs: 2, labels: ['macos', 'xcode', 'ci'] },
  { prefix: 'agent-box', os: 'linux', cpus: 16, memGb: 64, diskGb: 994, maxAgents: 10, maxJobs: 2, labels: ['linux'] },
  { prefix: 'studio', os: 'darwin', cpus: 24, memGb: 192, diskGb: 3_990, maxAgents: 12, maxJobs: 4, labels: ['macos', 'xcode', 'gpu'] },
] as const;

/**
 * A fleet of `size` machines with a realistic mix of states for tests and
 * screenshots: the two demo Macs first, then generated machines.
 */
export function generateFleet(size = 50, now = Date.now(), ids?: { studio: string; mbp: string }): Machine[] {
  const r = rng(7);
  const pick = (lo: number, hi: number) => lo + r() * (hi - lo);
  const int = (lo: number, hi: number) => Math.floor(pick(lo, hi + 1));
  const kinds: Kind[] = [];
  for (const [kind, n] of MIX) for (let i = 0; i < n; i++) kinds.push(kind);
  const fleet = fleetMachines(now, ids).slice(0, size);
  const counters: Record<string, number> = {};
  for (let i = fleet.length; i < size; i++) {
    const kind = kinds[i - 2] ?? 'healthy';
    const fam = FAMILIES[i % FAMILIES.length];
    counters[fam.prefix] = (counters[fam.prefix] ?? 0) + 1;
    const n = counters[fam.prefix];
    const name = `${fam.prefix}-${String(n).padStart(2, '0')}`;
    const perCore = kind === 'overloaded' ? pick(2.2, 6) : kind === 'busy' ? pick(0.7, 1.3) : kind === 'idle' ? pick(0.02, 0.2) : pick(0.2, 0.9);
    const l1 = perCore * fam.cpus;
    const agents = kind === 'idle' || kind === 'drained' || kind === 'offline' ? 0 : kind === 'busy' || kind === 'overloaded' ? fam.maxAgents - int(0, 1) : int(1, Math.max(1, fam.maxAgents - 2));
    const spec: Spec = {
      id: `mch_${name.replace(/-/g, '_')}`,
      name,
      os: fam.os,
      cpus: fam.cpus,
      load: [l1, l1 * pick(0.8, 1.1), l1 * pick(0.6, 1)],
      memGb: fam.memGb,
      memFreeGb: kind === 'memory' ? Math.round(fam.memGb * pick(0.02, 0.05) * 10) / 10 : Math.round(fam.memGb * pick(0.2, 0.6)),
      pressure: kind === 'memory' ? (i % 2 ? 'critical' : 'warn') : 'normal',
      processes: kind === 'overloaded' && i % 2 ? int(2_100, 3_400) : int(380, 1_400),
      diskGb: fam.diskGb,
      diskFreeGb: kind === 'low-disk' ? Math.round(pick(2.5, 8) * 10) / 10 : Math.round(fam.diskGb * pick(0.15, 0.7)),
      power: kind === 'battery' ? { source: 'battery', percent: int(28, 81), charging: false } : fam.os === 'darwin' ? { source: 'ac' } : undefined,
      agents,
      jobs: kind === 'drained' || kind === 'offline' || kind === 'idle' ? 0 : Math.min(fam.maxJobs, int(0, 2)),
      maxAgents: fam.maxAgents,
      maxJobs: fam.maxJobs,
      labels: [...fam.labels],
      providers: kind === 'no-provider' ? [] : i % 3 ? ['claudeAgent', 'codex'] : ['codex'],
      status: kind === 'offline' ? 'offline' : undefined,
      seen: kind === 'offline' ? int(600, 20_000) : int(2, 14),
      schedule: kind === 'cordoned' ? { cordoned: true } : kind === 'draining' || kind === 'drained' ? { drain: true } : undefined,
    };
    const m = build(spec, now);
    if (kind === 'legacy') {
      // An older node on an older hub: no health, schedule or placement.
      delete m.health;
      delete m.schedule;
      delete m.placement;
      delete m.reportedLabels;
    }
    fleet.push(m);
  }
  return fleet;
}
