import type { ObservedMachine, Session, SessionPage, SessionStatus, SessionsSummary, SessionsWindow, SessionTokens, TokenGroup } from './types';

/*
 * Tolerant decoding for observed T3 Code sessions. The contract is being
 * built alongside this client: optional fields stay optional, numbers may
 * arrive as strings, malformed entries are dropped instead of failing the
 * screen, and unknown statuses decode as `unknown`.
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

const STATUSES = ['running', 'waiting', 'idle', 'error'] as const;
export const sessionStatus = (v: unknown): SessionStatus => (typeof v === 'string' && (STATUSES as readonly string[]).includes(v) ? (v as SessionStatus) : 'unknown');

function decodeTokens(v: unknown): SessionTokens {
  const o = obj(v) ?? {};
  return { input: count(o.input), output: count(o.output), cacheRead: count(o.cacheRead), cacheWrite: count(o.cacheWrite), reasoning: count(o.reasoning) };
}

export function decodeSession(v: unknown): Session | null {
  const o = obj(v);
  const id = str(o?.id);
  if (!o || !id) return null;
  const createdAt = time(o.createdAt);
  const lastActivityAt = time(o.lastActivityAt) ?? createdAt;
  const project = obj(o.project);
  const projectName = str(project?.name) ?? str(o.project);
  const machineId = str(o.machineId) ?? '';
  return {
    id,
    machineId,
    machineName: str(o.machineName) ?? machineId,
    threadId: str(o.threadId) ?? id,
    ...(str(o.title) ? { title: str(o.title)!.trim() } : {}),
    ...(projectName ? { project: { name: projectName, ...(str(project?.path) ? { path: str(project?.path) } : {}) } } : {}),
    ...(str(o.branch) ? { branch: str(o.branch) } : {}),
    provider: str(o.provider) ?? 'unknown',
    ...(str(o.providerInstanceId) ? { providerInstanceId: str(o.providerInstanceId) } : {}),
    ...(str(o.model) ? { model: str(o.model) } : {}),
    status: sessionStatus(o.status),
    ...(str(o.parentThreadId) ? { parentThreadId: str(o.parentThreadId) } : {}),
    childCount: count(o.childCount),
    createdAt: createdAt ?? lastActivityAt ?? new Date(0).toISOString(),
    lastActivityAt: lastActivityAt ?? new Date(0).toISOString(),
    turns: count(o.turns),
    tokens: decodeTokens(o.tokens),
  };
}

/** `GET /sessions`: `{ sessions, nextCursor? }`, or a bare array from a simpler hub. */
export function decodeSessionPage(body: unknown): SessionPage {
  const o = obj(body);
  const list = Array.isArray(body) ? body : arr(o?.sessions);
  const cursor = o?.nextCursor;
  const nextCursor = typeof cursor === 'number' && Number.isFinite(cursor) ? String(cursor) : str(cursor);
  return { sessions: list.map(decodeSession).filter((s): s is Session => s !== null), ...(nextCursor ? { nextCursor } : {}) };
}

function decodeMachine(v: unknown): ObservedMachine | null {
  const o = obj(v);
  const machineId = str(o?.machineId) ?? str(o?.id);
  if (!o || !machineId) return null;
  return {
    machineId,
    name: str(o.name) ?? machineId,
    online: o.online === true,
    observing: o.observing === true,
    ...(time(o.lastObservedAt) ? { lastObservedAt: time(o.lastObservedAt) } : {}),
    running: count(o.running),
    waiting: count(o.waiting),
    idle: count(o.idle),
  };
}

/** A token group keyed by whichever of `field`, `key` or `id` is present. */
function decodeGroup(field: string) {
  return (v: unknown): TokenGroup | null => {
    const o = obj(v);
    const key = str(o?.[field]) ?? str(o?.key) ?? str(o?.id);
    if (!o || !key) return null;
    return { key, input: count(o.input), output: count(o.output), cacheRead: count(o.cacheRead), cacheWrite: count(o.cacheWrite) };
  };
}

const groups = (v: unknown, field: string) => arr(v).map(decodeGroup(field)).filter((g): g is TokenGroup => g !== null);

/** `GET /sessions/summary`, or the `summary` envelope a hub may wrap it in. */
export function decodeSessionsSummary(body: unknown, window: SessionsWindow): SessionsSummary {
  const root = obj(body) ?? {};
  const o = obj(root.summary) ?? root;
  const machines = arr(o.machines).map(decodeMachine).filter((m): m is ObservedMachine => m !== null);
  const totals = obj(o.totals);
  const tokens = obj(o.tokens) ?? {};
  const sum = (k: 'running' | 'waiting') => machines.reduce((s, m) => s + m[k], 0);
  const running = totals && num(totals.running) !== undefined ? count(totals.running) : sum('running');
  const waiting = totals && num(totals.waiting) !== undefined ? count(totals.waiting) : sum('waiting');
  return {
    window,
    machines,
    totals: { running, waiting, sessionsActive: totals && num(totals.sessionsActive) !== undefined ? count(totals.sessionsActive) : running + waiting },
    tokens: {
      byProvider: groups(tokens.byProvider, 'provider'),
      byModel: groups(tokens.byModel, 'model'),
      byMachine: groups(tokens.byMachine, 'machineId'),
      series: arr(tokens.series)
        .map((p) => {
          const x = obj(p);
          const at = time(x?.at);
          return x && at ? { at, input: count(x.input), output: count(x.output) } : null;
        })
        .filter((p): p is { at: string; input: number; output: number } => p !== null)
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    },
  };
}
