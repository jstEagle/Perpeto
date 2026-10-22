import { useEffect, useId, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useHub, useResource } from '../app/hub-context';
import type { Pacing, PacingSettings } from '../api/types';
import { Async, Button, Disclosure, Empty, PageHeader, Panel, Segmented, Toggle } from '../components/ui';
import { IconChevronRight, IconPacing } from '../components/icons';
import { StatusLabel } from '../components/status';
import { PacingStateLabel, PacingTimeline } from '../components/pacing';
import { providerLabel } from '../workflow/registry';
import { plural } from '../lib/format';
import { accountTrack, limitedByText, orderedWindows, pacingHeadline, resetsIn } from '../lib/pacing';
import { adviceHeadline, headroomText, isAdvice } from '../lib/sessions';
import { LiveDot } from '../components/status';

const TARGETS = [90, 95, 100];

export function PacingPage() {
  const pacing = useResource((api) => api.pacing(), [], (e) => e.type.startsWith('pacing.') || e.subject.kind === 'account');
  const advice = isAdvice(pacing.data);
  return (
    <div className="page">
      <PageHeader
        title="Pacing"
        description={
          advice
            ? 'How each subscription is tracking toward its reset at the current pace, and how much more it could take. Perpeto only observes, so this is advice.'
            : 'Perpeto scales the agents it runs so every subscription’s limit is used up by the time it resets, without downtime or unused tokens.'
        }
      />
      <Async resource={pacing} what="pacing">
        {(p) =>
          p === null ? (
            <section className="card">
              <Empty title="This hub doesn’t pace subscriptions yet" icon={<IconPacing />}>
                Update the hub to a version with pacing. Until then, each machine runs agents up to its own slots.
              </Empty>
            </section>
          ) : isAdvice(p) ? (
            <AdviceView pacing={p} />
          ) : (
            <PacingView pacing={p} onChanged={pacing.reload} />
          )
        }
      </Async>
    </div>
  );
}

