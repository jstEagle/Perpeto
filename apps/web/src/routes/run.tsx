import { useRef, useState } from 'react';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { useHub, useResource } from '../app/hub-context';
import type { Resource } from '../app/hub-context';
import type { Assignment, Machine, MetricsSnapshot, MetricsWindow, Run, WorkItem, WorkflowGraph } from '../api/types';
import { Async, btn, Button, Dialog, Disclosure, Field, Menu, Mono, PageHeader, Panel, Segmented, Stat } from '../components/ui';
import { AssignmentStatusLabel, runTone, StatusChip, StatusLabel, WorkStatusLabel } from '../components/status';
import { IconAlert, IconPause, IconPlay, IconPlus, IconSettings, IconStop } from '../components/icons';
import { GraphCanvas } from '../workflow/graph-canvas';
import type { Selection } from '../workflow/graph-canvas';
import { BOTTLENECK_LABEL } from '../workflow/step-node';
import { StepList } from '../workflow/step-list';
import { NODE_SPECS, providerLabel } from '../workflow/registry';
import { INTERACTION_TYPES, InteractionFeed, useRunEvents } from '../run/feed';
import { VelocityPanel, WhereRunningPanel } from '../run/panels';
import { bottleneckTitle, byUrgency } from '../run/issues';
import { WorkBoard } from '../run/board';
import { BudgetLine, IntakePaused, RunSettingsDialog } from '../run/intake';
import { countActive, intakeSummary } from '../run/budget';
import { duration, pct, plural, rate, relative, tokens } from '../lib/format';

type Tab = 'map' | 'work' | 'timeline';

/** Metrics are recomputed by the hub per request; coalesce bursts of events into one fetch a second, at most every 4 s. */
const METRICS_REFRESH = { debounceMs: 1000, maxWaitMs: 4000 };

export function RunPage() {
  const { projectId, runId } = useParams({ from: '/projects/$projectId/runs/$runId' });
  const { node } = useSearch({ from: '/projects/$projectId/runs/$runId' });
  const run = useResource((api) => api.getRun(runId), [runId], (e) => (e.subject.kind === 'run' && e.subject.id === runId) || (e.runId === runId && e.type.startsWith('budget.')));
  return (
    <div className="page">
      <Async resource={run} what="run">
        {(r) => <RunView run={r} projectId={projectId} onChanged={run.reload} initialNode={node} />}
      </Async>
    </div>
  );
}

