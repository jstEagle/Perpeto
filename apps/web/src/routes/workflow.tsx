import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useHub, useResource } from '../app/hub-context';
import type { GraphDiff, Workflow } from '../api/types';
import { Async, Button, PageHeader, Panel } from '../components/ui';
import { StatusLabel, WorkflowStatusLabel } from '../components/status';
import { IconEdit, IconPlay } from '../components/icons';
import { EdgeLegend, GraphCanvas } from '../workflow/graph-canvas';
import type { Selection } from '../workflow/graph-canvas';
import { diffGraphs, diffIsEmpty } from '../workflow/diff';
import { validateGraph } from '../workflow/validate';
import { ArchitectProgress, ArchitectPrompt } from '../workflow/architect';
import { NODE_SPECS } from '../workflow/registry';
import { dateTime, relative } from '../lib/format';

export function WorkflowPage() {
  const { projectId, workflowId } = useParams({ from: '/projects/$projectId/workflows/$workflowId' });
  const search = useSearch({ from: '/projects/$projectId/workflows/$workflowId' });
  const versions = useResource((api) => api.listVersions(workflowId), [workflowId], (e) => e.subject.kind === 'workflow' && e.subject.id === workflowId);

  return (
    <div className="page page-wide">
      <Async resource={versions} what="workflow versions">
        {(list) => <WorkflowDetail projectId={projectId} versions={list} requested={search.version} follow={search.follow} reload={versions.reload} />}
      </Async>
    </div>
  );
}

