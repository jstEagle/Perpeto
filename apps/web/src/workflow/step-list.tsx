import type { MetricsSnapshot, WorkflowGraph } from '../api/types';
import { StatusLabel } from '../components/status';
import { BOTTLENECK_LABEL, TypeGlyph } from './step-node';
import { layer } from './layout';
import { nodeSummary } from './registry';
import type { Selection } from './graph-canvas';

/**
 * The live map on narrow screens: steps in flow order as compact cards
 * joined by a short connector. Side steps (helpers, fail branches) indent
 * under the step they serve; returns are written in the meta line.
 */
export function StepList({ graph, metrics, selection, onSelect, className }: { graph: WorkflowGraph; metrics?: MetricsSnapshot; selection?: Selection; onSelect?(s: Selection): void; className?: string }) {
  const { rank, row, mainRows } = layer(graph.nodes, graph.edges);
  const ordered = [...graph.nodes].sort((a, b) => rank.get(a.id)! - rank.get(b.id)! || row.get(a.id)! - row.get(b.id)!);
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
  const traffic = new Map((metrics?.edges ?? []).map((e) => [e.edgeId, e.count]));
  return (
    <ol className={`steps ${className ?? ''}`} aria-label="Workflow steps">
      {ordered.map((n) => {
        const m = metrics?.nodes.find((x) => x.nodeId === n.id);
        const b = metrics?.bottlenecks.find((x) => x.nodeId === n.id && x.severity !== 'info');
        const returned = graph.edges.filter((e) => e.kind === 'flow' && e.from.node === n.id && e.from.port === 'fail' && (traffic.get(e.id) ?? 0) > 0);
        const live = !!m && m.active > 0;
        const parts: string[] = [];
        if (m && n.type !== 'input' && n.type !== 'output') {
          if (m.concurrency && n.type !== 'loop') parts.push(`${m.active} of ${m.concurrency} active`);
          else if (m.active) parts.push(`${m.active} active`);
          if (m.queued) parts.push(`${m.queued} queued`);
        }
        for (const e of returned) parts.push(`${traffic.get(e.id)} returned to ${label(e.to.node)}`);
        const end =
          n.type === 'input' ? (
            m && `${m.done} in`
          ) : n.type === 'output' ? (
            m && m.done
          ) : b ? (
            <StatusLabel tone="attention">{BOTTLENECK_LABEL[b.reason]}</StatusLabel>
          ) : live ? (
            <span className="dot" role="img" aria-label="Live" />
          ) : m ? (
            m.queued ? 'Waiting' : 'Idle'
          ) : null;
        const selected = selection?.kind === 'node' && selection.id === n.id;
        return (
          <li key={n.id}>
            <button type="button" className={`step ${row.get(n.id)! >= mainRows ? 'step-side' : ''}`} aria-pressed={selected} onClick={() => onSelect?.(selected ? null : { kind: 'node', id: n.id })}>
              <span className="tile tile-sm" aria-hidden="true">
                <TypeGlyph type={n.type} />
              </span>
              <span className="step-main">
                <span className="step-name">{n.label}</span>
                <span className="step-meta">{parts.length ? parts.join(' · ') : nodeSummary(n)}</span>
              </span>
              {end !== null && end !== undefined && <span className="step-end">{end}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
