import { useEffect, useState } from 'react';
import type { HubApi } from '../api/hub';
import type { HubEvent, ObservedMachine, Session, SessionsSummary, SessionsWindow } from '../api/types';
import { useResource } from '../app/hub-context';
import { modelName, SESSION_STATUS, sessionTime, sessionTokens } from '../lib/sessions';
import type { SessionNode } from '../lib/sessions';
import { plural, relative, tokens } from '../lib/format';
import { IconChevronDown, IconMachines } from './icons';
import { StatusLabel } from './status';

/** Observed sessions change often; refetch at most about once a second, at least every five. */
const REFRESH = { debounceMs: 1000, maxWaitMs: 5000 };
export const sessionEvent = (e: HubEvent) => e.type.startsWith('session') || e.subject.kind === 'session';

/** Every page of `GET /sessions`, up to `maxPages`; `null` when the hub doesn't observe sessions. */
export async function loadAllSessions(api: HubApi, maxPages = 10): Promise<Session[] | null> {
  const all: Session[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await api.listSessions({ limit: 200, ...(cursor ? { cursor } : {}) });
    if (!page) return i === 0 ? null : all;
    all.push(...page.sessions);
    if (!page.nextCursor || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }
  return all;
}

export function useSessions() {
  return useResource((api) => loadAllSessions(api), [], sessionEvent, REFRESH);
}

export function useSessionsSummary(window: SessionsWindow) {
  return useResource((api) => api.sessionsSummary(window), [window], (e) => sessionEvent(e) || e.subject.kind === 'machine', REFRESH);
}

/** Re-renders on an interval so "for 42 min" and "seen 2 min ago" stay true. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export function SessionStatusLabel({ session }: { session: Session }) {
  const [tone, label] = SESSION_STATUS[session.status];
  return <StatusLabel tone={tone}>{label}</StatusLabel>;
}

/** Project, branch and model, the identifiers in mono. */
function SessionMeta({ session: s, machine }: { session: Session; machine?: boolean }) {
  const parts = [
    machine ? <code className="mono" key="m">{s.machineName}</code> : null,
    s.project ? <span key="p">{s.project.name}</span> : null,
    // With the machine shown, the branch is left out so the line fits a narrow card.
    s.branch && !machine ? <code className="mono" key="b">{s.branch}</code> : null,
    <span key="model">{modelName(s.model)}</span>,
  ].filter(Boolean);
  return (
    <span className="session-meta">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {p}
        </span>
      ))}
    </span>
  );
}

/** One session: title and identifiers, status with how long, then tokens and turns. */
export function SessionRow({ session: s, now, showMachine, child }: { session: Session; now: number; showMachine?: boolean; child?: boolean }) {
  return (
    <div className={`session-row is-${s.status} ${child ? 'is-child' : ''}`}>
      <div className="session-main">
        <span className="session-title" title={s.title}>
          {s.title ?? <span className="muted">Untitled session</span>}
        </span>
        <SessionMeta session={s} machine={showMachine} />
      </div>
      <div className="session-status">
        <SessionStatusLabel session={s} />
        <span className="cell-sub tabular">{sessionTime(s, now)}</span>
      </div>
      <div className="session-nums">
        <span className="session-tokens" title={`${s.tokens.input.toLocaleString('en')} input, ${s.tokens.output.toLocaleString('en')} output, ${s.tokens.cacheRead.toLocaleString('en')} cache read`}>
          {tokens(sessionTokens(s))}
        </span>
        <span className="cell-sub tabular">{plural(s.turns, 'turn')}</span>
      </div>
    </div>
  );
}

/** A session and, behind a disclosure, the subagents it spawned. Open while one of them is busy. */
export function SessionItem({ node, now, showMachine }: { node: SessionNode; now: number; showMachine?: boolean }) {
  const busy = node.children.filter((c) => c.status === 'running' || c.status === 'waiting');
  const reported = Math.max(node.children.length, node.session.childCount);
  return (
    <li className="session">
      <SessionRow session={node.session} now={now} showMachine={showMachine} />
      {node.children.length > 0 ? (
        <details className="disclosure session-children" open={busy.length > 0}>
          <summary>
            {plural(node.children.length, 'subagent')}
            {busy.length > 0 && ` · ${busy.filter((c) => c.status === 'running').length ? `${busy.filter((c) => c.status === 'running').length} running` : `${busy.length} waiting`}`}
            <IconChevronDown size={16} />
          </summary>
          <div className="disclosure-body">
            <ul className="session-child-list">
              {node.children.map((c) => (
                <li key={c.id}>
                  <SessionRow session={c} now={now} child />
                </li>
              ))}
            </ul>
          </div>
        </details>
      ) : (
        reported > 0 && <span className="session-children-note">{plural(reported, 'subagent')}</span>
      )}
    </li>
  );
}

/** One line per machine: name, whether its node watches T3 Code, and what runs there. */
export function MachineLine({ machine: m, now, thisMac }: { machine: ObservedMachine; now: number; thisMac?: boolean }) {
  const counts = [m.running ? `${m.running} running` : null, m.waiting ? `${m.waiting} waiting` : null].filter(Boolean).join(' · ') || 'Nothing running';
  return (
    <li className="machine-line">
      <span className="tile tile-sm" aria-hidden="true">
        <IconMachines />
      </span>
      <span className="row-main">
        <span className="machine-line-name">
          <code className="mono cell-title">{m.name}</code>
          {thisMac && <span className="chip-quiet">This Mac</span>}
        </span>
        <span className="cell-sub">
          {m.observing ? 'Watching T3 Code' : m.online ? 'Not watching T3 Code' : 'Offline'} · {m.lastObservedAt ? `seen ${relative(m.lastObservedAt, now)}` : 'not seen yet'}
        </span>
      </span>
      <span className={`machine-line-counts tabular ${m.waiting ? 'is-waiting' : ''}`}>{counts}</span>
      {!m.online ? (
        <StatusLabel tone="attention">Offline</StatusLabel>
      ) : m.observing ? (
        <StatusLabel tone="done">Observing</StatusLabel>
      ) : (
        <StatusLabel tone="quiet">Not observing</StatusLabel>
      )}
    </li>
  );
}

/**
 * Tokens over a window as grey bars, the newest bucket in ink, labels only
 * at the ends. No orange: this is history, not live work.
 */
export function TokenBars({ summary, from, tall }: { summary: SessionsSummary; from: string; tall?: boolean }) {
  const points = summary.tokens.series;
  const max = Math.max(1, ...points.map((p) => p.input + p.output));
  if (!points.length) return <p className="muted chart-empty">No tokens reported in this window.</p>;
  return (
    <figure className="usage-chart" aria-label={`Tokens ${from.replace(' ago', '')}: ${points.map((p) => tokens(p.input + p.output)).join(', ')}`}>
      <div className={`bars ${tall ? 'bars-tall' : 'bars-mid'}`} aria-hidden="true">
        {points.map((p, i) => {
          const total = p.input + p.output;
          return <span key={p.at} className={i === points.length - 1 ? 'now' : total === 0 ? 'zero' : ''} style={{ height: total ? `${(total / max) * 100}%` : undefined }} title={`${new Date(p.at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}: ${tokens(total)} tokens`} />;
        })}
      </div>
      <div className="bars-axis" aria-hidden="true">
        <span>{from}</span>
        <span>Now</span>
      </div>
    </figure>
  );
}
