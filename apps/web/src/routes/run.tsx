import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useHub, useResource } from '../app/hub-context';
import type { Resource } from '../app/hub-context';
import type { Assignment, Machine, MetricsSnapshot, MetricsWindow, Run, WorkItem, WorkflowGraph } from '../api/types';
import { Async, Button, Dialog, Empty, Field, Mono, PageHeader, Panel, Segmented } from '../components/ui';
import { AssignmentStatusLabel, RunStatusLabel, StatusLabel } from '../components/status';
import { IconPause, IconPlay, IconPlus, IconStop } from '../components/icons';
import { EdgeLegend, GraphCanvas } from '../workflow/graph-canvas';
import type { Selection } from '../workflow/graph-canvas';
import { BOTTLENECK_LABEL } from '../workflow/step-node';
import { NODE_SPECS, providerLabel } from '../workflow/registry';
import { InteractionFeed, useRunEvents } from '../run/feed';
import { BottlenecksPanel, VelocityPanel, WhereRunningPanel } from '../run/panels';
import { WorkBoard } from '../run/board';
import { duration, pct, rate, relative, tokens } from '../lib/format';

type Tab = 'map' | 'work' | 'assignments' | 'timeline';

/** Metrics are recomputed by the hub per request; coalesce bursts of events into one fetch a second, at most every 4 s. */
const METRICS_REFRESH = { debounceMs: 1000, maxWaitMs: 4000 };

export function RunPage() {
  const { projectId, runId } = useParams({ from: '/projects/$projectId/runs/$runId' });
  const run = useResource((api) => api.getRun(runId), [runId], (e) => e.subject.kind === 'run' && e.subject.id === runId);
  return (
    <div className="page page-wide">
      <Async resource={run} what="run">
        {(r) => <RunView run={r} projectId={projectId} onChanged={run.reload} />}
      </Async>
    </div>
  );
}

