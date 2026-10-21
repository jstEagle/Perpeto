import { useState } from 'react';
import { useHub } from '../app/hub-context';
import type { WorkItem, WorkItemStatus, WorkflowGraph } from '../api/types';
import { Button } from '../components/ui';
import { WorkStatusLabel } from '../components/status';
import { prNumber, shortSha } from '../lib/format';

const COLUMNS: { status: WorkItemStatus; title: string; empty: string }[] = [
  { status: 'queued', title: 'Queued', empty: 'Nothing waiting.' },
  { status: 'active', title: 'Active', empty: 'No agent is working on an item.' },
  { status: 'blocked', title: 'Blocked', empty: 'Nothing is blocked.' },
  { status: 'failed', title: 'Failed', empty: 'No failures.' },
  { status: 'done', title: 'Done', empty: 'Nothing finished yet.' },
];

/** Work items by status. Items waiting at a human gate can be decided here. */
export function WorkBoard({ items, graph, runLabel }: { items: WorkItem[]; graph?: WorkflowGraph; runLabel?: (item: WorkItem) => string | undefined }) {
  const [showAllDone, setShowAllDone] = useState(false);
  return (
    <div className="board" role="list" aria-label="Work items by status">
      {COLUMNS.map((col) => {
        const all = items.filter((i) => i.status === col.status);
        const list = col.status === 'done' && !showAllDone ? all.slice(-6).reverse() : all;
        return (
          <section key={col.status} className="board-col" role="listitem" aria-labelledby={`col-${col.status}`}>
            <header className="board-col-header">
              <WorkStatusLabel status={col.status} />
              <span className="board-col-count" id={`col-${col.status}`} aria-label={`${col.title}: ${all.length} items`}>
                {all.length}
              </span>
            </header>
            {all.length === 0 ? (
              <p className="note" style={{ padding: 12 }}>
                {col.empty}
              </p>
            ) : (
              <ul className="board-list">
                {list.map((item) => (
                  <WorkCard key={item.id} item={item} graph={graph} runLabel={runLabel?.(item)} />
                ))}
              </ul>
            )}
            {all.length > list.length && (
              <div className="board-more">
                <button type="button" className="chip-button" onClick={() => setShowAllDone(true)}>
                  Show all {all.length} done
                </button>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function WorkCard({ item, graph, runLabel }: { item: WorkItem; graph?: WorkflowGraph; runLabel?: string }) {
  const { api } = useHub();
  const node = graph?.nodes.find((n) => n.id === item.nodeId);
  const atHuman = node?.type === 'human' && item.status === 'blocked';
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function decide(decision: 'approve' | 'return') {
    setBusy(true);
    try {
      await api.decideWorkItem(item.id, { decision });
      setResult(decision === 'approve' ? 'Approved.' : 'Returned for rework.');
    } catch (err) {
      setResult(`Decision not recorded. ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="card">
      <span className="card-title">{item.title}</span>
      <span className="card-meta">
        <span>At {node?.label ?? item.nodeId}</span>
        {item.iteration > 1 && <span className={item.iteration >= 3 ? 'diff-removed' : ''}>Iteration {item.iteration}</span>}
        {runLabel && <span className="mono">{runLabel}</span>}
      </span>
      {(item.branch || item.prUrl) && (
        <span className="card-meta">
          {item.branch && <code className="mono">{item.branch}</code>}
          {item.prUrl && (
            <a className="link" href={item.prUrl} target="_blank" rel="noreferrer">
              PR {prNumber(item.prUrl)}
            </a>
          )}
          {item.headSha && <code className="mono">{shortSha(item.headSha)}</code>}
        </span>
      )}
      {atHuman && !result && (
        <div className="stack-sm" style={{ gap: 8 }}>
          <span className="status status-warning">
            <span className="status-mark" aria-hidden="true" />
            Approval needed
          </span>
          <div className="row" style={{ gap: 8 }}>
            <Button size="sm" variant="primary" busy={busy} onClick={() => decide('approve')}>
              Approve
            </Button>
            <Button size="sm" busy={busy} onClick={() => decide('return')}>
              Return
            </Button>
          </div>
        </div>
      )}
      {result && <span className="note" role="status">{result}</span>}
    </li>
  );
}
