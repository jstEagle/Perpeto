import { useState } from 'react';
import { useHub } from '../app/hub-context';
import { HubError } from '../api/hub';
import type { WorkItem, WorkItemStatus, WorkflowGraph } from '../api/types';
import { Button } from '../components/ui';
import { StatusLabel, WorkStatusLabel } from '../components/status';
import { prNumber, shortSha } from '../lib/format';

const COLUMN_LIMIT = 6;

const COLUMNS: { status: WorkItemStatus; title: string; empty: string }[] = [
  { status: 'queued', title: 'Queued', empty: 'Nothing waiting.' },
  { status: 'active', title: 'Active', empty: 'No agent is working on an item.' },
  { status: 'blocked', title: 'Blocked', empty: 'Nothing is blocked.' },
  { status: 'failed', title: 'Failed', empty: 'No failures.' },
  { status: 'done', title: 'Done', empty: 'Nothing finished yet.' },
];

/** Work items by status. Items waiting at a human gate can be decided here. */
export function WorkBoard({
  items,
  graph,
  runLabel,
  onStale,
}: {
  items: WorkItem[];
  graph?: WorkflowGraph;
  runLabel?: (item: WorkItem) => string | undefined;
  /** Reloads the items after the hub refuses a decision because the item moved on. */
  onStale?: () => void;
}) {
  const [expanded, setExpanded] = useState<Set<WorkItemStatus>>(new Set());
  return (
    <div className="board" role="list" aria-label="Work items by status">
      {COLUMNS.map((col) => {
        const all = items.filter((i) => i.status === col.status);
        // A few per column; the rest on request. Done shows the latest first.
        const ordered = col.status === 'done' ? [...all].reverse() : all;
        const list = expanded.has(col.status) ? ordered : ordered.slice(0, COLUMN_LIMIT);
        return (
          <section key={col.status} className="board-col" role="listitem" aria-labelledby={`col-${col.status}`}>
            <header className="board-col-header">
              <WorkStatusLabel status={col.status} />
              <span className="board-col-count" id={`col-${col.status}`} aria-label={`${col.title}: ${all.length} items`}>
                {all.length}
              </span>
            </header>
            {all.length === 0 ? (
              <p className="board-empty">{col.empty}</p>
            ) : (
              <ul className="board-list">
                {list.map((item) => (
                  <WorkCard key={item.id} item={item} graph={graph} runLabel={runLabel?.(item)} onStale={onStale} />
                ))}
              </ul>
            )}
            {all.length > list.length && (
              <div className="board-more">
                <button type="button" className="text-btn" onClick={() => setExpanded((e) => new Set(e).add(col.status))}>
                  Show all {all.length}
                </button>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Refusals that mean the board is out of date rather than that the request failed. */
const STALE_CODES = new Set(['STALE_DECISION', 'CONFLICT']);

function WorkCard({ item, graph, runLabel, onStale }: { item: WorkItem; graph?: WorkflowGraph; runLabel?: string; onStale?: () => void }) {
  const { api } = useHub();
  const node = graph?.nodes.find((n) => n.id === item.nodeId);
  const atHuman = node?.type === 'human' && item.status === 'blocked';
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'approve' | 'return') {
    setBusy(true);
    setError(null);
    try {
      await api.decideWorkItem(item.id, { decision, ...(item.decisionId ? { decisionId: item.decisionId } : {}) });
      setResult(decision === 'approve' ? 'Approved.' : 'Returned for rework.');
    } catch (err) {
      if (err instanceof HubError && err.status === 409 && STALE_CODES.has(err.code)) {
        setError(
          err.code === 'STALE_DECISION'
            ? 'Decision not recorded. This item has moved on and now waits for a newer decision. The board is refreshed, so review it again.'
            : 'Decision not recorded. This item is no longer waiting for a person. The board is refreshed.',
        );
        onStale?.();
      } else setError(`Decision not recorded. ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="work-card">
      <span className="work-title">{item.title}</span>
      <span className="work-meta">
        <span>At {node?.label ?? item.nodeId}</span>
        {item.iteration > 1 && <span>Iteration {item.iteration}</span>}
        {runLabel && <span className="mono">{runLabel}</span>}
      </span>
      {(item.branch || item.prUrl) && (
        <span className="work-meta">
          {item.branch && <code className="mono">{item.branch}</code>}
          {item.prUrl && (
            <a className="row-link" href={item.prUrl} target="_blank" rel="noreferrer">
              PR {prNumber(item.prUrl)}
            </a>
          )}
          {item.headSha && <code className="mono">{shortSha(item.headSha)}</code>}
        </span>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {atHuman && !result && (
        <div className="stack-sm">
          <StatusLabel tone="approval">Approval needed</StatusLabel>
          <div className="row">
            <Button size="sm" variant="primary" busy={busy} onClick={() => decide('approve')}>
              Approve
            </Button>
            <Button size="sm" busy={busy} onClick={() => decide('return')}>
              Return
            </Button>
          </div>
        </div>
      )}
      {result && (
        <span className="note" role="status">
          {result}
        </span>
      )}
    </li>
  );
}
