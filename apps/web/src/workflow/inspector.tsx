import { useId, useState } from 'react';
import type { DocRef, EdgeKind, GraphEdge, GraphNode, ValidationIssue, WorkflowGraph } from '../api/types';
import { Button } from '../components/ui';
import { IconPlus, IconTrash, IconXCircle } from '../components/icons';
import { StatusLabel } from '../components/status';
import { EDGE_KIND_HINT, EDGE_KIND_LABEL, NODE_SPECS, PROVIDERS, isRole, readHarness, readPolicy } from './registry';
import type { Selection } from './graph-canvas';

interface Props {
  graph: WorkflowGraph;
  selection: Selection;
  issues: ValidationIssue[];
  docs: DocRef[];
  onChange(graph: WorkflowGraph): void;
  onSelect(selection: Selection): void;
}

export function Inspector(props: Props) {
  const { graph, selection } = props;
  const node = selection?.kind === 'node' ? graph.nodes.find((n) => n.id === selection.id) : undefined;
  const edge = selection?.kind === 'edge' ? graph.edges.find((e) => e.id === selection.id) : undefined;
  return (
    <aside className="inspector" aria-label="Inspector">
      {node ? <NodeInspector key={node.id} {...props} node={node} /> : edge ? <EdgeInspector key={edge.id} {...props} edge={edge} /> : <GraphInspector {...props} />}
      <IssuesSection {...props} />
    </aside>
  );
}

