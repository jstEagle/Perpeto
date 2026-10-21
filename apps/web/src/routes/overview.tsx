import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useHub, useResource } from '../app/hub-context';
import type { Bottleneck, Goal, MergeEntry, MetricsSnapshot, Overview as OverviewData, Project, Run, Workflow } from '../api/types';
import { encodeGoals } from '../api/goals';
import { Async, Button, btn, Dialog, Disclosure, Empty, Field, Meter, Mono, PageHeader, Panel, Stat } from '../components/ui';
import { LiveDot, MergeStatusLabel, RunStatusLabel, StatusLabel } from '../components/status';
import { IconAlert, IconArrowRight, IconChevronRight, IconDoc, IconWorkflow } from '../components/icons';
import { bottleneckTitle, byUrgency } from '../run/issues';
import { BudgetLine, RunIntakeState } from '../run/intake';
import { intakeSummary } from '../run/budget';
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
  const overview = useResource((api) => api.overview(projectId), [projectId], (e) => e.projectId === projectId && (e.type.startsWith('assignment') || e.type.startsWith('run') || e.type.startsWith('budget.')));
  const week = useResource((api) => api.usage({ projectId, groupBy: 'day' }), [projectId], (e) => e.projectId === projectId && e.type === 'assignment.usage', { debounceMs: 2000, maxWaitMs: 10000 });
  const runs = useResource((api) => api.listRuns(projectId), [projectId], (e) => e.projectId === projectId && e.type.startsWith('run'));
  const workflows = useResource((api) => api.listWorkflows(projectId), [projectId], (e) => e.subject.kind === 'workflow');
  const metrics = useResource((api) => api.projectMetrics(projectId, '24h'), [projectId], (e) => e.projectId === projectId && !!e.runId, { debounceMs: 1500, maxWaitMs: 6000 });
  const queue = useResource((api) => api.mergeQueue(projectId), [projectId], (e) => e.projectId === projectId && e.subject.kind === 'merge-entry');
  const [editingGoals, setEditingGoals] = useState(false);

  const cutoff = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const tokens7d = week.data?.rows.filter((r) => r.key >= cutoff).reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  // The overview's runs carry intake and budget use; older hubs only list runs.
  const liveRuns = liveFirst(overview.data?.runs ?? runs.data?.filter((r) => r.status === 'running' || r.status === 'paused') ?? []);
  const activeRun = liveRuns[0];
  const noWorkflows = workflows.data && workflows.data.length === 0;

  return (
    <>
      <PageHeader
        title={project.name}
        description={
          <>
            <a className="mono row-link" href={project.repo.url} target="_blank" rel="noreferrer">
              {repoName(project.repo.url)}
            </a>{' '}
            on <Mono>{project.repo.defaultBranch}</Mono>
          </>
        }
        actions={
          activeRun ? (
            <Link to="/projects/$projectId/runs/$runId" params={{ projectId, runId: activeRun.id }} className={btn('primary')}>
              Open live map <IconArrowRight />
            </Link>
          ) : (
            noWorkflows === false && (
              <Link to="/projects/$projectId/workflows" params={{ projectId }} className={btn('primary')}>
                Start a run <IconArrowRight />
              </Link>
            )
          )
        }
      />

      {noWorkflows ? (
        <Panel>
          <Empty
            title="No workflows yet"
            icon={<IconWorkflow />}
            action={
              <Link to="/projects/$projectId/workflows" params={{ projectId }} className={btn('primary')}>
                Draft a workflow
              </Link>
            }
          >
            Describe how this project should be built. An architect agent drafts the workflow from your goals and docs, and you review it before anything runs.
          </Empty>
        </Panel>
      ) : (
        <LiveCard projectId={projectId} runs={liveRuns} workflows={workflows.data ?? []} overview={overview.data} metrics={metrics.data} tokens7d={tokens7d} />
      )}

      <div className="cols">
        <div className="stack">
          {activeRun && metrics.data && <AttentionCard projectId={projectId} runs={liveRuns} metrics={metrics.data} workflows={workflows.data ?? []} />}
          <GoalsCard project={project} onEdit={() => setEditingGoals(true)} />
        </div>
        <div className="stack">
          <Panel
            title="Runs"
            actions={
              <Link className="card-link" to="/projects/$projectId/runs" params={{ projectId }}>
                All <IconChevronRight />
              </Link>
            }
          >
            <Async resource={runs} what="runs">
              {(list) => (list.length === 0 ? <p className="muted">Activate a workflow, then start a run.</p> : <RunList runs={list.slice(0, 3)} projectId={projectId} workflows={workflows.data ?? []} />)}
            </Async>
          </Panel>
          <Panel
            title="Merge queue"
            actions={
              <Link className="card-link" to="/projects/$projectId/merge-queue" params={{ projectId }}>
                Open <IconChevronRight />
              </Link>
            }
          >
            <Async resource={queue} what="merge queue">
              {(entries) => <QueueHealth entries={entries} />}
            </Async>
          </Panel>
        </div>
      </div>

      <GoalsDialog open={editingGoals} onClose={() => setEditingGoals(false)} project={project} onSaved={onChanged} />
    </>
  );
}

