import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useHub, useResource } from '../app/hub-context';
import type { Workflow } from '../api/types';
import { Async, Button, Dialog, Field, PageHeader, Panel } from '../components/ui';
import { WorkflowStatusLabel } from '../components/status';
import { IconChevronRight } from '../components/icons';
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
      <PageHeader title="Workflows" description="An agent drafts each workflow from your description. You review the graph, then activate it. Edit by hand whenever you want." />

      {drafts.map((d) => (
        <div key={`${d.id}-${d.version}`} className="callout callout-info">
          <div className="callout-body">
            <span className="callout-title">
              {d.name} version {d.version} is waiting for review
            </span>
            <span className="muted">
              {d.authoredBy?.kind === 'agent' ? 'Proposed by an agent' : 'Saved by you'} {relative(d.createdAt)}. The active version keeps running until you activate this one.
            </span>
          </div>
          <Link to="/projects/$projectId/workflows/$workflowId" params={{ projectId, workflowId: d.id }} search={{ version: d.version }} className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }}>
            Review draft
          </Link>
        </div>
      ))}

      {following && (
        <ArchitectProgress
          assignmentId={following}
          projectId={projectId}
          onDone={(workflowId, version) => void navigate({ to: '/projects/$projectId/workflows/$workflowId', params: { projectId, workflowId }, search: { version } })}
          onDismiss={() => setFollowing(null)}
        />
      )}

      <section className={`panel architect-panel ${hasWorkflows ? '' : 'architect-panel-primary'}`} aria-label="Ask the workflow architect">
        <div className="panel-body">
          <ArchitectPrompt projectId={projectId} onStarted={setFollowing} title={hasWorkflows ? 'Describe a new workflow' : 'Describe how this project should be built'} />
        </div>
        <div className="panel-footer">
          <span className="muted">Prefer to draw it yourself?</span>
          <button type="button" className="chip-button" onClick={() => setManual(true)}>
            Start from a template or a blank canvas
          </button>
        </div>
      </section>

      <Async resource={workflows} what="workflows">
        {(list) =>
          list.length > 0 && (
            <Panel title="Workflows in this project" flush>
              <div className="table-wrap">
                <table className="table table-rows-link">
                  <thead>
                    <tr>
                      <th scope="col">Workflow</th>
                      <th scope="col">Latest version</th>
                      <th scope="col" className="hide-sm">Authored by</th>
                      <th scope="col" className="hide-sm">Saved</th>
                      <th scope="col" className="col-chevron"><span className="visually-hidden">Open</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((w) => (
                      <tr key={w.id}>
                        <td>
                          <Link to="/projects/$projectId/workflows/$workflowId" params={{ projectId, workflowId: w.id }} search={{}} className="row-link">
                            <span className="cell-title">{w.name}</span>
                          </Link>
                          <span className="muted">{PURPOSE[w.purpose]}</span>
                        </td>
                        <td>
                          <div className="cell-stack">
                            <span className="mono">v{w.version}</span>
                            <WorkflowStatusLabel status={w.status} />
                          </div>
                        </td>
                        <td className="hide-sm">{w.authoredBy?.kind === 'agent' ? 'Workflow architect' : 'You'}</td>
                        <td className="hide-sm muted">{relative(w.createdAt)}</td>
                        <td className="col-chevron" aria-hidden="true">
                          <IconChevronRight />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )
        }
      </Async>
      <ManualDialog open={manual} onClose={() => setManual(false)} projectId={projectId} />
    </div>
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
        <fieldset className="fieldset">
          <legend>Start from</legend>
          {TEMPLATES.map((t) => (
            <label key={t.purpose} className={`template-option ${template === t.purpose ? 'is-selected' : ''}`}>
              <input type="radio" name="template" value={t.purpose} checked={template === t.purpose} onChange={() => setTemplate(t.purpose)} />
              <span>
                <span className="cell-title">{t.name}</span>
                <span className="muted">{t.description}</span>
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