function RunView({ run, projectId, onChanged }: { run: Run; projectId: string; onChanged(): void }) {
  const { api } = useHub();
  const [metricsWindow, setMetricsWindow] = useState<MetricsWindow>('24h');
  const [tab, setTab] = useState<Tab>('map');
  const [selection, setSelection] = useState<Selection>(null);
  const [adding, setAdding] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const isRunEvent = (e: { runId?: string }) => e.runId === run.id;
  const versions = useResource((a) => a.listVersions(run.workflowId), [run.workflowId], (e) => e.subject.kind === 'workflow' && e.subject.id === run.workflowId);
  const metrics = useResource((a) => a.runMetrics(run.id, metricsWindow), [run.id, metricsWindow], isRunEvent, METRICS_REFRESH);
  const items = useResource((a) => a.listWorkItems(run.id), [run.id], (e) => isRunEvent(e) && (e.type.startsWith('workitem') || e.type === 'gate.result'));
  const assignments = useResource((a) => a.listAssignments(run.id), [run.id], (e) => isRunEvent(e) && e.type.startsWith('assignment'));
  const machines = useResource((a) => a.listMachines(), [], (e) => e.subject.kind === 'machine');
  const { events, fresh } = useRunEvents(run.id);

  const version = versions.data?.find((v) => v.version === run.workflowVersion);
  const draft = versions.data?.find((v) => v.status === 'draft' && v.version > run.workflowVersion);

  async function act(fn: () => Promise<Run>, what: string) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setActionError(`Could not ${what} the run. ${(err as Error).message}`);
    } finally {
      setBusy(false);
      setStopping(false);
    }
  }

  const live = run.status === 'running' || run.status === 'paused';
  const top = metrics.data?.bottlenecks.filter((b) => b.severity !== 'info') ?? [];

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link activeOptions={{ exact: true }} to="/projects/$projectId/runs" params={{ projectId }}>
          Runs
        </Link>
        <span aria-hidden="true">/</span>
        <Mono>{run.id}</Mono>
      </nav>
      <PageHeader
        title={version ? `${version.name} run` : 'Run'}
        meta={
          <>
            <RunStatusLabel status={run.status} />
            <span>
              Workflow version <span className="mono">v{run.workflowVersion}</span>
            </span>
            <span>Started {relative(run.startedAt)}</span>
            {run.stoppedAt && <span>Ended {relative(run.stoppedAt)}</span>}
          </>
        }
        actions={
          live && (
            <>
              <Button onClick={() => setAdding(true)}>
                <IconPlus /> Add input
              </Button>
              {run.status === 'running' ? (
                <Button onClick={() => act(() => api.pauseRun(run.id), 'pause')} busy={busy}>
                  <IconPause /> Pause
                </Button>
              ) : (
                <Button variant="primary" onClick={() => act(() => api.resumeRun(run.id), 'resume')} busy={busy}>
                  <IconPlay /> Resume
                </Button>
              )}
              <Button variant="danger" onClick={() => setStopping(true)}>
                <IconStop /> Stop
              </Button>
            </>
          )
        }
      />
      {actionError && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}
      {run.status === 'paused' && (
        <div className="callout callout-warning">
          <div className="callout-body">
            <span className="callout-title">Paused. No new assignments start until you resume.</span>
            <span className="muted">Work already leased to a machine may still report its result.</span>
          </div>
        </div>
      )}
      {top.map((b, i) => (
        <div key={`${b.nodeId}-${b.reason}`} className={`callout callout-${b.severity}`}>
          <div className="callout-body">
            <span className="callout-title">
              {version?.graph.nodes.find((n) => n.id === b.nodeId)?.label ?? b.nodeId}: {BOTTLENECK_LABEL[b.reason].toLowerCase()}
            </span>
            <span>{b.evidence}</span>
          </div>
          <div className="callout-actions">
            <Button size="sm" variant="ghost" onClick={() => setSelection({ kind: 'node', id: b.nodeId })}>
              Show on map
            </Button>
            {draft && b.severity === 'critical' && top.findIndex((x) => x.severity === 'critical') === i && (
              <Link to="/projects/$projectId/workflows/$workflowId" params={{ projectId, workflowId: run.workflowId }} search={{ version: draft.version }} className="btn btn-secondary btn-sm">
                Review proposed v{draft.version}
              </Link>
            )}
          </div>
        </div>
      ))}

      <div className="tabs-bar">
        <div role="tablist" aria-label="Run views" className="tabs">
          {(
            [
              ['map', 'Live map'],
              ['work', `Work items${items.data ? ` · ${items.data.length}` : ''}`],
              ['assignments', `Assignments${assignments.data ? ` · ${assignments.data.length}` : ''}`],
              ['timeline', 'Timeline'],
            ] as [Tab, string][]
          ).map(([value, label]) => (
            <button key={value} role="tab" id={`tab-${value}`} aria-selected={tab === value} aria-controls={`panel-${value}`} className="tab" onClick={() => setTab(value)}>
              {label}
            </button>
          ))}
        </div>
        {tab === 'map' && (
          <Segmented<MetricsWindow>
            label="Metrics window"
            value={metricsWindow}
            onChange={setMetricsWindow}
            options={[
              { value: '1h', label: '1 h' },
              { value: '24h', label: '24 h' },
              { value: '7d', label: '7 d' },
            ]}
          />
        )}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'map' &&
          (version && metrics.data ? (
            <div className="stack">
              <div className="stack-sm">
                <GraphCanvas
                  graph={version.graph}
                  mode="live"
                  label={`Live map of ${version.name} run`}
                  live={{ metrics: metrics.data, items: items.data ?? [] }}
                  selection={selection}
                  onSelect={setSelection}
                  className="graph-map"
                />
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <EdgeLegend live />
                  <ul className="edge-legend" aria-label="Work item markers">
                    <li>
                      <span className="marker marker-active" aria-hidden="true" /> Active
                    </li>
                    <li>
                      <span className="marker" aria-hidden="true" /> Queued
                    </li>
                    <li>
                      <span className="marker marker-failed" aria-hidden="true" /> Failed
                    </li>
                  </ul>
                </div>
              </div>
              <div className="live-layout">
                <div className="stack">
                  {selection && (
                    <SelectionPanel selection={selection} graph={version.graph} metrics={metrics.data} assignments={assignments.data ?? []} items={items.data ?? []} machines={machines.data ?? []} onClear={() => setSelection(null)} />
                  )}
                  <Panel
                    title={selection ? `Interactions: ${selectionName(selection, version.graph, metrics.data)}` : 'Interactions'}
                    actions={
                      selection && (
                        <Button size="sm" variant="ghost" onClick={() => setSelection(null)}>
                          Show all
                        </Button>
                      )
                    }
                    flush
                  >
                    <InteractionFeed events={events} fresh={fresh} graph={version.graph} selection={selection} items={items.data} machines={machines.data} />
                  </Panel>
                  <NodeTable graph={version.graph} metrics={metrics.data} selection={selection} onSelect={setSelection} />
                </div>
                <div className="live-side">
                  <BottlenecksPanel bottlenecks={metrics.data.bottlenecks} graph={version.graph} onSelect={setSelection} />
                  <VelocityPanel metrics={metrics.data} />
                  <WhereRunningPanel metrics={metrics.data} machines={machines.data ?? []} assignments={assignments.data ?? []} graph={version.graph} onSelect={setSelection} />
                </div>
              </div>
            </div>
          ) : (
            <Async<unknown> resource={(metrics.error ? metrics : versions.error ? versions : { ...metrics, data: undefined }) as Resource<unknown>} what="the live map">
              {() => null}
            </Async>
          ))}
        {tab === 'work' && (
          <Async resource={items} what="work items">
            {(list) => <WorkBoard items={list} graph={version?.graph} />}
          </Async>
        )}
        {tab === 'assignments' && (
          <Async resource={assignments} what="assignments">
            {(list) => <AssignmentsTable assignments={list} items={items.data ?? []} machines={machines.data ?? []} graph={version?.graph} />}
          </Async>
        )}
        {tab === 'timeline' && version && (
          <Panel title="Timeline" flush>
            <InteractionFeed events={events} fresh={fresh} graph={version.graph} selection={null} limit={60} onlyInteractions={false} items={items.data} machines={machines.data} />
          </Panel>
        )}
      </div>

      <AddInputDialog open={adding} onClose={() => setAdding(false)} runId={run.id} />
      <Dialog
        open={stopping}
        onClose={() => setStopping(false)}
        title="Stop this run?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setStopping(false)}>
              Keep running
            </Button>
            <Button variant="danger" busy={busy} onClick={() => act(() => api.stopRun(run.id), 'stop')}>
              Stop run
            </Button>
          </>
        }
      >
        <p>A stopped run cannot be resumed. Pause instead if you want to continue later. Branches and pull requests already opened stay where they are.</p>
      </Dialog>
    </>
  );
}

