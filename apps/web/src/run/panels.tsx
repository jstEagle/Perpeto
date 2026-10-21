import type { Machine, MetricsSnapshot, MetricsWindow } from '../api/types';
import { Meter, Mono, Panel, Stat } from '../components/ui';
import { duration, rate } from '../lib/format';

const WINDOW_TEXT: Record<MetricsWindow, string> = { '1h': '1 h', '24h': '24 h', '7d': '7 d' };

/** Two numbers and the trend as grey bars, the current period in ink. */
export function VelocityPanel({ metrics }: { metrics: MetricsSnapshot }) {
  const v = metrics.run;
  const trend = v.velocity.trend;
  const max = Math.max(1, ...trend);
  const cycle = duration(v.cycleTimeSec.avg);
  const [cycleValue, cycleUnit] = cycle === '—' ? ['—', undefined] : cycle.split(' ');
  return (
    <Panel title="Velocity" actions={`Last ${WINDOW_TEXT[metrics.window]}`}>
      <dl className="metrics">
        <Stat label="Items done per day" value={rate(v.velocity.itemsDonePerDay)} />
        <Stat label="Cycle time" value={cycleValue} unit={cycleUnit} />
      </dl>
      {trend.length > 0 && (
        <figure className="velocity-chart" aria-label={`Items finished in each of ${trend.length} periods over the last ${WINDOW_TEXT[metrics.window]}: ${trend.join(', ')}`}>
          <div className="bars" aria-hidden="true">
            {trend.map((n, i) => (
              <span key={i} className={i === trend.length - 1 ? 'now' : n === 0 ? 'zero' : ''} style={{ height: n === 0 ? undefined : `${(n / max) * 100}%` }} />
            ))}
          </div>
          <div className="bars-axis" aria-hidden="true">
            <span>{WINDOW_TEXT[metrics.window]} ago</span>
            <span>Now</span>
          </div>
        </figure>
      )}
    </Panel>
  );
}

/** Machines with agents on this run, and how full each one is. */
export function WhereRunningPanel({ metrics, machines }: { metrics: MetricsSnapshot; machines: Machine[] }) {
  const entries = metrics.run.machines;
  return (
    <Panel title="Where work is running">
      {entries.length === 0 ? (
        <p className="muted">Work starts when a machine with a matching provider leases it.</p>
      ) : (
        <ul className="rows">
          {entries.map((entry) => {
            const m = machines.find((x) => x.id === entry.machineId);
            const used = m?.running.agents ?? entry.activeAgents;
            const max = m?.capacity.maxAgents ?? 0;
            return (
              <li key={entry.machineId} className="meter-row">
                <span className="meter-row-head">
                  <Mono>{m?.name ?? entry.machineId}</Mono>
                  <span>{max ? `${used} of ${max} slots` : `${entry.activeAgents} agents`}</span>
                </span>
                <Meter value={used} max={Math.max(1, max)} label={`${m?.name ?? entry.machineId} slots in use`} />
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
