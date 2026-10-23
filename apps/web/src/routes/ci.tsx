import { useId, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useHub, useResource } from '../app/hub-context';
import type { Resource } from '../app/hub-context';
import { Async, Button, Dialog, Empty, Field, Meter, Mono, PageHeader, Panel, Stat } from '../components/ui';
import { DurationTrend, PipelineRunStatusLabel, usePoll } from '../components/ci';
import { IconCi, IconPlay } from '../components/icons';
import { formatBytes, formatMs, isRunActive, jobCounts, runElapsedMs, TRIGGER_LABEL } from '../api/ci';
import type { FlakyJob, Pipeline, PipelineInsight, PipelineList, PipelineRun, Runner, RunnersView } from '../api/ci';
import { dateTime, pct, plural, relative, shortSha } from '../lib/format';

const ciEvent = (projectId: string) => (e: { type: string; projectId?: string }) =>
  (e.projectId === projectId || !e.projectId) && (e.type.startsWith('pipeline') || e.type.startsWith('job'));

export function CiPage() {
  const { projectId } = useParams({ from: '/projects/$projectId/ci' });
  const pipelines = useResource((api) => api.ciPipelines(projectId), [projectId]);
  const runs = useResource((api) => api.ciRuns({ projectId, limit: 30 }), [projectId], ciEvent(projectId));
  const runners = useResource((api) => api.ciRunners(), []);
  const insights = useResource((api) => api.ciInsights(projectId, '7d'), [projectId]);
  const flaky = useResource((api) => api.ciFlaky(projectId), [projectId]);
  const [starting, setStarting] = useState<string | null>(null);
  const active = (runs.data ?? []).some(isRunActive);
  usePoll(() => {
    runs.reload();
    runners.reload();
  }, active);

  const list = pipelines.data;
  const hasPipelines = Boolean(list && list.pipelines.length);
  return (
    <div className="page">
      <PageHeader
        title="CI"
        description="Pipelines from the repository's .perpeto/ci.json run on your machines at an exact commit. Jobs fan out by their dependencies and matrix."
        actions={
          hasPipelines && (
            <Button variant="primary" onClick={() => setStarting(list!.pipelines[0].name)}>
              <IconPlay /> Run pipeline
            </Button>
          )
        }
      />

      <Async resource={pipelines} what="pipelines">
        {(value) =>
          value === null ? (
            <section className="card">
              <Empty title="This hub does not run CI pipelines yet" icon={<IconCi />}>
                Update the hub to run repository pipelines. Workflow CI steps still run as before.
              </Empty>
            </section>
          ) : (
            <>
              <Summary runs={runs.data ?? []} insights={insights.data} />
              <RunsPanel projectId={projectId} runs={runs} />
              <PipelinesPanel list={value} insights={insights.data?.pipelines ?? []} onRun={setStarting} />
            </>
          )
        }
      </Async>

      <RunnersPanel runners={runners} />
      <FlakyPanel projectId={projectId} flaky={flaky} />

      {list && starting !== null && <StartDialog projectId={projectId} list={list} initial={starting} onClose={() => setStarting(null)} onStarted={runs.reload} />}
    </div>
  );
}

function Summary({ runs, insights }: { runs: PipelineRun[]; insights?: { pipelines: { runs: number; passed: number }[]; queueWait: { avgMs: number; p90Ms: number } } }) {
  const total = insights?.pipelines.reduce((n, p) => n + p.runs, 0) ?? 0;
  const passed = insights?.pipelines.reduce((n, p) => n + p.passed, 0) ?? 0;
  return (
    <section className="card" aria-label="CI summary">
      <dl className="metrics">
        <Stat label="Runs in progress" value={runs.filter(isRunActive).length} />
        <Stat label="Pass rate" detail="7 days" value={total ? pct(passed / total) : '—'} />
        <Stat label="Queue wait" detail={insights ? `p90 ${formatMs(insights.queueWait.p90Ms)}` : undefined} value={insights ? formatMs(insights.queueWait.avgMs) : '—'} />
      </dl>
    </section>
  );
}

