import { useState } from 'react';
import { useResource } from '../app/hub-context';
import type { UsageGroupBy, UsageRow, UsageSummary } from '../api/types';
import { Async, Disclosure, Empty, Meter, PageHeader, Panel, Segmented, Stat } from '../components/ui';
import { IconUsage } from '../components/icons';
import { providerLabel } from '../workflow/registry';
import { count, day, pct, tokens } from '../lib/format';
import { useAppMode } from '../app/mode';
import type { SessionsSummary, SessionsWindow, TokenGroup } from '../api/types';
import { TokenBars, useSessionsSummary } from '../components/sessions';
import { modelName } from '../lib/sessions';

const total = (r: UsageRow) => r.inputTokens + r.outputTokens;

type Source = 'runs' | 'sessions';

/**
 * Usage of factory runs (`GET /usage`) and of observed T3 Code sessions
 * (`GET /sessions/summary`). Without projects only the sessions exist.
 */
export function UsagePage() {
  const { observe } = useAppMode();
  const observed = useSessionsSummary('24h');
  const [picked, setSource] = useState<Source>('runs');
  const source: Source = observe ? 'sessions' : picked;
  const canSwitch = !observe && !!observed.data;
  const header = (
    <PageHeader
      title="Usage"
      description={
        source === 'sessions'
          ? 'Tokens your T3 Code sessions used, by provider, model and machine. Input and output are counted; cache reads and writes are shown separately.'
          : 'Tokens reported by harnesses through T3, across every machine. Input and output are counted; cache reads and writes are shown separately.'
      }
      actions={
        canSwitch ? (
          <Segmented<Source>
            label="Usage from"
            value={source}
            onChange={setSource}
            options={[
              { value: 'runs', label: 'Factory runs' },
              { value: 'sessions', label: 'T3 sessions' },
            ]}
          />
        ) : undefined
      }
    />
  );
  return (
    <div className="page">
      {header}
      {source === 'sessions' ? <ObservedUsage /> : <RunsUsage />}
    </div>
  );
}

function RunsUsage() {
  const [groupBy, setGroupBy] = useState<UsageGroupBy>('day');
  const [projectId, setProjectId] = useState('');
  const projects = useResource((api) => api.listProjects(), []);
  const usage = useResource((api) => api.usage({ groupBy, projectId: projectId || undefined }), [groupBy, projectId], (e) => e.type === 'assignment.usage');
  const byDay = useResource((api) => api.usage({ groupBy: 'day', projectId: projectId || undefined }), [projectId], (e) => e.type === 'assignment.usage');

  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const days = byDay.data?.rows ?? [];
  const todayTokens = days.filter((r) => r.key === today).reduce((s, r) => s + total(r), 0);
  const weekTokens = days.filter((r) => r.key >= cutoff).reduce((s, r) => s + total(r), 0);
  const cacheRead = days.filter((r) => r.key >= cutoff).reduce((s, r) => s + r.cacheReadTokens, 0);
  const allInput = days.filter((r) => r.key >= cutoff).reduce((s, r) => s + r.inputTokens + r.cacheReadTokens, 0);

  return (
    <>
      <section className="card" aria-label="Totals">
        <dl className="metrics">
          <Stat label="Tokens today" value={byDay.data ? tokens(todayTokens) : '—'} />
          <Stat label="Tokens, 7 days" value={byDay.data ? tokens(weekTokens) : '—'} />
          <Stat label="Daily average, 7 days" value={byDay.data ? tokens(weekTokens / 7) : '—'} />
        </dl>
        <div className="card-foot">
          <Disclosure summary="Cache">
            <dl className="metrics metrics-small">
              <Stat label="Cache reads, share of input, 7 days" value={byDay.data && allInput ? pct(cacheRead / allInput) : '—'} />
              <Stat label="Cache reads, 7 days" value={byDay.data ? tokens(cacheRead) : '—'} />
            </dl>
          </Disclosure>
        </div>
      </section>
      <div className="toolbar">
        <Segmented<UsageGroupBy>
          label="Group usage by"
          value={groupBy}
          onChange={setGroupBy}
          options={[
            { value: 'day', label: 'Day' },
            { value: 'provider', label: 'Provider' },
            { value: 'model', label: 'Model' },
            { value: 'machine', label: 'Machine' },
            { value: 'role', label: 'Role' },
          ]}
        />
        <span className="select">
          <select className="input" aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">All projects</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </span>
      </div>
      <Async resource={usage} what="usage">
        {(summary) =>
          summary.rows.length === 0 ? (
            <section className="card">
              <Empty title="No usage recorded" icon={<IconUsage />}>
                Usage appears once agents run and report tokens.
              </Empty>
            </section>
          ) : (
            <>
              {summary.groupBy === 'day' && <DayChart rows={summary.rows.slice(-14)} today={today} />}
              <UsageTable summary={summary} />
            </>
          )
        }
      </Async>
    </>
  );
}

