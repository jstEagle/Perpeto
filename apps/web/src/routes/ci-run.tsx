import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { useHub, useResource } from '../app/hub-context';
import { Async, Button, Mono, PageHeader, Panel } from '../components/ui';
import { JobLog, PipelineJobStatusLabel, PipelineRunStatusChip, pipelineJobTone, usePoll } from '../components/ci';
import { StatusIcon } from '../components/status';
import { IconChevronRight } from '../components/icons';
import { dagColumns, formatBytes, formatMs, isRunActive, jobElapsedMs, matrixLabel, runElapsedMs, TRIGGER_LABEL } from '../api/ci';
import type { ArtifactRef, PipelineRun, PipelineRunJob } from '../api/ci';
import { dateTime, relative, shortSha } from '../lib/format';

export function CiRunPage() {
  const { projectId, runId } = useParams({ from: '/projects/$projectId/ci/$runId' });
  const { api } = useHub();
  const run = useResource((a) => a.ciRun(runId), [runId], (e) => e.subject.id === runId || e.type.startsWith('job'));
  const runners = useResource((a) => a.ciRunners(), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  usePoll(run.reload, Boolean(run.data && isRunActive(run.data)));
  const machineName = (id?: string) => (id ? runners.data?.runners.find((r) => r.machineId === id)?.name ?? id : undefined);

  async function act(kind: 'cancel' | 'retry', job?: string) {
    setBusy(job ? `retry:${job}` : kind);
    setError(null);
    try {
      if (kind === 'cancel') await api.cancelCiRun(runId);
      else await api.retryCiRun(runId, job);
      run.reload();
    } catch (err) {
      setError(`${kind === 'cancel' ? 'The run was not cancelled' : 'Nothing was retried'}. ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page">
      <Async resource={run} what="the pipeline run">
        {(value) => {
          const active = isRunActive(value);
          const failedJobs = value.jobs.filter((j) => ['failed', 'error', 'cancelled'].includes(j.status));
          const current = value.jobs.find((j) => j.key === selected) ?? pickJob(value);
          return (
            <>
              <PageHeader
                back={{ label: 'CI', to: '/projects/$projectId/ci', params: { projectId } }}
                title={value.pipeline}
                status={<PipelineRunStatusChip status={value.status} />}
                meta={
                  <span className="ci-run-meta">
                    <span>
                      <Mono title={value.revision}>{shortSha(value.revision)}</Mono>
                      {value.ref && (
                        <>
                          {' '}
                          on <Mono>{value.ref}</Mono>
                        </>
                      )}
                    </span>
                    <span>{TRIGGER_LABEL[value.trigger.kind] ?? value.trigger.kind}</span>
                    <span title={dateTime(value.createdAt)}>Started {relative(value.startedAt ?? value.createdAt)}</span>
                    <span className="tabular">{active ? `${formatMs(runElapsedMs(value))} so far` : formatMs(runElapsedMs(value))}</span>
                  </span>
                }
                actions={
                  <>
                    {!active && failedJobs.length > 0 && (
                      <Button onClick={() => act('retry')} busy={busy === 'retry'}>
                        Retry failed jobs
                      </Button>
                    )}
                    {active && (
                      <Button onClick={() => act('cancel')} busy={busy === 'cancel'}>
                        Cancel run
                      </Button>
                    )}
                  </>
                }
              />
              {error && <p className="field-error" role="alert">{error}</p>}
              {value.supersededBy && <p className="muted">A newer run for the same ref replaced this one.</p>}
              {value.reason && value.status !== 'passed' && <p className="muted">{value.reason}</p>}

              <Panel title="Jobs">
                <JobGraph run={value} selected={current?.key ?? null} onSelect={setSelected} machineName={machineName} />
              </Panel>

              {current && (
                <JobDetail
                  key={current.key}
                  job={current}
                  machineName={machineName}
                  onRetry={!isRunActive(value) && ['failed', 'error', 'cancelled'].includes(current.status) ? () => act('retry', current.key) : undefined}
                  retrying={busy === `retry:${current.key}`}
                />
              )}
            </>
          );
        }}
      </Async>
    </div>
  );
}

/** The job to open first: one running now, else the first failure, else the first job. */
function pickJob(run: PipelineRun): PipelineRunJob | undefined {
  return (
    run.jobs.find((j) => j.status === 'running') ??
    run.jobs.find((j) => j.status === 'failed' || j.status === 'error') ??
    run.jobs.find((j) => j.jobId) ??
    run.jobs[0]
  );
}

function JobGraph({ run, selected, onSelect, machineName }: { run: PipelineRun; selected: string | null; onSelect(key: string): void; machineName(id?: string): string | undefined }) {
  const columns = dagColumns(run.jobs);
  return (
    <div className="ci-dag" role="list" aria-label="Jobs by stage">
      {columns.map((column, i) => (
        <div className="ci-dag-stage" key={i} role="listitem">
          {i > 0 && (
            <span className="ci-dag-arrow" aria-hidden="true">
              <IconChevronRight size={16} />
            </span>
          )}
          <ul className="ci-dag-column" aria-label={i === 0 ? 'First stage' : `After ${columns[i - 1].map((j) => j.key).join(', ')}`}>
            {column.map((job) => {
              const elapsed = jobElapsedMs(job);
              const tone = pipelineJobTone(job.status);
              return (
                <li key={job.key}>
                  <button
                    type="button"
                    className={`ci-job ci-job-${tone}`}
                    aria-pressed={job.key === selected}
                    onClick={() => onSelect(job.key)}
                  >
                    <span className="ci-job-head">
                      <StatusIcon tone={tone} />
                      <span className="ci-job-name">{job.name}</span>
                      {job.flaky && <span className="tag">Flaky</span>}
                    </span>
                    {job.matrix && <span className="ci-job-matrix">{matrixLabel(job.matrix)}</span>}
                    <span className="ci-job-meta tabular">
                      <PipelineJobStatusLabel status={job.status} />
                      {elapsed !== undefined && <span>{formatMs(elapsed)}</span>}
                    </span>
                    {(job.machineId || job.attempt > 1) && (
                      <span className="ci-job-meta">
                        {job.machineId && <span className="mono">{machineName(job.machineId)}</span>}
                        {job.attempt > 1 && <span>attempt {job.attempt}</span>}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function JobDetail({ job, machineName, onRetry, retrying }: { job: PipelineRunJob; machineName(id?: string): string | undefined; onRetry?: () => void; retrying: boolean }) {
  const title = job.matrix ? `${job.name}, ${matrixLabel(job.matrix)}` : job.name;
  return (
    <Panel
      title={title}
      actions={
        onRetry && (
          <Button size="sm" onClick={onRetry} busy={retrying}>
            Retry this job
          </Button>
        )
      }
    >
      <dl className="ci-facts">
        <div>
          <dt>Status</dt>
          <dd>
            <PipelineJobStatusLabel status={job.status} />
          </dd>
        </div>
        <div>
          <dt>Runner</dt>
          <dd className="mono">{machineName(job.machineId) ?? '—'}</dd>
        </div>
        <div>
          <dt>Waited in queue</dt>
          <dd className="tabular">{formatMs(job.queueWaitMs)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd className="tabular">{formatMs(jobElapsedMs(job))}</dd>
        </div>
        <div>
          <dt>Pool</dt>
          <dd>
            {job.runsOn.pool ?? 'Any pool'}
            {job.runsOn.os ? `, ${job.runsOn.os}` : ''}
            {job.runsOn.labels.length ? `, ${job.runsOn.labels.join(', ')}` : ''}
          </dd>
        </div>
        <div>
          <dt>Attempt</dt>
          <dd className="tabular">
            {job.attempt} of {job.maxAttempts}
          </dd>
        </div>
      </dl>

      {job.cache && job.cache.length > 0 && (
        <div className="ci-section">
          <h3 className="ci-section-title">Dependency cache</h3>
          <ul className="ci-plain">
            {job.cache.map((c) => (
              <li key={c.key} className="row">
                <StatusIcon tone={c.hit ? 'done' : 'quiet'} />
                <span>{c.hit ? 'Restored' : 'Not cached yet, saved after a pass'}</span>
                <Mono>{c.key}</Mono>
              </li>
            ))}
          </ul>
        </div>
      )}

      {job.attempts.length > 1 && (
        <div className="ci-section">
          <h3 className="ci-section-title">Attempts</h3>
          <ul className="ci-plain">
            {job.attempts.map((a, i) => (
              <li key={a.jobId} className="row">
                <PipelineJobStatusLabel status={a.status} />
                <span>Attempt {i + 1}</span>
                {a.machineId && <span className="mono muted">{machineName(a.machineId)}</span>}
                {a.startedAt && a.finishedAt && <span className="muted tabular">{formatMs(Date.parse(a.finishedAt) - Date.parse(a.startedAt))}</span>}
              </li>
            ))}
          </ul>
          {job.flaky && <p className="muted">This job failed and then passed at the same commit, so it is marked flaky.</p>}
        </div>
      )}

      {job.jobId && <Artifacts jobId={job.jobId} known={job.artifacts} />}

      <div className="ci-section">
        <h3 className="ci-section-title">Log</h3>
        {job.jobId ? <JobLog jobId={job.jobId} status={job.status} /> : <p className="muted">{job.status === 'skipped' ? 'Skipped because a job it needs did not pass.' : 'This job starts once the jobs it needs pass.'}</p>}
      </div>
    </Panel>
  );
}

function Artifacts({ jobId, known }: { jobId: string; known?: ArtifactRef[] }) {
  const { api } = useHub();
  const artifacts = useResource((a) => a.ciArtifacts(jobId), [jobId]);
  const [error, setError] = useState<string | null>(null);
  const list = artifacts.data ?? known ?? [];
  if (!list.length) return null;

  async function download(id: string, path: string) {
    setError(null);
    try {
      const blob = await api.ciArtifact(jobId, id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = path.split('/').pop() || id;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(`The artifact did not download. ${(err as Error).message}`);
    }
  }

  return (
    <div className="ci-section">
      <h3 className="ci-section-title">Artifacts</h3>
      <ul className="ci-plain">
        {list.map((a) => (
          <li key={a.id} className="row ci-artifact">
            <span className="mono">{a.path}</span>
            <span className="muted tabular">{formatBytes(a.size)}</span>
            <Button size="sm" variant="ghost" onClick={() => download(a.id, a.path)}>
              Download
            </Button>
          </li>
        ))}
      </ul>
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}