function WorkflowDetail({ projectId, versions, requested, follow, reload }: { projectId: string; versions: Workflow[]; requested?: number; follow?: string; reload(): void }) {
  const { api } = useHub();
  const navigate = useNavigate();
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const active = sorted.find((v) => v.status === 'active');
  const latest = sorted[0];
  const viewing = sorted.find((v) => v.version === requested) ?? (latest.status === 'draft' ? latest : (active ?? latest));
  const isProposal = viewing.status === 'draft';
  const base = isProposal ? (active ?? sorted.find((v) => v.version === viewing.parentVersion)) : undefined;
  const [selection, setSelection] = useState<Selection>(null);
  const [asking, setAsking] = useState(false);
  const [activating, setActivating] = useState(false);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const diff: GraphDiff | undefined = useMemo(() => (base && base.version !== viewing.version ? diffGraphs(base.graph, viewing.graph) : undefined), [base, viewing]);
  // The hub's engine is the authority on validity; the local check covers the moment before it answers.
  const local = useMemo(() => validateGraph(viewing.graph), [viewing]);
  const checked = useResource((a) => a.validateWorkflow(viewing.id, viewing.graph), [viewing.id, viewing.version]);
  const issues = checked.data?.issues ?? local;
  const errors = issues.filter((i) => i.severity === 'error');

  const goVersion = (version: number, followId?: string) =>
    void navigate({ to: '/projects/$projectId/workflows/$workflowId', params: { projectId, workflowId: viewing.id }, search: { version, ...(followId ? { follow: followId } : {}) } });

  async function activate() {
    setActivating(true);
    setActionError(null);
    try {
      await api.activateVersion(viewing.id, viewing.version);
      reload();
    } catch (err) {
      setActionError(`Version ${viewing.version} was not activated. ${(err as Error).message}`);
    } finally {
      setActivating(false);
    }
  }

  async function startRun() {
    setStarting(true);
    setActionError(null);
    try {
      const run = await api.startRun(viewing.id);
      await navigate({ to: '/projects/$projectId/runs/$runId', params: { projectId, runId: run.id } });
    } catch (err) {
      setActionError(`The run did not start. ${(err as Error).message}`);
      setStarting(false);
    }
  }

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link activeOptions={{ exact: true }} to="/projects/$projectId/workflows" params={{ projectId }}>
          Workflows
        </Link>
        <span aria-hidden="true">/</span>
        <span>{viewing.name}</span>
      </nav>
      <PageHeader
        title={isProposal ? `${viewing.name}: proposed version ${viewing.version}` : viewing.name}
        meta={
          <>
            <WorkflowStatusLabel status={viewing.status} />
            <span className="mono">v{viewing.version}</span>
            {active && active.version !== viewing.version && <span>Active version is v{active.version}</span>}
            <span>{viewing.authoredBy?.kind === 'agent' ? 'Drafted by the workflow architect' : 'Saved by you'}</span>
            {viewing.createdAt && <span>{relative(viewing.createdAt)}</span>}
          </>
        }
        actions={
          <>
            <Link to="/projects/$projectId/workflows/$workflowId/edit" params={{ projectId, workflowId: viewing.id }} className="btn btn-secondary btn-md">
              <IconEdit /> Edit by hand
            </Link>
            {isProposal ? (
              <Button variant="primary" onClick={activate} busy={activating} disabled={errors.length > 0} title={errors.length ? 'Fix validation errors before activating.' : undefined}>
                Activate version {viewing.version}
              </Button>
            ) : (
              viewing.status === 'active' && (
                <Button variant="primary" onClick={startRun} busy={starting}>
                  <IconPlay /> Start run
                </Button>
              )
            )}
          </>
        }
      />
      {actionError && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}

      {follow && <ArchitectProgress assignmentId={follow} projectId={projectId} onDone={(_, version) => goVersion(version)} onDismiss={() => goVersion(viewing.version)} />}

      <div className="stack-sm">
          <GraphCanvas
            graph={viewing.graph}
            mode="view"
            label={`${viewing.name} version ${viewing.version} graph`}
            diff={diff && base ? { base: base.graph, diff } : undefined}
            selection={selection}
            onSelect={setSelection}
            className="graph-drawing"
          />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <EdgeLegend />
            {diff && (
              <ul className="edge-legend" aria-label="Diff marks">
                <li>
                  <span className="swatch swatch-added" aria-hidden="true" /> Added
                </li>
                <li>
                  <span className="swatch swatch-changed" aria-hidden="true" /> Changed
                </li>
                <li>
                  <span className="swatch swatch-removed" aria-hidden="true" /> Removed
                </li>
              </ul>
            )}
          </div>
      </div>

      <div className="proposal-layout">
        <div className="stack-sm">
          <Panel title={isProposal ? 'Proposal' : 'Why it looks like this'}>
            <div className="stack-sm">
              {viewing.authoredBy?.prompt && (
                <div className="stack-sm">
                  <span className="label">Asked</span>
                  <p className="prompt-quote">{viewing.authoredBy.prompt}</p>
                </div>
              )}
              <div className="stack-sm">
                <span className="label">Rationale</span>
                <p className="rationale">{viewing.rationale ?? 'No rationale was recorded for this version.'}</p>
              </div>
              <div>
                {errors.length === 0 ? (
                  <StatusLabel tone="success">Validated: 0 errors{issues.length ? `, ${issues.length} ${issues.length === 1 ? 'warning' : 'warnings'}` : ''}</StatusLabel>
                ) : (
                  <StatusLabel tone="error">
                    {errors.length} validation {errors.length === 1 ? 'error' : 'errors'}
                  </StatusLabel>
                )}
              </div>
              {isProposal && <p className="note">The running workflow keeps using {active ? `version ${active.version}` : 'no version'} until you activate this one. Runs never change silently.</p>}
            </div>
          </Panel>

          {diff && base && <DiffPanel diff={diff} base={base} next={viewing} onSelect={setSelection} />}
        </div>
        <div className="stack-sm">

          <Panel title={asking ? 'Ask for changes' : 'Change this workflow'}>
            {asking ? (
              <ArchitectPrompt
                projectId={projectId}
                base={viewing}
                compact
                title="What should the architect change?"
                onStarted={(id) => {
                  setAsking(false);
                  goVersion(viewing.version, id);
                }}
              />
            ) : (
              <div className="stack-sm">
                <p className="muted">Describe the change and the architect drafts a new version from this one. Or edit the graph yourself.</p>
                <div className="row">
                  <Button onClick={() => setAsking(true)}>Ask for changes</Button>
                  <Link to="/projects/$projectId/workflows/$workflowId/edit" params={{ projectId, workflowId: viewing.id }} className="btn btn-ghost btn-md">
                    Edit by hand
                  </Link>
                </div>
              </div>
            )}
          </Panel>

          <VersionHistory versions={sorted} current={viewing.version} projectId={projectId} />
        </div>
      </div>
    </>
  );
}

