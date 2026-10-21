import { useState } from 'react';
import { useResource } from '../app/hub-context';
import type { UsageGroupBy, UsageRow, UsageSummary } from '../api/types';
import { Async, Disclosure, Empty, Meter, PageHeader, Panel, Segmented, Stat } from '../components/ui';
import { IconUsage } from '../components/icons';
import { providerLabel } from '../workflow/registry';
import { count, day, pct, tokens } from '../lib/format';

const total = (r: UsageRow) => r.inputTokens + r.outputTokens;

export function UsagePage() {
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
    <div className="page">
      <PageHeader title="Usage" description="Tokens reported by harnesses through T3, across every machine. Input and output are counted; cache reads and writes are shown separately." />
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
    </div>
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
