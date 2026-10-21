import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useHub, useResource } from '../app/hub-context';
import type { Assignment, Run, Workflow, WorkflowPurpose } from '../api/types';
import { Async, btn, Button, Dialog, Field, PageHeader, Panel } from '../components/ui';
import { StatusLabel, WorkflowStatusLabel } from '../components/status';
import { IconApproval, IconArrowRight, IconPlay, IconWorkflow } from '../components/icons';
import { ArchitectProgress, ArchitectPrompt } from '../workflow/architect';
import { SuggestedList } from '../workflow/suggested';
import { blankTemplate, templateName } from '../workflow/templates';
import { BudgetLine, RunIntakeState, RunSettingsDialog } from '../run/intake';
import { intakeSummary } from '../run/budget';
import { relative } from '../lib/format';

const PURPOSES: WorkflowPurpose[] = ['build', 'improve', 'maintain', 'bugfix', 'docs', 'security-audit', 'dependency-upgrade'];
const purposeLabel = (p: WorkflowPurpose) => (p === 'custom' ? 'Custom' : templateName(p));
const isActive = (w: Workflow) => w.activeVersion !== undefined || w.status === 'active';

export function WorkflowsPage() {
  const { projectId } = useParams({ from: '/projects/$projectId/workflows' });
  const navigate = useNavigate();
  const workflows = useResource((api) => api.listWorkflows(projectId), [projectId], (e) => e.subject.kind === 'workflow');
  const runs = useResource((api) => api.listRuns(projectId), [projectId], (e) => e.projectId === projectId && e.type.startsWith('run'));
  const overview = useResource((api) => api.overview(projectId), [projectId], (e) => e.projectId === projectId && (e.type.startsWith('run') || e.type.startsWith('budget.') || e.type === 'assignment.usage'), { debounceMs: 1500, maxWaitMs: 6000 });
  const list = workflows.data ?? [];
  const drafts = list.filter((w) => w.status === 'draft');
  // The architect saves extra proposals as their own drafts; its assignment names which one is the answer.
  const architectIds = [...new Set(drafts.map((d) => (d.authoredBy?.kind === 'agent' ? d.authoredBy.assignmentId : undefined)).filter((id): id is string => !!id))];
  const architects = useResource(
    (api) => Promise.all(architectIds.map((id) => api.getAssignment(id).catch(() => null))),
    [architectIds.join(',')],
    (e) => e.subject.kind === 'workflow',
  );
  const [following, setFollowing] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [starting, setStarting] = useState<Workflow | null>(null);

  const primaryOf = new Map<string, Assignment>();
  for (const a of architects.data ?? []) if (a?.draftWorkflowId) primaryOf.set(a.id, a);
  const isSuggestion = (w: Workflow) => {
    const a = w.authoredBy?.assignmentId ? primaryOf.get(w.authoredBy.assignmentId) : undefined;
    return !!a && a.draftWorkflowId !== w.id;
  };
  const suggestionsFor = (assignmentId?: string) => (assignmentId ? drafts.filter((d) => d.authoredBy?.assignmentId === assignmentId && isSuggestion(d)) : []);
  const primaries = drafts.filter((d) => !isSuggestion(d));
  // Extra proposals whose answer was already activated or edited still deserve a look.
  const orphans = drafts.filter((d) => isSuggestion(d) && !primaries.some((p) => p.authoredBy?.assignmentId === d.authoredBy?.assignmentId));

  const active = list.filter(isActive);
  const others = list.filter((w) => !isActive(w) && w.status !== 'draft');
  const liveRuns = overview.data?.runs ?? runs.data?.filter((r) => r.status === 'running' || r.status === 'paused') ?? [];
  const runFor = (w: Workflow) => liveRuns.filter((r) => r.workflowId === w.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

  return (
    <div className="page">
      <PageHeader title="Workflows" description="Each workflow is one way of working. Several can be active at once; their runs share machines and the merge queue." />

      {following && (
        <ArchitectProgress
          assignmentId={following}
          projectId={projectId}
          onDone={(workflowId, version) => void navigate({ to: '/projects/$projectId/workflows/$workflowId', params: { projectId, workflowId }, search: { version } })}
          onDismiss={() => setFollowing(null)}
        />
      )}

      {primaries.map((d) => {
        const extra = suggestionsFor(d.authoredBy?.assignmentId);
        return (
          <section key={`${d.id}-${d.version}`} className="card" aria-label="Draft waiting for review">
            <div className="issue-card">
              <div className="issue">
                <span className="issue-icon">
                  <IconApproval />
                </span>
                <div className="issue-main">
                  <h2 className="issue-title">
                    {d.name} v{d.version} is waiting for review
                  </h2>
                  <p className="issue-text">
                    {d.authoredBy?.kind === 'agent' ? 'Proposed by the workflow architect' : 'Saved by you'}
                    {d.createdAt ? ` ${relative(d.createdAt)}` : ''}. {d.activeVersion ? 'The active version keeps running until you activate this one.' : 'Nothing runs until you activate it.'}
                  </p>
                </div>
              </div>
              <div className="issue-actions">
                <Link to="/projects/$projectId/workflows/$workflowId" params={{ projectId, workflowId: d.id }} search={{ version: d.version }} className={btn('secondary')}>
                  Review draft
                </Link>
              </div>
            </div>
            {extra.length > 0 && <SuggestedList projectId={projectId} workflows={extra} />}
          </section>
        );
      })}
      {orphans.length > 0 && (
        <section className="card" aria-label="Also suggested">
          <SuggestedList projectId={projectId} workflows={orphans} />
        </section>
      )}

      {active.length > 0 && (
        <section className="wf-active" aria-labelledby="wf-active-title">
          <h2 id="wf-active-title" className="section-title">
            Active workflows
          </h2>
          <div className="wf-grid">
            {active.map((w) => (
              <ActiveWorkflow key={w.id} workflow={w} run={runFor(w)} projectId={projectId} onStart={() => setStarting(w)} />
            ))}
          </div>
        </section>
      )}

      <section className="card architect-card" aria-label="Ask the workflow architect">
        <ArchitectPrompt projectId={projectId} onStarted={setFollowing} title={list.length ? 'Describe another workflow' : 'How should this project be built?'} />
        <div className="architect-foot">
          <span className="muted">Know what you want?</span>
          <button type="button" className="text-btn" onClick={() => setManual(true)}>
            Start from a template
          </button>
        </div>
      </section>

      <Async resource={workflows} what="workflows">
        {() =>
          others.length > 0 && (
            <Panel title="Not active" actions={`${others.length}`}>
              <ul className="rows">
                {others.map((w) => (
                  <WorkflowRow key={w.id} workflow={w} projectId={projectId} />
                ))}
              </ul>
            </Panel>
          )
        }
      </Async>
      <ManualDialog open={manual} onClose={() => setManual(false)} projectId={projectId} />
      {starting && (
        <RunSettingsDialog
          open
          onClose={() => setStarting(null)}
          target={{ kind: 'start', workflow: starting }}
          onDone={(run) => void navigate({ to: '/projects/$projectId/runs/$runId', params: { projectId, runId: run.id } })}
        />
      )}
    </div>
  );
}

/** One active workflow: its version, its live run with intake and budget, and the one next step. */
function ActiveWorkflow({ workflow: w, run, projectId, onStart }: { workflow: Workflow; run?: Run; projectId: string; onStart(): void }) {
  const version = w.activeVersion ?? w.version;
  const hasDraft = w.status === 'draft' && w.version > version;
  return (
    <article className="card wf-card" aria-label={`${w.name} workflow`}>
      <div className="wf-card-head">
        <span className="tile" aria-hidden="true">
          <IconWorkflow />
        </span>
        <span className="row-main">
          <Link to="/projects/$projectId/workflows/$workflowId" params={{ projectId, workflowId: w.id }} search={{}} className="card-title">
            {w.name}
          </Link>
          <span className="row-meta">
            {purposeLabel(w.purpose) !== w.name ? `${purposeLabel(w.purpose)} · ` : ''}Version {version}
          </span>
        </span>
        {hasDraft && <span className="chip-quiet">Draft v{w.version}</span>}
      </div>
      {run ? (
        <div className="wf-card-run">
          <RunIntakeState run={run} />
          <span className="row-meta">{intakeSummary(run)}</span>
          <BudgetLine run={run} />
        </div>
      ) : (
        <p className="muted wf-card-run">No run. Start one to put this workflow to work.</p>
      )}
      <div className="wf-card-foot">
        {run ? (
          <Link to="/projects/$projectId/runs/$runId" params={{ projectId, runId: run.id }} className={btn('secondary', 'sm')}>
            Open run <IconArrowRight />
          </Link>
        ) : (
          <Button size="sm" onClick={onStart}>
            <IconPlay /> Start run
          </Button>
        )}
      </div>
    </article>
  );
}

function WorkflowRow({ workflow: w, projectId }: { workflow: Workflow; projectId: string }) {
  return (
    <li>
      <span className="tile" aria-hidden="true">
        <IconWorkflow />
      </span>
      <span className="row-main">
        <Link to="/projects/$projectId/workflows/$workflowId" params={{ projectId, workflowId: w.id }} search={{}} className="row-title">
          {w.name}
        </Link>
        <span className="row-meta">
          {purposeLabel(w.purpose) !== w.name ? `${purposeLabel(w.purpose)} · ` : ''}
          {w.authoredBy?.kind === 'agent' ? 'Drafted by the workflow architect' : 'Drawn by you'}
          {w.createdAt ? ` · ${relative(w.createdAt)}` : ''}
        </span>
      </span>
      <span className="row-end">
        {w.status === 'paused' ? <WorkflowStatusLabel status="paused" /> : <StatusLabel tone="quiet">Not active</StatusLabel>}
        <span className="tabular">v{w.version}</span>
      </span>
    </li>
  );
}

const BLANK = 'blank';

/** The template library, each with its one-line description, plus a blank canvas. */
function ManualDialog({ open, onClose, projectId }: { open: boolean; onClose(): void; projectId: string }) {
  const { api } = useHub();
  const navigate = useNavigate();
  const templates = useResource((a) => (open ? a.listTemplates() : Promise.resolve(null)), [open]);
  const [template, setTemplate] = useState('build');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = [...(templates.data ?? []), { id: BLANK, description: 'An input and an output. Add the rest yourself.', graph: blankTemplate() }];
  const chosen = options.find((t) => t.id === template) ?? options[0];
  const label = (id: string) => (id === BLANK ? 'Blank' : templateName(id));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const purpose = (PURPOSES as string[]).includes(chosen.id) ? (chosen.id as WorkflowPurpose) : 'custom';
      const wf = await api.createWorkflow(projectId, { name: name.trim() || label(chosen.id), purpose, graph: structuredClone(chosen.graph) });
      onClose();
      await navigate({ to: '/projects/$projectId/workflows/$workflowId/edit', params: { projectId, workflowId: wf.id } });
    } catch (err) {
      setError(`Workflow was not created. ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Start from a template"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="manual-workflow" busy={busy} disabled={!templates.data}>
            Open editor
          </Button>
        </>
      }
    >
      <form id="manual-workflow" className="form" onSubmit={create}>
        <Async resource={templates} what="templates">
          {() => (
            <fieldset className="template-options">
              <legend className="visually-hidden">Template</legend>
              {options.map((t) => (
                <label key={t.id} className={`template-option ${chosen.id === t.id ? 'is-selected' : ''}`}>
                  <input type="radio" name="template" value={t.id} checked={chosen.id === t.id} onChange={() => setTemplate(t.id)} />
                  <span className="row-main">
                    <span className="row-title">{label(t.id)}</span>
                    <span className="row-meta row-meta-wrap">{t.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
        </Async>
        <Field label="Name" htmlFor="wf-name" hint="Defaults to the template name.">
          <input id="wf-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={label(chosen.id)} autoComplete="off" />
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
