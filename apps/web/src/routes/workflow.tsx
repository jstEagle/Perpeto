import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useHub, useResource } from '../app/hub-context';
import type { GraphDiff, Workflow } from '../api/types';
import { Async, btn, Button, Disclosure, PageHeader, Panel, Stat } from '../components/ui';
import { StatusChip, StatusLabel, WorkflowStatusLabel } from '../components/status';
import { IconEdit, IconPlay } from '../components/icons';
import { GraphCanvas } from '../workflow/graph-canvas';
import { StepList } from '../workflow/step-list';
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
    <div className="page">
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
      <PageHeader
        back={{ label: 'Workflows', to: '/projects/$projectId/workflows', params: { projectId } }}
        title={isProposal ? `${viewing.name}: proposed version ${viewing.version}` : viewing.name}
        status={
          <StatusChip tone={viewing.status === 'active' ? 'done' : 'quiet'} quiet={viewing.status !== 'active'}>
            {viewing.status === 'active' ? 'Active' : viewing.status === 'draft' ? 'Draft' : 'Paused'} · v{viewing.version}
          </StatusChip>
        }
        meta={
          <>
            {viewing.authoredBy?.kind === 'agent' ? 'Drafted by the workflow architect' : 'Saved by you'}
            {viewing.createdAt && ` ${relative(viewing.createdAt)}`}
            {active && active.version !== viewing.version && ` · Active version is v${active.version}`}
          </>
        }
        actions={
          <>
            <Link to="/projects/$projectId/workflows/$workflowId/edit" params={{ projectId, workflowId: viewing.id }} className={btn('secondary')}>
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

      <div className="hide-sm">
        <GraphCanvas
          graph={viewing.graph}
          mode="view"
          label={`${viewing.name} version ${viewing.version} graph`}
          diff={diff && base ? { base: base.graph, diff } : undefined}
          selection={selection}
          onSelect={setSelection}
          className="graph-drawing"
        />
      </div>
      <StepList graph={viewing.graph} selection={selection} onSelect={setSelection} className="only-mobile" />

      <div className="cols">
        <div className="stack">
          <Panel
            title={isProposal ? 'Proposal' : 'Why it looks like this'}
            actions={
              errors.length === 0 ? (
                <StatusLabel tone="done">Valid{issues.length ? `, ${issues.length} ${issues.length === 1 ? 'warning' : 'warnings'}` : ''}</StatusLabel>
              ) : (
                <StatusLabel tone="failed">
                  {errors.length} validation {errors.length === 1 ? 'error' : 'errors'}
                </StatusLabel>
              )
            }
          >
            <div className="stack">
              {viewing.authoredBy?.prompt && <blockquote className="prompt-quote">{viewing.authoredBy.prompt}</blockquote>}
              <p className="rationale">{viewing.rationale ?? 'No rationale was recorded for this version.'}</p>
              {isProposal && <p className="note">The running workflow keeps using {active ? `version ${active.version}` : 'no version'} until you activate this one. Runs never change silently.</p>}
            </div>
          </Panel>

          {diff && base && <DiffPanel diff={diff} base={base} next={viewing} onSelect={setSelection} />}
        </div>
        <div className="stack">
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
                <p className="muted">Describe the change and the architect drafts a new version from this one.</p>
                <div className="row">
                  <Button onClick={() => setAsking(true)}>Ask for changes</Button>
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
    <Panel title={`Changes from version ${base.version}`}>
      {diffIsEmpty(diff) ? (
        <p className="muted">No structural changes. Node positions may differ.</p>
      ) : (
        <>
          <dl className="metrics metrics-small diff-summary">
            <Stat label="Added" value={added} />
            <Stat label="Changed" value={diff.nodes.changed.length} />
            <Stat label="Removed" value={removed} />
          </dl>
          <div className="card-foot">
            <Disclosure summary={`Show all ${rows.length} changes`}>
              <ul className="rows">
                {rows.map((r, i) => (
                  <li key={i}>
                    <StatusLabel tone={r.kind === 'Added' ? 'done' : r.kind === 'Removed' ? 'failed' : 'attention'}>{r.kind}</StatusLabel>
                    <span className="row-main">
                      {r.select ? (
                        <button type="button" className="cell-button" onClick={() => onSelect(r.select!)}>
                          {r.text}
                        </button>
                      ) : (
                        <span>{r.text}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          </div>
        </>
      )}
    </Panel>
  );
}

function VersionHistory({ versions, current, projectId }: { versions: Workflow[]; current: number; projectId: string }) {
  return (
    <Panel title="Version history" actions={`${versions.length}`}>
      <ul className="rows versions">
        {versions.map((v) => (
          <li key={v.version}>
            <Link
              to="/projects/$projectId/workflows/$workflowId"
              params={{ projectId, workflowId: v.id }}
              search={{ version: v.version }}
              className="version-row"
              aria-current={v.version === current ? 'true' : undefined}
            >
              <span className="chip-quiet">v{v.version}</span>
              <span className="row-main">
                <span className="row-title">{v.authoredBy?.prompt ?? v.rationale ?? 'Edited by hand'}</span>
                <span className="row-meta">
                  {v.authoredBy?.kind === 'agent' ? 'Workflow architect' : 'You'}
                  {v.createdAt ? ` · ${dateTime(v.createdAt)}` : ''}
                </span>
              </span>
              <span className="row-end">{v.status === 'active' ? <WorkflowStatusLabel status="active" /> : v.status === 'draft' ? <WorkflowStatusLabel status="draft" /> : 'Previous'}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
