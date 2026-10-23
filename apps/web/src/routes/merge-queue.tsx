import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useParams } from '@tanstack/react-router';
import { useHub, useResource } from '../app/hub-context';
import { Async, Button, Disclosure, Empty, Menu, Mono, PageHeader, Panel, Segmented, Stat } from '../components/ui';
import { JobStatusLabel, LiveDot, MergeStatusLabel, StatusLabel } from '../components/status';
import { IconMerge } from '../components/icons';
import { MergeQueueSettingsDialog } from '../components/merge-queue-settings';
import { clock, pct, plural, prNumber, rate, relative, shortSha } from '../lib/format';
import { attemptLabel, causeLabel, freezeText, minutes, strategyLabel, waitingSummary } from '../lib/merge-queue';
import type { HubEvent, MergeEntry, MergeEntryCommand, MergeQueueSettings, MergeQueueView, MetricsWindow, QueueEntryView } from '../api/types';
import '../styles/merge-queue.css';

const queueEvent = (e: HubEvent) => e.type.startsWith('merge-queue.') || e.type.startsWith('merge-entry.') || e.subject.kind === 'merge-entry' || e.subject.kind === 'job';

export function MergeQueuePage() {
  const { projectId } = useParams({ from: '/projects/$projectId/merge-queue' });
  const settings = useResource((api) => api.mergeQueues(projectId), [projectId], (e) => e.type.startsWith('merge-queue.'));
  const [editing, setEditing] = useState(false);
  return (
    <div className="page">
      <Async resource={settings} what="the merge queues">
        {(s) =>
          s === null ? (
            <LegacyQueue projectId={projectId} />
          ) : (
            <Queues settings={s} projectId={projectId} onEdit={() => setEditing(true)} />
          )
        }
      </Async>
      {settings.data && (
        <MergeQueueSettingsDialog
          open={editing}
          settings={settings.data}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            settings.reload();
          }}
        />
      )}
    </div>
  );
}

function Queues({ settings, projectId, onEdit }: { settings: MergeQueueSettings; projectId: string; onEdit(): void }) {
  const [selected, setSelected] = useState<string | null>(settings.queues[0]?.id ?? null);
  useEffect(() => {
    if (!settings.queues.some((q) => q.id === selected)) setSelected(settings.queues[0]?.id ?? null);
  }, [settings, selected]);
  const queue = settings.queues.find((q) => q.id === selected) ?? null;
  const description = 'Changes merge after CI passes on the exact candidate commit. Lanes order the work; a freeze holds publication.';
  if (!queue) {
    return (
      <>
        <PageHeader title="Merge queue" description={description} />
        <section className="card">
          <Empty title="No merge queues yet" icon={<IconMerge />} action={<Button variant="primary" onClick={onEdit}>Set up a merge queue</Button>}>
            Name a queue for each target branch, with its strategy, required checks and lanes. Workflows can then use it by name.
          </Empty>
        </section>
        <RepoNote settings={settings} />
      </>
    );
  }
  return (
    <QueueScreen
      key={queue.id}
      queueId={queue.id}
      projectId={projectId}
      settings={settings}
      picker={
        settings.queues.length > 1 ? (
          <Segmented
            label="Merge queue"
            value={queue.id}
            onChange={setSelected}
            options={settings.queues.map((q) => ({ value: q.id, label: q.name, count: q.counts.queued + q.counts.testing + q.counts.merging || undefined }))}
          />
        ) : null
      }
      onEdit={onEdit}
      description={description}
    />
  );
}

