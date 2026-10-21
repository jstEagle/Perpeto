import { useCallback, useEffect, useState } from 'react';
import { useHub } from '../app/hub-context';
import type { HubEvent, InteractionData, Machine, WorkItem, WorkflowGraph } from '../api/types';
import { Loading } from '../components/ui';
import { clock } from '../lib/format';
import type { Selection } from '../workflow/graph-canvas';

export const INTERACTION_TYPES = new Set(['workitem.moved', 'agent.delegated', 'agent.messaged', 'assignment.state', 'gate.result']);

const TYPE_LABEL: Record<string, string> = {
  'workitem.moved': 'Moved',
  'agent.delegated': 'Delegated',
  'agent.messaged': 'Message',
  'assignment.state': 'Assignment',
  'gate.result': 'Gate',
};

const GATE_FAILED = new Set(['fail', 'failed', 'error', 'rejected', 'blocked', 'cancelled']);

const STATE_WORD: Record<string, string> = {
  queued: 'queued',
  leased: 'leased',
  running: 'started',
  succeeded: 'finished',
  failed: 'failed',
  cancelled: 'was cancelled',
};

/**
 * One sentence per event. The demo supplies `summary`; hub events carry
 * only ids, so the sentence is written from the graph's labels.
 */
export interface Names {
  node(id?: string): string;
  item?(id?: string): string | undefined;
  machine?(id?: string): string | undefined;
}

export function describeEvent(e: HubEvent, names: Names): string {
  const d = e.data as InteractionData & { summary?: string };
  if (d.summary) return d.summary;
  const name = names.node;
  const machine = names.machine ?? (() => undefined);
  const from = name(d.sourceNodeId ?? d.nodeId);
  const to = name(d.targetNodeId);
  const title = names.item?.(d.workItemId);
  switch (e.type) {
    case 'workitem.moved':
      return title ? `"${title}" moved from ${from} to ${to}` : `A work item moved from ${from} to ${to}`;
    case 'agent.delegated':
      return `${from} delegated to ${to}`;
    case 'agent.messaged':
      return `${name(d.senderRoleId) || from} messaged ${name(d.recipientRoleId) || to}`;
    case 'assignment.state': {
      const where = machine(d.machineId);
      const attempt = d.attempt && d.attempt > 1 ? `, attempt ${d.attempt}` : '';
      return `${from} assignment ${STATE_WORD[String(d.state)] ?? d.state}${where ? ` on ${where}` : ''}${attempt}`;
    }
    case 'gate.result': {
      const gate = d.source === 'human' ? 'Human gate' : d.source === 'ci' ? 'CI' : d.source === 'merge-queue' ? 'Merge queue' : `${from} review`;
      return `${gate}: ${String(d.decision ?? d.result ?? 'result recorded')}${title ? ` for "${title}"` : ''}`;
    }
    default:
      return e.type.replace(/[.-]/g, ' ');
  }
}

/** Failed gates and assignments read in red, the only colour in the feed. */
function isFailure(e: HubEvent) {
  const d = e.data as InteractionData;
  if (e.type === 'gate.result') return GATE_FAILED.has(String(d.result)) && d.source === 'ci';
  return e.type === 'assignment.state' && d.state === 'failed';
}

export function matchesSelection(e: HubEvent, selection: Selection, graph: WorkflowGraph): boolean {
  if (!selection) return true;
  const d = e.data as InteractionData;
  if (selection.kind === 'node') return d.nodeId === selection.id || d.sourceNodeId === selection.id || d.targetNodeId === selection.id;
  if (d.edgeId === selection.id) return true;
  const edge = graph.edges.find((x) => x.id === selection.id);
  if (!edge) return false;
  const kindMatches =
    (edge.kind === 'flow' && (e.type === 'workitem.moved' || e.type === 'gate.result')) ||
    (edge.kind === 'delegates' && e.type === 'agent.delegated') ||
    (edge.kind === 'messages' && e.type === 'agent.messaged' && !d.unplanned);
  const ends =
    edge.kind === 'messages'
      ? [edge.from.node, edge.to.node].includes(d.sourceNodeId ?? '') && [edge.from.node, edge.to.node].includes(d.targetNodeId ?? '')
      : d.sourceNodeId === edge.from.node && d.targetNodeId === edge.to.node;
  return kindMatches && ends;
}

const EVENT_PAGE = 200;

