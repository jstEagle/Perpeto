import { useEffect, useRef, useState, type PointerEvent } from "react";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useProjects } from "../../state/entities";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { usePreparedConnection, useEnvironmentScope } from "../../state/session";
import { randomUUID } from "../../lib/utils";
import { messagingRequest } from "./messaging";
import { connectionError, createFactoryNode, edgeLabels, editorConfig, factoryPayload, harnesses, nodeLabels, removeFactoryNode, type Definition, type Factory, type FactoryEdge, type FactoryNode, type HarnessKind } from "./editor";
import workshopTokens from "../../../../../../../brand/tokens.css?inline";
import "./factory-editor.css";

type Prepared = Extract<ReturnType<typeof usePreparedConnection>, { _tag: "Some" }>["value"];
interface Draft { id: string; definition: Definition; saved: Factory | null }
interface ProjectDrafts { selectedId: string | null; drafts: Map<string, Draft> }
// Browser-session state survives sidebar navigation; a reload still requires saved revisions.
const editorDraftCache = new Map<string, ProjectDrafts>();
const fresh = (): Draft => ({ id: randomUUID(), definition: { name: "Delivery factory", nodes: [], edges: [] }, saved: null });
const fromSaved = (factory: Factory): Draft => ({ id: factory.id, definition: factoryPayload(factory), saved: factory });
const errorText = (error: unknown) => error instanceof Error ? error.message : "Request failed. Retry the selected environment.";
const hasCode = (error: unknown, code: string) => error !== null && typeof error === "object" && "code" in error && error.code === code;

export function FactoryEditorPage() {
  const projects = useProjects(); const { environments } = useEnvironments(); const primary = usePrimaryEnvironmentId();
  const [selectedProject, setSelectedProject] = useState("");
  const project = projects.find((item) => `${item.environmentId}:${item.id}` === selectedProject) ?? projects.find((item) => item.environmentId === primary) ?? projects[0];
  const environment = useEnvironment(project?.environmentId ?? null);
  const connection = usePreparedConnection(project?.environmentId ?? null);
  const canOperate = useEnvironmentScope(project?.environmentId ?? null, AuthOrchestrationOperateScope);
  const drafts = useRef(editorDraftCache);
  const key = project ? `${project.environmentId}:${project.id}` : "";
  if (project && !drafts.current.has(key)) drafts.current.set(key, { selectedId: null, drafts: new Map() });
  return <section className="perpeto-editor" aria-label="Factory builder">
    <style>{workshopTokens.replace(":root", ".perpeto-editor")}</style>
    <header className="editor-heading"><div><h1>Factories</h1><p>{environment?.label ?? "Select an environment"}</p></div>
      <label>Project<select value={key} onChange={(event) => setSelectedProject(event.target.value)}>
        {!project && <option value="">No projects</option>}
        {projects.map((item) => <option key={`${item.environmentId}:${item.id}`} value={`${item.environmentId}:${item.id}`}>{item.title} · {environments.find((entry) => entry.environmentId === item.environmentId)?.label ?? "Environment"}</option>)}
      </select></label>
    </header>
    {!project ? <p className="editor-empty">Add a project from the sidebar to create a factory.</p>
      : connection._tag === "None" ? <p className="editor-empty">Connect this project's environment to edit its factories.</p>
        : <ProjectEditor key={key} projectId={project.id} prepared={connection.value} canOperate={canOperate} cache={drafts.current.get(key)!} />}
  </section>;
}