function IssuesSection({ issues, graph, onSelect, selection }: Props) {
  const scoped = selection?.kind === 'node' ? issues.filter((i) => i.nodeId === selection.id) : selection?.kind === 'edge' ? issues.filter((i) => i.edgeId === selection.id) : issues;
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;
  const name = (id?: string) => graph.nodes.find((n) => n.id === id)?.label;
  return (
    <section className="inspector-section" aria-labelledby="issues-title" aria-live="polite">
      <div className="inspector-title">
        <h2 id="issues-title">{selection ? 'Issues here' : 'Validation'}</h2>
        <span className="note">
          {errors} {errors === 1 ? 'error' : 'errors'} · {warnings} {warnings === 1 ? 'warning' : 'warnings'}
        </span>
      </div>
      {scoped.length === 0 ? (
        <StatusLabel tone="done">{selection ? 'No issues on this item.' : 'Graph is valid.'}</StatusLabel>
      ) : (
        <ul className="check-list">
          {scoped.map((issue, i) => (
            <li key={i}>
              <button
                type="button"
                className={`check-item ${issue.severity === 'error' ? 'is-error' : ''}`}
                onClick={() => (issue.nodeId ? onSelect({ kind: 'node', id: issue.nodeId }) : issue.edgeId ? onSelect({ kind: 'edge', id: issue.edgeId }) : undefined)}
                title={issue.nodeId ? `Select ${name(issue.nodeId) ?? 'node'}` : undefined}
              >
                <IconXCircle size={16} />
                <span>
                  <span className="visually-hidden">{issue.severity === 'error' ? 'Error: ' : 'Warning: '}</span>
                  {issue.message}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GraphInspector({ graph }: Props) {
  const roles = graph.nodes.filter((n) => isRole(n)).length;
  return (
    <section className="inspector-section">
      <h2>Workflow</h2>
      <p className="muted">Select a node or connection to configure it. Drag from the palette, or press a palette item to add it.</p>
      <dl className="kv">
        <dt>Nodes</dt>
        <dd className="tabular">{graph.nodes.length}</dd>
        <dt>Agent roles</dt>
        <dd className="tabular">{roles}</dd>
        <dt>Connections</dt>
        <dd className="tabular">
          {(['flow', 'delegates', 'messages'] as EdgeKind[]).map((k) => `${graph.edges.filter((e) => e.kind === k).length} ${EDGE_KIND_LABEL[k].toLowerCase()}`).join(' · ')}
        </dd>
      </dl>
      <div className="stack-sm">
        <span className="field-label">Connecting</span>
        <p className="note">Flow: drag from a right-side port to a node’s left port. Delegates and messages: drag between the round ports under agent roles; the toolbar picks which.</p>
      </div>
    </section>
  );
}

function update(graph: WorkflowGraph, id: string, fn: (n: GraphNode) => GraphNode): WorkflowGraph {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === id ? fn(n) : n)) };
}

function NodeInspector({ graph, node, onChange, onSelect, docs }: Props & { node: GraphNode }) {
  const uid = useId();
  const spec = NODE_SPECS[node.type];
  const set = (key: string, value: unknown) => onChange(update(graph, node.id, (n) => ({ ...n, config: { ...n.config, [key]: value } })));
  const c = node.config;
  const f = (name: string) => `${uid}-${name}`;

  return (
    <>
      <section className="inspector-section">
        <div className="inspector-title">
          <h2>{spec.title}</h2>
          <code className="mono">{node.id}</code>
        </div>
        <p className="note">{spec.description}</p>
        <div className="field">
          <label className="field-label" htmlFor={f('label')}>Label</label>
          <input id={f('label')} className="input" value={node.label} onChange={(e) => onChange(update(graph, node.id, (n) => ({ ...n, label: e.target.value })))} />
        </div>

        {node.type === 'input' && (
          <>
            <SelectField id={f('source')} label="Source" value={String(c.source ?? 'manual')} onChange={(v) => set('source', v)} options={[['manual', 'Manual ideas and input'], ['goals', 'Project goals'], ['issues', 'Issues']]} />
            {docs.length > 0 && (
              <fieldset className="field-group">
                <legend>Docs given to agents</legend>
                {docs.map((d) => {
                  const list = (c.docs as string[] | undefined) ?? [];
                  return (
                    <label key={d.id} className="checkbox">
                      <input type="checkbox" checked={list.includes(d.id)} onChange={(e) => set('docs', e.target.checked ? [...list, d.id] : list.filter((x) => x !== d.id))} />
                      {d.title}
                    </label>
                  );
                })}
              </fieldset>
            )}
          </>
        )}

        {isRole(node) && <HarnessFields id={f('harness')} node={node} onChange={(h) => set('harness', h)} />}

        {(node.type === 'planner' || node.type === 'agent' || node.type === 'review' || node.type === 'human') && (
          <div className="field">
            <label className="field-label" htmlFor={f('prompt')}>{node.type === 'human' ? 'Question for the person' : 'Prompt'}</label>
            <textarea id={f('prompt')} className="input" rows={4} value={String(c.prompt ?? '')} onChange={(e) => set('prompt', e.target.value)} />
          </div>
        )}
        {node.type === 'planner' && <NumberField id={f('maxItems')} label="Max work items" value={c.maxItems} min={1} onChange={(v) => set('maxItems', v)} />}
        {node.type === 'review' && (
          <div className="field">
            <label className="field-label" htmlFor={f('rubric')}>Rubric</label>
            <textarea id={f('rubric')} className="input" rows={2} value={String(c.rubric ?? '')} onChange={(e) => set('rubric', e.target.value)} />
          </div>
        )}
        {(node.type === 'agent' || node.type === 'review') && (
          <NumberField id={f('concurrency')} label="Concurrency" hint="How many agents in this role can work at once." value={c.concurrency} min={1} onChange={(v) => set('concurrency', v)} />
        )}
        {node.type === 'loop' && (
          <>
            <SelectField id={f('until')} label="Repeat until" value={String(c.until ?? 'review-pass')} onChange={(v) => set('until', v)} options={[['review-pass', 'Review passes'], ['ci-pass', 'CI passes'], ['manual', 'A person decides']]} />
            <NumberField id={f('maxIter')} label="Max iterations" hint="The work item fails when it reaches this limit." value={c.maxIterations} min={1} onChange={(v) => set('maxIterations', v)} />
          </>
        )}
        {node.type === 'merge-queue' && (
          <>
            <SelectField id={f('strategy')} label="Strategy" value={String(c.strategy ?? 'serial')} onChange={(v) => set('strategy', v)} options={[['serial', 'Serial'], ['batch', 'Batch']]} />
            <SelectField id={f('method')} label="Merge method" value={String(c.method ?? 'squash')} onChange={(v) => set('method', v)} options={[['squash', 'Squash'], ['merge', 'Merge commit'], ['rebase', 'Rebase']]} />
            <ListField id={f('checks')} label="Required checks" hint="Comma separated." value={(c.requiredChecks as string[]) ?? []} onChange={(v) => set('requiredChecks', v)} />
          </>
        )}
        {node.type === 'ci' && <CiFields id={f('ci')} node={node} onChange={(key, value) => set(key, value)} />}
      </section>

      {node.type === 'agent' && <PolicyFields id={f('policy')} node={node} graph={graph} onChange={(p) => set('policy', p)} />}

      <ConnectionsSection graph={graph} node={node} onChange={onChange} onSelect={onSelect} />

      <section className="inspector-section">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            onChange({ ...graph, nodes: graph.nodes.filter((n) => n.id !== node.id), edges: graph.edges.filter((e) => e.from.node !== node.id && e.to.node !== node.id) });
            onSelect(null);
          }}
        >
          <IconTrash /> Delete node
        </Button>
      </section>
    </>
  );
}

function HarnessFields({ id, node, onChange }: { id: string; node: GraphNode; onChange(h: { provider: string; model: string }): void }) {
  const h = readHarness(node) ?? { provider: '', model: '' };
  const models = PROVIDERS.find((p) => p.id === h.provider)?.models ?? [];
  return (
    <fieldset className="field-group">
      <legend>Harness</legend>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-p`}>Provider</label>
        <span className="select">
          <select id={`${id}-p`} className="input" value={h.provider} onChange={(e) => onChange({ provider: e.target.value, model: PROVIDERS.find((p) => p.id === e.target.value)?.models[0] ?? '' })}>
            <option value="">Choose a provider</option>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </span>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-m`}>Model</label>
        <input id={`${id}-m`} className="input mono-input" list={`${id}-models`} value={h.model} onChange={(e) => onChange({ ...h, model: e.target.value })} spellCheck={false} />
        <datalist id={`${id}-models`}>
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
    </fieldset>
  );
}

function PolicyFields({ id, node, graph, onChange }: { id: string; node: GraphNode; graph: WorkflowGraph; onChange(p: Record<string, unknown>): void }) {
  const p = readPolicy(node) ?? { maxSubagents: 0, allowedSubagentProviders: [] };
  const canMessage = graph.edges
    .filter((e) => e.kind === 'messages' && (e.from.node === node.id || e.to.node === node.id))
    .map((e) => graph.nodes.find((n) => n.id === (e.from.node === node.id ? e.to.node : e.from.node))?.label ?? '?');
  return (
    <section className="inspector-section">
      <h2>Agent policy</h2>
      <NumberField id={`${id}-sub`} label="Max subagents" hint="0 means this agent cannot spawn subagents or delegate." value={p.maxSubagents} min={0} onChange={(v) => onChange({ ...p, maxSubagents: v })} />
      <fieldset className="field-group">
        <legend>Subagent providers</legend>
        {PROVIDERS.slice(0, 4).map((prov) => (
          <label key={prov.id} className="checkbox">
            <input
              type="checkbox"
              checked={p.allowedSubagentProviders.includes(prov.id)}
              onChange={(e) => onChange({ ...p, allowedSubagentProviders: e.target.checked ? [...p.allowedSubagentProviders, prov.id] : p.allowedSubagentProviders.filter((x) => x !== prov.id) })}
            />
            {prov.label}
          </label>
        ))}
      </fieldset>
      <NumberField id={`${id}-turns`} label="Max turns" optional value={p.maxTurns} min={1} onChange={(v) => onChange({ ...p, maxTurns: v })} />
      <NumberField id={`${id}-tokens`} label="Max tokens per assignment" optional value={p.maxTokens} min={1000} onChange={(v) => onChange({ ...p, maxTokens: v })} />
      <div className="stack-sm">
        <span className="field-label">Can message</span>
        <p className="note">{canMessage.length ? canMessage.join(', ') : 'Nobody.'} Derived from messages connections.</p>
      </div>
    </section>
  );
}

function CiFields({ id, node, onChange }: { id: string; node: GraphNode; onChange(key: string, value: unknown): void }) {
  const steps = (node.config.steps as { name: string; run: string }[] | undefined) ?? [];
  const req = (node.config.requirements as { os?: string; labels?: string[] } | undefined) ?? {};
  const setStep = (i: number, patch: Partial<{ name: string; run: string }>) => onChange('steps', steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <>
      <fieldset className="field-group">
        <legend>Steps</legend>
        {steps.map((s, i) => (
          <div key={i} className="step-row">
            <input className="input" aria-label={`Step ${i + 1} name`} value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} placeholder="Name" />
            <input className="input mono-input" aria-label={`Step ${i + 1} command`} value={s.run} onChange={(e) => setStep(i, { run: e.target.value })} placeholder="Command" spellCheck={false} />
            <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`Remove step ${i + 1}`} onClick={() => onChange('steps', steps.filter((_, j) => j !== i))}>
              <IconTrash />
            </button>
          </div>
        ))}
        <div>
          <Button size="sm" variant="ghost" onClick={() => onChange('steps', [...steps, { name: '', run: '' }])}>
            <IconPlus /> Add step
          </Button>
        </div>
      </fieldset>
      <SelectField id={`${id}-os`} label="Machine OS" value={req.os ?? ''} onChange={(v) => onChange('requirements', { ...req, os: v || undefined })} options={[['', 'Any'], ['darwin', 'macOS'], ['linux', 'Linux'], ['windows', 'Windows']]} />
      <ListField id={`${id}-labels`} label="Machine labels" hint="Comma separated. The job runs only where all match." value={req.labels ?? []} onChange={(v) => onChange('requirements', { ...req, labels: v })} />
    </>
  );
}

