import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams } from '@tanstack/react-router';
import { useHub, useResource } from '../app/hub-context';
import type { NodeType, ValidationIssue, Workflow, WorkflowGraph } from '../api/types';
import { Async, Button, Segmented } from '../components/ui';
import { StatusLabel } from '../components/status';
import { DRAG_MIME, EdgeLegend, GraphCanvas } from '../workflow/graph-canvas';
import type { Selection } from '../workflow/graph-canvas';
import { Inspector } from '../workflow/inspector';
import { NODE_SPECS, PALETTE_ORDER } from '../workflow/registry';
import { TypeGlyph } from '../workflow/step-node';
import { validateGraph } from '../workflow/validate';
import { COL, TEMPLATES } from '../workflow/templates';

export function EditorPage() {
  const { projectId, workflowId } = useParams({ from: '/projects/$projectId/workflows/$workflowId/edit' });
  const workflow = useResource((api) => api.getWorkflow(workflowId), [workflowId]);
  const project = useResource((api) => api.getProject(projectId), [projectId]);
  return (
    <Async resource={workflow} what="workflow">
      {(wf) => <Editor key={`${wf.id}-${wf.version}`} workflow={wf} projectId={projectId} docs={project.data?.docs ?? []} />}
    </Async>
  );
}

function Editor({ workflow, projectId, docs }: { workflow: Workflow; projectId: string; docs: NonNullable<Parameters<typeof Inspector>[0]['docs']> }) {
  const { api } = useHub();
  const navigate = useNavigate();
  const [graph, setGraph] = useState<WorkflowGraph>(workflow.graph);
  const [selection, setSelection] = useState<Selection>(null);
  const [roleKind, setRoleKind] = useState<'delegates' | 'messages'>('delegates');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const dirty = useRef(false);

  const localIssues = useMemo(() => validateGraph(graph), [graph]);
  const issues = useMemo(() => {
    const seen = new Set(localIssues.map((i) => i.message));
    return [...localIssues, ...serverIssues.filter((i) => !seen.has(i.message))];
  }, [localIssues, serverIssues]);
  const errors = issues.filter((i) => i.severity === 'error');

  const issuesByNode = useMemo(() => {
    const map = new Map<string, { errors: number; warnings: number }>();
    for (const i of issues) {
      if (!i.nodeId) continue;
      const v = map.get(i.nodeId) ?? { errors: 0, warnings: 0 };
      if (i.severity === 'error') v.errors++;
      else v.warnings++;
      map.set(i.nodeId, v);
    }
    return map;
  }, [issues]);

  // The hub's validator is authoritative; ask it after edits settle.
  useEffect(() => {
    if (api.mode !== 'hub') return;
    const t = setTimeout(() => {
      api
        .validateWorkflow(workflow.id, graph)
        .then((r) => setServerIssues(r.issues))
        .catch(() => setServerIssues([]));
    }, 600);
    return () => clearTimeout(t);
  }, [api, graph, workflow.id]);

  useBlocker({
    shouldBlockFn: () => dirty.current && !window.confirm('Leave without saving? Your changes to this workflow will be lost.'),
    enableBeforeUnload: () => dirty.current,
  });

  const change = (next: WorkflowGraph) => {
    dirty.current = true;
    setGraph(next);
  };

  function addNode(type: NodeType, position?: { x: number; y: number }) {
    const spec = NODE_SPECS[type];
    let n = 1;
    while (graph.nodes.some((x) => x.id === `${type}-${n}`)) n++;
    const maxX = graph.nodes.reduce((m, x) => Math.max(m, x.position.x), -COL);
    const pos = position ?? { x: maxX + COL, y: 0 };
    const node = { id: `${type}-${n}`, type, label: n > 1 ? `${spec.title} ${n}` : spec.title, position: pos, config: spec.defaults() };
    change({ ...graph, nodes: [...graph.nodes, node] });
    setSelection({ kind: 'node', id: node.id });
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await api.saveWorkflow(workflow.id, { graph });
      dirty.current = false;
      await navigate({ to: '/projects/$projectId/workflows/$workflowId', params: { projectId, workflowId: workflow.id }, search: { version: saved.version } });
    } catch (err) {
      setSaveError(`Not saved. ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="editor-page">
      <div className="editor-bar">
        <div className="editor-bar-title">
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <Link activeOptions={{ exact: true }} to="/projects/$projectId/workflows" params={{ projectId }}>
              Workflows
            </Link>
            <span aria-hidden="true">/</span>
            <Link activeOptions={{ exact: true }} to="/projects/$projectId/workflows/$workflowId" params={{ projectId, workflowId: workflow.id }} search={{}}>
              {workflow.name}
            </Link>
          </nav>
          <h1>Edit by hand</h1>
        </div>
        <div className="editor-bar-actions">
          <span className="save-state" aria-live="polite">
            {errors.length ? (
              <StatusLabel tone="error">
                {errors.length} {errors.length === 1 ? 'error' : 'errors'}
              </StatusLabel>
            ) : (
              <StatusLabel tone="success">Valid</StatusLabel>
            )}
          </span>
          <span className="save-state">Editing from v{workflow.version}. Saving creates a draft version.</span>
          <span className="select">
            <select
              className="input"
              aria-label="Replace with a template"
              value=""
              onChange={(e) => {
                const t = TEMPLATES.find((x) => x.purpose === e.target.value);
                if (t && window.confirm(`Replace the graph with the ${t.name} template?`)) {
                  change(t.graph());
                  setSelection(null);
                }
              }}
            >
              <option value="">Template…</option>
              {TEMPLATES.map((t) => (
                <option key={t.purpose} value={t.purpose}>
                  {t.name}
                </option>
              ))}
            </select>
          </span>
          <Button variant="primary" onClick={save} busy={saving} disabled={errors.length > 0} title={errors.length ? 'Fix errors before saving.' : undefined}>
            Save draft
          </Button>
        </div>
      </div>
      {saveError && (
        <p className="form-error" role="alert" style={{ margin: '0 24px 12px' }}>
          {saveError}
        </p>
      )}
      <div className="editor">
        <aside className="palette" aria-label="Node palette">
          <h2>Add a node</h2>
          <ul className="palette-list">
            {PALETTE_ORDER.map((type) => (
              <li key={type}>
                <button
                  type="button"
                  className="palette-item"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_MIME, type);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => addNode(type)}
                  title={NODE_SPECS[type].description}
                >
                  <TypeGlyph type={type} />
                  {NODE_SPECS[type].title}
                </button>
              </li>
            ))}
          </ul>
          <p className="palette-hint">Drag onto the canvas, or press to add at the end of the graph.</p>
        </aside>
        <div className="editor-canvas">
          <div className="canvas-toolbar">
            <div className="row" style={{ gap: 8 }}>
              <span className="note">Role ports create</span>
              <Segmented<'delegates' | 'messages'>
                label="Connection kind for role ports"
                value={roleKind}
                onChange={setRoleKind}
                options={[
                  { value: 'delegates', label: 'Delegates' },
                  { value: 'messages', label: 'Messages' },
                ]}
              />
            </div>
            <EdgeLegend />
          </div>
          <GraphCanvas
            graph={graph}
            mode="edit"
            label={`${workflow.name} editor canvas`}
            issuesByNode={issuesByNode}
            selection={selection}
            onSelect={setSelection}
            onGraphChange={change}
            roleKind={roleKind}
            onDropNode={addNode}
          />
        </div>
        <Inspector graph={graph} selection={selection} issues={issues} docs={docs} onChange={change} onSelect={setSelection} />
      </div>
    </div>
  );
}
