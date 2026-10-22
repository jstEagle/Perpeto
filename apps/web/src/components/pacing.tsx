import { Fragment } from 'react';
import type { Pacing, PacingAccountState } from '../api/types';
import { providerLabel } from '../workflow/registry';
import { clock } from '../lib/format';
import { STATE, projectionText, resetsIn, timelineLayout } from '../lib/pacing';
import type { MeterWindow } from '../lib/pacing';
import { StatusLabel } from './status';

export function PacingStateLabel({ state, title }: { state: PacingAccountState; title?: string }) {
  const [tone, label] = STATE[state] ?? STATE.unknown;
  return (
    <StatusLabel tone={tone} title={title}>
      {label}
    </StatusLabel>
  );
}

const pctText = (n: number) => `${Math.round(n)}%`;

/**
 * One limit window: used share in ink, the share still to come by the reset
 * in a lighter grey, and a small mark where the window is projected to end.
 */
export function UsageMeter({ window: w, now = Date.now() }: { window: MeterWindow; now?: number }) {
  const used = Math.min(100, w.usedPercent);
  const projected = w.projectedPercentAtReset === undefined ? undefined : Math.min(100, Math.max(used, w.projectedPercentAtReset));
  const resets = resetsIn(w.resetsAt, now);
  const projection = projectionText(w);
  const label = [`${w.label} ${pctText(w.usedPercent)} used`, resets, projection].filter(Boolean).join(', ');
  return (
    <div className="usage-meter">
      <div className="usage-meter-head">
        <span className="usage-meter-label">{w.label}</span>
        <span className="usage-meter-value">{pctText(w.usedPercent)}</span>
      </div>
      <span className="usage-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w.usedPercent)} aria-label={label} title={label}>
        {projected !== undefined && projected > used && <span className="usage-bar-ahead" style={{ left: `${used}%`, width: `${projected - used}%` }} />}
        <span className="usage-bar-used" style={{ width: `${used}%` }} />
        {projected !== undefined && <span className={`usage-bar-mark ${w.onTrack === 'over' ? 'is-over' : ''}`} style={{ left: `${projected}%` }} />}
      </span>
      <div className="usage-meter-foot">
        <span>{resets ?? 'No reset reported'}</span>
        {projection && <span className={w.onTrack === 'over' ? 'usage-over' : undefined}>{projection}</span>}
      </div>
    </div>
  );
}

/**
 * The rotation drawn as lanes, one per subscription: burn turns in ink,
 * rest in a quiet grey, the past a step lighter, and a line at now. The
 * subscription burning now carries the live dot where the line crosses it.
 */
export function PacingTimeline({ pacing, now = Date.now(), hoursAhead = 10 }: { pacing: Pacing; now?: number; hoursAhead?: number }) {
  const layout = timelineLayout(pacing, now, hoursAhead);
  const nowIso = new Date(now).toISOString();
  const nowAt = layout.now;
  const summary = layout.groups
    .flatMap((g) => g.lanes)
    .map((l) => {
      const next = l.segments.find((s) => s.phase === 'burn' && Date.parse(s.to) > now);
      if (!next) return `${l.account.label}: no turn in the next ${hoursAhead} hours`;
      return Date.parse(next.from) <= now ? `${l.account.label}: burning until ${clock(next.to)}` : `${l.account.label}: next turn ${clock(next.from)} to ${clock(next.to)}`;
    })
    .join('. ');
  return (
    <figure className="timeline" aria-label={`Rotation for the next ${hoursAhead} hours. ${summary}.`}>
      <div className="timeline-grid" aria-hidden="true">
        {layout.groups.map((group, gi) => (
          <Fragment key={group.provider}>
            <div className={`timeline-provider ${gi ? 'is-later' : ''}`}>{providerLabel(group.provider)}</div>
            <div className={`timeline-provider-gap ${gi ? 'is-later' : ''}`}>
              <span className="timeline-now" style={{ left: `${nowAt}%` }} />
            </div>
            {group.lanes.map((lane) => {
              const live = lane.account.state === 'burning' && lane.segments.some((s) => s.phase === 'burn' && s.from <= nowIso && s.to > nowIso);
              return (
                <Fragment key={lane.account.accountId}>
                  <div className="timeline-label" title={lane.account.label}>
                    {lane.account.label}
                  </div>
                  <div className="timeline-track">
                    {lane.segments.flatMap((s, i) => {
                      // Split at now: what already happened is drawn a step lighter.
                      const end = s.left + s.width;
                      const parts: { left: number; width: number; past: boolean }[] = [];
                      if (end <= nowAt) parts.push({ left: s.left, width: s.width, past: true });
                      else if (s.left >= nowAt) parts.push({ left: s.left, width: s.width, past: false });
                      else parts.push({ left: s.left, width: nowAt - s.left, past: true }, { left: nowAt, width: end - nowAt, past: false });
                      return parts.map((p, j) => (
                        <span
                          key={`${i}-${j}`}
                          className={`timeline-seg is-${s.phase} ${p.past ? 'is-past' : ''} ${j === 1 ? 'is-joined' : ''} ${parts.length === 2 && j === 0 ? 'is-split' : ''}`}
                          style={{ left: `${p.left}%`, width: `${p.width}%` }}
                          title={`${s.phase === 'burn' ? 'Burning' : 'Resting'} ${clock(s.from)} to ${clock(s.to)}`}
                        />
                      ));
                    })}
                    <span className="timeline-now" style={{ left: `${nowAt}%` }} />
                    {live && <span className="dot timeline-live" style={{ left: `${nowAt}%` }} />}
                  </div>
                </Fragment>
              );
            })}
          </Fragment>
        ))}
        <div className="timeline-axis-spacer" />
        <div className="timeline-axis">
          {layout.ticks.map((t) => (
            <span key={t.at} style={{ left: `${t.at}%` }}>
              {t.label}
            </span>
          ))}
          <span className="timeline-axis-now" style={{ left: `${nowAt}%` }}>
            Now
          </span>
        </div>
      </div>
      <figcaption className="timeline-legend">
        <span>
          <i className="legend-burn" />
          Burning
        </span>
        <span>
          <i className="legend-rest" />
          Resting until its limit resets
        </span>
      </figcaption>
    </figure>
  );
}