function ProjectEditor({ projectId, prepared, canOperate, cache }: { projectId: string; prepared: Prepared; canOperate: boolean; cache: ProjectDrafts }) {
  const selectInitialSaved = useRef(cache.drafts.size === 0);
  const [draft, setDraftState] = useState<Draft>(() => {
    const initial = (cache.selectedId ? cache.drafts.get(cache.selectedId) : null) ?? fresh();
    cache.selectedId = initial.id; cache.drafts.set(initial.id, initial);
    return initial;
  });
  const [factories, setFactories] = useState<Factory[]>([]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const drafts = cache.drafts;
  const draftRef = useRef(draft);
  function setDraft(next: Draft | ((current: Draft) => Draft)) {
    selectInitialSaved.current = false;
    const value = typeof next === "function" ? next(draftRef.current) : next;
    draftRef.current = value; cache.selectedId = value.id; cache.drafts.set(value.id, value);
    setDraftState(value);
  }
  const base = `/api/perpeto/factories/projects/${encodeURIComponent(projectId)}`;
  const definition = draft.definition;
  const dirty = draft.saved === null || JSON.stringify(definition) !== JSON.stringify(factoryPayload(draft.saved));
  const selected = definition.nodes.find((node) => node.id === selectedNode);
  useEffect(() => {
    mounted.current = true;
    request.current?.abort(); request.current = null;
    setBusy(false); setLoading(true);
    const controller = new AbortController();
    void messagingRequest<{ factories: Factory[] }>({ prepared, path: base, signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setFactories(result.factories);
      if (selectInitialSaved.current && result.factories[0]) setDraft(fromSaved(result.factories[0]));
      selectInitialSaved.current = false;
      setError(null);
    }).catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { mounted.current = false; controller.abort(); request.current?.abort(); };
  }, [base, prepared]);
  function change(next: Definition) { setDraft((current) => ({ ...current, definition: next })); }
  function updateNode(node: FactoryNode) { change({ ...definition, nodes: definition.nodes.map((item) => item.id === node.id ? node : item) }); }
  function addNode(type: FactoryNode["type"]) {
    const node = createFactoryNode(type, randomUUID(), definition.nodes.length);
    change({ ...definition, nodes: [...definition.nodes, node] }); setSelectedNode(node.id);
  }
  function selectFactory(id: string) {
    drafts.set(draft.id, draft);
    const cached = drafts.get(id); const saved = factories.find((item) => item.id === id);
    if (cached ?? saved) { setDraft(cached ?? fromSaved(saved!)); setSelectedNode(null); setConflict(false); setError(null); }
  }
  function newFactory() {
    drafts.set(draft.id, draft); setDraft(fresh()); setSelectedNode(null); setConflict(false); setError(null);
  }
  async function save(copy = false) {
    if (busy || loading || !canOperate) return;
    const snapshot = draftRef.current;
    const id = copy ? randomUUID() : snapshot.id;
    const creating = copy || snapshot.saved === null;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(null);
    try {
      const payload = factoryPayload(snapshot.definition);
      const saved = await messagingRequest<Factory>({ prepared, path: creating ? base : `${base}/${encodeURIComponent(id)}`, method: creating ? "POST" : "PUT",
        body: creating ? { id, ...payload } : { expectedVersion: snapshot.saved!.version, ...payload }, signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      setFactories((items) => [...items.filter((item) => item.id !== saved.id), saved]);
      setDraft(fromSaved(saved)); setConflict(false);
    } catch (cause) {
      if (!mounted.current || controller.signal.aborted) return;
      setConflict(hasCode(cause, "CONFLICT"));
      setError(hasCode(cause, "CONFLICT") ? "This factory changed elsewhere. Your edits are kept. Reload the saved version or save a copy." : errorText(cause));
    } finally { if (mounted.current && !controller.signal.aborted) setBusy(false); }
  }
  async function reload() {
    if (busy || loading || (!draft.saved && !factories.some((item) => item.id === draft.id) && !conflict)) return;
    const controller = new AbortController(); request.current = controller; setBusy(true);
    try {
      const saved = await messagingRequest<Factory>({ prepared, path: `${base}/${encodeURIComponent(draft.id)}`, signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      setDraft(fromSaved(saved)); setFactories((items) => [...items.filter((item) => item.id !== saved.id), saved]); setConflict(false); setError(null); setSelectedNode(null);
    } catch (cause) { if (!controller.signal.aborted) setError(errorText(cause)); }
    finally { if (mounted.current && !controller.signal.aborted) setBusy(false); }
  }
  const choices = [...factories.map((item) => ({ id: item.id, name: item.name })), ...[...drafts.values()].filter((item) => !factories.some((factory) => factory.id === item.id)).map((item) => ({ id: item.id, name: `${item.definition.name} · draft` }))];
  if (!choices.some((item) => item.id === draft.id)) choices.push({ id: draft.id, name: `${definition.name} · draft` });
  return <>
    <div className="editor-toolbar">
      <label className="editor-factory-picker">Factory<select aria-label="Factory" value={draft.id} disabled={busy || loading} onChange={(event) => selectFactory(event.target.value)}>{choices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {canOperate && <button type="button" onClick={newFactory} disabled={busy || loading}>New</button>}
      <span className="editor-definition-status">Definition only</span>
      <span className="editor-save-status" role="status">{loading ? "Loading…" : draft.saved ? `Version ${draft.saved.version}${dirty ? " · Unsaved" : " · Saved"}` : "Unsaved"}</span>
      {(draft.saved || conflict || factories.some((item) => item.id === draft.id)) && <button type="button" onClick={() => void reload()} disabled={busy || loading} title="Replace this draft with the current saved version">Reload saved</button>}
      {conflict && canOperate && <button type="button" onClick={() => void save(true)} disabled={busy}>Save copy</button>}
      {canOperate && <button type="button" className="editor-primary" onClick={() => void save()} disabled={busy || loading || !dirty || !definition.name.trim()}>{busy ? "Saving…" : "Save"}</button>}
    </div>
    {error && <p role="alert" className="editor-error">{error}</p>}
    <div className="editor-body">
      <div className="editor-workbench">
        <div className="editor-palette" aria-label="Add a node">{(Object.keys(nodeLabels) as FactoryNode["type"][]).map((type) => <button key={type} type="button" onClick={() => addNode(type)} disabled={!canOperate || busy || loading}>+ {nodeLabels[type]}</button>)}</div>
        <NodeCanvas definition={definition} selected={selectedNode} onSelect={setSelectedNode} onMove={updateNode} disabled={!canOperate || busy || loading} />
      </div>
      <aside className="editor-inspector" aria-label="Factory properties">
        <label>Factory name<input aria-label="Factory name" value={definition.name} maxLength={200} disabled={!canOperate || busy || loading} onChange={(event) => change({ ...definition, name: event.target.value })} /></label>
        {selected ? <NodeInspector node={selected} disabled={!canOperate || busy || loading} update={updateNode} remove={() => { change(removeFactoryNode(definition, selected.id)); setSelectedNode(null); }} /> : <p className="editor-hint">Select a node to edit its configuration. Drag nodes or use arrow keys to move them.</p>}
        <Connections definition={definition} disabled={!canOperate || busy || loading} change={change} />
      </aside>
    </div>
  </>;
}

function NodeCanvas({ definition, selected, onSelect, onMove, disabled }: { definition: Definition; selected: string | null; onSelect: (id: string) => void; onMove: (node: FactoryNode) => void; disabled: boolean }) {
  const drag = useRef<{ node: FactoryNode; x: number; y: number; origin: { x: number; y: number } } | null>(null);
  const position = (node: FactoryNode) => node.position ?? { x: 48, y: 48 };
  const width = Math.max(editorConfig.canvasWidth, ...definition.nodes.map((node) => position(node).x + editorConfig.nodeWidth + 48));
  const height = Math.max(editorConfig.canvasHeight, ...definition.nodes.map((node) => position(node).y + editorConfig.nodeHeight + 48));
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current || disabled) return;
    const { node, origin, x, y } = drag.current;
    onMove({ ...node, position: { x: Math.max(0, Math.round(origin.x + event.clientX - x)), y: Math.max(0, Math.round(origin.y + event.clientY - y)) } });
  };
  return <div className="editor-canvas-scroll" aria-label="Factory graph"><div className="editor-canvas" style={{ width, height }}>
    <svg width={width} height={height} aria-label="Factory connections" className="editor-wires">
      <defs><marker id="factory-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="currentColor" /></marker></defs>
      {definition.edges.map((edge) => {
        const source = definition.nodes.find((node) => node.id === edge.source); const target = definition.nodes.find((node) => node.id === edge.target); if (!source || !target) return null;
        const from = position(source); const to = position(target); const x1 = from.x + editorConfig.nodeWidth; const y1 = from.y + editorConfig.nodeHeight / 2; const x2 = to.x; const y2 = to.y + editorConfig.nodeHeight / 2; const bend = Math.max(64, Math.abs(x2 - x1) / 2);
        return <g key={edge.id} className={`editor-wire editor-wire-${edge.type}`}><path d={`M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`} markerEnd="url(#factory-arrow)" /><text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 8}>{edgeLabels[edge.type]}</text></g>;
      })}
    </svg>
    {!definition.nodes.length && <div className="editor-canvas-empty"><h2>Build your factory</h2><p>Add agents, context and delivery checks.</p></div>}
    {definition.nodes.map((node) => <button key={node.id} type="button" className={`editor-node editor-node-${node.type}`} style={{ left: position(node).x, top: position(node).y, width: editorConfig.nodeWidth, minHeight: editorConfig.nodeHeight }} aria-pressed={selected === node.id} aria-label={`Select ${node.label}`} onClick={() => onSelect(node.id)}
      onPointerDown={(event) => { onSelect(node.id); if (!disabled) { drag.current = { node, x: event.clientX, y: event.clientY, origin: position(node) }; event.currentTarget.setPointerCapture(event.pointerId); } }} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onKeyDown={(event) => { const vectors: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }; const vector = vectors[event.key]; if (disabled || !vector) return; event.preventDefault(); onMove({ ...node, position: { x: Math.max(0, position(node).x + vector[0] * editorConfig.keyboardStep), y: Math.max(0, position(node).y + vector[1] * editorConfig.keyboardStep) } }); }}>
      <span className="editor-node-kind">{nodeLabels[node.type]}</span><strong>{node.label}</strong><span className="editor-node-detail">{node.type === "agent" ? `${harnesses.find((item) => item.id === node.harness)?.label} · ${node.maxConcurrent} concurrent` : node.type === "context" ? `${node.references.length} references` : node.type === "check" ? node.command.join(" ") : "Review and checks"}</span>
    </button>)}
  </div></div>;
}

function NodeInspector({ node, disabled, update, remove }: { node: FactoryNode; disabled: boolean; update: (node: FactoryNode) => void; remove: () => void }) {
  return <fieldset disabled={disabled} className="editor-node-inspector"><legend>{nodeLabels[node.type]}</legend>
    <label>Node name<input aria-label="Node name" value={node.label} maxLength={200} onChange={(event) => update({ ...node, label: event.target.value })} /></label>
    {node.type === "agent" && <>
      <label>Harness<select aria-label="Harness" value={node.harness} onChange={(event) => update({ ...node, harness: event.target.value as HarnessKind })}>{harnesses.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>Model<input aria-label="Model" placeholder="Harness default" value={node.model ?? ""} onChange={(event) => { const { model: _model, ...rest } = node; update(event.target.value.trim() ? { ...rest, model: event.target.value } : rest); }} /></label>
      <label className="editor-checkbox"><input type="checkbox" checked={node.allowSubagents} onChange={(event) => update({ ...node, allowSubagents: event.target.checked, maxSubagents: event.target.checked ? editorConfig.defaultAgent.maxSubagents : 0 })} />Allow subagents</label>
      <label>Maximum subagents<input aria-label="Maximum subagents" type="number" min="0" step="1" disabled={!node.allowSubagents} value={node.maxSubagents} onChange={(event) => update({ ...node, maxSubagents: event.target.valueAsNumber })} /></label>
      <label>Concurrent agents<input aria-label="Concurrent agents" type="number" min="1" step="1" value={node.maxConcurrent} onChange={(event) => update({ ...node, maxConcurrent: event.target.valueAsNumber })} /></label>
    </>}
    {node.type === "context" && <label>References, one per line<textarea aria-label="Context references" rows={4} value={node.references.join("\n")} onChange={(event) => update({ ...node, references: event.target.value.split("\n") })} /></label>}
    {node.type === "check" && <label>Command arguments, one per line<textarea aria-label="Command arguments" rows={4} value={node.command.join("\n")} onChange={(event) => update({ ...node, command: event.target.value.split("\n") })} /></label>}
    {node.type === "merge-queue" && <><label className="editor-checkbox"><input type="checkbox" checked={node.requireChecks} onChange={(event) => update({ ...node, requireChecks: event.target.checked })} />Require checks</label><label className="editor-checkbox"><input type="checkbox" checked={node.requireReview} onChange={(event) => update({ ...node, requireReview: event.target.checked })} />Require review</label></>}
    <button type="button" className="editor-remove" onClick={remove}>Remove node</button>
  </fieldset>;
}

function Connections({ definition, disabled, change }: { definition: Definition; disabled: boolean; change: (definition: Definition) => void }) {
  const [source, setSource] = useState(""); const [target, setTarget] = useState(""); const [type, setType] = useState<FactoryEdge["type"]>("workflow"); const [error, setError] = useState<string | null>(null);
  function connect() {
    const error = connectionError(definition, source, target, type); setError(error); if (error) return;
    change({ ...definition, edges: [...definition.edges, { id: randomUUID(), source, target, type }] });
  }
  return <fieldset disabled={disabled} className="editor-connections"><legend>Connections</legend>
    <label>Relationship<select aria-label="Relationship" value={type} onChange={(event) => setType(event.target.value as FactoryEdge["type"])}>{Object.entries(edgeLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <label>From<select aria-label="Connection source" value={source} onChange={(event) => setSource(event.target.value)}><option value="">Choose node</option>{definition.nodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select></label>
    <label>To<select aria-label="Connection target" value={target} onChange={(event) => setTarget(event.target.value)}><option value="">Choose node</option>{definition.nodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select></label>
    <button type="button" onClick={connect} disabled={!source || !target}>Connect</button>
    {error && <p role="alert" className="editor-error">{error}</p>}
    <ul>{definition.edges.map((edge) => <li key={edge.id}><span>{definition.nodes.find((node) => node.id === edge.source)?.label} → {definition.nodes.find((node) => node.id === edge.target)?.label}<small>{edgeLabels[edge.type]}</small></span><button type="button" aria-label={`Remove connection ${definition.nodes.find((node) => node.id === edge.source)?.label} to ${definition.nodes.find((node) => node.id === edge.target)?.label}`} onClick={() => change({ ...definition, edges: definition.edges.filter((item) => item.id !== edge.id) })}>×</button></li>)}</ul>
  </fieldset>;
}