/** Running before paused, newest first. */
function liveFirst(runs: Run[]): Run[] {
  return [...runs].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt.localeCompare(a.startedAt));
}

const workflowName = (workflows: Workflow[], id: string) => workflows.find((w) => w.id === id)?.name ?? 'Workflow';

/** What is live, three numbers, each live run with its budget, and the rest behind "More metrics". */
function LiveCard({ projectId, runs, workflows, overview, metrics, tokens7d }: { projectId: string; runs: Run[]; workflows: Workflow[]; overview?: OverviewData; metrics?: MetricsSnapshot; tokens7d?: number }) {
  const run = runs[0];
  const running = runs.filter((r) => r.status === 'running').length;
  const names = runs.map((r) => workflowName(workflows, r.workflowId));
  const title = !run
    ? 'Nothing is running'
    : runs.length === 1
      ? `${names[0]} run is ${run.status === 'running' ? 'live' : 'paused'}`
      : running === runs.length
        ? `${runs.length} workflows are live`
        : `${running} live, ${runs.length - running} paused`;
  const showRuns = runs.length > 1 || runs.some((r) => r.intake?.paused || (r.budget && Object.keys(r.budget).length));
  return (
    <section className="card live-card" aria-label="Live state">
      <div className="live-card-top">
        <div className="live-card-text">
          <h2 className="live-title">
            {running > 0 && <LiveDot />}
            {title}
          </h2>
          <p className="row-meta">
            {!run ? (
              'Start a run from an active workflow.'
            ) : runs.length === 1 ? (
              <>
                <Mono>{run.id}</Mono> · Workflow v{run.workflowVersion} · Started {relative(run.startedAt)}
              </>
            ) : (
              `${names.slice(0, -1).join(', ')} and ${names.at(-1)} run side by side`
            )}
          </p>
        </div>
        <dl className="metrics live-metrics" aria-live="polite">
          <Stat label="Agents working" value={overview?.activeAgents ?? '—'} />
          <Stat label="Queued work" value={overview?.queuedWork ?? '—'} />
          <Stat label="Tokens today" value={overview ? tokens(overview.tokensToday) : '—'} />
        </dl>
      </div>
      {showRuns && (
        <ul className="live-runs" aria-label="Live runs">
          {runs.map((r) => (
            <li key={r.id}>
              <span className="live-run-head">
                <Link to="/projects/$projectId/runs/$runId" params={{ projectId, runId: r.id }} className="row-title">
                  {workflowName(workflows, r.workflowId)}
                </Link>
                <RunIntakeState run={r} />
              </span>
              <span className="row-meta">{intakeSummary(r)}</span>
              <BudgetLine run={r} />
            </li>
          ))}
        </ul>
      )}
      <Disclosure summary="More metrics" className="live-more">
        <dl className="metrics metrics-small">
          <Stat label="Items done per day" value={metrics ? rate(metrics.run.velocity.itemsDonePerDay) : '—'} />
          <Stat label="Cycle time" value={metrics ? duration(metrics.run.cycleTimeSec.avg) : '—'} />
          <Stat label="Work in progress" value={metrics ? plural(metrics.run.wip, 'item') : '—'} />
          <Stat label="Tokens, 7 days" value={tokens7d !== undefined ? tokens(tokens7d) : '—'} />
        </dl>
      </Disclosure>
    </section>
  );
}