function DiffPanel({ diff, base, next, onSelect }: { diff: GraphDiff; base: Workflow; next: Workflow; onSelect(s: Selection): void }) {
  const nodeName = (id: string, g: Workflow) => {
    const n = g.graph.nodes.find((x) => x.id === id);
    return n ? n.label || NODE_SPECS[n.type].title : id;
  };
  const edgeName = (id: string, g: Workflow) => {
    const e = g.graph.edges.find((x) => x.id === id);
    if (!e) return id;
    return `${nodeName(e.from.node, g)}${e.from.port ? ` (${e.from.port})` : ''} → ${nodeName(e.to.node, g)}, ${e.kind}`;
  };
  const rows: { kind: 'Added' | 'Changed' | 'Removed'; text: string; select?: Selection }[] = [
    ...diff.nodes.added.map((id) => ({ kind: 'Added' as const, text: `Node: ${nodeName(id, next)}`, select: { kind: 'node' as const, id } })),
    ...diff.nodes.changed.map((id) => ({ kind: 'Changed' as const, text: `Node: ${nodeName(id, next)}`, select: { kind: 'node' as const, id } })),
    ...diff.nodes.removed.map((id) => ({ kind: 'Removed' as const, text: `Node: ${nodeName(id, base)}` })),
    ...diff.edges.added.map((id) => ({ kind: 'Added' as const, text: edgeName(id, next), select: { kind: 'edge' as const, id } })),
    ...diff.edges.removed.map((id) => ({ kind: 'Removed' as const, text: edgeName(id, base) })),
  ];
  const added = diff.nodes.added.length + diff.edges.added.length;
  const removed = diff.nodes.removed.length + diff.edges.removed.length;
  return (
    <Panel title={`Changes from version ${base.version}`} flush>
      {diffIsEmpty(diff) ? (
        <p className="panel-body muted">No structural changes. Node positions may differ.</p>
      ) : (
        <>
          <dl className="diff-summary">
            <div>
              <dt>Added</dt>
              <dd className="diff-added">{added}</dd>
            </div>
            <div>
              <dt>Changed</dt>
              <dd className="diff-changed">{diff.nodes.changed.length}</dd>
            </div>
            <div>
              <dt>Removed</dt>
              <dd className="diff-removed">{removed}</dd>
            </div>
          </dl>
          <ul className="diff-list">
            {rows.map((r, i) => (
              <li key={i}>
                <span className={`diff-kind diff-${r.kind.toLowerCase()}`}>{r.kind}</span>
                {r.select ? (
                  <button type="button" className="chip-button" onClick={() => onSelect(r.select!)}>
                    {r.text}
                  </button>
                ) : (
                  <span>{r.text}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function VersionHistory({ versions, current, projectId }: { versions: Workflow[]; current: number; projectId: string }) {
  return (
    <Panel title="Version history" flush className="versions">
      <div>
        {versions.map((v) => (
          <Link
            key={v.version}
            to="/projects/$projectId/workflows/$workflowId"
            params={{ projectId, workflowId: v.id }}
            search={{ version: v.version }}
            className="version-row"
            aria-current={v.version === current ? 'true' : undefined}
          >
            <span className="version-number">v{v.version}</span>
            <span className="version-meta">
              <span className="version-author">
                {v.authoredBy?.kind === 'agent' ? 'Workflow architect' : 'You'}
                {v.createdAt ? ` · ${dateTime(v.createdAt)}` : ''}
              </span>
              <span className="version-prompt">{v.authoredBy?.prompt ?? v.rationale ?? 'Edited by hand'}</span>
            </span>
            {v.status === 'active' ? <WorkflowStatusLabel status="active" /> : v.status === 'draft' ? <WorkflowStatusLabel status="draft" /> : <span className="note">Previous</span>}
          </Link>
        ))}
      </div>
    </Panel>
  );
}