/** Events for one run, newest first, live. Older pages load on request. */
export function useRunEvents(runId: string) {
  const { api, onEvent } = useHub();
  const [events, setEvents] = useState<HubEvent[] | null>(null);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [older, setOlder] = useState<{ before: number; hasMore: boolean; loading: boolean }>({ before: 0, hasMore: false, loading: false });
  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    void api
      .eventPage({ runId, limit: EVENT_PAGE })
      .then((page) => {
        if (cancelled) return;
        // Live events that arrived while the page loaded stay on top.
        setEvents((prev) => [...(prev ?? []).filter((e) => !page.events.some((p) => p.seq === e.seq)), ...page.events]);
        setOlder({ before: page.before, hasMore: page.hasMore, loading: false });
      })
      .catch(() => !cancelled && setEvents([]));
    const off = onEvent((e) => {
      if (e.runId !== runId) return;
      setEvents((prev) => (prev?.some((p) => p.seq === e.seq) ? prev : [e, ...(prev ?? [])]));
      setFresh((f) => new Set(f).add(e.seq));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [api, onEvent, runId]);

  const loadOlder = useCallback(async () => {
    if (!older.hasMore || older.loading) return;
    setOlder((o) => ({ ...o, loading: true }));
    try {
      const page = await api.eventPage({ runId, before: older.before, limit: EVENT_PAGE });
      setEvents((prev) => [...(prev ?? []), ...page.events.filter((e) => !prev?.some((p) => p.seq === e.seq))]);
      setOlder({ before: page.before, hasMore: page.hasMore, loading: false });
    } catch {
      setOlder((o) => ({ ...o, loading: false }));
    }
  }, [api, runId, older]);
  return { events, fresh, hasOlder: older.hasMore, loadingOlder: older.loading, loadOlder };
}

export function InteractionFeed({
  events,
  fresh,
  graph,
  selection,
  limit = 12,
  onlyInteractions = true,
  items = [],
  machines = [],
  hasOlder = false,
  loadingOlder = false,
  onOlder,
}: {
  events: HubEvent[] | null;
  fresh: Set<number>;
  graph: WorkflowGraph;
  items?: WorkItem[];
  machines?: Machine[];
  selection: Selection;
  limit?: number;
  onlyInteractions?: boolean;
  /** The hub has events older than those loaded. */
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onOlder?(): void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!events) return <Loading label="Loading activity" />;
  const name = (id?: string) => (id ? (graph.nodes.find((n) => n.id === id)?.label ?? id) : '');
  const matching = events.filter((e) => (!onlyInteractions || INTERACTION_TYPES.has(e.type)) && matchesSelection(e, selection, graph));
  const shown = expanded ? matching : matching.slice(0, limit);
  const older = hasOlder && onOlder && (expanded || matching.length <= limit) && (
    <button type="button" className="text-btn" onClick={onOlder} disabled={loadingOlder}>
      {loadingOlder ? 'Loading older events…' : 'Show older events'}
    </button>
  );
  if (shown.length === 0 && older) return older;
  if (shown.length === 0)
    return <p className="muted">{selection ? 'No activity here yet. Clear the selection to see the whole run.' : 'Agents report moves, delegation and messages as they work.'}</p>;
  return (
    <>
      <ol className="rows feed">
        {shown.map((e) => {
          const d = e.data as InteractionData;
          const route = d.sourceNodeId && d.targetNodeId ? `${name(d.sourceNodeId)} to ${name(d.targetNodeId)}` : d.nodeId ? name(d.nodeId) : '';
          const kind = d.unplanned ? `Unplanned ${(TYPE_LABEL[e.type] ?? e.type).toLowerCase()}` : e.type === 'workitem.moved' || e.type === 'assignment.state' ? '' : TYPE_LABEL[e.type];
          return (
            <li key={e.seq} className={`feed-item ${fresh.has(e.seq) ? 'feed-new' : ''} ${isFailure(e) ? 'feed-failed' : ''}`}>
              <time className="feed-time" dateTime={e.at}>
                {clock(e.at)}
              </time>
              <span className="row-main">
                <span className="feed-text">{describeEvent(e, { node: name, item: (id) => items.find((i) => i.id === id)?.title, machine: (id) => machines.find((m) => m.id === id)?.name })}</span>
                <span className="row-meta">{[kind, route].filter(Boolean).join(' · ')}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {(matching.length > shown.length || older) && (
        <div className="card-foot row">
          {matching.length > shown.length && (
            <button type="button" className="text-btn" onClick={() => setExpanded(true)}>
              Show all {matching.length}
            </button>
          )}
          {older}
        </div>
      )}
    </>
  );
}