function PacingView({ pacing: served, onChanged }: { pacing: Pacing; onChanged(): void }) {
  const { api } = useHub();
  // Settings apply at once on screen; the hub's answer replaces them.
  const [pending, setPending] = useState<PacingSettings>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setPending({}), [served]);
  const p: Pacing = { ...served, ...stripUndefined(pending), strategy: pending.strategy ?? served.strategy };
  const save = async (patch: PacingSettings) => {
    setPending((x) => ({ ...x, ...patch }));
    setBusy(true);
    setError(null);
    try {
      await api.updatePacing(patch);
      onChanged();
    } catch (e) {
      setPending({});
      setError(`Saving the pacing settings failed. ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const { lead, detail } = pacingHeadline(served);

  return (
    <>
      <section className="card pace-hero" aria-labelledby="pace-headline">
        <h2 className="pace-headline" id="pace-headline">
          <span>{lead}</span> · <span className="muted">{detail}</span>
        </h2>
        {served.providers.length > 0 && (
          <ul className="pace-providers">
            {served.providers.map((x) => (
              <li key={x.provider}>
                <span className="pace-provider-name">{providerLabel(x.provider)}</span>
                {x.starved || x.limitedBy === 'work' ? <StatusLabel tone="attention">{limitedByText(x)}</StatusLabel> : <span className="pace-limit">{limitedByText(x)}</span>}
                <span className="muted tabular">
                  {x.runningAgents} of {plural(x.targetAgents, 'agent')} · {plural(x.readyWork, 'item')} ready · {plural(x.slots, 'slot')}
                </span>
              </li>
            ))}
          </ul>
        )}
        {served.enabled && served.timeline.length > 0 ? (
          <PacingTimeline pacing={served} />
        ) : (
          <p className="pace-off muted">{served.enabled ? 'No turns planned yet. The plan appears once subscriptions report their limits.' : 'Pacing is off, so there is no rotation to show. Turn it on to plan one.'}</p>
        )}
      </section>

      <div className="cols">
        <Panel
          title="Projected at reset"
          actions={
            <Link to="/accounts" className="card-link">
              Accounts
              <IconChevronRight />
            </Link>
          }
        >
          {served.accounts.length === 0 ? (
            <p className="muted">No subscriptions reported yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">Projected use of each subscription at its reset</caption>
                <thead>
                  <tr>
                    <th scope="col">Subscription</th>
                    <th scope="col" className="hide-sm">
                      State
                    </th>
                    <th scope="col" className="num">
                      Agents
                    </th>
                    <th scope="col" className="num">
                      Session
                    </th>
                    <th scope="col" className="num">
                      Weekly
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {served.accounts.map((a) => {
                    const [session, weekly] = ['session', 'weekly'].map((k) => orderedWindows(a.windows).find((w) => w.kind === k));
                    const track = accountTrack(a);
                    return (
                      <tr key={a.accountId}>
                        <td>
                          <span className="cell-title">{a.label}</span>
                          <span className="cell-sub">
                            {[a.plan, track === 'under' ? 'under target' : track === 'over' ? 'runs out early' : null, a.idleForecastMins > 0 ? `${a.idleForecastMins} min idle forecast` : null].filter(Boolean).join(' · ') ||
                              providerLabel(a.provider)}
                          </span>
                        </td>
                        <td className="hide-sm">
                          <PacingStateLabel state={a.state} />
                        </td>
                        <td className="num">{a.state === 'burning' || a.runningAgents ? a.runningAgents : <span className="muted">0</span>}</td>
                        <td className="num">{projected(session)}</td>
                        <td className="num">{projected(weekly)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Settings" actions={busy ? 'Saving…' : undefined}>
          <PacingSettingsForm pacing={p} disabled={busy} onSave={save} />
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </Panel>
      </div>
    </>
  );
}

/**
 * Advise mode: nothing is enforced, so there is no rotation and no settings.
 * The headline reads as advice; each subscription shows where it lands at
 * reset and about how many more agents it could take.
 */
function AdviceView({ pacing: p }: { pacing: Pacing }) {
  const summary = useResource((api) => api.sessionsSummary('1h').catch(() => null), [], (e) => e.type.startsWith('session'), { debounceMs: 1000, maxWaitMs: 5000 });
  const running = summary.data?.totals.running;
  const [lead, ...rest] = adviceHeadline(p, running);
  const now = Date.now();
  return (
    <>
      <section className="card pace-hero" aria-labelledby="pace-headline">
        <h2 className="pace-headline" id="pace-headline">
          {(running ?? p.providers.reduce((s, x) => s + x.runningAgents, 0)) > 0 && <LiveDot className="headline-dot" label="Live" />}
          <span>{lead}</span>
          {rest.length > 0 && <span className="muted"> · {rest.join(' · ')}</span>}
        </h2>
        {p.accounts.length > 0 && (
          <ul className="advice-list">
            {p.accounts.map((a) => {
              const room = headroomText(a.headroomAgents);
              const binding = [...a.windows].sort((x, y) => y.projectedPercentAtReset - x.projectedPercentAtReset)[0];
              return (
                <li key={a.accountId}>
                  <span className="cell-title">{a.label}</span>
                  <span className="advice-room">{room ? room.charAt(0).toUpperCase() + room.slice(1) : 'Room not reported'}</span>
                  <span className="muted tabular">
                    {binding
                      ? binding.onTrack === 'over'
                        ? `${binding.label} runs out before reset`
                        : `${binding.label} ${Math.round(binding.projectedPercentAtReset)}% at reset, ${resetsIn(binding.resetsAt, now) ?? 'no reset reported'}`
                      : 'No limits reported yet'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Panel
        title="Projected at reset"
        actions={
          <Link to="/accounts" className="card-link">
            Accounts
            <IconChevronRight />
          </Link>
        }
      >
        {p.accounts.length === 0 ? (
          <p className="muted">No subscriptions reported yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Projected use of each subscription at its reset, and room for more agents</caption>
              <thead>
                <tr>
                  <th scope="col">Subscription</th>
                  <th scope="col" className="num">
                    Running
                  </th>
                  <th scope="col" className="num">
                    Session
                  </th>
                  <th scope="col" className="num">
                    Weekly
                  </th>
                  <th scope="col" className="num">
                    Room
                  </th>
                </tr>
              </thead>
              <tbody>
                {p.accounts.map((a) => {
                  const [session, weekly] = ['session', 'weekly'].map((k) => orderedWindows(a.windows).find((w) => w.kind === k));
                  return (
                    <tr key={a.accountId}>
                      <td>
                        <span className="cell-title">{a.label}</span>
                        <span className="cell-sub">{[a.plan, providerLabel(a.provider)].filter(Boolean).join(' · ')}</span>
                      </td>
                      <td className="num">{a.runningAgents || <span className="muted">0</span>}</td>
                      <td className="num">{advised(session)}</td>
                      <td className="num">{advised(weekly)}</td>
                      <td className="num cell-title">{a.headroomAgents !== undefined ? `about ${a.headroomAgents}` : <span className="muted">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="advice-note muted">Perpeto is only observing, so nothing is enforced. Numbers are advice, aimed at {p.targetUsePercent}% of each limit by its reset.</p>
      </Panel>
    </>
  );
}

/** In advice, landing under the target is normal; only an overrun stands out. */
function advised(w: { projectedPercentAtReset: number; onTrack: string } | undefined) {
  if (!w) return <span className="muted">—</span>;
  return w.onTrack === 'over' ? <span className="cell-title">runs out</span> : `${Math.round(w.projectedPercentAtReset)}%`;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function projected(w: { projectedPercentAtReset: number; onTrack: string } | undefined) {
  if (!w) return <span className="muted">—</span>;
  const value = `${Math.round(w.projectedPercentAtReset)}%`;
  return w.onTrack === 'on' ? value : <span className={w.onTrack === 'over' ? 'cell-title' : 'muted'}>{value}</span>;
}

function PacingSettingsForm({ pacing: p, disabled, onSave }: { pacing: Pacing; disabled: boolean; onSave(patch: PacingSettings): void }) {
  const id = useId();
  const targets = TARGETS.includes(p.targetUsePercent) ? TARGETS : [...TARGETS, p.targetUsePercent].sort((a, b) => a - b);
  return (
    <div className="settings-list">
      <div className="setting setting-inline">
        <div>
          <div className="setting-title" id={`${id}-on`}>
            Pacing
          </div>
          <p className="setting-help" id={`${id}-on-help`}>
            Scale agents to each subscription’s limits. Off, every machine fills its own slots.
          </p>
        </div>
        <Toggle checked={p.enabled} onChange={(enabled) => onSave({ enabled })} label="Pacing" describedBy={`${id}-on-help`} />
      </div>
      <div className="setting">
        <div className="setting-title">Strategy</div>
        <Segmented<'rotation' | 'parallel'>
          label="Strategy"
          value={p.strategy === 'parallel' ? 'parallel' : 'rotation'}
          onChange={(strategy) => onSave({ strategy })}
          options={[
            { value: 'rotation', label: 'Rotation' },
            { value: 'parallel', label: 'Parallel' },
          ]}
        />
        <p className="setting-help">
          {p.strategy === 'parallel'
            ? 'Every subscription runs at once, each at the pace its own limits allow.'
            : 'One subscription burns at a time, so the first has reset by the time the last one finishes.'}
        </p>
      </div>
      <div className="setting">
        <div className="setting-title">Target use</div>
        <Segmented<string>
          label="Target use"
          value={String(p.targetUsePercent)}
          onChange={(v) => onSave({ targetUsePercent: Number(v) })}
          options={targets.map((t) => ({ value: String(t), label: `${t}%` }))}
        />
        <p className="setting-help">How much of each limit to use by its reset. A little headroom absorbs turns that run longer than estimated.</p>
      </div>
      {p.minAgents !== undefined && <AgentLimits min={p.minAgents} max={p.maxAgents ?? null} disabled={disabled} onSave={onSave} />}
    </div>
  );
}

/** Fewest and most agents pacing may run; an empty maximum means no cap. */
function AgentLimits({ min, max, disabled, onSave }: { min: number; max: number | null; disabled: boolean; onSave(patch: PacingSettings): void }) {
  const id = useId();
  const [lo, setLo] = useState(String(min));
  const [hi, setHi] = useState(max === null ? '' : String(max));
  useEffect(() => {
    setLo(String(min));
    setHi(max === null ? '' : String(max));
  }, [min, max]);
  const a = Number(lo);
  const b = hi.trim() === '' ? null : Number(hi);
  const invalid = lo.trim() === '' || !Number.isInteger(a) || a < 0 || (b !== null && (!Number.isInteger(b) || b < 1 || a > b));
  const changed = a !== min || b !== max;
  return (
    <Disclosure summary={max === null ? `Agent limits · at least ${min}` : `Agent limits · ${min} to ${max}`}>
      <form
        className="setting"
        onSubmit={(e) => {
          e.preventDefault();
          if (!invalid && changed) onSave({ minAgents: a, maxAgents: b });
        }}
      >
        <div className="limit-fields">
          <label className="field">
            <span className="field-label">Fewest agents</span>
            <input id={`${id}-min`} className="input" inputMode="numeric" value={lo} onChange={(e) => setLo(e.target.value)} aria-invalid={invalid} />
          </label>
          <label className="field">
            <span className="field-label">Most agents</span>
            <input id={`${id}-max`} className="input" inputMode="numeric" value={hi} placeholder="No limit" onChange={(e) => setHi(e.target.value)} aria-invalid={invalid} />
          </label>
        </div>
        <p className={invalid ? 'field-error' : 'setting-help'}>{invalid ? 'Use whole numbers, with the fewest no more than the most.' : 'Pacing stays within these across every machine.'}</p>
        <div>
          <Button type="submit" size="sm" disabled={disabled || invalid || !changed}>
            Save limits
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}
