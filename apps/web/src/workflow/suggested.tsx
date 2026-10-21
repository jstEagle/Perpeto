import { Link } from '@tanstack/react-router';
import { useResource } from '../app/hub-context';
import type { Workflow } from '../api/types';
import { btn } from '../components/ui';
import { templateName } from './templates';

/**
 * The architect's additional proposals: each is its own draft workflow,
 * reviewed and activated on its own.
 */
export function SuggestedList({ projectId, workflows, title = 'Also suggested' }: { projectId: string; workflows: Workflow[]; title?: string }) {
  if (!workflows.length) return null;
  return (
    <div className="suggested">
      <h3 className="suggested-title">{title}</h3>
      <ul className="rows">
        {workflows.map((w) => (
          <li key={w.id}>
            <span className="row-main">
              <span className="row-title">
                {w.name}
                {w.templateId && templateName(w.templateId) !== w.name && <span className="muted"> · from {templateName(w.templateId)}</span>}
              </span>
              {w.rationale && <span className="row-meta row-meta-wrap suggested-why">{w.rationale}</span>}
            </span>
            <span className="row-end">
              <Link to="/projects/$projectId/workflows/$workflowId" params={{ projectId, workflowId: w.id }} search={{ version: w.version }} className={btn('ghost', 'sm')}>
                Review
              </Link>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** On a proposal: the other drafts the same architect answer saved. */
export function AlsoSuggested({ projectId, workflow }: { projectId: string; workflow: Workflow }) {
  const assignmentId = workflow.authoredBy?.kind === 'agent' ? workflow.authoredBy.assignmentId : undefined;
  const others = useResource(
    async (api) => {
      if (!assignmentId) return [];
      const assignment = await api.getAssignment(assignmentId).catch(() => null);
      const ids = (assignment?.drafts ?? []).map((d) => d.workflowId).filter((id) => id !== workflow.id);
      if (!ids.length) return [];
      const all = await api.listWorkflows(projectId);
      return all.filter((w) => ids.includes(w.id) && w.status === 'draft');
    },
    [assignmentId, workflow.id, projectId],
    (e) => e.subject.kind === 'workflow',
  );
  if (!others.data?.length) return null;
  return (
    <section className="card" aria-label="Also suggested">
      <SuggestedList projectId={projectId} workflows={others.data} title="The architect also suggested" />
    </section>
  );
}
