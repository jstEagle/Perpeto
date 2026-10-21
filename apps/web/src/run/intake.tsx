import { useEffect, useId, useState } from 'react';
import { useHub } from '../app/hub-context';
import type { Run, RunBudget, RunSettings, RunSource, Workflow } from '../api/types';
import { Button, Dialog, Disclosure, Field, Meter, Segmented } from '../components/ui';
import { IconClock } from '../components/icons';
import { StatusLabel } from '../components/status';
import { budgetFill, budgetRows, pauseDetail, PAUSE_TITLE, resumeText } from './budget';
import { DAY_NAMES, describeSchedule, fromCron, isCron, localOffset, offsetLabel, toCron } from './schedule';
import type { Repeat, ScheduleSpec } from './schedule';

/** Today's budget as one thin line: the fullest limit fills it, the numbers sit beside it. */
export function BudgetLine({ run, activeItems, label = 'Budget today' }: { run: Run; activeItems?: number; label?: string }) {
  const rows = budgetRows(run, activeItems);
  if (!rows.length) return null;
  const fill = budgetFill(rows);
  return (
    <div className="budget-line">
      <span className="budget-label">{label}</span>
      <Meter value={Math.round(fill * 100)} max={100} label={`${label}: ${rows.map((r) => r.text).join(', ')}`} />
      <span className="budget-text">{rows.map((r) => r.text).join(' · ')}</span>
    </div>
  );
}

/** Live, paused by you, or taking no new work until the budget allows. */
export function RunIntakeState({ run }: { run: Run }) {
  if (run.status === 'paused') return <StatusLabel tone="paused">Paused</StatusLabel>;
  if (run.intake?.paused)
    return (
      <StatusLabel tone="paused" title={pauseDetail(run.intake)}>
        New work paused · {resumeText(run.intake).replace(/^Resumes/, 'resumes')}
      </StatusLabel>
    );
  return <StatusLabel tone="live">Live</StatusLabel>;
}

/** Intake stopped by the budget, which is not the run's own pause: agents keep finishing. */
export function IntakePaused({ run, onChange }: { run: Run; onChange?(): void }) {
  const reason = run.intake?.paused ? run.intake.reason : undefined;
  if (!reason) return null;
  return (
    <div className="callout callout-intake" role="status">
      <IconClock />
      <div className="callout-body">
        <span className="callout-title">
          New work is paused. {PAUSE_TITLE[reason.limit]}.
        </span>
        <span>
          {pauseDetail(run.intake)} {resumeText(run.intake)}.
        </span>
      </div>
      {onChange && (
        <Button size="sm" onClick={onChange}>
          Change budget
        </Button>
      )}
    </div>
  );
}

const SOURCES: { value: RunSource; label: string; help: string }[] = [
  { value: 'goals', label: 'Goals', help: 'The intake agent turns unfinished project goals into work.' },
  { value: 'schedule', label: 'Schedule', help: 'The intake agent asks for new work on a schedule.' },
  { value: 'manual', label: 'Manual', help: 'Only the input you add.' },
];

const REPEATS: { value: Repeat; label: string }[] = [
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Once a week' },
  { value: 'custom', label: 'Custom (cron)' },
];

