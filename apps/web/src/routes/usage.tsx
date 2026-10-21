import { useState } from 'react';
import { useResource } from '../app/hub-context';
import type { UsageGroupBy, UsageRow, UsageSummary } from '../api/types';
import { Async, Empty, PageHeader, Panel, Segmented, Stat } from '../components/ui';
import { providerLabel } from '../workflow/registry';
import { count, day, pct, tokens } from '../lib/format';

const total = (r: UsageRow) => r.inputTokens + r.outputTokens;

export function UsagePage() {
  const [groupBy, setGroupBy] = useState<UsageGroupBy>('day');
  const [projectId, setProjectId] = useState('');
  const projects = useResource((api) => api.listProjects(), []);
  const usage = useResource((api) => api.usage({ groupBy, projectId: projectId || undefined }), [groupBy, projectId], (e) => e.type === 'usage.recorded');
  const byDay = useResource((api) => api.usage({ groupBy: 'day', projectId: projectId || undefined }), [projectId], (e) => e.type === 'usage.recorded');

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
      <dl className="stats">
        <Stat label="Tokens today" value={byDay.data ? tokens(todayTokens) : '—'} />
        <Stat label="Tokens, 7 days" value={byDay.data ? tokens(weekTokens) : '—'} />
        <Stat label="Daily average, 7 days" value={byDay.data ? tokens(weekTokens / 7) : '—'} />
        <Stat label="Cache read share, 7 days" value={byDay.data && allInput ? pct(cacheRead / allInput) : '—'} detail="of input" />
      </dl>
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
          ]}
        />
        <span className="select toolbar-select">
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
            <div className="panel">
              <Empty title="No usage recorded.">Usage appears once agents run and report tokens.</Empty>
            </div>
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

function DayChart({ rows, today }: { rows: UsageRow[]; today: string }) {
  const max = Math.max(...rows.map(total));
  const step = niceStep(max / 3);
  const top = Math.ceil(max / step) * step;
  const rules = Array.from({ length: Math.round(top / step) }, (_, i) => (i + 1) * step);
  return (
    <Panel title="Tokens per day" actions={<span className="note">Input and output · last {rows.length} UTC days</span>}>
      <figure className="chart" aria-label={`Tokens per day: ${rows.map((r) => `${day(r.key)} ${tokens(total(r))}`).join(', ')}`}>
        <div className="bars" aria-hidden="true">
          {rules.map((v) => (
            <div key={v} className="bars-rule" style={{ bottom: `${(v / top) * 100}%` }}>
              <span>{tokens(v)}</span>
            </div>
          ))}
          {rows.map((r) => (
            <div key={r.key} className={`bar ${r.key === today ? 'is-current' : ''}`} title={`${day(r.key)}: ${count(total(r))} tokens`}>
              <span className="bar-fill" style={{ height: `${(total(r) / top) * 100}%` }} />
            </div>
          ))}
        </div>
        <div className="bar-axis" aria-hidden="true">
          {rows.map((r, i) => (
            <span key={r.key}>{i % 2 === rows.length % 2 || r.key === today ? (r.key === today ? 'Today' : day(r.key)) : ''}</span>
          ))}
        </div>
      </figure>
    </Panel>
  );
}

function niceStep(raw: number) {
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function UsageTable({ summary }: { summary: UsageSummary }) {
  const rows = summary.groupBy === 'day' ? [...summary.rows].reverse() : summary.rows;
  const grand = summary.rows.reduce((s, r) => s + total(r), 0);
  const label = (k: string) => (summary.groupBy === 'day' ? day(k) : summary.groupBy === 'provider' ? providerLabel(k) : k);
  const mono = summary.groupBy === 'model';
  const head = { day: 'Day (UTC)', provider: 'Provider', model: 'Model', machine: 'Machine' }[summary.groupBy];
  return (
    <div className="panel panel-flush table-wrap">
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
              <td>{mono ? <code className="mono">{r.key}</code> : label(r.key)}</td>
              <td className="num">{tokens(r.inputTokens)}</td>
              <td className="num">{tokens(r.outputTokens)}</td>
              <td className="num hide-sm muted">{tokens(r.cacheReadTokens)}</td>
              <td className="num hide-sm muted">{tokens(r.cacheWriteTokens)}</td>
              <td className="num">
                <b>{tokens(total(r))}</b>
              </td>
              <td className="hide-sm">
                <div className="share-cell">
                  <span className="hbar-track" aria-hidden="true">
                    <span className="hbar" style={{ width: `${(total(r) / grand) * 100}%` }} />
                  </span>
                  <span className="note tabular">{pct(total(r) / grand)}</span>
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
            <td className="num">
              <b>{tokens(grand)}</b>
            </td>
            <td className="hide-sm" />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