function RunView({ run, projectId, onChanged, initialNode }: { run: Run; projectId: string; onChanged(): void; initialNode?: string }) {
  const { api } = useHub();
  const [metricsWindow, setMetricsWindow] = useState<MetricsWindow>('24h');
  const [tab, setTab] = useState<Tab>('map');
  const [selection, setSelection] = useState<Selection>(initialNode ? { kind: 'node', id: initialNode } : null);
  const [focus, setFocus] = useState<{ id: string } | undefined>(initialNode ? { id: initialNode } : undefined);
  const mapRef = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const isRunEvent = (e: { runId?: string }) => e.runId === run.id;
  const versions = useResource((a) => a.listVersions(run.workflowId), [run.workflowId], (e) => e.subject.kind === 'workflow' && e.subject.id === run.workflowId);
  const metrics = useResource((a) => a.runMetrics(run.id, metricsWindow), [run.id, metricsWindow], isRunEvent, METRICS_REFRESH);
  const items = useResource((a) => a.listWorkItems(run.id), [run.id], (e) => isRunEvent(e) && (e.type.startsWith('workitem') || e.type === 'gate.result'));
  const assignments = useResource((a) => a.listAssignments(run.id), [run.id], (e) => isRunEvent(e) && e.type.startsWith('assignment'));
  const machines = useResource((a) => a.listMachines(), [], (e) => e.subject.kind === 'machine');
  const { events, fresh, hasOlder, loadingOlder, loadOlder } = useRunEvents(run.id);
  const olderProps = { hasOlder, loadingOlder, onOlder: () => void loadOlder() };

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
  // Leaf work in progress, as the budget counts it: a parent waiting on its children is not active.
  const activeItems = items.data && countActive(items.data);
  const issues = byUrgency(metrics.data?.bottlenecks.filter((b) => b.severity !== 'info') ?? []);
  const today = events?.filter((e) => INTERACTION_TYPES.has(e.type) && e.at.slice(0, 10) === new Date().toISOString().slice(0, 10)).length;
  // Select the step, bring the map on screen, and scroll or pan the map to the step.
  const showOnMap = (nodeId: string) => {
    setTab('map');
    setSelection({ kind: 'node', id: nodeId });
    setFocus({ id: nodeId });
    requestAnimationFrame(() => mapRef.current?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }));
  };

  return (
    <>
      <PageHeader
        back={{ label: 'Runs', to: '/projects/$projectId/runs', params: { projectId } }}
        title={version ? `${version.name} run` : 'Run'}
        status={
          <StatusChip tone={runTone(run.status)}>
            <RunStatusText status={run.status} />
          </StatusChip>
        }
        meta={
          <>
            <Mono>{run.id}</Mono> · Workflow v{run.workflowVersion} · Started {relative(run.startedAt)}
            {run.completedAt ? ` · Completed ${relative(run.completedAt)}` : run.stoppedAt ? ` · ${run.status === 'failed' ? 'Failed' : 'Stopped'} ${relative(run.stoppedAt)}` : ''}
          </>
        }
        actions={
          live && (
            <>
              {run.status === 'running' ? (
                <Button onClick={() => act(() => api.pauseRun(run.id), 'pause')} busy={busy}>
                  <IconPause /> Pause
                </Button>
              ) : (
                <Button variant={issues.length && draft ? 'secondary' : 'primary'} onClick={() => act(() => api.resumeRun(run.id), 'resume')} busy={busy}>
                  <IconPlay /> Resume
                </Button>
              )}
              <Button onClick={() => setStopping(true)}>
                <IconStop /> Stop
              </Button>
              <Menu
                label="More run actions"
                items={[
                  { label: 'Add input', icon: <IconPlus />, onSelect: () => setAdding(true) },
                  { label: 'Run settings', icon: <IconSettings />, onSelect: () => setSettingsOpen(true) },
                ]}
              />
            </>
          )
        }
      />
      {actionError && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}
      {live && (
        <section className="run-intake" aria-label="Intake and budget">
          <span className="run-intake-text">{intakeSummary(run)}</span>
          <BudgetLine run={run} activeItems={activeItems} />
          <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>
            Settings
          </Button>
        </section>
      )}
      {live && <IntakePaused run={run} onChange={() => setSettingsOpen(true)} />}
      {run.status === 'paused' && (
        <div className="callout" role="status">
          <IconPause />
          <div className="callout-body">
            <span className="callout-title">Paused. No new assignments start until you resume.</span>
            <span>Work already leased to a machine may still report its result.</span>
          </div>
        </div>
      )}
      {issues.length > 0 && (
        <section className="card" aria-label="Needs attention">
          <div className="issue-card">
            <div className="issue">
              <span className="issue-icon">
                <IconAlert />
              </span>
              <div className="issue-main">
                <h2 className="issue-title">{bottleneckTitle(issues[0], version?.graph)}</h2>
                <p className="issue-text">{issues[0].evidence.charAt(0).toUpperCase() + issues[0].evidence.slice(1)}</p>
              </div>
            </div>
            <div className="issue-actions">
              <Button variant="ghost" onClick={() => showOnMap(issues[0].nodeId)}>
                Show on map
              </Button>
              {draft && (
                <Link to="/projects/$projectId/workflows/$workflowId" params={{ projectId, workflowId: run.workflowId }} search={{ version: draft.version }} className={btn('primary')}>
                  Review proposal
                </Link>
              )}
            </div>
          </div>
          {issues.length > 1 && (
            <div className="issue-more">
              <Disclosure summary={issues.length === 2 ? '1 more issue' : `${issues.length - 1} more issues`}>
                {issues.slice(1).map((b) => (
                  <div className="issue" key={`${b.nodeId}-${b.reason}`}>
                    <span className="issue-icon">
                      <IconAlert />
                    </span>
                    <div className="issue-main">
                      <h3 className="issue-title">{bottleneckTitle(b, version?.graph)}</h3>
                      <p className="issue-text">{b.evidence}</p>
                      <div className="issue-actions">
                        <Button variant="ghost" size="sm" onClick={() => showOnMap(b.nodeId)}>
                          Show on map
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </Disclosure>
            </div>
          )}
        </section>
      )}

      <div className="toolbar">
        <Segmented<Tab>
          label="Run views"
          className="seg-fill"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'map', label: 'Live map' },
            { value: 'work', label: 'Work', count: items.data?.length },
            { value: 'timeline', label: 'Timeline' },
          ]}
        />
        {tab === 'map' && (
          <Segmented<MetricsWindow>
            label="Metrics window"
            className="hide-sm"
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

      {tab === 'map' &&
        (version && metrics.data ? (
          <>
            <div className="hide-sm" ref={mapRef}>
              <GraphCanvas
                focus={focus}
                graph={version.graph}
                mode="live"
                label={`Live map of ${version.name} run`}
                live={{ metrics: metrics.data, items: items.data ?? [] }}
                selection={selection}
                onSelect={setSelection}
                className="graph-map"
              />
            </div>
            <StepList graph={version.graph} metrics={metrics.data} selection={selection} onSelect={setSelection} className="only-mobile" />
            <div className="cols">
              <div className="stack">
                {selection && (
                  <SelectionPanel selection={selection} graph={version.graph} metrics={metrics.data} assignments={assignments.data ?? []} items={items.data ?? []} machines={machines.data ?? []} onClear={() => setSelection(null)} />
                )}
                <Panel title={selection ? `Activity at ${selectionName(selection, version.graph, metrics.data)}` : 'Activity'} actions={!selection && today !== undefined ? `${plural(today, 'event')} today` : undefined}>
                  <InteractionFeed events={events} fresh={fresh} graph={version.graph} selection={selection} limit={5} items={items.data} machines={machines.data} {...olderProps} />
                </Panel>
              </div>
              <div className="stack">
                <VelocityPanel metrics={metrics.data} />
                <WhereRunningPanel metrics={metrics.data} machines={machines.data ?? []} />
              </div>
            </div>
            <section className="card" aria-label="Node details">
              <Disclosure summary="Node details">
                <NodeTable graph={version.graph} metrics={metrics.data} selection={selection} onSelect={setSelection} />
              </Disclosure>
            </section>
          </>
        ) : (
          <Async<unknown> resource={(metrics.error ? metrics : versions.error ? versions : { ...metrics, data: undefined }) as Resource<unknown>} what="the live map">
            {() => null}
          </Async>
        ))}
      {tab === 'work' && (
        <Async resource={items} what="work items">
          {(list) => (
            <>
              <WorkBoard items={list} graph={version?.graph} onStale={items.reload} />
              <section className="card" aria-label="Assignments">
                <Disclosure summary={`Assignments${assignments.data ? ` · ${assignments.data.length}` : ''}`}>
                  <Async resource={assignments} what="assignments">
                    {(rows) => <AssignmentsTable assignments={rows} items={list} machines={machines.data ?? []} graph={version?.graph} />}
                  </Async>
                </Disclosure>
              </section>
            </>
          )}
        </Async>
      )}
      {tab === 'timeline' && version && (
        <Panel title="Timeline" actions={events ? `${plural(events.length, 'event')} loaded` : undefined}>
          <InteractionFeed events={events} fresh={fresh} graph={version.graph} selection={null} limit={60} onlyInteractions={false} items={items.data} machines={machines.data} {...olderProps} />
        </Panel>
      )}

      <AddInputDialog open={adding} onClose={() => setAdding(false)} runId={run.id} />
      {live && (
        <RunSettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          target={{ kind: 'edit', run }}
          onDone={() => {
            setSettingsOpen(false);
            onChanged();
          }}
        />
      )}
      <Dialog
        open={stopping}
        onClose={() => setStopping(false)}
        title="Stop this run?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setStopping(false)}>
              Keep running
            </Button>
            <Button variant="primary" busy={busy} onClick={() => act(() => api.stopRun(run.id), 'stop')}>
              Stop run
            </Button>
          </>
        }
      >
        <p className="muted">A stopped run cannot be resumed. Pause instead if you want to continue later. Branches and pull requests already opened stay where they are.</p>
      </Dialog>
    </>
  );
}