/** "500k", "2M", "1,200" as a whole number; blank is no limit. */
export function parseAmount(text: string): number | null | undefined {
  const t = text.trim().replace(/[,_\s]/g, '').toLowerCase();
  if (!t) return undefined;
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(t);
  if (!m) return null;
  const n = Math.round(Number(m[1]) * (m[2] === 'k' ? 1_000 : m[2] === 'm' ? 1_000_000 : 1));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const amountText = (n: number | undefined) => (n === undefined ? '' : n >= 1_000_000 && n % 100_000 === 0 ? `${n / 1_000_000}M` : n >= 1_000 && n % 1_000 === 0 ? `${n / 1_000}k` : String(n));

type Target = { kind: 'start'; workflow: Workflow } | { kind: 'edit'; run: Run };

interface Draft {
  source: RunSource;
  keepOpen: boolean;
  schedule: ScheduleSpec;
  tokens: string;
  items: string;
  active: string;
}

function initial(target: Target): Draft {
  if (target.kind === 'edit') {
    const r = target.run;
    return {
      source: r.source ?? 'manual',
      keepOpen: !!r.keepOpen,
      schedule: fromCron(r.schedule),
      tokens: amountText(r.budget?.maxTokensPerDay),
      items: amountText(r.budget?.maxItemsPerDay),
      active: amountText(r.budget?.maxActiveItems),
    };
  }
  // A new run starts from what the workflow's input step asks for.
  const config = target.workflow.graph.nodes.find((n) => n.type === 'input')?.config as { source?: string; schedule?: string } | undefined;
  const source: RunSource = config?.source === 'goals' || config?.source === 'schedule' ? config.source : 'manual';
  return { source, keepOpen: source !== 'manual', schedule: fromCron(config?.schedule), tokens: '', items: '', active: '' };
}

/**
 * Keep running, where new work comes from, and the daily budget. Starts a
 * run with these settings, or changes a running or paused one.
 */
export function RunSettingsDialog({ open, onClose, target, onDone }: { open: boolean; onClose(): void; target: Target; onDone(run: Run): void }) {
  const { api } = useHub();
  const id = useId();
  const [draft, setDraft] = useState<Draft>(() => initial(target));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touchedKeepOpen, setTouchedKeepOpen] = useState(false);
  const offset = localOffset();

  useEffect(() => {
    if (!open) return;
    setDraft(initial(target));
    setError(null);
    setTouchedKeepOpen(false);
    // Reset only when the dialog opens; the target object is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setSchedule = (patch: Partial<ScheduleSpec>) => setDraft((d) => ({ ...d, schedule: { ...d.schedule, ...patch } }));
  const cron = toCron(draft.schedule, offset);
  const cronInvalid = draft.source === 'schedule' && !isCron(cron);
  const amounts = { maxTokensPerDay: parseAmount(draft.tokens), maxItemsPerDay: parseAmount(draft.items), maxActiveItems: parseAmount(draft.active) };
  const invalid = (key: keyof typeof amounts) => (amounts[key] === null ? 'Use a whole number above zero, or leave it empty.' : null);
  const hasBudget = Object.values(amounts).some((n) => n !== undefined);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (cronInvalid || Object.values(amounts).some((n) => n === null)) return;
    const budget = Object.fromEntries(Object.entries(amounts).filter(([, n]) => n !== undefined)) as RunBudget;
    const settings: RunSettings = {
      keepOpen: draft.keepOpen,
      source: draft.source,
      ...(draft.source === 'schedule' ? { schedule: cron } : {}),
      // An edit always sends the budget: an empty one removes every limit.
      ...(target.kind === 'edit' || hasBudget ? { budget } : {}),
    };
    setBusy(true);
    setError(null);
    try {
      const run = target.kind === 'start' ? await api.startRun(target.workflow.id, settings) : await api.updateRun(target.run.id, settings);
      onDone(run);
    } catch (err) {
      setError(`${target.kind === 'start' ? 'The run did not start.' : 'The settings were not saved.'} ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const source = SOURCES.find((s) => s.value === draft.source)!;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={target.kind === 'start' ? `Start a ${target.workflow.name} run` : 'Run settings'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={`${id}-form`} busy={busy}>
            {target.kind === 'start' ? 'Start run' : 'Save settings'}
          </Button>
        </>
      }
    >
      <form id={`${id}-form`} className="form" onSubmit={submit} noValidate>
        <fieldset className="field">
          <legend className="field-label">New work comes from</legend>
          <Segmented<RunSource>
            label="New work comes from"
            className="seg-fill"
            value={draft.source}
            onChange={(value) => set({ source: value, ...(touchedKeepOpen ? {} : { keepOpen: value !== 'manual' }) })}
            options={SOURCES.map((s) => ({ value: s.value, label: s.label }))}
          />
          <p className="field-help">{source.help}</p>
        </fieldset>

        {draft.source === 'schedule' && (
          <div className="schedule-picker">
            <Field label="Repeat" htmlFor={`${id}-repeat`}>
              <span className="select">
                <select id={`${id}-repeat`} className="input" value={draft.schedule.repeat} onChange={(e) => setSchedule(e.target.value === 'custom' ? { repeat: 'custom', cron } : { repeat: e.target.value as Repeat })}>
                  {REPEATS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </span>
            </Field>
            {draft.schedule.repeat === 'weekly' && (
              <Field label="Day" htmlFor={`${id}-day`}>
                <span className="select">
                  <select id={`${id}-day`} className="input" value={draft.schedule.day} onChange={(e) => setSchedule({ day: Number(e.target.value) })}>
                    {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                      <option key={d} value={d}>
                        {DAY_NAMES[d]}
                      </option>
                    ))}
                  </select>
                </span>
              </Field>
            )}
            {draft.schedule.repeat === 'hourly' && (
              <Field label="Minute past the hour" htmlFor={`${id}-minute`}>
                <span className="select">
                  <select id={`${id}-minute`} className="input" value={draft.schedule.minute} onChange={(e) => setSchedule({ minute: Number(e.target.value) })}>
                    {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
                      <option key={m} value={m}>
                        :{String(m).padStart(2, '0')}
                      </option>
                    ))}
                  </select>
                </span>
              </Field>
            )}
            {(draft.schedule.repeat === 'daily' || draft.schedule.repeat === 'weekdays' || draft.schedule.repeat === 'weekly') && (
              <Field label="Time" htmlFor={`${id}-time`}>
                <input id={`${id}-time`} className="input" type="time" value={draft.schedule.time} onChange={(e) => e.target.value && setSchedule({ time: e.target.value })} required />
              </Field>
            )}
            {draft.schedule.repeat === 'custom' && (
              <Field label="Cron, in UTC" htmlFor={`${id}-cron`} error={cronInvalid ? 'Five numeric fields: minute, hour, day, month, weekday.' : null}>
                <input id={`${id}-cron`} className="input mono" value={draft.schedule.cron} onChange={(e) => setSchedule({ cron: e.target.value })} placeholder="0 */6 * * *" spellCheck={false} autoComplete="off" />
              </Field>
            )}
            <p className="field-help schedule-summary">
              {draft.schedule.repeat === 'custom' ? 'Times in cron are UTC.' : `${describeSchedule(cron, offset)}, your time (${offsetLabel(offset)}).`}
            </p>
          </div>
        )}

        <div className="field">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.keepOpen}
              onChange={(e) => {
                setTouchedKeepOpen(true);
                set({ keepOpen: e.target.checked });
              }}
            />
            Keep running when the work is done
          </label>
          <p className="field-help">{draft.keepOpen ? 'The run waits for new work instead of completing.' : 'The run completes once every item is finished.'}</p>
        </div>

        <Disclosure summary={hasBudget ? 'Daily budget' : 'Daily budget · no limits'} defaultOpen={hasBudget}>
          <div className="budget-fields">
            <Field label="Tokens per day" htmlFor={`${id}-tokens`} hint="e.g. 500k or 2M" error={invalid('maxTokensPerDay')}>
              <input id={`${id}-tokens`} className="input" inputMode="numeric" value={draft.tokens} onChange={(e) => set({ tokens: e.target.value })} placeholder="No limit" autoComplete="off" />
            </Field>
            <Field label="Items per day" htmlFor={`${id}-items`} hint="New items started" error={invalid('maxItemsPerDay')}>
              <input id={`${id}-items`} className="input" inputMode="numeric" value={draft.items} onChange={(e) => set({ items: e.target.value })} placeholder="No limit" autoComplete="off" />
            </Field>
            <Field label="Active items" htmlFor={`${id}-active`} hint="In progress at once" error={invalid('maxActiveItems')}>
              <input id={`${id}-active`} className="input" inputMode="numeric" value={draft.active} onChange={(e) => set({ active: e.target.value })} placeholder="No limit" autoComplete="off" />
            </Field>
          </div>
          <p className="field-help">When a limit is reached, new work waits. Work already started finishes. Daily limits reset at midnight UTC.</p>
        </Disclosure>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
