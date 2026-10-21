import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import type { Bottleneck, GraphNode, NodeMetrics, NodeType, WorkItem } from '../api/types';
import { NODE_SPECS, nodeSummary } from './registry';
import { duration, pct, rate } from '../lib/format';

export type DiffMark = 'added' | 'removed' | 'changed';

export interface StepData extends Record<string, unknown> {
  node: GraphNode;
  mode: 'edit' | 'view' | 'live';
  issues?: { errors: number; warnings: number };
  diff?: DiffMark;
  changedKeys?: string[];
  metrics?: NodeMetrics;
  bottleneck?: Bottleneck;
  items?: WorkItem[];
  dimmed?: boolean;
}

export type StepNodeType = Node<StepData, 'step'>;

export const NODE_WIDTH = 208;
/** Vertical offset of flow ports, so edges stay straight between nodes in a row. */
export const PORT_TOP = 30;
const GATE_PORTS: Record<string, number> = { pass: 30, fail: 56 };

const TYPE_LABEL: Record<NodeType, string> = {
  input: 'Input',
  planner: 'Planner',
  agent: 'Agent',
  review: 'Review gate',
  ci: 'CI gate',
  'merge-queue': 'Merge queue',
  loop: 'Loop',
  human: 'Human gate',
  output: 'Output',
};

export const BOTTLENECK_LABEL: Record<Bottleneck['reason'], string> = {
  saturated: 'Saturated',
  'queue-growing': 'Queue growing',
  'high-failure': 'High failure rate',
  'waiting-on-human': 'Waiting on a person',
  'no-capacity': 'No capacity',
  'rework-loop': 'Rework loop',
};

/** Small geometric glyph per node type, drawn on the 12 px grid. */
export function TypeGlyph({ type }: { type: NodeType }) {
  const common = { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true, focusable: false } as const;
  switch (type) {
    case 'input':
      return <svg {...common}><path d="M1 6h7M5.5 3 8.5 6l-3 3M10.5 1v10" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>;
    case 'output':
      return <svg {...common}><path d="M1.5 1v10M4 6h6.5" stroke="currentColor" strokeWidth="1.5" fill="none" /><rect x="8" y="4" width="3" height="4" fill="currentColor" /></svg>;
    case 'planner':
      return <svg {...common}><path d="M1 2.5h10M1 6h7M1 9.5h4" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>;
    case 'agent':
      return <svg {...common}><rect x="2" y="2" width="8" height="8" fill="currentColor" /></svg>;
    case 'review':
      return <svg {...common}><path d="M6 1 11 6 6 11 1 6z" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>;
    case 'ci':
      return <svg {...common}><rect x="1.5" y="1.5" width="9" height="9" stroke="currentColor" strokeWidth="1.5" fill="none" /><path d="m3.5 6 1.8 1.8L8.7 4.3" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>;
    case 'merge-queue':
      return <svg {...common}><path d="M1 2.5h4.5L8 6h3M1 9.5h4.5L8 6" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>;
    case 'loop':
      return <svg {...common}><path d="M9.5 3.5A4 4 0 1 0 10 7" stroke="currentColor" strokeWidth="1.5" fill="none" /><path d="M7 3.5h3v-3" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>;
    case 'human':
      return <svg {...common}><circle cx="6" cy="6" r="4.25" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>;
  }
}

function LiveStrip({ metrics, items, bottleneck, type }: { metrics?: NodeMetrics; items?: WorkItem[]; bottleneck?: Bottleneck; type: NodeType }) {
  if (!metrics) return null;
  const terminal = type === 'input' || type === 'output';
  const showsCapacity = metrics.concurrency > 0 && type !== 'loop';
  const high = metrics.utilization >= 0.9;
  const shown = (items ?? []).filter((i) => i.status !== 'done').slice(0, 14);
  const extra = (items ?? []).filter((i) => i.status !== 'done').length - shown.length;
  return (
    <div className="gnode-live">
      {terminal ? (
        <div className="gnode-figures">
          <span>
            <b>{metrics.done}</b> {type === 'output' ? 'finished' : 'received'}
          </span>
        </div>
      ) : (
        <>
          <div className="gnode-figures">
            <span>
              <b>{metrics.active}</b> active
            </span>
            <span className={metrics.queued >= 5 ? 'is-high' : ''}>
              <b>{metrics.queued}</b> queued
            </span>
            {type === 'loop' && (
              <span>
                <b>{metrics.done}</b> passes
              </span>
            )}
          </div>
          {showsCapacity && (
            <div className="gnode-util" title={`Utilization: ${metrics.active} active of ${metrics.concurrency}`}>
              <span className="meter meter-sm" aria-hidden="true">
                <span className={`meter-fill ${high ? 'meter-error' : 'meter-ink'}`} style={{ width: `${Math.min(1, metrics.utilization) * 100}%` }} />
              </span>
              <span className="gnode-util-num">
                {pct(metrics.utilization)} of {metrics.concurrency}
              </span>
            </div>
          )}
          {type !== 'loop' && (
            <div className="gnode-figures gnode-figures-muted">
              <span>wait {duration(metrics.waitSec.avg)}</span>
              <span>{rate(metrics.throughputPerHour)}/h</span>
            </div>
          )}
        </>
      )}
      {shown.length > 0 && (
        <div className="gnode-markers" aria-label={`${shown.length + Math.max(0, extra)} work items here`}>
          {shown.map((item) => (
            <span key={item.id} className={`marker marker-${item.status}`} title={`${item.title} · ${item.status}${item.iteration > 1 ? ` · iteration ${item.iteration}` : ''}`} />
          ))}
          {extra > 0 && <span className="marker-more">+{extra}</span>}
        </div>
      )}
      {bottleneck && <span className="visually-hidden">Bottleneck: {BOTTLENECK_LABEL[bottleneck.reason]}. {bottleneck.evidence}</span>}
    </div>
  );
}

