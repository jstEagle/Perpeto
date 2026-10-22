import type {
  Account,
  AccountUsage,
  OnTrack,
  Pacing,
  PacingAccount,
  PacingAccountState,
  PacingLimit,
  PacingMode,
  PacingProvider,
  PacingSegment,
  PacingStrategy,
  PacingWindow,
  UsageWindow,
  UsageWindowKind,
} from './types';

/*
 * Tolerant decoding for subscription usage and pacing. The contract is new
 * and may still shift: optional fields stay optional, malformed entries are
 * dropped instead of failing the screen, and unknown enum values decode to a
 * neutral member.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const count = (v: unknown): number => Math.max(0, Math.round(num(v) ?? 0));
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const time = (v: unknown): string | undefined => {
  const s = str(v);
  return s && !Number.isNaN(Date.parse(s)) ? s : undefined;
};
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

const KINDS = ['session', 'weekly', 'monthly', 'other'] as const;
const STRATEGIES = ['rotation', 'parallel'] as const;
const LIMITS = ['weekly', 'session', 'slots', 'work', 'none'] as const;
const STATES = ['burning', 'next', 'resting', 'cooling', 'exhausted'] as const;
const TRACKS = ['under', 'on', 'over'] as const;

const kind = (v: unknown): UsageWindowKind => oneOf(v, KINDS, 'other');
const KIND_LABEL: Record<UsageWindowKind, string> = { session: 'Session', weekly: 'Weekly', monthly: 'Monthly', other: 'Limit' };

function decodeUsageWindow(v: unknown): UsageWindow | null {
  const o = obj(v);
  const used = num(o?.usedPercent);
  if (!o || used === undefined) return null;
  const k = kind(o.kind);
  return {
    id: str(o.id) ?? k,
    kind: k,
    label: str(o.label) ?? KIND_LABEL[k],
    usedPercent: Math.max(0, used),
    ...(time(o.resetsAt) ? { resetsAt: time(o.resetsAt) } : {}),
    ...(num(o.windowMins) !== undefined ? { windowMins: num(o.windowMins) } : {}),
  };
}

export function decodeAccountUsage(v: unknown): AccountUsage | undefined {
  const o = obj(v);
  if (!o) return undefined;
  const windows = arr(o.windows).map(decodeUsageWindow).filter((w): w is UsageWindow => w !== null);
  return { ...(time(o.checkedAt) ? { checkedAt: time(o.checkedAt) } : {}), windows };
}

/** Keeps the account as sent; only `plan` and `usage` are checked, since they are new. */
export function decodeAccount(v: unknown): Account {
  const o = (obj(v) ?? {}) as Obj & Account;
  const { plan, usage, source, ...rest } = o;
  const decodedUsage = decodeAccountUsage(usage);
  return {
    ...rest,
    ...(str(plan) ? { plan: str(plan) } : {}),
    ...(decodedUsage ? { usage: decodedUsage } : {}),
    ...(str(source) ? { source: str(source) } : {}),
  } as Account;
}

function decodePacingWindow(v: unknown): PacingWindow | null {
  const base = decodeUsageWindow(v);
  if (!base) return null;
  const o = obj(v)!;
  return {
    id: base.id,
    kind: base.kind,
    label: base.label,
    usedPercent: base.usedPercent,
    ...(base.resetsAt ? { resetsAt: base.resetsAt } : {}),
    projectedPercentAtReset: Math.max(0, num(o.projectedPercentAtReset) ?? base.usedPercent),
    onTrack: oneOf<OnTrack>(o.onTrack, TRACKS, 'unknown'),
  };
}

function decodeProvider(v: unknown): PacingProvider | null {
  const o = obj(v);
  const provider = str(o?.provider);
  if (!o || !provider) return null;
  return {
    provider,
    targetAgents: count(o.targetAgents),
    runningAgents: count(o.runningAgents),
    slots: count(o.slots),
    readyWork: count(o.readyWork),
    limitedBy: oneOf<PacingLimit>(o.limitedBy, LIMITS, 'unknown'),
    starved: o.starved === true,
  };
}

function decodePacingAccount(v: unknown): PacingAccount | null {
  const o = obj(v);
  const accountId = str(o?.accountId) ?? str(o?.id);
  if (!o || !accountId) return null;
  return {
    accountId,
    machineId: str(o.machineId) ?? '',
    provider: str(o.provider) ?? '',
    label: str(o.label) ?? accountId,
    ...(str(o.plan) ? { plan: str(o.plan) } : {}),
    state: oneOf<PacingAccountState>(o.state, STATES, 'unknown'),
    targetAgents: count(o.targetAgents),
    runningAgents: count(o.runningAgents),
    ...(num(o.burnPerAgentHour) !== undefined ? { burnPerAgentHour: num(o.burnPerAgentHour) } : {}),
    windows: arr(o.windows).map(decodePacingWindow).filter((w): w is PacingWindow => w !== null),
    idleForecastMins: Math.max(0, num(o.idleForecastMins) ?? 0),
    ...(num(o.headroomAgents) !== undefined ? { headroomAgents: count(o.headroomAgents) } : {}),
  };
}

function decodeSegment(v: unknown): PacingSegment | null {
  const o = obj(v);
  const accountId = str(o?.accountId);
  const from = time(o?.from);
  const to = time(o?.to);
  if (!o || !accountId || !from || !to || Date.parse(to) <= Date.parse(from)) return null;
  if (o.phase !== 'burn' && o.phase !== 'rest') return null;
  return { accountId, from, to, phase: o.phase };
}

/** `GET /pacing`, or the `pacing` envelope a hub may wrap it in. */
export function decodePacing(body: unknown): Pacing {
  const root = obj(body) ?? {};
  const o = obj(root.pacing) ?? root;
  const target = num(o.targetUsePercent);
  // No field: an older hub that enforces. Anything but `enforce` is advice.
  const mode: PacingMode = o.mode === undefined || o.mode === null || o.mode === 'enforce' ? 'enforce' : 'advise';
  return {
    mode,
    enabled: o.enabled === true,
    strategy: oneOf<PacingStrategy>(o.strategy, STRATEGIES, 'unknown'),
    targetUsePercent: target !== undefined ? Math.min(100, Math.max(1, Math.round(target))) : 95,
    ...(num(o.minAgents) !== undefined ? { minAgents: count(o.minAgents) } : {}),
    ...(o.maxAgents === null ? { maxAgents: null } : num(o.maxAgents) !== undefined ? { maxAgents: count(o.maxAgents) } : {}),
    ...(time(o.updatedAt) ? { updatedAt: time(o.updatedAt) } : {}),
    providers: arr(o.providers).map(decodeProvider).filter((p): p is PacingProvider => p !== null),
    accounts: arr(o.accounts).map(decodePacingAccount).filter((a): a is PacingAccount => a !== null),
    timeline: arr(o.timeline).map(decodeSegment).filter((s): s is PacingSegment => s !== null),
  };
}

/** True when a response body carries pacing state rather than an acknowledgement. */
export function looksLikePacing(body: unknown): boolean {
  const o = obj(obj(body)?.pacing) ?? obj(body);
  return !!o && ('enabled' in o || 'accounts' in o || 'providers' in o);
}