function QueueScreen({ queueId, settings, picker, onEdit, description }: { queueId: string; projectId: string; settings: MergeQueueSettings; picker: ReactNode; onEdit(): void; description: string }) {
  const { api } = useHub();
  const [window, setWindow] = useState<MetricsWindow>('24h');
  const view = useResource((a) => a.mergeQueueView(queueId, window), [queueId, window], queueEvent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, what: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      view.reload();
    } catch (e) {
      setError(`${what} failed. ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const frozen = view.data?.frozen;
  const manual = frozen && frozen.kind !== 'window';
  return (
    <>
      <PageHeader
        title="Merge queue"
        description={description}
        actions={
          <>
            {view.data && !manual && (
              <Button onClick={() => act(() => api.freezeMergeQueue(queueId, 'Frozen by the owner.'), 'Freezing the queue')} busy={busy}>
                Freeze
              </Button>
            )}
            <Button onClick={onEdit}>Settings</Button>
          </>
        }
      />
      {picker && <div className="mq-picker">{picker}</div>}
      {error && <p className="form-error mq-error">{error}</p>}
      <Async resource={view} what="the queue">
        {(v) => (
          <div className="stack mq-stack">
            {v.frozen && (
              <section className="card mq-frozen" aria-label="Freeze">
                <div className="mq-frozen-text">
                  <h2 className="card-title">Frozen: {v.frozen.reason}</h2>
                  <p className="muted">
                    {freezeText(v.frozen)}. Tested changes wait; nothing merges until it lifts.
                  </p>
                </div>
                {v.frozen.kind !== 'window' && (
                  <Button variant="primary" busy={busy} onClick={() => act(() => api.unfreezeMergeQueue(queueId), 'Unfreezing the queue')}>
                    Unfreeze
                  </Button>
                )}
              </section>
            )}
            <NowCard view={v} />
            <MetricsCard view={v} window={window} onWindow={setWindow} />
            <OrderCard view={v} busy={busy} onCommand={(id, command, what) => act(() => api.mergeEntryCommand(id, command), what)} />
            <RecentCard view={v} />
            <RepoNote settings={settings} />
          </div>
        )}
      </Async>
    </>
  );
}

function NowCard({ view }: { view: MergeQueueView }) {
  const live = view.attempts.length > 0;
  const next = view.entries.find((e) => e.etaAt);
  return (
    <section className="card" aria-labelledby="mq-now">
      <div className="mq-now-head">
        <h2 className="mq-headline" id="mq-now">
          {live && <LiveDot label="Testing now" className="headline-dot" />}
          <span>{waitingSummary(view)}</span>
          {next?.etaAt && !view.frozen && <span className="muted"> · next merge about {clock(next.etaAt)}</span>}
        </h2>
        <p className="muted mq-now-meta">
          <Mono>{view.branches.join(', ')}</Mono> · {strategyLabel(view)}
          {view.config?.requiredChecks.length ? <> · requires {view.config.requiredChecks.join(', ')}</> : null}
          {view.source === 'merged' || view.source === 'repo' ? ' · set in the repository file' : null}
        </p>
      </div>
      {live && (
        <ul className="rows mq-attempts">
          {view.attempts.map((attempt) => (
            <li key={attempt.id}>
              <div className="row-main">
                <div className="row-title">{attemptLabel(attempt, view.strategy)}</div>
                <div className="row-meta">
                  {attempt.entryIds
                    .map((id) => view.entries.find((e) => e.id === id))
                    .filter((e): e is QueueEntryView => !!e)
                    .map((e) => prNumber(e.prUrl))
                    .join(', ')}
                  {attempt.startedAt && <> · started {relative(attempt.startedAt)}</>}
                  {attempt.revision && (
                    <>
                      {' '}
                      · candidate <Mono title={attempt.revision}>{shortSha(attempt.revision)}</Mono>
                    </>
                  )}
                  {attempt.reason && <> · {attempt.reason}</>}
                </div>
              </div>
              {attempt.jobStatus && <JobStatusLabel status={attempt.jobStatus} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MetricsCard({ view, window, onWindow }: { view: MergeQueueView; window: MetricsWindow; onWindow(w: MetricsWindow): void }) {
  const m = view.metrics;
  const max = Math.max(1, ...m.hourly.map((h) => h.merged + h.rejected));
  return (
    <Panel
      title="Throughput"
      actions={
        <Segmented
          className="seg-sm"
          label="Window"
          value={window}
          onChange={onWindow}
          options={[
            { value: '1h', label: '1 h' },
            { value: '24h', label: '24 h' },
            { value: '7d', label: '7 d' },
          ]}
        />
      }
    >
      <dl className="metrics">
        <Stat label="Merged per hour" value={rate(m.throughputPerHour, m.throughputPerHour > 0 && m.throughputPerHour < 1 ? 2 : 1)} detail={plural(m.merged, 'merge')} />
        <Stat label="Median time in queue" value={minutes(m.medianTimeInQueueMs)} />
        <Stat label="Failure rate" value={pct(m.failureRate)} detail={m.rejected ? plural(m.rejected, 'rejection') : undefined} />
      </dl>
      <Disclosure summary="More metrics" className="mq-more">
        <div className="mq-more-grid">
          <figure className="mq-chart" aria-label={`Merges per hour over the last ${m.hourly.length} hours`}>
            <div className="bars bars-mid" aria-hidden="true">
              {m.hourly.map((h, i) => (
                <span key={h.start} className={i === m.hourly.length - 1 ? 'now' : h.merged + h.rejected === 0 ? 'zero' : ''} style={{ height: h.merged + h.rejected ? `${((h.merged + h.rejected) / max) * 100}%` : undefined }} title={`${clock(h.start)}: ${h.merged} merged, ${h.rejected} rejected`} />
              ))}
            </div>
            <figcaption className="bars-axis">
              <span>{m.hourly.length} h ago</span>
              <span>Now</span>
            </figcaption>
          </figure>
          <dl className="kv mq-kv">
            <dt>Batch success</dt>
            <dd>{m.batches.total ? `${pct(m.batches.successRate)} of ${m.batches.total}` : '—'}</dd>
            <dt>Flaky retries</dt>
            <dd>{m.flakyRetries}</dd>
            <dt>Attempt time</dt>
            <dd>{minutes(view.eta.attemptMs)}</dd>
            {m.failuresByReason.map((f) => (
              <FailureRow key={f.cause} cause={f.cause} count={f.count} rate={f.rate} />
            ))}
          </dl>
        </div>
      </Disclosure>
    </Panel>
  );
}

function FailureRow({ cause, count, rate: share }: { cause: string; count: number; rate: number }) {
  return (
    <>
      <dt>{causeLabel(cause)}</dt>
      <dd>
        {count} · {pct(share)}
      </dd>
    </>
  );
}

function OrderCard({ view, busy, onCommand }: { view: MergeQueueView; busy: boolean; onCommand(id: string, command: MergeEntryCommand, what: string): void }) {
  const lanes = view.config?.lanes ?? [];
  if (!view.entries.length) {
    return (
      <section className="card">
        <Empty title="The queue is empty" icon={<IconMerge />}>
          Pull requests join after their workflow’s gates pass.
        </Empty>
      </section>
    );
  }
  return (
    <Panel title="In order" actions={view.entries.length > 1 ? `${view.entries.length} open` : undefined}>
      <div className="table-wrap">
        <table className="table mq-table" aria-busy={busy || undefined}>
          <caption className="visually-hidden">Merge queue entries in the order they will merge</caption>
          <thead>
            <tr>
              <th scope="col" className="num">#</th>
              <th scope="col">Pull request</th>
              {lanes.length > 0 && <th scope="col" className="hide-sm">Lane</th>}
              <th scope="col">Status</th>
              <th scope="col" className="hide-sm num">Expected</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {view.entries.map((e) => (
              <tr key={e.id}>
                <td className="num tabular">{e.position}</td>
                <td>
                  <a className="cell-title" href={e.prUrl} target="_blank" rel="noreferrer">
                    Pull request {prNumber(e.prUrl)}
                  </a>
                  <span className="cell-sub">
                    {e.headBranch && <Mono>{e.headBranch}</Mono>}
                    {e.waitedMs !== undefined && <> · waiting {minutes(e.waitedMs)}</>}
                  </span>
                  {(e.reason || e.deliveryError) && <span className="cell-sub cell-wrap">{e.deliveryError ?? e.reason}</span>}
                </td>
                {lanes.length > 0 && <td className="hide-sm">{e.lane ? <span className="chip chip-quiet">{e.lane}</span> : '—'}</td>}
                <td>
                  <MergeStatusLabel status={e.status} />
                </td>
                <td className="hide-sm num tabular">{e.etaAt ? clock(e.etaAt) : '—'}</td>
                <td className="mq-actions">
                  {e.status !== 'merging' && (
                    <Menu
                      label={`Actions for pull request ${prNumber(e.prUrl)}`}
                      items={[
                        ...lanes
                          .filter((l) => l.name !== e.lane)
                          .map((l) => ({ label: `Move to ${l.name}`, onSelect: () => onCommand(e.id, { action: 'priority', lane: l.name }, `Moving ${prNumber(e.prUrl)}`) })),
                        { label: 'Send to the back', onSelect: () => onCommand(e.id, { action: 'requeue' }, `Requeuing ${prNumber(e.prUrl)}`) },
                        { label: 'Eject', onSelect: () => onCommand(e.id, { action: 'eject' }, `Ejecting ${prNumber(e.prUrl)}`) },
                      ]}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function RecentCard({ view }: { view: MergeQueueView }) {
  if (!view.recent.length) return null;
  return (
    <section className="card mq-recent">
      <Disclosure summary={`Recent outcomes (${view.recent.length})`}>
        <ul className="rows">
          {view.recent.map((e) => (
            <li key={e.id}>
              <div className="row-main">
                <div className="row-title">
                  <a href={e.prUrl} target="_blank" rel="noreferrer" className="link">
                    Pull request {prNumber(e.prUrl)}
                  </a>
                </div>
                <div className="row-meta">
                  {e.status === 'rejected' ? `${causeLabel(e.cause)}${e.reason ? `: ${e.reason}` : ''}` : `In queue ${minutes(e.waitedMs)}`}
                  {e.finishedAt && <> · {relative(e.finishedAt)}</>}
                </div>
              </div>
              <MergeStatusLabel status={e.status} />
            </li>
          ))}
        </ul>
      </Disclosure>
    </section>
  );
}

function RepoNote({ settings }: { settings: MergeQueueSettings }) {
  const { repo } = settings;
  if (!repo.found && !repo.error) {
    return <p className="muted mq-note">Settings version {settings.version}. A committed <Mono>{repo.path}</Mono> would override them per queue.</p>;
  }
  if (repo.applied) {
    return (
      <p className="muted mq-note">
        Settings version {settings.version}, with <Mono>{repo.path}</Mono> from <Mono>{shortSha(repo.revision)}</Mono> applied on top.
      </p>
    );
  }
  return (
    <section className="card mq-repo-error" aria-label="Repository settings file">
      <StatusLabel tone="failed">
        <Mono>{repo.path}</Mono> is not applied
      </StatusLabel>
      <p className="muted">{repo.error ?? 'It has problems, so the hub settings apply unchanged:'}</p>
      {repo.errors && (
        <ul className="mq-problems">
          {repo.errors.map((p) => (
            <li key={`${p.path}${p.message}`}>
              <Mono>{p.path}</Mono> {p.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Hubs from before configurable queues: the plain entry list. */
function LegacyQueue({ projectId }: { projectId: string }) {
  const queue = useResource((api) => api.mergeQueue(projectId), [projectId], (e) => e.subject.kind === 'merge-entry' || e.subject.kind === 'job');
  return (
    <>
      <PageHeader title="Merge queue" description="Changes merge into the base branch after CI passes at the exact head commit. Rejected entries say why." />
      <Async resource={queue} what="the merge queue">
        {(entries: MergeEntry[]) =>
          entries.length === 0 ? (
            <section className="card">
              <Empty title="The merge queue is empty" icon={<IconMerge />}>
                Pull requests join the queue after they pass review and CI.
              </Empty>
            </section>
          ) : (
            <section className="card">
              <ul className="rows">
                {[...entries].reverse().map((e) => (
                  <li key={e.id}>
                    <div className="row-main">
                      <a className="row-title link" href={e.prUrl} target="_blank" rel="noreferrer">
                        Pull request {prNumber(e.prUrl)}
                      </a>
                      <div className="row-meta">
                        <Mono>{shortSha(e.headSha)}</Mono> into <Mono>{e.baseBranch}</Mono>
                        {e.reason && <> · {e.reason}</>}
                      </div>
                    </div>
                    <MergeStatusLabel status={e.status} />
                  </li>
                ))}
              </ul>
            </section>
          )
        }
      </Async>
    </>
  );
}
