import { Link } from '@tanstack/react-router';
import { useAppMode } from '../app/mode';
import { useResource } from '../app/hub-context';
import type { Account, Machine, Pacing, Session, SessionsSummary } from '../api/types';
import { btn, Empty, Loading, PageHeader, Panel, Stat } from '../components/ui';
import { IconChevronRight, IconSessions } from '../components/icons';
import { LiveDot } from '../components/status';
import { UsageMeter } from '../components/pacing';
import { MachineLine, SessionItem, TokenBars, useNow, useSessions, useSessionsSummary } from '../components/sessions';
import { adviceHeadline, headroomText, isThisMac, nestSessions, summaryTokens } from '../lib/sessions';
import { meterWindows } from '../lib/pacing';
import { tokens } from '../lib/format';
import { providerLabel } from '../workflow/registry';
import { ProjectsPage } from './projects';

/**
 * `/`: the factory home in observe-only mode (no projects), else the
 * project list as before.
 */
export function HomePage() {
  const { observe } = useAppMode();
  if (observe === undefined) return <Loading label="Loading your factory" />;
  return observe ? <ObserveHome /> : <ProjectsPage />;
}

const accountEvent = (e: { type: string; subject: { kind: string } }) => e.subject.kind === 'account' || e.type.startsWith('pacing.');

function ObserveHome() {
  const sessions = useSessions();
  const day = useSessionsSummary('24h');
  const pacing = useResource((api) => api.pacing().catch(() => null), [], accountEvent);
  const accounts = useResource((api) => api.listAccounts(), [], accountEvent);
  const machines = useResource((api) => api.listMachines().catch(() => [] as Machine[]), [], (e) => e.subject.kind === 'machine');
  const now = useNow();
  const list = sessions.data ?? undefined;
  const summary = day.data ?? undefined;
  const observing = summary?.machines.filter((m) => m.observing).length;

  return (
    <div className="page">
      <PageHeader
        title="Home"
        description={summary ? `T3 Code on ${summary.machines.length === 1 ? 'one machine' : `${summary.machines.length} machines`}, watched read-only. Nothing here changes a session.` : 'Your T3 Code sessions and subscriptions, watched read-only.'}
        actions={
          <Link to="/sessions" className={btn('primary')}>
            Open sessions
          </Link>
        }
      />
      {sessions.data === null && day.data === null ? (
        <section className="card">
          <Empty title="This hub doesn’t observe sessions yet" icon={<IconSessions />}>
            Update the hub and run a node on each Mac with T3 Code. Each node watches its T3 Code app read-only.
          </Empty>
        </section>
      ) : (
        <>
          <Hero pacing={pacing.data ?? undefined} summary={summary} sessions={list} observing={observing} />
          <div className="cols">
            <div className="stack">
              <RunningNow sessions={list} now={now} />
              <Subscriptions accounts={accounts.data} pacing={pacing.data ?? undefined} machines={machines.data ?? []} now={now} />
            </div>
            <div className="stack">
              <Panel
                title="Machines"
                actions={
                  <Link to="/machines" className="card-link">
                    Machines
                    <IconChevronRight />
                  </Link>
                }
              >
                {summary?.machines.length ? (
                  <ul className="machine-lines machine-lines-stacked">
                    {summary.machines.map((m) => (
                      <MachineLine key={m.machineId} machine={m} now={now} thisMac={isThisMac(machines.data?.find((x) => x.id === m.machineId) ?? { name: m.name })} />
                    ))}
                  </ul>
                ) : (
                  <p className="muted">{summary ? 'No machine is watching T3 Code yet.' : 'Loading…'}</p>
                )}
              </Panel>
              <Panel title="Tokens over 24 hours" actions={summary ? `${tokens(summaryTokens(summary) ?? 0)} input and output` : undefined}>
                {summary ? <TokenBars summary={summary} from="24 h ago" /> : <p className="muted">Loading…</p>}
              </Panel>
            </div>
          </div>
          <p className="home-foot muted">
            Workflows, runs and the merge queue appear once the hub has a project.{' '}
            <Link to="/projects" className="card-link">
              Add a project
              <IconChevronRight />
            </Link>
          </p>
        </>
      )}
    </div>
  );
}

