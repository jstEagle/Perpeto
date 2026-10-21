import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useHub, useResource } from '../app/hub-context';
import type { Workflow } from '../api/types';
import { Async, btn, Button, Dialog, Field, PageHeader, Panel } from '../components/ui';
import { StatusLabel, WorkflowStatusLabel } from '../components/status';
import { IconApproval, IconWorkflow } from '../components/icons';
import { ArchitectProgress, ArchitectPrompt } from '../workflow/architect';
import { TEMPLATES } from '../workflow/templates';
import { relative } from '../lib/format';

const PURPOSE: Record<Workflow['purpose'], string> = { build: 'Build', improve: 'Improve', maintain: 'Maintain', custom: 'Custom' };

export function WorkflowsPage() {
  const { projectId } = useParams({ from: '/projects/$projectId/workflows' });
  const navigate = useNavigate();
  const workflows = useResource((api) => api.listWorkflows(projectId), [projectId], (e) => e.subject.kind === 'workflow');
  const [following, setFollowing] = useState<string | null>(null);
  const [manual, setManual] = useState(false);

  const drafts = (workflows.data ?? []).filter((w) => w.status === 'draft');
  const hasWorkflows = (workflows.data ?? []).length > 0;

  return (
    <div className="page">
      <PageHeader title="Workflows" description="Describe how this project should be built. An agent drafts the workflow, you review it, then activate it." />

      {following && (
        <ArchitectProgress
          assignmentId={following}
          projectId={projectId}
          onDone={(workflowId, version) => void navigate({ to: '/projects/$projectId/workflows/$workflowId', params: { projectId, workflowId }, search: { version } })}
          onDismiss={() => setFollowing(null)}
        />
      )}

      <section className="card architect-card" aria-label="Ask the workflow architect">
        <ArchitectPrompt projectId={projectId} onStarted={setFollowing} title={hasWorkflows ? 'Describe a new workflow' : 'How should this project be built?'} />
        <div className="architect-foot">
          <span className="muted">Prefer to draw it yourself?</span>
          <button type="button" className="text-btn" onClick={() => setManual(true)}>
            Start from a template
          </button>
        </div>
      </section>

      {drafts.map((d) => (
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
                  {d.createdAt ? ` ${relative(d.createdAt)}` : ''}. The active version keeps running until you activate this one.
                </p>
              </div>
            </div>
            <div className="issue-actions">
              <Link to="/projects/$projectId/workflows/$workflowId" params={{ projectId, workflowId: d.id }} search={{ version: d.version }} className={btn('secondary')}>
                Review draft
              </Link>
            </div>
          </div>
        </section>
      ))}

      <Async resource={workflows} what="workflows">
        {(list) =>
          list.length > 0 && (
            <Panel title="Workflows in this project" actions={`${list.length}`}>
              <ul className="rows">
                {list.map((w) => (
                  <WorkflowRow key={w.id} workflow={w} projectId={projectId} />
                ))}
              </ul>
            </Panel>
          )
        }
      </Async>
      <ManualDialog open={manual} onClose={() => setManual(false)} projectId={projectId} />
    </div>
  );
}

function WorkflowRow({ workflow: w, projectId }: { workflow: Workflow; projectId: string }) {
  const versions = useResource((api) => api.listVersions(w.id), [w.id], (e) => e.subject.kind === 'workflow' && e.subject.id === w.id);
  const active = versions.data?.find((v) => v.status === 'active');
  const draft = versions.data?.find((v) => v.status === 'draft' && v.version > (active?.version ?? 0));
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
          {PURPOSE[w.purpose] !== w.name ? `${PURPOSE[w.purpose]} · ` : ''}
          {w.authoredBy?.kind === 'agent' ? 'Drafted by the workflow architect' : 'Drawn by you'} · {relative(w.createdAt)}
        </span>
      </span>
      <span className="row-end">
        {draft && <span className="chip-quiet">Draft v{draft.version}</span>}
        {active ? <WorkflowStatusLabel status="active" title={`Version ${active.version} is active`} /> : <StatusLabel tone="quiet">Not active</StatusLabel>}
        {active && <span className="tabular">v{active.version}</span>}
      </span>
    </li>
  );
}

function ManualDialog({ open, onClose, projectId }: { open: boolean; onClose(): void; projectId: string }) {
  const { api } = useHub();
  const navigate = useNavigate();
  const [template, setTemplate] = useState(TEMPLATES[0].purpose);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const t = TEMPLATES.find((x) => x.purpose === template)!;
    setBusy(true);
    setError(null);
    try {
      const wf = await api.createWorkflow(projectId, { name: name.trim() || t.name, purpose: t.purpose, graph: t.graph() });
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
      title="Build a workflow by hand"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="manual-workflow" busy={busy}>
            Open editor
          </Button>
        </>
      }
    >
      <form id="manual-workflow" className="form" onSubmit={create}>
        <fieldset className="template-options">
          <legend>Start from</legend>
          {TEMPLATES.map((t) => (
            <label key={t.purpose} className={`template-option ${template === t.purpose ? 'is-selected' : ''}`}>
              <input type="radio" name="template" value={t.purpose} checked={template === t.purpose} onChange={() => setTemplate(t.purpose)} />
              <span className="row-main">
                <span className="row-title">{t.name}</span>
                <span className="row-meta row-meta-wrap">{t.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Field label="Name" htmlFor="wf-name" hint="Defaults to the template name.">
          <input id="wf-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
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
