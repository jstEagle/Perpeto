import { useEffect, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { normalizeMergeQueueConfig } from '@perpeto/delivery/queue-config';
import { useHub } from '../app/hub-context';
import { HubError } from '../api/hub';
import type { ConfigProblem, MergeQueueConfig, MergeQueueSettings } from '../api/types';
import { Button, Dialog, Field, Mono, Segmented, Toggle } from './ui';
import { IconXCircle } from './icons';
import {
  configFromDrafts,
  newDraftQueue,
  newLane,
  newWindow,
  problemAt,
  queuePath,
  toDraft,
  unplacedProblems,
  type DraftLane,
  type DraftQueue,
  type DraftWindow,
} from '../lib/merge-queue';

const QUEUE_FIELDS = ['name', 'branches', 'strategy', 'maxBatchSize', 'depth', 'requiredChecks', 'method', 'publication', 'lanes', 'defaultLane', 'freeze', 'maxInFlight',
  'flakyRetries', 'bisectOnBatchFailure', 'autoRebaseOnConflict', 'ejectAfterMinutes', 'requiredApprovals'];

/**
 * The hub's merge queue settings as a form, one queue at a time. Every change is checked with the same validator the
 * hub runs, so problems show under their field before saving; the hub's own answer is shown the same way.
 */
export function MergeQueueSettingsDialog({ open, settings, onClose, onSaved }: { open: boolean; settings: MergeQueueSettings; onClose(): void; onSaved(): void }) {
  const { api } = useHub();
  const [drafts, setDrafts] = useState<DraftQueue[]>([]);
  const [index, setIndex] = useState(0);
  const [served, setServed] = useState<ConfigProblem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    // The editor starts from the hub's own document, normalized so every field has its value.
    setDrafts(normalizeMergeQueueConfig(settings.config).config.queues.map(toDraft));
    setIndex(0);
    setServed(null);
    setError(null);
  }, [open, settings]);
  const config = useMemo(() => configFromDrafts(drafts), [drafts]);
  const local = useMemo(() => normalizeMergeQueueConfig(config).errors, [config]);
  const problems = served ?? local;
  const draft = drafts[index];
  const update = (patch: Partial<DraftQueue>) => {
    setServed(null);
    setDrafts((all) => all.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveMergeQueues(settings.projectId, config as unknown as MergeQueueConfig, settings.version);
      onSaved();
    } catch (e) {
      if (e instanceof HubError && e.details?.length) setServed(e.details);
      setError(e instanceof HubError && e.code === 'VERSION_CONFLICT' ? `${e.message}` : `Saving failed. ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const at = (field: string) => problemAt(problems, queuePath(index, field));
  const others = unplacedProblems(problems, drafts.map((_, i) => queuePath(i)).flatMap((p) => QUEUE_FIELDS.map((f) => `${p}.${f}`)).concat(drafts.map((_, i) => queuePath(i))));
  const otherQueues = problems.filter((p) => !p.path.startsWith(queuePath(index)) && p.path.startsWith('$.queues['));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Merge queue settings"
      wide
      footer={
        <>
          {problems.length > 0 && (
            <span className="form-error mq-foot-error">
              <IconXCircle size={16} />
              {problems.length === 1 ? '1 problem to fix' : `${problems.length} problems to fix`}
            </span>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} disabled={problems.length > 0} onClick={save}>
            Save settings
          </Button>
        </>
      }
    >
      <div className="mq-settings">
        <p className="muted">
          Version {settings.version}. A committed <Mono>{settings.repo.path}</Mono> overrides these per queue and field{settings.repo.applied ? ', and does now' : ''}.
        </p>
        <div className="row mq-settings-queues">
          {drafts.length > 0 && (
            <Segmented
              label="Queue"
              value={String(index)}
              onChange={(v) => setIndex(Number(v))}
              options={drafts.map((d, i) => ({ value: String(i), label: d.name || 'Unnamed', count: problems.some((p) => p.path.startsWith(queuePath(i))) ? '!' : undefined }))}
            />
          )}
          <Button
            size="sm"
            onClick={() => {
              const name = ['main', 'release', 'staging'].find((n) => !drafts.some((d) => d.name === n)) ?? `queue-${drafts.length + 1}`;
              setDrafts((all) => [...all, newDraftQueue(name)]);
              setIndex(drafts.length);
              setServed(null);
            }}
          >
            Add queue
          </Button>
        </div>
        {error && <p className="form-error">{error}</p>}
        {others.length > 0 && <Problems problems={others} />}
        {otherQueues.length > 0 && <p className="field-help">Other queues have problems too; they are marked with “!”.</p>}
        {draft ? <QueueForm draft={draft} update={update} at={at} index={index} problems={problems} onRemove={() => {
          setDrafts((all) => all.filter((_, i) => i !== index));
          setIndex(Math.max(0, index - 1));
          setServed(null);
        }} /> : <p className="muted">No queues. Add one for each target branch you merge into.</p>}
      </div>
    </Dialog>
  );
}

function Problems({ problems }: { problems: ConfigProblem[] }) {
  return (
    <ul className="mq-problems form-error-list">
      {problems.map((p) => (
        <li key={`${p.path}${p.message}`} className="form-error">
          <IconXCircle size={16} />
          <span>
            <Mono>{p.path}</Mono> {p.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

function QueueForm({ draft, update, at, index, problems, onRemove }: { draft: DraftQueue; update(patch: Partial<DraftQueue>): void; at(field: string): string | null; index: number; problems: ConfigProblem[]; onRemove(): void }) {
  const id = useId();
  const text = (field: keyof DraftQueue, label: string, hint?: ReactNode, mono = false) => (
    <Field label={label} hint={hint} error={at(field)} htmlFor={`${id}-${field}`}>
      <input
        id={`${id}-${field}`}
        className={`input ${mono ? 'mono' : ''}`}
        value={draft[field] as string}
        aria-invalid={at(field) ? true : undefined}
        aria-describedby={at(field) ? `${id}-${field}-error` : undefined}
        onChange={(e) => update({ [field]: e.target.value } as Partial<DraftQueue>)}
      />
    </Field>
  );
  const setLane = (j: number, patch: Partial<DraftLane>) => update({ lanes: draft.lanes.map((l, k) => (k === j ? { ...l, ...patch } : l)) });
  const setWindow = (j: number, patch: Partial<DraftWindow>) => update({ windows: draft.windows.map((w, k) => (k === j ? { ...w, ...patch } : w)) });
  const lanePath = (j: number, field: string) => problemAt(problems, `${queuePath(index, 'lanes')}[${j}].${field}`);
  const windowPath = (j: number, field?: string) => problemAt(problems, `${queuePath(index, 'freeze.windows')}[${j}]${field ? `.${field}` : ''}`);

  return (
    <div className="mq-form">
      <section className="mq-form-section" aria-label="Queue">
        <div className="cols cols-even">
          {text('name', 'Name', 'Workflows refer to the queue by this name.', true)}
          {text('branches', 'Target branches', 'Comma-separated, for example main or release/*.', true)}
        </div>
        <Field label="Strategy" error={at('strategy')} htmlFor={`${id}-strategy`}>
          <div id={`${id}-strategy`}>
            <Segmented
              label="Strategy"
              value={draft.strategy}
              onChange={(strategy) => update({ strategy })}
              options={[
                { value: 'serial', label: 'One at a time' },
                { value: 'batch', label: 'Batches' },
                { value: 'speculative', label: 'Speculative' },
              ]}
            />
          </div>
        </Field>
        <div className="cols cols-even">
          {draft.strategy === 'batch' && text('maxBatchSize', 'Largest batch', 'A failed batch is split to find the culprit.')}
          {draft.strategy === 'speculative' && text('depth', 'Depth', 'Changes tested at once, each on the one ahead.')}
          {text('maxInFlight', 'Most in flight', 'Leave empty for no limit.')}
        </div>
        <div className="cols cols-even">
          <Field label="Merge method" error={at('method')} htmlFor={`${id}-method`}>
            <span className="select">
              <select id={`${id}-method`} className="input" value={draft.method} onChange={(e) => update({ method: e.target.value as DraftQueue['method'] })}>
                <option value="squash">Squash</option>
                <option value="merge">Merge commit</option>
                <option value="rebase">Rebase</option>
              </select>
            </span>
          </Field>
          <Field label="Publication" error={at('publication')} htmlFor={`${id}-publication`}>
            <span className="select">
              <select id={`${id}-publication`} className="input" value={draft.publication} onChange={(e) => update({ publication: e.target.value as DraftQueue['publication'] })}>
                <option value="fast-forward-push">Push the tested commit</option>
                <option value="github-merge-queue">GitHub merge queue</option>
              </select>
            </span>
          </Field>
        </div>
      </section>

      <section className="mq-form-section" aria-label="Gates">
        <h3 className="mq-form-title">Gates</h3>
        <div className="cols cols-even">
          {text('requiredChecks', 'Required checks', 'CI pipeline or step names, comma-separated.', true)}
          {text('requiredApprovals', 'Approving reviews', 'Review gates that must pass first.')}
        </div>
        <div className="cols cols-even">
          {text('flakyRetries', 'Flaky retries', 'Runs CI again on the same commit before rejecting.')}
          {text('ejectAfterMinutes', 'Eject after (minutes)', 'Leave empty to wait as long as it takes.')}
        </div>
        <div className="mq-toggles">
          <ToggleRow label="Split a failed batch to find the culprit" checked={draft.bisectOnBatchFailure} onChange={(v) => update({ bisectOnBatchFailure: v })} />
          <ToggleRow label="Rebase automatically after a conflict" checked={draft.autoRebaseOnConflict} onChange={(v) => update({ autoRebaseOnConflict: v })} />
        </div>
      </section>

      <section className="mq-form-section" aria-label="Lanes">
        <div className="row row-between">
          <h3 className="mq-form-title">Lanes</h3>
          <Button size="sm" variant="ghost" onClick={() => update({ lanes: [...draft.lanes, newLane()] })}>
            Add lane
          </Button>
        </div>
        {draft.lanes.length === 0 ? (
          <p className="field-help">Without lanes the queue is first come, first served. Add lanes such as hotfix, normal and dependencies to merge urgent work first.</p>
        ) : (
          <>
            {draft.lanes.map((lane, j) => (
              <div key={j} className="mq-lane">
                <LaneInput label="Lane" value={lane.name} error={lanePath(j, 'name')} onChange={(v) => setLane(j, { name: v })} mono />
                <LaneInput label="Priority" value={lane.priority} error={lanePath(j, 'priority')} onChange={(v) => setLane(j, { priority: v })} />
                <LaneInput label="Labels" value={lane.labels} error={lanePath(j, 'labels')} onChange={(v) => setLane(j, { labels: v })} />
                <LaneInput label="Branches" value={lane.branches} error={lanePath(j, 'branches')} onChange={(v) => setLane(j, { branches: v })} mono />
                <Button size="sm" variant="ghost" aria-label={`Remove lane ${lane.name || j + 1}`} onClick={() => update({ lanes: draft.lanes.filter((_, k) => k !== j) })}>
                  Remove
                </Button>
              </div>
            ))}
            <Field label="Default lane" error={at('defaultLane')} htmlFor={`${id}-default`}>
              <span className="select">
                <select id={`${id}-default`} className="input" value={draft.defaultLane} onChange={(e) => update({ defaultLane: e.target.value })}>
                  <option value="">Lowest priority, or “normal”</option>
                  {draft.lanes.filter((l) => l.name).map((l) => (
                    <option key={l.name} value={l.name}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </span>
            </Field>
          </>
        )}
      </section>

      <section className="mq-form-section" aria-label="Freeze windows">
        <div className="row row-between">
          <h3 className="mq-form-title">Freeze windows</h3>
          <div className="row">
            <Button size="sm" variant="ghost" onClick={() => update({ windows: [...draft.windows, newWindow('cron')] })}>
              Add weekly window
            </Button>
            <Button size="sm" variant="ghost" onClick={() => update({ windows: [...draft.windows, newWindow('range')] })}>
              Add date range
            </Button>
          </div>
        </div>
        {draft.windows.length === 0 ? (
          <p className="field-help">Nothing merges during a window; tested changes wait for it to end. Times are UTC.</p>
        ) : (
          draft.windows.map((w, j) => (
            <div key={j} className="mq-lane mq-window">
              {w.kind === 'cron' ? (
                <>
                  <LaneInput label="Starts (cron, UTC)" value={w.cron} error={windowPath(j, 'cron')} onChange={(v) => setWindow(j, { cron: v })} mono />
                  <LaneInput label="Minutes" value={w.durationMinutes} error={windowPath(j, 'durationMinutes')} onChange={(v) => setWindow(j, { durationMinutes: v })} />
                </>
              ) : (
                <>
                  <LaneInput label="From" value={w.start} error={windowPath(j, 'start')} onChange={(v) => setWindow(j, { start: v })} mono placeholder="2026-12-20T00:00:00Z" />
                  <LaneInput label="Until" value={w.end} error={windowPath(j, 'end')} onChange={(v) => setWindow(j, { end: v })} mono placeholder="2027-01-02T00:00:00Z" />
                </>
              )}
              <LaneInput label="Reason" value={w.reason} error={windowPath(j, 'reason')} onChange={(v) => setWindow(j, { reason: v })} />
              <Button size="sm" variant="ghost" aria-label={`Remove freeze window ${j + 1}`} onClick={() => update({ windows: draft.windows.filter((_, k) => k !== j) })}>
                Remove
              </Button>
            </div>
          ))
        )}
      </section>
      <div className="row-end mq-remove-queue">
        <Button size="sm" variant="ghost" onClick={onRemove}>
          Remove this queue
        </Button>
      </div>
    </div>
  );
}

function LaneInput({ label, value, error, onChange, mono, placeholder }: { label: string; value: string; error: string | null; onChange(v: string): void; mono?: boolean; placeholder?: string }) {
  const id = useId();
  return (
    <Field label={label} error={error} htmlFor={id}>
      <input id={id} className={`input ${mono ? 'mono' : ''}`} value={value} placeholder={placeholder} aria-invalid={error ? true : undefined} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <div className="row row-between mq-toggle">
      <span>{label}</span>
      <Toggle label={label} checked={checked} onChange={onChange} />
    </div>
  );
}