/** The advice line, then the three numbers that matter. */
function Hero({ pacing, summary, sessions, observing }: { pacing?: Pacing; summary?: SessionsSummary; sessions?: Session[]; observing?: number }) {
  const running = summary?.totals.running ?? sessions?.filter((s) => s.status === 'running').length;
  const waiting = summary?.totals.waiting ?? sessions?.filter((s) => s.status === 'waiting').length;
  const [lead, ...rest] = pacing ? adviceHeadline(pacing, running) : [running !== undefined ? `${running} ${running === 1 ? 'session' : 'sessions'} running` : 'Loading sessions'];
  return (
    <section className="card pace-hero home-hero" aria-labelledby="home-headline">
      <h2 className="pace-headline" id="home-headline">
        {!!running && <LiveDot className="headline-dot" label="Live" />}
        <span>{lead}</span>
        {rest.length > 0 && <span className="muted"> · {rest.join(' · ')}</span>}
      </h2>
      <dl className="metrics">
        <Stat label="Waiting for you" value={waiting ?? '—'} />
        <Stat label="Tokens in the last 24 hours" value={summary ? tokens(summaryTokens(summary) ?? 0) : '—'} />
        <Stat label="Machines observing" value={observing ?? '—'} unit={summary ? `of ${summary.machines.length}` : undefined} />
      </dl>
    </section>
  );
}

/** Waiting first, then running; subagents fold under their parent. */
function RunningNow({ sessions, now }: { sessions?: Session[]; now: number }) {
  const nodes = sessions ? nestSessions(sessions).filter((n) => n.session.status === 'running' || n.session.status === 'waiting') : [];
  return (
    <Panel
      title="Running now"
      actions={
        <Link to="/sessions" className="card-link">
          All sessions
          <IconChevronRight />
        </Link>
      }
    >
      {!sessions ? (
        <p className="muted">Loading…</p>
      ) : nodes.length === 0 ? (
        <p className="muted">Nothing is running. Sessions show up here the moment T3 Code starts a turn.</p>
      ) : (
        <ul className="sessions sessions-compact">
          {nodes.slice(0, 5).map((n) => (
            <SessionItem key={n.session.id} node={{ ...n, children: [] }} now={now} showMachine />
          ))}
        </ul>
      )}
      {nodes.length > 5 && (
        <div className="card-foot">
          <Link to="/sessions" className="text-btn">
            Show all {nodes.length}
          </Link>
        </div>
      )}
    </Panel>
  );
}

function Subscriptions({ accounts, pacing, machines, now }: { accounts?: Account[]; pacing?: Pacing; machines: Machine[]; now: number }) {
  return (
    <Panel
      title="Subscriptions"
      actions={
        <Link to="/accounts" className="card-link">
          Accounts
          <IconChevronRight />
        </Link>
      }
    >
      {!accounts ? (
        <p className="muted">Loading…</p>
      ) : accounts.length === 0 ? (
        <p className="muted">No subscriptions seen yet. They appear once T3 Code reports its limits.</p>
      ) : (
        <ul className="rows home-subs">
          {accounts.map((a) => {
            const paced = pacing?.accounts.find((p) => p.accountId === a.id);
            const room = headroomText(paced?.headroomAgents);
            const machine = machines.find((m) => m.id === a.machineId)?.name;
            return (
              <li key={a.id}>
                <div className="home-sub-head">
                  <span>
                    <span className="cell-title">{a.label}</span>
                    <span className="cell-sub">
                      {a.plan ?? providerLabel(a.provider)}
                      {machine && (
                        <>
                          {' · '}
                          <code className="mono">{machine}</code>
                        </>
                      )}
                    </span>
                  </span>
                </div>
                <div className="home-sub-meters">
                  {meterWindows(a, paced)
                    .slice(0, 2)
                    .map((w) => (
                      <UsageMeter key={w.id} window={w} now={now} />
                    ))}
                </div>
                {room && <p className="home-sub-room">{room.charAt(0).toUpperCase() + room.slice(1)}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