const WINDOW_FROM: Record<SessionsWindow, string> = { '1h': '1 h ago', '24h': '24 h ago', '7d': '7 days ago' };
const WINDOW_LABEL: Record<SessionsWindow, string> = { '1h': 'last hour', '24h': 'last 24 hours', '7d': 'last 7 days' };
type ObservedGroup = 'provider' | 'model' | 'machine';

function ObservedUsage() {
  const [window, setWindow] = useState<SessionsWindow>('24h');
  const [group, setGroup] = useState<ObservedGroup>('provider');
  const summary = useSessionsSummary(window);
  return (
    <>
      <div className="toolbar">
        <Segmented<SessionsWindow>
          label="Window"
          value={window}
          onChange={setWindow}
          options={[
            { value: '1h', label: '1 h' },
            { value: '24h', label: '24 h' },
            { value: '7d', label: '7 d' },
          ]}
        />
        <Segmented<ObservedGroup>
          label="Group usage by"
          value={group}
          onChange={setGroup}
          options={[
            { value: 'provider', label: 'Provider' },
            { value: 'model', label: 'Model' },
            { value: 'machine', label: 'Machine' },
          ]}
        />
      </div>
      <Async resource={summary} what="session usage">
        {(s) =>
          s === null ? (
            <section className="card">
              <Empty title="This hub doesn’t observe sessions yet" icon={<IconUsage />}>
                Update the hub and run a node on each Mac with T3 Code to see what its sessions use.
              </Empty>
            </section>
          ) : (
            <ObservedSummary summary={s} group={group} />
          )
        }
      </Async>
    </>
  );
}

const groupTotal = (g: TokenGroup) => g.input + g.output;

function ObservedSummary({ summary: s, group }: { summary: SessionsSummary; group: ObservedGroup }) {
  const rows = group === 'provider' ? s.tokens.byProvider : group === 'model' ? s.tokens.byModel : s.tokens.byMachine;
  const all = s.tokens.byProvider.length ? s.tokens.byProvider : rows;
  const input = all.reduce((n, g) => n + g.input, 0);
  const output = all.reduce((n, g) => n + g.output, 0);
  const cache = all.reduce((n, g) => n + g.cacheRead, 0);
  const when = WINDOW_LABEL[s.window];
  return (
    <>
      <section className="card" aria-label="Totals">
        <dl className="metrics">
          <Stat label={`Tokens, ${when}`} value={tokens(input + output)} />
          <Stat label="Input" value={tokens(input)} />
          <Stat label="Output" value={tokens(output)} />
        </dl>
        <div className="card-foot">
          <Disclosure summary="Cache">
            <dl className="metrics metrics-small">
              <Stat label={`Cache reads, ${when}`} value={tokens(cache)} />
              <Stat label="Cache reads, share of input" value={input + cache ? pct(cache / (input + cache)) : '—'} />
            </dl>
          </Disclosure>
        </div>
      </section>
      <Panel title="Tokens over time" actions={when.charAt(0).toUpperCase() + when.slice(1)}>
        <TokenBars summary={s} from={WINDOW_FROM[s.window]} tall />
      </Panel>
      {rows.length === 0 ? (
        <section className="card">
          <Empty title="No usage in this window" icon={<IconUsage />}>
            Tokens appear once a session takes a turn.
          </Empty>
        </section>
      ) : (
        <GroupTable rows={rows} group={group} label={(k) => (group === 'provider' ? providerLabel(k) : group === 'machine' ? (s.machines.find((m) => m.machineId === k)?.name ?? k) : modelName(k))} />
      )}
    </>
  );
}