function ConnectionsSection({ graph, node, onChange, onSelect }: { graph: WorkflowGraph; node: GraphNode; onChange(g: WorkflowGraph): void; onSelect(s: Selection): void }) {
  const uid = useId();
  const spec = NODE_SPECS[node.type];
  const kinds: EdgeKind[] = spec.role ? ['flow', 'delegates', 'messages'] : ['flow'];
  const [kind, setKind] = useState<EdgeKind>(spec.outputs.length ? 'flow' : kinds[1] ?? 'flow');
  const [port, setPort] = useState(spec.outputs[0] ?? 'out');
  const targets = graph.nodes.filter((n) => n.id !== node.id && (kind === 'flow' ? NODE_SPECS[n.type].input : kind === 'delegates' ? n.type === 'agent' || n.type === 'review' : isRole(n)));
  const [target, setTarget] = useState('');
  const name = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
  const mine = graph.edges.filter((e) => e.from.node === node.id || e.to.node === node.id);
  const canAddFlow = spec.outputs.length > 0;

  function add(e: React.FormEvent) {
    e.preventDefault();
    const to = target || targets[0]?.id;
    if (!to) return;
    const p = kind === 'flow' && port !== 'out' ? port : undefined;
    const id = `${kind === 'flow' ? 'e' : kind === 'delegates' ? 'd' : 'm'}-${node.id}-${p ?? (kind === 'flow' ? 'out' : 'role')}-${to}`;
    if (graph.edges.some((x) => x.id === id)) return;
    const edge: GraphEdge = { id, kind, from: { node: node.id, ...(p ? { port: p } : {}) }, to: { node: to } };
    onChange({ ...graph, edges: [...graph.edges, edge] });
  }

  return (
    <section className="inspector-section">
      <h2>Connections</h2>
      {mine.length === 0 ? (
        <p className="note">None yet.</p>
      ) : (
        <ul className="check-list">
          {mine.map((e) => {
            const out = e.from.node === node.id;
            return (
              <li key={e.id} className="connection-row">
                <button type="button" className="cell-button" onClick={() => onSelect({ kind: 'edge', id: e.id })}>
                  {out ? `${e.from.port ? `${e.from.port} ` : ''}→ ${name(e.to.node)}` : `← ${name(e.from.node)}${e.from.port ? ` (${e.from.port})` : ''}`}
                </button>
                <span className="connection-row-end">
                  <span className="note">{EDGE_KIND_LABEL[e.kind]}</span>
                  <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`Remove connection ${out ? 'to' : 'from'} ${name(out ? e.to.node : e.from.node)}`} onClick={() => onChange({ ...graph, edges: graph.edges.filter((x) => x.id !== e.id) })}>
                    <IconTrash />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {(canAddFlow || spec.role) && (
        <form className="stack-sm" onSubmit={add} aria-label="Add a connection">
          <span className="field-label">Add connection</span>
          <SelectField id={`${uid}-kind`} label="Kind" value={kind} onChange={(v) => setKind(v as EdgeKind)} options={kinds.filter((k) => k !== 'flow' || canAddFlow).map((k) => [k, `${EDGE_KIND_LABEL[k]}: ${EDGE_KIND_HINT[k].toLowerCase()}`])} />
          {kind === 'flow' && spec.outputs.length > 1 && <SelectField id={`${uid}-port`} label="From port" value={port} onChange={setPort} options={spec.outputs.map((o) => [o, o])} />}
          <SelectField id={`${uid}-to`} label="To" value={target || targets[0]?.id || ''} onChange={setTarget} options={targets.map((n) => [n.id, n.label || NODE_SPECS[n.type].title])} />
          <div>
            <Button size="sm" type="submit" disabled={targets.length === 0}>
              <IconPlus /> Connect
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function EdgeInspector({ graph, edge, onChange, onSelect }: Props & { edge: GraphEdge }) {
  const uid = useId();
  const from = graph.nodes.find((n) => n.id === edge.from.node);
  const to = graph.nodes.find((n) => n.id === edge.to.node);
  const roleEdge = edge.kind !== 'flow';
  return (
    <section className="inspector-section">
      <div className="inspector-title">
        <h2>{EDGE_KIND_LABEL[edge.kind]} connection</h2>
        <code className="mono">{edge.id}</code>
      </div>
      <p className="note">{EDGE_KIND_HINT[edge.kind]}.</p>
      <dl className="kv">
        <dt>From</dt>
        <dd>
          {from?.label ?? edge.from.node}
          {edge.from.port ? ` (${edge.from.port})` : ''}
        </dd>
        <dt>To</dt>
        <dd>{to?.label ?? edge.to.node}</dd>
      </dl>
      {roleEdge && (
        <SelectField
          id={`${uid}-kind`}
          label="Kind"
          value={edge.kind}
          onChange={(v) => onChange({ ...graph, edges: graph.edges.map((e) => (e.id === edge.id ? { ...e, kind: v as EdgeKind } : e)) })}
          options={[
            ['delegates', 'Delegates'],
            ['messages', 'Messages'],
          ]}
        />
      )}
      <div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            onChange({ ...graph, edges: graph.edges.filter((e) => e.id !== edge.id) });
            onSelect(null);
          }}
        >
          <IconTrash /> Delete connection
        </Button>
      </div>
    </section>
  );
}

function SelectField({ id, label, value, onChange, options }: { id: string; label: string; value: string; onChange(v: string): void; options: [string, string][] }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      <span className="select">
        <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </span>
    </div>
  );
}

function NumberField({ id, label, hint, value, min, onChange, optional }: { id: string; label: string; hint?: string; value: unknown; min: number; onChange(v: number | undefined): void; optional?: boolean }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
        {optional && <span className="muted"> (optional)</span>}
      </label>
      <input
        id={id}
        className="input tabular"
        type="number"
        inputMode="numeric"
        min={min}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? (optional ? undefined : 0) : Number(e.target.value))}
      />
      {hint && <p className="field-help">{hint}</p>}
    </div>
  );
}

function ListField({ id, label, hint, value, onChange }: { id: string; label: string; hint?: string; value: string[]; onChange(v: string[]): void }) {
  const [text, setText] = useState(value.join(', '));
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      <input
        id={id}
        className="input mono-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onChange(text.split(',').map((s) => s.trim()).filter(Boolean))}
        spellCheck={false}
      />
      {hint && <p className="field-help">{hint}</p>}
    </div>
  );
}