/** Project bottlenecks name their run; with several live runs each issue says which workflow it is in and links to that run. */
function AttentionCard({ projectId, runs, metrics, workflows }: { projectId: string; runs: Run[]; metrics: MetricsSnapshot; workflows: Workflow[] }) {
  const issues = byUrgency(metrics.bottlenecks.filter((b) => b.severity !== 'info'));
  const context = (b: Bottleneck) => {
    const run = runs.find((r) => r.id === b.runId) ?? runs[0];
    const workflow = workflows.find((w) => w.id === run.workflowId);
    // A newer draft of this run's own workflow, not some other workflow's draft.
    const draft = workflow && workflow.status === 'draft' && workflow.version > run.workflowVersion ? workflow : undefined;
    return { run, graph: workflow?.graph, draft, where: runs.length > 1 ? workflow?.name : undefined };
  };
  const issue = (b: Bottleneck, i: number, withDraft: boolean) => {
    const c = context(b);
    return <Issue key={`${b.runId ?? ''}-${b.nodeId}-${b.reason}-${i}`} projectId={projectId} run={c.run} nodeId={b.nodeId} title={bottleneckTitle(b, c.graph)} where={c.where} text={b.evidence} draft={withDraft ? c.draft : undefined} />;
  };
  return (
    <Panel title="Needs attention" actions={issues.length ? `${issues.length} open` : undefined}>
      {issues.length === 0 ? (
        <p className="muted">Nothing is holding work up.</p>
      ) : (
        <>
          {issue(issues[0], 0, true)}
          {issues.length > 1 && (
            <div className="card-foot">
              <Disclosure summary={issues.length === 2 ? '1 more issue' : `${issues.length - 1} more issues`}>{issues.slice(1).map((b, i) => issue(b, i + 1, false))}</Disclosure>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function Issue({ projectId, run, nodeId, title, where, text, draft }: { projectId: string; run: Run; nodeId: string; title: string; where?: string; text: string; draft?: Workflow }) {
  return (
    <div className="issue">
      <span className="issue-icon">
        <IconAlert />
      </span>
      <div className="issue-main">
        <h3 className="issue-title">{title}</h3>
        <p className="issue-text">
          {where ? `${where}: ` : ''}
          {sentence(text)}
          {draft ? ` Workflow v${draft.version} proposes a change.` : ''}
        </p>
        <div className="issue-actions">
          {draft && (
            <Link to="/projects/$projectId/workflows/$workflowId" params={{ projectId, workflowId: draft.id }} search={{ version: draft.version }} className={btn('secondary')}>
              Review proposal
            </Link>
          )}
          <Link to="/projects/$projectId/runs/$runId" params={{ projectId, runId: run.id }} search={{ node: nodeId }} className={btn('ghost')}>
            Show on map
          </Link>
        </div>
      </div>
    </div>
  );
}

/** Hub evidence arrives as a clause; make it a sentence before adding another. */
const sentence = (text: string) => {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t.charAt(0).toUpperCase()}${t.slice(1)}.`;
};

/** A goal with its progress: leaf work items done of those linked to it. */
function GoalRow({ goal }: { goal: Goal }) {
  return (
    <li className="meter-row">
      <span className="meter-row-head">
        <span>{goal.title}</span>
        {goal.status === 'done' ? (
          <StatusLabel tone="done">Done</StatusLabel>
        ) : goal.total ? (
          <span>
            {goal.done} of {goal.total}
          </span>
        ) : (
          <span>No work yet</span>
        )}
      </span>
      <Meter value={goal.status === 'done' ? 1 : goal.done} max={goal.status === 'done' ? 1 : Math.max(1, goal.total)} label={`${goal.title}: ${goal.done} of ${goal.total} work items done`} />
    </li>
  );
}

function GoalsCard({ project, onEdit }: { project: Project; onEdit(): void }) {
  return (
    <Panel
      title="Goals"
      actions={
        <button type="button" className="text-btn" onClick={onEdit}>
          {project.goals.length ? 'Edit' : 'Add goals'}
        </button>
      }
    >
      {project.goals.length === 0 ? (
        <p className="muted">Add a goal to start planning work. Planners and the workflow architect read them.</p>
      ) : (
        <>
          <ol className="rows goals">
            {project.goals
              .filter((g) => g.status !== 'dropped')
              .map((g) => (
                <GoalRow key={g.id} goal={g} />
              ))}
          </ol>
          {project.goals.some((g) => g.status === 'dropped') && (
            <div className="card-foot">
              <Disclosure summary={`Dropped · ${project.goals.filter((g) => g.status === 'dropped').length}`}>
                <ol className="rows">
                  {project.goals
                    .filter((g) => g.status === 'dropped')
                    .map((g) => (
                      <li key={g.id} className="muted">
                        {g.title}
                      </li>
                    ))}
                </ol>
              </Disclosure>
            </div>
          )}
        </>
      )}
      <div className="card-foot">
        <Disclosure summary={`Docs and requirements · ${project.docs.length}`}>
          {project.docs.length === 0 ? (
            <p className="muted">Agents plan from the repository alone until you add requirements or a spec.</p>
          ) : (
            <ul className="rows">
              {project.docs.map((d) => (
                <li key={d.id}>
                  <span className="tile tile-sm" aria-hidden="true">
                    <IconDoc />
                  </span>
                  <span className="row-main">
                    <span className="row-title">{d.title}</span>
                    <span className="row-meta mono">{d.path ?? d.url}</span>
                  </span>
                  <span className="row-end">{d.kind}</span>
                </li>
              ))}
            </ul>
          )}
        </Disclosure>
      </div>
    </Panel>
  );
}

function RunList({ runs, projectId, workflows }: { runs: Run[]; projectId: string; workflows: Workflow[] }) {
  return (
    <ul className="rows">
      {runs.map((r) => (
        <li key={r.id}>
          <span className="row-main">
            <Link to="/projects/$projectId/runs/$runId" params={{ projectId, runId: r.id }} className="row-title">
              {workflowName(workflows, r.workflowId)} <span className="mono muted">{r.id}</span>
            </Link>
            <span className="row-meta">
              v{r.workflowVersion} · {r.completedAt ? `completed ${relative(r.completedAt)}` : r.stoppedAt ? `ended ${relative(r.stoppedAt)}` : `started ${relative(r.startedAt)}`}
            </span>
          </span>
          <span className="row-end">
            <RunStatusLabel status={r.status} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function QueueHealth({ entries }: { entries: MergeEntry[] }) {
  if (entries.length === 0) return <p className="muted">Changes appear here after they pass their gates.</p>;
  const counts = (['testing', 'merging', 'queued', 'merged', 'rejected'] as const).map((s) => [s, entries.filter((e) => e.status === s).length] as const).filter(([, n]) => n > 0);
  return (
    <ul className="rows">
      {counts.map(([status, n]) => (
        <li key={status}>
          <MergeStatusLabel status={status} />
          <span className="row-end tabular">{n}</span>
        </li>
      ))}
    </ul>
  );
}

function GoalsDialog({ open, onClose, project, onSaved }: { open: boolean; onClose(): void; project: Project; onSaved(): void }) {
  const { api } = useHub();
  const [text, setText] = useState(project.goals.map((g) => g.title).join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const lines = text.split('\n').map((g) => g.trim()).filter(Boolean);
      await api.updateProject(project.id, { goals: encodeGoals(lines, project.goals) });
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
