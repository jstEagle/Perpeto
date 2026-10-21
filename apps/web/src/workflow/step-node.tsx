import { memo } from 'react';
import { Handle, Position, useStore } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import type { Bottleneck, GraphNode, NodeMetrics, NodeType, WorkItem } from '../api/types';
import { NODE_SPECS, nodeSummary } from './registry';
import { StatusLabel } from '../components/status';
import { IconCi, IconCode, IconFlag, IconInbox, IconLoop, IconMerge, IconPerson, IconPlanner, IconReview } from '../components/icons';
import { NODE_W } from './layout';
import { PORT_Y } from './router';

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
  /** Large graphs draw compact nodes when zoomed far out. */
  large?: boolean;
}

export type StepNodeType = Node<StepData, 'step'>;

export const NODE_WIDTH = NODE_W;
/** Below this zoom, nodes of a large graph drop their live detail: unreadable at that size and costly in DOM. */
export const COMPACT_ZOOM = 0.45;
/** Flow ports sit at the centre of the head; `fail` sits just below it. */
export const PORT_TOP = PORT_Y.out;

export const TYPE_LABEL: Record<NodeType, string> = {
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

/** Outline glyph per step type, from the Mono icon set. */
export function TypeGlyph({ type, size = 17 }: { type: NodeType; size?: number }) {
  const Icon = { input: IconInbox, planner: IconPlanner, agent: IconCode, review: IconReview, ci: IconCi, 'merge-queue': IconMerge, loop: IconLoop, human: IconPerson, output: IconFlag }[type];
  return <Icon size={size} />;
}

/** One stat line and, where there is capacity, a 4 px meter. */
function LiveFoot({ metrics, bottleneck, type }: { metrics?: NodeMetrics; bottleneck?: Bottleneck; type: NodeType }) {
  if (!metrics) return null;
  if (type === 'input' || type === 'output')
    return (
      <div className="gnode-foot">
        <div className="gnode-stat">
          <span>
            {metrics.done} {type === 'output' ? 'finished' : 'received'}
          </span>
        </div>
      </div>
    );
  const capacity = !!metrics.concurrency && type !== 'loop';
  const attention = bottleneck && bottleneck.severity !== 'info';
  const left = attention ? (
    <StatusLabel tone="attention">{BOTTLENECK_LABEL[bottleneck.reason]}</StatusLabel>
  ) : capacity ? (
    <span>
      {metrics.active} of {metrics.concurrency} active
    </span>
  ) : type === 'loop' ? (
    <span>{metrics.done} passes</span>
  ) : metrics.active ? (
    <span>{metrics.active} active</span>
  ) : (
    <StatusLabel tone="quiet">Idle</StatusLabel>
  );
  return (
    <div className="gnode-foot">
      <div className="gnode-stat">
        {left}
        <span className="quiet">{metrics.queued} queued</span>
      </div>
      {capacity && (
        <span className="meter" aria-hidden="true">
          <span style={{ width: `${Math.min(1, metrics.utilization ?? 0) * 100}%` }} />
        </span>
      )}
      {bottleneck && (
        <span className="visually-hidden">
          Bottleneck: {BOTTLENECK_LABEL[bottleneck.reason]}. {bottleneck.evidence}
        </span>
      )}
    </div>
  );
}

function StepNodeView({ data, selected }: NodeProps<StepNodeType>) {
  const { node, mode, issues, diff, changedKeys, metrics, bottleneck, dimmed, large } = data;
  const spec = NODE_SPECS[node.type];
  const editable = mode === 'edit';
  // Subscribes to a boolean, so a node re-renders only when it crosses the threshold.
  const compact = useStore((s) => !!large && s.transform[2] < COMPACT_ZOOM);
  const live = mode === 'live' && !!metrics && metrics.active > 0;
  const classes = ['gnode', `gnode-${mode}`, selected ? 'is-selected' : '', issues?.errors ? 'has-errors' : '', diff ? `is-${diff}` : '', dimmed ? 'is-dimmed' : ''].join(' ');
  const status =
    diff === 'added' ? (
      <StatusLabel tone="done">Added</StatusLabel>
    ) : diff === 'removed' ? (
      <StatusLabel tone="failed">Removed</StatusLabel>
    ) : diff === 'changed' ? (
      <StatusLabel tone="attention">{changedKeys?.length ? `Changed ${changedKeys.join(', ')}` : 'Changed'}</StatusLabel>
    ) : issues && issues.errors > 0 ? (
      <StatusLabel tone="failed">{issues.errors === 1 ? '1 error' : `${issues.errors} errors`}</StatusLabel>
    ) : issues && issues.warnings > 0 ? (
      <StatusLabel tone="attention">{issues.warnings === 1 ? '1 warning' : `${issues.warnings} warnings`}</StatusLabel>
    ) : null;

  return (
    <div className={classes} style={{ width: NODE_WIDTH }}>
      {spec.input && <Handle type="target" position={Position.Left} id="in" className="port port-in" style={{ top: PORT_Y.in }} isConnectable={editable} />}
      <div className="gnode-head">
        <span className="tile tile-sm" aria-hidden="true">
          <TypeGlyph type={node.type} />
        </span>
        <span className="gnode-text">
          <span className="gnode-label">{node.label || spec.title}</span>
          <span className="gnode-meta">{nodeSummary(node)}</span>
        </span>
        <span className="visually-hidden">{TYPE_LABEL[node.type]}</span>
      </div>
      {live && <span className="dot gnode-dot" role="img" aria-label="Live" />}
      {status && <div className="gnode-status">{status}</div>}
      {mode === 'live' && !compact && <LiveFoot metrics={metrics} bottleneck={bottleneck} type={node.type} />}
      {spec.outputs.map((port) =>
        port === 'out' ? (
          <Handle key={port} type="source" position={Position.Right} id="out" className="port port-out" style={{ top: PORT_Y.out }} isConnectable={editable} />
        ) : (
          <Handle key={port} type="source" position={Position.Right} id={port} className={`port port-out port-${port}`} style={{ top: PORT_Y[port] }} isConnectable={editable} title={port === 'fail' ? 'Fail' : 'Pass'}>
            {port === 'fail' && editable && <span className="port-label">fail</span>}
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
