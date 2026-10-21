import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer } from '@xyflow/react';
import type { Edge, EdgeProps } from '@xyflow/react';
import type { EdgeKind } from '../api/types';
import { roundedPath } from './geometry';
import type { Route } from './router';

export interface RuledData extends Record<string, unknown> {
  kind: EdgeKind;
  port?: string;
  /** Precomputed by the router for the whole graph; see router.ts. */
  route?: Route;
  diff?: 'added' | 'removed';
  traffic?: number;
  unplanned?: boolean;
  dimmed?: boolean;
  highlighted?: boolean;
}

export type RuledEdgeType = Edge<RuledData, 'ruled'>;

/**
 * Draws one routed edge: an orthogonal path with 12 px corners, no arrowheads.
 * Flow reads left to right; returns arc over the top. Delegates and messages
 * show small round ends; a delegate's source end is filled.
 */
function RuledEdgeView({ id, sourceX, sourceY, targetX, targetY, data, selected }: EdgeProps<RuledEdgeType>) {
  const kind = data?.kind ?? 'flow';
  const route = data?.route;
  const points = route?.points ?? [
    [sourceX, sourceY],
    [targetX, targetY],
  ];
  const path = roundedPath(points, 12);
  const unreached = kind === 'flow' && data?.traffic === 0 && !data?.diff;

  const classes = [
    'gedge',
    `gedge-${kind}`,
    data?.port === 'fail' ? 'gedge-fail' : '',
    unreached ? 'gedge-unreached' : '',
    kind === 'flow' && (data?.traffic ?? 0) > 0 ? 'gedge-active' : '',
    data?.unplanned ? 'gedge-unplanned' : '',
    data?.diff ? `gedge-${data.diff}` : '',
    selected || data?.highlighted ? 'is-selected' : '',
    data?.dimmed ? 'is-dimmed' : '',
  ].join(' ');

  const label = route?.label;
  return (
    <>
      <BaseEdge id={id} path={path} className={classes} interactionWidth={14} />
      {route?.tooltip && (
        <path d={path} fill="none" stroke="transparent" strokeWidth={14}>
          <title>{route.tooltip}</title>
        </path>
      )}
      {route?.ends?.map((end) => (
        <circle
          key={end.end}
          cx={end.x}
          cy={end.y}
          r={3}
          className={`gedge-end gedge-end-${kind} gedge-end-${end.end} ${data?.unplanned ? 'is-unplanned' : ''} ${data?.diff ? `is-${data.diff}` : ''} ${data?.dimmed ? 'is-dimmed' : ''}`}
        />
      ))}
      {label && (
        <EdgeLabelRenderer>
          <div
            className={`gedge-label gedge-label-${kind} ${data?.unplanned ? 'is-unplanned' : ''} ${data?.diff ? `is-${data.diff}` : ''} ${data?.dimmed ? 'is-dimmed' : ''} ${selected || data?.highlighted ? 'is-selected' : ''}`}
            style={{ transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)` }}
          >
            {label.text}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const RuledEdge = memo(RuledEdgeView);