function GroupTable({ rows, group, label }: { rows: TokenGroup[]; group: ObservedGroup; label(key: string): string }) {
  const grand = rows.reduce((n, r) => n + groupTotal(r), 0);
  const head = { provider: 'Provider', model: 'Model', machine: 'Machine' }[group];
  return (
    <section className="card">
      <div className="table-wrap">
        <table className="table">
          <caption className="visually-hidden">Session usage by {head.toLowerCase()}</caption>
          <thead>
            <tr>
              <th scope="col">{head}</th>
              <th scope="col" className="num">Input</th>
              <th scope="col" className="num">Output</th>
              <th scope="col" className="num hide-sm">Cache read</th>
              <th scope="col" className="num hide-sm">Cache write</th>
              <th scope="col" className="num">Total</th>
              <th scope="col" className="hide-sm">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>
                  {group === 'machine' ? <code className="mono">{label(r.key)}</code> : label(r.key)}
                  {group === 'model' && label(r.key) !== r.key && <code className="cell-sub mono">{r.key}</code>}
                </td>
                <td className="num">{tokens(r.input)}</td>
                <td className="num">{tokens(r.output)}</td>
                <td className="num hide-sm muted">{tokens(r.cacheRead)}</td>
                <td className="num hide-sm muted">{tokens(r.cacheWrite)}</td>
                <td className="num cell-title">{tokens(groupTotal(r))}</td>
                <td className="hide-sm">
                  <div className="meter-cell">
                    <span className="tabular">{pct(groupTotal(r) / grand)}</span>
                    <Meter value={groupTotal(r)} max={grand} label={`${label(r.key)} share`} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Grey bars with today in ink; labels only at the ends. Exact numbers are in the table below. */
function DayChart({ rows, today }: { rows: UsageRow[]; today: string }) {
  const max = Math.max(1, ...rows.map(total));
  return (
    <Panel title="Tokens per day" actions={`Last ${rows.length} days`}>
      <figure className="usage-chart" aria-label={`Tokens per day: ${rows.map((r) => `${day(r.key)} ${tokens(total(r))}`).join(', ')}`}>
        <div className="bars bars-tall" aria-hidden="true">
          {rows.map((r) => (
            <span key={r.key} className={r.key === today ? 'now' : total(r) === 0 ? 'zero' : ''} style={{ height: total(r) ? `${(total(r) / max) * 100}%` : undefined }} title={`${day(r.key)}: ${count(total(r))} tokens`} />
          ))}
        </div>
        <div className="bars-axis" aria-hidden="true">
          <span>{rows[0] ? day(rows[0].key) : ''}</span>
          <span>{rows.at(-1)?.key === today ? 'Today' : rows.at(-1) ? day(rows.at(-1)!.key) : ''}</span>
        </div>
      </figure>
    </Panel>
  );
}

/** Hubs group usage from before role attribution as `unknown`. */
const UNKNOWN_ROLE = 'unknown';
const roleLabel = (key: string) => (key === UNKNOWN_ROLE ? 'No role recorded' : key.charAt(0).toUpperCase() + key.slice(1).replace(/[-_]+/g, ' '));

function UsageTable({ summary }: { summary: UsageSummary }) {
  const [all, setAll] = useState(false);
  const ordered = summary.groupBy === 'day' ? [...summary.rows].reverse() : summary.rows;
  const rows = all ? ordered : ordered.slice(0, 7);
  const grand = summary.rows.reduce((s, r) => s + total(r), 0);
  const label = (k: string) => (summary.groupBy === 'day' ? day(k) : summary.groupBy === 'provider' ? providerLabel(k) : summary.groupBy === 'role' ? roleLabel(k) : k);
  const mono = summary.groupBy === 'model';
  const head = { day: 'Day (UTC)', provider: 'Provider', model: 'Model', machine: 'Machine', role: 'Role' }[summary.groupBy];
  return (
    <section className="card">
      <div className="table-wrap">
      <table className="table">
        <caption className="visually-hidden">Usage by {head.toLowerCase()}</caption>
        <thead>
          <tr>
            <th scope="col">{head}</th>
            <th scope="col" className="num">Input</th>
            <th scope="col" className="num">Output</th>
            <th scope="col" className="num hide-sm">Cache read</th>
            <th scope="col" className="num hide-sm">Cache write</th>
            <th scope="col" className="num">Total</th>
            <th scope="col" className="hide-sm">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className={summary.groupBy === 'role' && r.key === UNKNOWN_ROLE ? 'muted' : undefined}>{mono ? <code className="mono">{r.key}</code> : label(r.key)}</td>
              <td className="num">{tokens(r.inputTokens)}</td>
              <td className="num">{tokens(r.outputTokens)}</td>
              <td className="num hide-sm muted">{tokens(r.cacheReadTokens)}</td>
              <td className="num hide-sm muted">{tokens(r.cacheWriteTokens)}</td>
              <td className="num cell-title">{tokens(total(r))}</td>
              <td className="hide-sm">
                <div className="meter-cell">
                  <span className="tabular">{pct(total(r) / grand)}</span>
                  <Meter value={total(r)} max={grand} label={`${label(r.key)} share`} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td className="num">{tokens(summary.rows.reduce((s, r) => s + r.inputTokens, 0))}</td>
            <td className="num">{tokens(summary.rows.reduce((s, r) => s + r.outputTokens, 0))}</td>
            <td className="num hide-sm muted">{tokens(summary.rows.reduce((s, r) => s + r.cacheReadTokens, 0))}</td>
            <td className="num hide-sm muted">{tokens(summary.rows.reduce((s, r) => s + r.cacheWriteTokens, 0))}</td>
            <td className="num cell-title">{tokens(grand)}</td>
            <td className="hide-sm" />
          </tr>
        </tfoot>
      </table>
      </div>
      {ordered.length > rows.length && (
        <div className="card-foot">
          <button type="button" className="text-btn" onClick={() => setAll(true)}>
            Show all {ordered.length}
          </button>
        </div>
      )}
    </section>
  );
}