function RunStatusText({ status }: { status: Run['status'] }) {
  return <>{{ running: 'Running', paused: 'Paused', stopped: 'Stopped', completed: 'Completed', failed: 'Failed' }[status]}</>;
}

/** The map's numbers as a table: readable at any width and by screen readers. */
function NodeTable({ graph, metrics, selection, onSelect }: { graph: WorkflowGraph; metrics: MetricsSnapshot; selection: Selection; onSelect(s: Selection): void }) {
  const rows = graph.nodes.filter((n) => n.type !== 'input' && n.type !== 'output');
  const bottleneck = new Map(metrics.bottlenecks.map((b) => [b.nodeId, b]));
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="visually-hidden">Live node metrics</caption>
        <thead>
          <tr>
            <th scope="col">Node</th>
            <th scope="col" className="num">Active</th>
            <th scope="col" className="num">Queued</th>
            <th scope="col" className="num">Utilization</th>
            <th scope="col" className="num">Wait p90</th>
            <th scope="col" className="num">Per hour</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => {
            const m = metrics.nodes.find((x) => x.nodeId === n.id);
            const b = bottleneck.get(n.id);
            return (
              <tr key={n.id} aria-selected={selection?.kind === 'node' && selection.id === n.id}>
                <td>
                  <button type="button" className="cell-button" onClick={() => onSelect({ kind: 'node', id: n.id })}>
                    {n.label}
                  </button>
                </td>
                <td className="num">
                  {m?.active ?? 0}
                  {m?.concurrency ? <span className="muted"> / {m.concurrency}</span> : null}
                </td>
                <td className="num">{m?.queued ?? 0}</td>
                <td className="num">{m?.concurrency && n.type !== 'loop' ? pct(m.utilization) : '—'}</td>
                <td className="num">{m && n.type !== 'loop' ? duration(m.waitSec.p90) : '—'}</td>
                <td className="num">{m ? rate(m.throughputPerHour) : '—'}</td>
                <td>{b ? <StatusLabel tone={b.severity === 'info' ? 'quiet' : 'attention'}>{BOTTLENECK_LABEL[b.reason]}</StatusLabel> : m?.active ? <StatusLabel tone="live">Working</StatusLabel> : <StatusLabel tone="quiet">Idle</StatusLabel>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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
      <Panel title="Connection" actions={<button type="button" className="text-btn" onClick={onClear}>Clear</button>}>
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
        {m?.unplanned && <p className="note card-foot">No edge in the workflow connects these roles. The interaction was recorded rather than blocked. Add a messages connection if it should be allowed, or tighten the agents’ prompts.</p>}
      </Panel>
    );
  }
  const node = graph.nodes.find((n) => n.id === selection.id);
  const m = metrics.nodes.find((x) => x.nodeId === selection.id);
  const here = assignments.filter((a) => a.nodeId === selection.id && ['running', 'leased', 'queued'].includes(a.status));
  const machineName = (id?: string) => machines.find((x) => x.id === id)?.name ?? id ?? 'Not leased';
  const nodeItems = items.filter((i) => i.nodeId === selection.id && i.status !== 'done');
  return (
    <Panel title={node?.label ?? selection.id} actions={<button type="button" className="text-btn" onClick={onClear}>Clear</button>}>
      {m && (
        <>
          <dl className="metrics metrics-small">
            <Stat label="Active" value={m.concurrency ? `${m.active} of ${m.concurrency}` : m.active} />
            <Stat label="Queued" value={m.queued} />
            <Stat label="Utilization" value={m.concurrency ? pct(m.utilization) : '—'} />
          </dl>
          <div className="card-foot">
            <Disclosure summary="More numbers">
              <dl className="kv">
                <dt>Wait avg, p90</dt>
                <dd>
                  {duration(m.waitSec.avg)}, {duration(m.waitSec.p90)}
                </dd>
                <dt>Service avg, p90</dt>
                <dd>
                  {duration(m.serviceSec.avg)}, {duration(m.serviceSec.p90)}
                </dd>
                <dt>Throughput</dt>
                <dd>{rate(m.throughputPerHour)} per hour</dd>
                <dt>Failure rate</dt>
                <dd>{pct(m.failureRate)}</dd>
                <dt>Tokens</dt>
                <dd>{tokens(m.tokens)}</dd>
              </dl>
            </Disclosure>
          </div>
        </>
      )}
      <div className="card-foot">
      {node && NODE_SPECS[node.type].role ? (
        here.length === 0 ? (
          <p className="muted">No assignments are queued or running here.</p>
        ) : (
          <ul className="rows">
            {here.map((a) => (
              <li key={a.id}>
                <span className="row-main">
                  <span className="row-title">{items.find((i) => i.id === a.workItemId)?.title ?? a.workItemId}</span>
                  <span className="row-meta">
                    <span className="mono">{machineName(a.machineId)}</span> · {providerLabel(a.harness.provider)} · <span className="mono">{a.harness.model}</span>
                    {a.attempt > 1 ? ` · attempt ${a.attempt}` : ''}
                  </span>
                </span>
                <span className="row-end">
                  <AssignmentStatusLabel status={a.status} />
                </span>
              </li>
            ))}
          </ul>
        )
      ) : nodeItems.length ? (
        <ul className="rows">
          {nodeItems.map((i) => (
            <li key={i.id}>
              <span className="row-main">
                <span className="row-title">{i.title}</span>
              </span>
              <span className="row-end">
                {i.status === 'failed' ? <StatusLabel tone="failed">Failed at iteration {i.iteration}</StatusLabel> : <WorkStatusLabel status={i.status} />}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No work items are waiting here.</p>
      )}
      </div>
    </Panel>
  );
}

function AssignmentsTable({ assignments, items, machines, graph }: { assignments: Assignment[]; items: WorkItem[]; machines: Machine[]; graph?: WorkflowGraph }) {
  if (assignments.length === 0) return <p className="muted">The engine creates assignments as work items reach agent roles.</p>;
  const order = { running: 0, leased: 1, queued: 2, failed: 3, succeeded: 4, cancelled: 5 } as const;
  const sorted = [...assignments].sort((a, b) => order[a.status] - order[b.status]);
  return (
    <div className="table-wrap">
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
                {a.result?.summary && <span className="cell-sub">{a.result.summary}</span>}
              </td>
              <td>{graph?.nodes.find((n) => n.id === a.nodeId)?.label ?? a.role}</td>
              <td>{machines.find((m) => m.id === a.machineId) ? <Mono>{machines.find((m) => m.id === a.machineId)!.name}</Mono> : <span className="muted">Not leased</span>}</td>
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
            <StatusLabel tone="done">{done}</StatusLabel>
          </p>
        )}
      </form>
    </Dialog>
  );
}
