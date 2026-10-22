import { useMemo, useState } from 'react';
import { useResource } from '../app/hub-context';
import type { Machine, Session, SessionsSummary } from '../api/types';
import { Async, Empty, PageHeader, Panel, Segmented, Stat } from '../components/ui';
import { IconMachines, IconSessions } from '../components/icons';
import { MachineLine, SessionItem, useNow, useSessions, useSessionsSummary } from '../components/sessions';
import { isThisMac, matchesFilter, nestSessions, summaryTokens } from '../lib/sessions';
import type { StatusFilter } from '../lib/sessions';
import { plural, tokens } from '../lib/format';

export function SessionsPage() {
  const sessions = useSessions();
  const summary = useSessionsSummary('1h');
  const machines = useResource((api) => api.listMachines().catch(() => [] as Machine[]), [], (e) => e.subject.kind === 'machine');
  const now = useNow();

  return (
    <div className="page">
      <PageHeader title="Sessions" description="Every T3 Code session on your machines. Perpeto only watches; nothing here changes a session." />
      <Async resource={sessions} what="sessions">
        {(list) =>
          list === null ? (
            <section className="card">
              <Empty title="This hub doesn’t observe sessions yet" icon={<IconSessions />}>
                Update the hub and run a node on each Mac with T3 Code. Each node watches its T3 Code app read-only and reports sessions here.
              </Empty>
            </section>
          ) : (
            <>
              <SummaryCard summary={summary.data ?? undefined} sessions={list} machines={machines.data ?? []} now={now} />
              <SessionList sessions={list} summary={summary.data ?? undefined} machines={machines.data ?? []} now={now} />
            </>
          )
        }
      </Async>
    </div>
  );
}

function SummaryCard({ summary, sessions, machines, now }: { summary?: SessionsSummary; sessions: Session[]; machines: Machine[]; now: number }) {
  const running = summary?.totals.running ?? sessions.filter((s) => s.status === 'running').length;
  const waiting = summary?.totals.waiting ?? sessions.filter((s) => s.status === 'waiting').length;
  const hour = summaryTokens(summary);
  return (
    <section className="card" aria-label="Across machines">
      <dl className="metrics live-metrics" aria-live="polite">
        <Stat label="Running" value={running} />
        <Stat label="Waiting for you" value={waiting} />
        <Stat label="Tokens in the last hour" value={hour !== undefined ? tokens(hour) : '—'} />
      </dl>
      {summary && summary.machines.length > 0 && (
        <ul className="machine-lines">
          {summary.machines.map((m) => (
            <MachineLine key={m.machineId} machine={m} now={now} thisMac={isThisMac(machines.find((x) => x.id === m.machineId) ?? { name: m.name })} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SessionList({ sessions, summary, machines, now }: { sessions: Session[]; summary?: SessionsSummary; machines: Machine[]; now: number }) {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [machine, setMachine] = useState('');
  const counts = useMemo(() => {
    const n = (f: StatusFilter) => sessions.filter((s) => matchesFilter(s, f)).length;
    return { all: sessions.length, running: n('running'), waiting: n('waiting'), idle: n('idle'), error: n('error') };
  }, [sessions]);

  // Machines in the summary's order, then any only the session list knows.
  const hosts = useMemo(() => {
    const order = new Map<string, string>();
    for (const m of summary?.machines ?? []) order.set(m.machineId, m.name);
    for (const s of sessions) if (!order.has(s.machineId)) order.set(s.machineId, s.machineName);
    return [...order.entries()].map(([id, name]) => ({ id, name }));
  }, [sessions, summary]);

  // A parent stays when it or one of its subagents matches, so a running subagent is never orphaned.
  const groups = hosts
    .filter((h) => !machine || h.id === machine)
    .map((h) => ({
      host: h,
      nodes: nestSessions(sessions.filter((s) => s.machineId === h.id)).filter((n) => matchesFilter(n.session, filter) || n.children.some((c) => matchesFilter(c, filter))),
    }))
    .filter((g) => g.nodes.length > 0 || filter === 'all');

  const options: { value: StatusFilter; label: string; count: number }[] = [
    { value: 'all', label: 'All', count: counts.all },
    { value: 'running', label: 'Running', count: counts.running },
    { value: 'waiting', label: 'Waiting', count: counts.waiting },
    { value: 'idle', label: 'Idle', count: counts.idle },
  ];
  if (counts.error || filter === 'error') options.push({ value: 'error', label: 'Errors', count: counts.error });

  return (
    <>
      <div className="toolbar">
        <Segmented<StatusFilter> label="Show sessions" value={filter} onChange={setFilter} options={options} />
        {hosts.length > 1 && (
          <span className="select">
            <select className="input" aria-label="Machine" value={machine} onChange={(e) => setMachine(e.target.value)}>
              <option value="">All machines</option>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </span>
        )}
      </div>
      {sessions.length === 0 ? (
        <section className="card">
          <Empty title="No sessions yet" icon={<IconSessions />}>
            Sessions appear here as soon as T3 Code starts one on a machine with a node.
          </Empty>
        </section>
      ) : groups.length === 0 ? (
        <section className="card">
          <Empty title={`No ${filter === 'error' ? 'sessions with errors' : `${filter} sessions`}`} icon={<IconSessions />}>
            {filter === 'waiting' ? 'Nothing is waiting for you right now.' : 'Try another filter.'}
          </Empty>
        </section>
      ) : (
        groups.map(({ host, nodes }) => {
          const all = sessions.filter((s) => s.machineId === host.id);
          const thisMac = isThisMac(machines.find((m) => m.id === host.id) ?? { name: host.name });
          return (
            <Panel
              key={host.id}
              title={
                <span className="machine-title">
                  <code className="mono">{host.name}</code>
                  {thisMac && <span className="chip-quiet">This Mac</span>}
                </span>
              }
              actions={plural(all.filter((s) => !s.parentThreadId || !all.some((p) => p.threadId === s.parentThreadId)).length, 'session')}
            >
              {nodes.length === 0 ? (
                <p className="muted session-none">
                  <IconMachines size={16} /> No sessions on this machine.
                </p>
              ) : (
                <ul className="sessions">
                  {nodes.map((n) => (
                    <SessionItem key={n.session.id} node={n} now={now} />
                  ))}
                </ul>
              )}
            </Panel>
          );
        })
      )}
    </>
  );
}