/** The map's numbers as a table: readable at any width and by screen readers. */
function NodeTable({ graph, metrics, selection, onSelect }: { graph: WorkflowGraph; metrics: MetricsSnapshot; selection: Selection; onSelect(s: Selection): void }) {
  const rows = graph.nodes.filter((n) => n.type !== 'input' && n.type !== 'output');
  const bottleneck = new Map(metrics.bottlenecks.map((b) => [b.nodeId, b]));
  return (
    <Panel title="Nodes" flush>
      <div className="table-wrap">
        <table className="table table-compact">
          <caption className="visually-hidden">Live node metrics</caption>
          <thead>
            <tr>
              <th scope="col">Node</th>
              <th scope="col" className="num">Active</th>
              <th scope="col" className="num">Queued</th>
              <th scope="col" className="num">Utilization</th>
              <th scope="col" className="num hide-sm">Wait p90</th>
              <th scope="col" className="num hide-sm">Per hour</th>
              <th scope="col" className="hide-sm">Bottleneck</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => {
              const m = metrics.nodes.find((x) => x.nodeId === n.id);
              const b = bottleneck.get(n.id);
              return (
                <tr key={n.id} className={selection?.kind === 'node' && selection.id === n.id ? 'is-selected' : ''}>
                  <th scope="row" style={{ fontWeight: 400, color: 'inherit', fontSize: 'inherit' }}>
                    <button type="button" className="chip-button" onClick={() => onSelect({ kind: 'node', id: n.id })}>
                      {n.label}
                    </button>
                  </th>
                  <td className="num">{m?.active ?? 0}{m?.concurrency ? <span className="muted"> / {m.concurrency}</span> : null}</td>
                  <td className="num">{m?.queued ?? 0}</td>
                  <td className="num">{m?.concurrency && n.type !== 'loop' ? pct(m.utilization) : '—'}</td>
                  <td className="num hide-sm">{m && n.type !== 'loop' ? duration(m.waitSec.p90) : '—'}</td>
                  <td className="num hide-sm">{m ? rate(m.throughputPerHour) : '—'}</td>
                  <td className="hide-sm">{b ? <StatusLabel tone={b.severity === 'critical' ? 'error' : b.severity === 'warning' ? 'warning' : 'neutral'}>{BOTTLENECK_LABEL[b.reason]}</StatusLabel> : <span className="muted">None</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function selectionName(selection: NonNullable<Selection>, graph: WorkflowGraph, metrics: MetricsSnapshot) {
  if (selection.kind === 'node') return graph.nodes.find((n) => n.id === selection.id)?.label ?? selection.id;
  const e = graph.edges.find((x) => x.id === selection.id);
  const name = (id?: string | null) => graph.nodes.find((n) => n.id === id || n.config?.role === id)?.label ?? id ?? '—';
  if (e) return `${name(e.from.node)} → ${name(e.to.node)}`;
  const u = metrics.edges.find((x) => x.edgeId === selection.id);
  return u ? `${name(u.from)} → ${name(u.to)}, unplanned` : selection.id;
}

function SelectionPanel({
  selection,
  graph,
  metrics,
  assignments,
  items,
  machines,
  onClear,
}: {
  selection: NonNullable<Selection>;
  graph: WorkflowGraph;
  metrics: MetricsSnapshot;
  assignments: Assignment[];
  items: WorkItem[];
  machines: Machine[];
  onClear(): void;
}) {
  if (selection.kind === 'edge') {
    const e = graph.edges.find((x) => x.id === selection.id);
    const m = metrics.edges.find((x) => x.edgeId === selection.id);
    const name = (id?: string | null) => graph.nodes.find((n) => n.id === id || n.config?.role === id)?.label ?? id ?? '—';
    return (
      <Panel title="Connection" actions={<Button size="sm" variant="ghost" onClick={onClear}>Clear</Button>}>
        <dl className="kv">
          <dt>Kind</dt>
          <dd>{m?.unplanned ? `${m.kind}, unplanned` : (e?.kind ?? m?.kind)}</dd>
          <dt>From</dt>
          <dd>
            {name(e?.from.node ?? m?.from)}
            {e?.from.port ? ` (${e.from.port})` : ''}
          </dd>
          <dt>To</dt>
          <dd>{name(e?.to.node ?? m?.to)}</dd>
          <dt>Traffic</dt>
          <dd className="tabular">
            {m?.count ?? 0} in {metrics.window}
          </dd>
        </dl>
        {m?.unplanned && <p className="note" style={{ marginTop: 12 }}>No edge in the workflow connects these roles. The interaction was recorded rather than blocked. Add a messages connection if it should be allowed, or tighten the agents’ prompts.</p>}
      </Panel>
    );
  }
  const node = graph.nodes.find((n) => n.id === selection.id);
  const m = metrics.nodes.find((x) => x.nodeId === selection.id);
  const here = assignments.filter((a) => a.nodeId === selection.id && ['running', 'leased', 'queued'].includes(a.status));
  const machineName = (id?: string) => machines.find((x) => x.id === id)?.name ?? id ?? 'Not leased';
  const nodeItems = items.filter((i) => i.nodeId === selection.id && i.status !== 'done');
  return (
    <Panel title={node?.label ?? selection.id} actions={<Button size="sm" variant="ghost" onClick={onClear}>Clear</Button>} flush>
      {m && (
        <dl className="figures">
          <div>
            <dt>Active</dt>
            <dd>
              {m.active}
              {m.concurrency ? <span className="muted"> of {m.concurrency}</span> : null}
            </dd>
          </div>
          <div>
            <dt>Queued</dt>
            <dd>{m.queued}</dd>
          </div>
          <div>
            <dt>Utilization</dt>
            <dd>{m.concurrency ? pct(m.utilization) : '—'}</dd>
          </div>
          <div>
            <dt>Wait avg / p90</dt>
            <dd>
              {duration(m.waitSec.avg)} <span className="muted">/ {duration(m.waitSec.p90)}</span>
            </dd>
          </div>
          <div>
            <dt>Service avg / p90</dt>
            <dd>
              {duration(m.serviceSec.avg)} <span className="muted">/ {duration(m.serviceSec.p90)}</span>
            </dd>
          </div>
          <div>
            <dt>Throughput</dt>
            <dd>{rate(m.throughputPerHour)}/h</dd>
          </div>
          <div>
            <dt>Failure rate</dt>
            <dd>{pct(m.failureRate)}</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>{tokens(m.tokens)}</dd>
          </div>
        </dl>
      )}
      {node && NODE_SPECS[node.type].role ? (
        here.length === 0 ? (
          <p className="panel-body muted">No assignments are queued or running here.</p>
        ) : (
          <ul className="ruled-list">
            {here.map((a) => (
              <li key={a.id} className="stack-sm" style={{ gap: 4 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="cell-title">{items.find((i) => i.id === a.workItemId)?.title ?? a.workItemId}</span>
                  <AssignmentStatusLabel status={a.status} />
                </div>
                <span className="note">
                  {machineName(a.machineId)} · {providerLabel(a.harness.provider)} · <code className="mono">{a.harness.model}</code>
                  {a.attempt > 1 ? ` · attempt ${a.attempt}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : nodeItems.length ? (
        <ul className="ruled-list">
          {nodeItems.map((i) => (
            <li key={i.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>{i.title}</span>
              <StatusLabel tone={i.status === 'failed' ? 'error' : i.status === 'active' ? 'accent' : 'neutral'}>{i.status === 'failed' ? `Failed at iteration ${i.iteration}` : i.status}</StatusLabel>
            </li>
          ))}
        </ul>
      ) : (
        <p className="panel-body muted">No work items are waiting here.</p>
      )}
    </Panel>
  );
}

function AssignmentsTable({ assignments, items, machines, graph }: { assignments: Assignment[]; items: WorkItem[]; machines: Machine[]; graph?: WorkflowGraph }) {
  if (assignments.length === 0) return <Empty title="No assignments yet.">The engine creates assignments as work items reach agent roles.</Empty>;
  const order = { running: 0, leased: 1, queued: 2, failed: 3, succeeded: 4, cancelled: 5 } as const;
  const sorted = [...assignments].sort((a, b) => order[a.status] - order[b.status]);
  return (
    <div className="panel panel-flush table-wrap">
      <table className="table">
        <caption className="visually-hidden">Assignments</caption>
        <thead>
          <tr>
            <th scope="col">Work item</th>
            <th scope="col">Role</th>
            <th scope="col">Machine</th>
            <th scope="col" className="hide-sm">Harness</th>
            <th scope="col">Status</th>
            <th scope="col" className="num hide-sm">Attempt</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((a) => (
            <tr key={a.id}>
              <td>
                <span className="cell-title">{items.find((i) => i.id === a.workItemId)?.title ?? a.workItemId}</span>
                {a.result?.summary && <span className="note">{a.result.summary}</span>}
              </td>
              <td>{graph?.nodes.find((n) => n.id === a.nodeId)?.label ?? a.role}</td>
              <td>{machines.find((m) => m.id === a.machineId)?.name ?? <span className="muted">Not leased</span>}</td>
              <td className="hide-sm">
                {providerLabel(a.harness.provider)} <Mono>{a.harness.model}</Mono>
              </td>
              <td>
                <AssignmentStatusLabel status={a.status} />
              </td>
              <td className="num hide-sm">{a.attempt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddInputDialog({ open, onClose, runId }: { open: boolean; onClose(): void; runId: string }) {
  const { api } = useHub();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setError('Give the input a title.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.addRunInput(runId, { title: title.trim(), body: body.trim() || undefined });
      setDone(`Added "${title.trim()}". It enters the run at its input node.`);
      setTitle('');
      setBody('');
    } catch (err) {
      setError(`Input was not added. ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    setDone(null);
    setError(null);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add input to this run"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {done ? 'Done' : 'Cancel'}
          </Button>
          <Button variant="primary" type="submit" form="add-input" busy={busy}>
            Add input
          </Button>
        </>
      }
    >
      <form id="add-input" className="form" onSubmit={submit}>
        <Field label="Title" htmlFor="in-title">
          <input id="in-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Details" htmlFor="in-body" hint="Context, acceptance criteria, links. The planner reads this.">
          <textarea id="in-body" className="input" rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {done && (
          <p role="status">
            <StatusLabel tone="success">{done}</StatusLabel>
          </p>
        )}
      </form>
    </Dialog>
  );
}
