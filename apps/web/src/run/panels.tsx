import type { Assignment, Bottleneck, Machine, MetricsSnapshot, WorkflowGraph } from '../api/types';
import { Empty, Panel } from '../components/ui';
import { MachineStatusLabel, StatusLabel } from '../components/status';
import { duration, rate, tokens } from '../lib/format';
import { BOTTLENECK_LABEL } from '../workflow/step-node';
import type { Selection } from '../workflow/graph-canvas';

const WEEKDAY = (offsetFromToday: number) => new Date(Date.now() - offsetFromToday * 86_400_000).toLocaleDateString('en-GB', { weekday: 'short' });

export function VelocityPanel({ metrics }: { metrics: MetricsSnapshot }) {
  const v = metrics.run;
  const trend = v.velocity.trend;
  const max = Math.max(1, ...trend);
  return (
    <Panel title="Velocity" actions={<span className="note">Last {metrics.window}</span>}>
      <div className="stack-sm">
        <div className="velocity-head">
          <div>
            <span className="velocity-value">{rate(v.velocity.itemsDonePerDay)}</span>
            <span className="muted"> items done per day</span>
          </div>
        </div>
        {trend.length > 0 && (
          <figure className="velocity-trend" aria-label={`Items done per day, last ${trend.length} days: ${trend.join(', ')}`}>
            <div className="spark" aria-hidden="true">
              {trend.map((n, i) => (
                <span key={i} style={{ height: `${(n / max) * 100}%` }} title={`${WEEKDAY(trend.length - 1 - i)}: ${n}`} />
              ))}
            </div>
            <div className="spark-axis" aria-hidden="true">
              {trend.map((n, i) => (
                <span key={i}>
                  <b>{n}</b>
                  {WEEKDAY(trend.length - 1 - i)}
                </span>
              ))}
            </div>
          </figure>
        )}
        <dl className="kv kv-figures">
          <dt>Cycle time</dt>
          <dd>
            {duration(v.cycleTimeSec.avg)} avg · {duration(v.cycleTimeSec.p90)} p90
          </dd>
          <dt>Work in progress</dt>
          <dd>{v.wip} items</dd>
          <dt>Tokens per item</dt>
          <dd>{tokens(v.tokensPerItem)}</dd>
          <dt>Agents working</dt>
          <dd>{v.activeAgents}</dd>
        </dl>
      </div>
    </Panel>
  );
}

export function BottlenecksPanel({ bottlenecks, graph, onSelect }: { bottlenecks: Bottleneck[]; graph: WorkflowGraph; onSelect(s: Selection): void }) {
  const order = { critical: 0, warning: 1, info: 2 } as const;
  const sorted = [...bottlenecks].sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <Panel title="Bottlenecks" flush>
      {sorted.length === 0 ? (
        <Empty title="Nothing is holding work up.">Bottlenecks appear here when measured queues, utilization or failures cross their limits.</Empty>
      ) : (
        <ul className="ruled-list">
          {sorted.map((b) => (
            <li key={`${b.nodeId}-${b.reason}`} className="bottleneck-row">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <button type="button" className="chip-button" onClick={() => onSelect({ kind: 'node', id: b.nodeId })}>
                  {graph.nodes.find((n) => n.id === b.nodeId)?.label ?? b.nodeId}
                </button>
                <StatusLabel tone={b.severity === 'critical' ? 'error' : b.severity === 'warning' ? 'warning' : 'neutral'}>{BOTTLENECK_LABEL[b.reason]}</StatusLabel>
              </div>
              <p className="note">{b.evidence}</p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function WhereRunningPanel({ metrics, machines, assignments, graph, onSelect }: { metrics: MetricsSnapshot; machines: Machine[]; assignments: Assignment[]; graph: WorkflowGraph; onSelect(s: Selection): void }) {
  const entries = metrics.run.machines;
  return (
    <Panel title="Where work is running" flush>
      {entries.length === 0 ? (
        <Empty title="No agents are running for this run.">Work starts when a machine with a matching provider leases it.</Empty>
      ) : (
        <ul className="machine-tree">
          {entries.map((entry) => {
            const m = machines.find((x) => x.id === entry.machineId);
            const running = assignments.filter((a) => a.machineId === entry.machineId && a.status === 'running');
            return (
              <li key={entry.machineId}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="cell-title">{m?.name ?? entry.machineId}</span>
                  {m && <MachineStatusLabel status={m.status} />}
                </div>
                <div className="row note">
                  <span className="meter-cell">
                    <span className="meter" aria-hidden="true">
                      <span className="meter-fill" style={{ width: `${m ? Math.min(100, (m.running.agents / Math.max(1, m.capacity.maxAgents)) * 100) : 0}%` }} />
                    </span>
                    {entry.activeAgents} agents here{m ? ` · ${m.running.agents} of ${m.capacity.maxAgents} slots in use` : ''}
                  </span>
                </div>
                <ul className="machine-tree-nodes">
                  {entry.nodes.map((nodeId) => {
                    const n = graph.nodes.find((x) => x.id === nodeId);
                    const here = running.filter((a) => a.nodeId === nodeId).length;
                    return (
                      <li key={nodeId}>
                        <button type="button" className="chip-button" onClick={() => onSelect({ kind: 'node', id: nodeId })}>
                          {n?.label ?? nodeId}
                        </button>
                        <span className="muted tabular">{n?.type === 'ci' ? `${m?.running.jobs ?? 0} job` : `${here} ${here === 1 ? 'agent' : 'agents'}`}</span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
