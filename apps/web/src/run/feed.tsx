import { useEffect, useRef, useState } from 'react';
import { useHub } from '../app/hub-context';
import type { HubEvent, InteractionData, WorkflowGraph } from '../api/types';
import { Empty, Loading } from '../components/ui';
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

function kindClass(e: HubEvent) {
  const d = e.data as InteractionData;
  if (d.unplanned) return 'feed-kind-unplanned';
  if (e.type === 'agent.messaged') return 'feed-kind-messages';
  if (e.type === 'agent.delegated') return 'feed-kind-delegates';
  if (e.type === 'assignment.state') return 'feed-kind-state';
  if (e.type === 'gate.result') return d.result === 'fail' ? 'feed-kind-fail' : 'feed-kind-pass';
  return '';
}

export function matchesSelection(e: HubEvent, selection: Selection, graph: WorkflowGraph): boolean {
  if (!selection) return true;
  const d = e.data as InteractionData;
  if (selection.kind === 'node') return d.nodeId === selection.id || d.fromNode === selection.id || d.toNode === selection.id;
  if (d.edgeId === selection.id) return true;
  const edge = graph.edges.find((x) => x.id === selection.id);
  if (!edge) return false;
  const kindMatches =
    (edge.kind === 'flow' && (e.type === 'workitem.moved' || e.type === 'gate.result')) ||
    (edge.kind === 'delegates' && e.type === 'agent.delegated') ||
    (edge.kind === 'messages' && e.type === 'agent.messaged' && !d.unplanned);
  const ends = edge.kind === 'messages' ? [edge.from.node, edge.to.node].includes(d.fromNode ?? '') && [edge.from.node, edge.to.node].includes(d.toNode ?? '') : d.fromNode === edge.from.node && d.toNode === edge.to.node;
  return kindMatches && ends;
}

/** Interaction events for one run, newest first, live. */
export function useRunEvents(runId: string) {
  const { api, onEvent } = useHub();
  const [events, setEvents] = useState<HubEvent[] | null>(null);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  useEffect(() => {
    let cancelled = false;
    void api
      .events(0, 500)
      .then((list) => !cancelled && setEvents(list.filter((e) => e.runId === runId).reverse()))
      .catch(() => !cancelled && setEvents([]));
    const off = onEvent((e) => {
      if (e.runId !== runId) return;
      setEvents((prev) => (prev && !prev.some((p) => p.seq === e.seq) ? [e, ...prev] : prev));
      setFresh((f) => new Set(f).add(e.seq));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [api, onEvent, runId]);
  return { events, fresh };
}

export function InteractionFeed({
  events,
  fresh,
  graph,
  selection,
  limit = 40,
  onlyInteractions = true,
}: {
  events: HubEvent[] | null;
  fresh: Set<number>;
  graph: WorkflowGraph;
  selection: Selection;
  limit?: number;
  onlyInteractions?: boolean;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  if (!events) return <Loading label="Loading interactions" />;
  const name = (id?: string) => (id ? (graph.nodes.find((n) => n.id === id)?.label ?? id) : '');
  const shown = events.filter((e) => (!onlyInteractions || INTERACTION_TYPES.has(e.type)) && matchesSelection(e, selection, graph)).slice(0, limit);
  if (shown.length === 0)
    return <Empty title={selection ? 'No interactions here yet.' : 'No interactions yet.'}>{selection ? 'Clear the selection to see the whole run.' : 'Agents report moves, delegation and messages as they work.'}</Empty>;
  return (
    <ol className="feed" ref={listRef}>
      {shown.map((e) => {
        const d = e.data as InteractionData;
        const route = d.fromNode && d.toNode ? `${name(d.fromNode)} → ${name(d.toNode)}` : d.nodeId ? name(d.nodeId) : '';
        return (
          <li key={e.seq} className={`feed-item ${fresh.has(e.seq) ? 'feed-new' : ''}`}>
            <time className="feed-time" dateTime={e.at}>
              {clock(e.at)}
            </time>
            <span className={`feed-kind ${kindClass(e)}`} aria-hidden="true" />
            <div className="feed-body">
              <span>{d.summary ?? e.type}</span>
              <span className="feed-route">
                {d.unplanned ? <span className="feed-unplanned">Unplanned · </span> : null}
                {TYPE_LABEL[e.type] ?? e.type}
                {route ? ` · ${route}` : ''}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