function RunsPanel({ projectId, runs }: { projectId: string; runs: Resource<PipelineRun[]> }) {
  return (
    <Panel title="Pipeline runs">
      <Async resource={runs} what="pipeline runs">
        {(list) =>
          list.length === 0 ? (
            <Empty title="No pipeline runs yet" icon={<IconCi />}>
              Runs start from pull requests, the merge queue, a schedule or the Run pipeline button.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">Pipeline runs</caption>
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="hide-sm">Trigger</th>
                    <th scope="col" className="hide-sm">Revision</th>
                    <th scope="col" className="hide-sm">Jobs</th>
                    <th scope="col" className="hide-sm">Started</th>
                    <th scope="col" className="num">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((run) => {
                    const counts = jobCounts(run.jobs);
                    return (
                      <tr key={run.id}>
                        <td>
                          <Link to="/projects/$projectId/ci/$runId" params={{ projectId, runId: run.id }} className="cell-title">
                            {run.pipeline}
                          </Link>
                          <span className="cell-sub mono">{run.id}</span>
                        </td>
                        <td>
                          <PipelineRunStatusLabel status={run.status} />
                        </td>
                        <td className="hide-sm">
                          {TRIGGER_LABEL[run.trigger.kind] ?? run.trigger.kind}
                          {run.ref && <span className="cell-sub mono">{run.ref}</span>}
                        </td>
                        <td className="hide-sm">
                          <Mono title={run.revision}>{shortSha(run.revision)}</Mono>
                        </td>
                        <td className="hide-sm">
                          <span className="tabular">
                            {counts.passed} of {counts.total} passed
                          </span>
                          {counts.failed > 0 && <span className="cell-sub ci-failed-text">{plural(counts.failed, 'failed job')}</span>}
                        </td>
                        <td className="hide-sm" title={dateTime(run.createdAt)}>
                          {relative(run.createdAt)}
                        </td>
                        <td className="num tabular">{formatMs(runElapsedMs(run))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        }
      </Async>
    </Panel>
  );
}

function sourceText(list: PipelineList) {
  if (list.source === 'repo') return <>From <Mono>{list.path ?? '.perpeto/ci.json'}</Mono> at <Mono title={list.revision ?? undefined}>{shortSha(list.revision ?? undefined)}</Mono></>;
  if (list.source === 'project') return 'From the project’s pipeline settings on the hub, since the repository has no .perpeto/ci.json.';
  return 'No pipelines are defined. Add .perpeto/ci.json to the repository.';
}

function triggerText(pipeline: Pipeline) {
  return pipeline.triggers.map((t) => (t.on === 'schedule' && t.cron ? `Schedule ${t.cron}` : TRIGGER_LABEL[t.on])).join(', ');
}

function PipelinesPanel({ list, insights, onRun }: { list: PipelineList; insights: PipelineInsight[]; onRun(name: string): void }) {
  return (
    <Panel title="Pipelines" actions={<span className="muted ci-source">{sourceText(list)}</span>}>
      {list.error && <p className="field-error">The pipeline file is invalid: {list.error.message}</p>}
      {list.pipelines.length === 0 ? (
        <Empty title="No pipelines" icon={<IconCi />}>
          Add .perpeto/ci.json to the repository, or set project pipelines on the hub.
        </Empty>
      ) : (
        <ul className="ci-pipelines">
          {list.pipelines.map((p) => {
            const insight = insights.find((i) => i.name === p.name);
            return (
              <li key={p.name} className="ci-pipeline">
                <div className="ci-pipeline-head">
                  <div>
                    <h3 className="ci-pipeline-name">{p.name}</h3>
                    <p className="muted">
                      {plural(p.jobs.length, 'job')} · {triggerText(p)}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => onRun(p.name)}>
                    Run
                  </Button>
                </div>
                {insight && insight.trend.length > 0 ? (
                  <DurationTrend insight={insight} label={`Durations of recent ${p.name} runs`} />
                ) : (
                  <p className="muted">No runs in the last 7 days.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

const MODE: Record<Runner['mode'], string> = { agents: 'Agents only', ci: 'CI only', both: 'Agents and CI', observe: 'Observe only' };

function RunnersPanel({ runners }: { runners: Resource<RunnersView | null> }) {
  return (
    <Panel title="Runners">
      <Async resource={runners} what="runners">
        {(view) =>
          !view || view.runners.length === 0 ? (
            <Empty title="No runners" icon={<IconCi />}>
              Machines with job slots run CI. Give a machine runner pools in its node config to add it.
            </Empty>
          ) : (
            <div className="stack">
              {view.pools.length > 0 && (
                <div className="tags" aria-label="Pools">
                  {view.pools.map((pool) => (
                    <span key={pool.name} className="tag">
                      {pool.name}: {pool.busy} of {pool.slots} busy{pool.queued ? `, ${pool.queued} queued` : ''}
                    </span>
                  ))}
                </div>
              )}
              <div className="table-wrap">
                <table className="table">
                  <caption className="visually-hidden">Runners</caption>
                  <thead>
                    <tr>
                      <th scope="col">Machine</th>
                      <th scope="col" className="hide-sm">Runs</th>
                      <th scope="col">Jobs</th>
                      <th scope="col" className="hide-sm">Pools</th>
                      <th scope="col" className="hide-sm">Dependency cache</th>
                      <th scope="col" className="num hide-sm">Use, 24 h</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.runners.map((r) => (
                      <tr key={r.machineId}>
                        <td>
                          <span className="cell-title mono">{r.name}</span>
                          <span className="cell-sub">
                            {r.os} {r.arch}
                            {r.status !== 'online' ? ` · ${r.status}` : ''}
                            {r.labels.length ? ` · ${r.labels.join(', ')}` : ''}
                          </span>
                          <span className="cell-sub show-sm">{MODE[r.mode]}</span>
                        </td>
                        <td className="hide-sm">{MODE[r.mode]}</td>
                        <td>
                          {r.maxJobs > 0 ? (
                            <span className="meter-cell">
                              <span className="tabular row">
                                {r.busy > 0 && <span className="dot" aria-hidden="true" />}
                                {r.busy > 0 ? `${r.busy} of ${r.maxJobs} busy` : `Idle, ${r.maxJobs} slots`}
                              </span>
                              <Meter value={r.busy} max={r.maxJobs} label={`${r.name} job slots`} />
                            </span>
                          ) : (
                            <span className="muted">No job slots</span>
                          )}
                        </td>
                        <td className="hide-sm">{r.pools.length ? r.pools.map((p) => `${p.name} ${p.busy}/${p.maxJobs}`).join(', ') : <span className="muted">—</span>}</td>
                        <td className="hide-sm">
                          {r.cache ? (
                            <span className="meter-cell">
                              <span className="tabular">
                                {formatBytes(r.cache.sizeBytes)} of {formatBytes(r.cache.maxBytes)}
                              </span>
                              <Meter value={r.cache.sizeBytes} max={r.cache.maxBytes} label={`${r.name} cache`} />
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td className="num hide-sm tabular">{r.maxJobs > 0 ? pct(r.utilisation) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        }
      </Async>
    </Panel>
  );
}

function FlakyPanel({ projectId, flaky }: { projectId: string; flaky: Resource<FlakyJob[]> }) {
  return (
    <Panel title="Flaky jobs">
      <Async resource={flaky} what="flaky jobs">
        {(list) =>
          list.length === 0 ? (
            <p className="muted">No job has both failed and passed at the same commit in the last 30 days.</p>
          ) : (
            <ul className="ci-flaky">
              {list.map((f) => (
                <li key={f.id} className="ci-flaky-row">
                  <div className="row-main">
                    <span className="row-title">
                      {f.pipeline} / {f.job}
                    </span>
                    <span className="row-meta">
                      Failed then passed at the same commit {f.occurrences === 1 ? 'once' : `${f.occurrences} times`}. Last at <Mono title={f.lastRevision}>{shortSha(f.lastRevision)}</Mono>, {relative(f.lastSeenAt)}.
                    </span>
                  </div>
                  <Link to="/projects/$projectId/ci/$runId" params={{ projectId, runId: f.lastRunId }} className="btn btn-ghost btn-sm">
                    Open run
                  </Link>
                </li>
              ))}
            </ul>
          )
        }
      </Async>
    </Panel>
  );
}

function StartDialog({ projectId, list, initial, onClose, onStarted }: { projectId: string; list: PipelineList; initial: string; onClose(): void; onStarted(): void }) {
  const { api } = useHub();
  const navigate = useNavigate();
  const [pipeline, setPipeline] = useState(initial);
  const [revision, setRevision] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pipelineId = useId();
  const revisionId = useId();
  const valid = revision === '' || /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(revision.trim());

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const run = await api.startCiRun({ projectId, pipeline, ...(revision.trim() ? { revision: revision.trim() } : {}) });
      onStarted();
      onClose();
      await navigate({ to: '/projects/$projectId/ci/$runId', params: { projectId, runId: run.id } });
    } catch (err) {
      setError(`The run did not start. ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Run a pipeline"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={start} busy={busy} disabled={!valid}>
            Run {pipeline}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Pipeline" htmlFor={pipelineId}>
          <select id={pipelineId} className="input" value={pipeline} onChange={(e) => setPipeline(e.target.value)}>
            {list.pipelines.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Commit"
          htmlFor={revisionId}
          hint={list.revision ? `Leave empty for the default branch head, ${shortSha(list.revision)}.` : 'A full commit SHA.'}
          error={valid ? error : 'Use a full 40 or 64 character commit SHA.'}
        >
          <input id={revisionId} className="input mono" value={revision} onChange={(e) => setRevision(e.target.value)} placeholder="Default branch head" spellCheck={false} autoComplete="off" />
        </Field>
      </div>
    </Dialog>
  );
}