function StepNodeView({ data, selected }: NodeProps<StepNodeType>) {
  const { node, mode, issues, diff, changedKeys, metrics, bottleneck, items, dimmed } = data;
  const spec = NODE_SPECS[node.type];
  const editable = mode === 'edit';
  const ports = spec.outputs;
  const classes = [
    'gnode',
    `gnode-${node.type}`,
    selected ? 'is-selected' : '',
    issues?.errors ? 'has-errors' : '',
    diff ? `is-${diff}` : '',
    bottleneck ? `has-bottleneck bottleneck-${bottleneck.severity}` : '',
    dimmed ? 'is-dimmed' : '',
  ].join(' ');

  return (
    <div className={classes} style={{ width: NODE_WIDTH }}>
      {bottleneck && (
        <span className={`gnode-flag flag-${bottleneck.severity}`} title={bottleneck.evidence}>
          {BOTTLENECK_LABEL[bottleneck.reason]}
        </span>
      )}
      {diff && <span className={`gnode-flag flag-diff-${diff}`}>{diff === 'added' ? 'Added' : diff === 'removed' ? 'Removed' : 'Changed'}</span>}
      {spec.input && <Handle type="target" position={Position.Left} id="in" className="port port-in" style={{ top: PORT_TOP }} isConnectable={editable} />}
      <div className="gnode-head">
        <span className="gnode-type">
          <TypeGlyph type={node.type} />
          {TYPE_LABEL[node.type]}
        </span>
        {issues && (issues.errors > 0 || issues.warnings > 0) && (
          <span className={`gnode-issues ${issues.errors ? 'is-error' : 'is-warning'}`}>
            {issues.errors ? `${issues.errors} ${issues.errors === 1 ? 'error' : 'errors'}` : `${issues.warnings} ${issues.warnings === 1 ? 'warning' : 'warnings'}`}
          </span>
        )}
      </div>
      <div className="gnode-label">{node.label || spec.title}</div>
      <div className="gnode-summary">{nodeSummary(node)}</div>
      {diff === 'changed' && changedKeys && changedKeys.length > 0 && <div className="gnode-changed">Changed: {changedKeys.join(', ')}</div>}
      {mode === 'live' && <LiveStrip metrics={metrics} items={items} bottleneck={bottleneck} type={node.type} />}
      {ports.map((port) =>
        port === 'out' ? (
          <Handle key={port} type="source" position={Position.Right} id="out" className="port port-out" style={{ top: PORT_TOP }} isConnectable={editable} />
        ) : (
          <Handle key={port} type="source" position={Position.Right} id={port} className={`port port-out port-${port}`} style={{ top: GATE_PORTS[port] }} isConnectable={editable}>
            <span className="port-label">{port}</span>
          </Handle>
        ),
      )}
      {spec.role && (
        <>
          <Handle type="source" position={Position.Bottom} id="role-out" className="port port-role port-role-out" style={{ left: '35%' }} isConnectable={editable} title="Delegate or message from this role" />
          <Handle type="target" position={Position.Bottom} id="role-in" className="port port-role port-role-in" style={{ left: '65%' }} isConnectable={editable} title="Receive delegation or messages" />
          <Handle type="source" position={Position.Top} id="role-out-top" className="port port-role port-role-out" style={{ left: '35%' }} isConnectable={editable} title="Delegate or message from this role" />
          <Handle type="target" position={Position.Top} id="role-in-top" className="port port-role port-role-in" style={{ left: '65%' }} isConnectable={editable} title="Receive delegation or messages" />
        </>
      )}
    </div>
  );
}

export const StepNode = memo(StepNodeView);
