import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useHub, useResource } from '../app/hub-context';
import type { MergeEntry, Project, Run } from '../api/types';
import { Async, Button, Dialog, Empty, Field, Mono, PageHeader, Panel, Stat } from '../components/ui';
import { MergeStatusLabel, RunStatusLabel, StatusLabel } from '../components/status';
import { IconArrowRight } from '../components/icons';
import { BOTTLENECK_LABEL } from '../workflow/step-node';
import { duration, plural, rate, relative, repoName, tokens } from '../lib/format';

export function OverviewPage() {
  const { projectId } = useParams({ from: '/projects/$projectId/' });
  const project = useResource((api) => api.getProject(projectId), [projectId], (e) => e.subject.kind === 'project' && e.subject.id === projectId);
  return (
    <div className="page">
      <Async resource={project} what="project">
        {(p) => <Overview project={p} onChanged={project.reload} />}
      </Async>
    </div>
  );
}

function Overview({ project, onChanged }: { project: Project; onChanged(): void }) {
  const projectId = project.id;
  const overview = useResource((api) => api.overview(projectId), [projectId], (e) => e.projectId === projectId && (e.type.startsWith('assignment') || e.type.startsWith('run')));
  const week = useResource((api) => api.usage({ projectId, groupBy: 'day' }), [projectId]);
  const runs = useResource((api) => api.listRuns(projectId), [projectId], (e) => e.projectId === projectId && e.type.startsWith('run'));
  const workflows = useResource((api) => api.listWorkflows(projectId), [projectId], (e) => e.subject.kind === 'workflow');
  const metrics = useResource((api) => api.projectMetrics(projectId, '24h'), [projectId], (e) => e.projectId === projectId && e.type.startsWith('gate'));
  const queue = useResource((api) => api.mergeQueue(projectId), [projectId], (e) => e.subject.kind === 'merge');
  const [editingGoals, setEditingGoals] = useState(false);

  const cutoff = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const tokens7d = week.data?.rows.filter((r) => r.key >= cutoff).reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  const activeRun = runs.data?.find((r) => r.status === 'running') ?? runs.data?.find((r) => r.status === 'paused');
  const bottleneck = metrics.data?.bottlenecks.slice().sort((a, b) => ['critical', 'warning', 'info'].indexOf(a.severity) - ['critical', 'warning', 'info'].indexOf(b.severity))[0];
  const draft = workflows.data?.find((w) => w.status === 'draft');
  const noWorkflows = workflows.data && workflows.data.length === 0;

  return (
    <>
      <PageHeader
        title={project.name}
        description={
          <>
            <a className="link mono" href={project.repo.url} target="_blank" rel="noreferrer">
              {repoName(project.repo.url)}
            </a>{' '}
            on <Mono>{project.repo.defaultBranch}</Mono>
          </>
        }
        actions={
          activeRun ? (
            <Link to="/projects/$projectId/runs/$runId" params={{ projectId, runId: activeRun.id }} className="btn btn-primary btn-md">
              Open live map <IconArrowRight />
            </Link>
          ) : (
            !noWorkflows && (
              <Link to="/projects/$projectId/workflows" params={{ projectId }} className="btn btn-secondary btn-md">
                Workflows
              </Link>
            )
          )
        }
      />

      <dl className="stats" aria-live="polite">
        <Stat label="Agents working" value={overview.data?.activeAgents ?? '—'} detail={activeRun ? 'in the active run' : undefined} />
        <Stat label="Queued work" value={overview.data?.queuedWork ?? '—'} detail="items" />
        <Stat label="Tokens today" value={overview.data ? tokens(overview.data.tokensToday) : '—'} detail="input and output" />
        <Stat label="Tokens, 7 days" value={tokens7d !== undefined ? tokens(tokens7d) : '—'} />
      </dl>

      {noWorkflows && (
        <Panel title="Describe how this project should be built">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <p className="muted">A workflow architect agent drafts the workflow from your goals and docs. You review it before anything runs.</p>
            <Link to="/projects/$projectId/workflows" params={{ projectId }} className="btn btn-primary btn-md">
              Draft a workflow
            </Link>
          </div>
        </Panel>
      )}

      {(bottleneck || metrics.data) && activeRun && (
        <div className="grid-2">
          <Panel title="Top bottleneck" actions={<Link className="link" to="/projects/$projectId/runs/$runId" params={{ projectId, runId: activeRun.id }}>Show on map</Link>}>
            {bottleneck ? (
              <div className="stack-sm">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="bottleneck-name">{workflows.data?.flatMap((w) => w.graph.nodes).find((n) => n.id === bottleneck.nodeId)?.label ?? bottleneck.nodeId}</span>
                  <StatusLabel tone={bottleneck.severity === 'critical' ? 'error' : bottleneck.severity === 'warning' ? 'warning' : 'neutral'}>{BOTTLENECK_LABEL[bottleneck.reason]}</StatusLabel>
                </div>
                <p>{bottleneck.evidence}</p>
                {draft && (
                  <p className="note">
                    {draft.name} version {draft.version} proposes a change.{' '}
                    <Link className="link" to="/projects/$projectId/workflows/$workflowId" params={{ projectId, workflowId: draft.id }} search={{ version: draft.version }}>
                      Review the proposal
                    </Link>
                  </p>
                )}
              </div>
            ) : (
              <p className="muted">Nothing is holding work up.</p>
            )}
          </Panel>
          <Panel title="Velocity" actions={<span className="note">Last 24 h</span>}>
            {metrics.data && (
              <dl className="kv kv-figures">
                <dt>Items done per day</dt>
                <dd>
                  <span className="figure-lg">{rate(metrics.data.run.velocity.itemsDonePerDay)}</span>
                  {metrics.data.run.velocity.trend.length > 1 && <TrendNote trend={metrics.data.run.velocity.trend} />}
                </dd>
                <dt>Cycle time</dt>
                <dd>
                  {duration(metrics.data.run.cycleTimeSec.avg)} avg · {duration(metrics.data.run.cycleTimeSec.p90)} p90
                </dd>
                <dt>Work in progress</dt>
                <dd>{plural(metrics.data.run.wip, 'item')}</dd>
                <dt>Tokens per item</dt>
                <dd>{tokens(metrics.data.run.tokensPerItem)}</dd>
              </dl>
            )}
          </Panel>
        </div>
      )}

      <div className="grid-2">
        <Panel title="Goals" actions={<Button size="sm" variant="ghost" onClick={() => setEditingGoals(true)}>Edit goals</Button>} flush>
          {project.goals.length === 0 ? (
            <Empty title="No goals yet." action={<Button variant="primary" onClick={() => setEditingGoals(true)}>Add a goal</Button>}>
              Add a goal to start planning work.
            </Empty>
          ) : (
            <ol className="ruled-list goals">
              {project.goals.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ol>
          )}
        </Panel>
        <Panel title="Docs and requirements" flush>
          {project.docs.length === 0 ? (
            <Empty title="No docs attached.">Agents plan from the repository alone until you add requirements or a spec.</Empty>
          ) : (
            <ul className="ruled-list">
              {project.docs.map((d) => (
                <li key={d.id} className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="cell-stack">
                    <span>{d.title}</span>
                    <Mono>{d.path ?? d.url}</Mono>
                  </span>
                  <span className="tag">{d.kind}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="grid-2">
        <Panel title="Runs" actions={<Link className="link" to="/projects/$projectId/runs" params={{ projectId }}>All runs</Link>} flush>
          <Async resource={runs} what="runs">
            {(list) => (list.length === 0 ? <Empty title="No runs yet.">Activate a workflow, then start a run.</Empty> : <RunList runs={list.slice(0, 4)} projectId={projectId} />)}
          </Async>
        </Panel>
        <Panel title="Merge queue" actions={<Link className="link" to="/projects/$projectId/merge-queue" params={{ projectId }}>Open queue</Link>} flush>
          <Async resource={queue} what="merge queue">
            {(entries) => <QueueHealth entries={entries} />}
          </Async>
        </Panel>
      </div>

      <GoalsDialog open={editingGoals} onClose={() => setEditingGoals(false)} project={project} onSaved={onChanged} />
    </>
  );
}


function TrendNote({ trend }: { trend: number[] }) {
  const prev = trend.slice(0, -1);
  const avg = prev.reduce((a, b) => a + b, 0) / prev.length;
  const last = trend.at(-1)!;
  const diff = last - avg;
  return (
    <span className="note">
      {' '}
      · today {last}, {Math.abs(diff) < 0.5 ? 'level with' : diff > 0 ? `${rate(diff)} above` : `${rate(-diff)} below`} the {prev.length}-day average
    </span>
  );
}

function RunList({ runs, projectId }: { runs: Run[]; projectId: string }) {
  return (
    <ul className="ruled-list">
      {runs.map((r) => (
        <li key={r.id} className="row" style={{ justifyContent: 'space-between' }}>
          <Link to="/projects/$projectId/runs/$runId" params={{ projectId, runId: r.id }} className="link mono">
            {r.id}
          </Link>
          <span className="row" style={{ gap: 16 }}>
            <span className="note">v{r.workflowVersion} · {relative(r.startedAt)}</span>
            <RunStatusLabel status={r.status} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function QueueHealth({ entries }: { entries: MergeEntry[] }) {
  if (entries.length === 0) return <Empty title="The merge queue is empty.">Changes appear here after they pass their gates.</Empty>;
  const counts = (['queued', 'testing', 'merging', 'merged', 'rejected'] as const).map((s) => [s, entries.filter((e) => e.status === s).length] as const);
  return (
    <ul className="ruled-list">
      {counts.map(([status, n]) => (
        <li key={status} className="row" style={{ justifyContent: 'space-between' }}>
          <MergeStatusLabel status={status} />
          <span className="tabular">{n}</span>
        </li>
      ))}
    </ul>
  );
}

function GoalsDialog({ open, onClose, project, onSaved }: { open: boolean; onClose(): void; project: Project; onSaved(): void }) {
  const { api } = useHub();
  const [text, setText] = useState(project.goals.join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateProject(project.id, { goals: text.split('\n').map((g) => g.trim()).filter(Boolean) });
      onSaved();
      onClose();
    } catch (err) {
      setError(`Goals were not saved. ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Project goals"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="goals-form" busy={busy}>
            Save goals
          </Button>
        </>
      }
    >
      <form id="goals-form" className="form" onSubmit={save}>
        <Field label="Goals" htmlFor="goals-text" hint="One per line. Planners and the workflow architect read these.">
          <textarea id="goals-text" className="input" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
