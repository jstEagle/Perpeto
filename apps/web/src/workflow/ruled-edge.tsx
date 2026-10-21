import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, useStore } from '@xyflow/react';
import type { Edge, EdgeProps, ReactFlowState } from '@xyflow/react';
import type { EdgeKind } from '../api/types';
import { longestHorizontalMid, roundedPath } from './geometry';

export interface RuledData extends Record<string, unknown> {
  kind: EdgeKind;
  port?: string;
  /** Rank among edges routed below the row; lower ranks sit closer. */
  lane: number;
  diff?: 'added' | 'removed';
  traffic?: number;
  unplanned?: boolean;
  dimmed?: boolean;
  highlighted?: boolean;
}

export type RuledEdgeType = Edge<RuledData, 'ruled'>;

const TRAFFIC_WORD: Record<EdgeKind, string> = { flow: 'moved', delegates: 'delegated', messages: 'messages' };

type Box = { x: number; y: number; w: number; h: number };

/**
 * Source and target boxes plus the lowest bottom among nodes in the source's
 * row between the two ends, serialised so the store selector stays stable.
 */
function geometry(source: string, target: string) {
  return (s: ReactFlowState) => {
    const box = (id: string) => {
      const n = s.nodeLookup.get(id);
      if (!n) return null;
      return { x: n.internals.positionAbsolute.x, y: n.internals.positionAbsolute.y, w: n.measured.width ?? 0, h: n.measured.height ?? 0 };
    };
    const a = box(source);
    const b = box(target);
    if (!a || !b) return '';
    const lo = Math.min(a.x, b.x) - 24;
    const hi = Math.max(a.x + a.w, b.x + b.w) + 24;
    let floor = Math.max(a.y + a.h, b.y + b.h);
    for (const n of s.nodeLookup.values()) {
      const x = n.internals.positionAbsolute.x;
      const y = n.internals.positionAbsolute.y;
      if (Math.abs(y - a.y) > 40 || x + (n.measured.width ?? 0) < lo || x > hi) continue;
      floor = Math.max(floor, y + (n.measured.height ?? 0));
    }
    return [a.x, a.y, a.w, a.h, b.x, b.y, b.w, b.h, floor].map(Math.round).join(',');
  };
}

function parse(key: string): { a: Box; b: Box; floor: number } | null {
  if (!key) return null;
  const v = key.split(',').map(Number);
  return { a: { x: v[0], y: v[1], w: v[2], h: v[3] }, b: { x: v[4], y: v[5], w: v[6], h: v[7] }, floor: v[8] };
}

function RuledEdgeView({ id, source, target, sourceX, sourceY, targetX, targetY, data, selected, markerEnd, markerStart }: EdgeProps<RuledEdgeType>) {
  const kind = data?.kind ?? 'flow';
  const lane = data?.lane ?? 0;
  const geo = parse(useStore(geometry(source, target)));
  const role = kind !== 'flow';
  const sameRow = !geo || Math.abs(geo.a.y - geo.b.y) < 40;
  const below = (geo ? geo.floor : Math.max(sourceY, targetY)) + 24 + lane * 16;

  let points: [number, number][];
  if (role) {
    if (sameRow) points = [[sourceX, sourceY], [sourceX, below], [targetX, below], [targetX, targetY]];
    else {
      // Between rows: just above the lower row.
      const lowerTop = geo!.b.y > geo!.a.y ? geo!.b.y : geo!.a.y;
      const ch = lowerTop - 28 - lane * 14;
      points = [[sourceX, sourceY], [sourceX, ch], [targetX, ch], [targetX, targetY]];
    }
  } else if (sameRow && targetX > sourceX + 24) {
    const midX = Math.round(sourceX + Math.max(16, (targetX - sourceX) / 2));
    points = Math.abs(sourceY - targetY) < 1 ? [[sourceX, sourceY], [targetX, targetY]] : [[sourceX, sourceY], [midX, sourceY], [midX, targetY], [targetX, targetY]];
  } else if (sameRow) {
    points = [[sourceX, sourceY], [sourceX + 14, sourceY], [sourceX + 14, below], [targetX - 14, below], [targetX - 14, targetY], [targetX, targetY]];
  } else {
    const lowerTop = geo!.b.y > geo!.a.y ? geo!.b.y : geo!.a.y;
    const ch = lowerTop - 28 - lane * 14;
    points = [[sourceX, sourceY], [sourceX + 14, sourceY], [sourceX + 14, ch], [targetX - 14, ch], [targetX - 14, targetY], [targetX, targetY]];
  }
  const path = roundedPath(points, 6);
  const [lx, ly] = longestHorizontalMid(points);
  const short = !role && sameRow && targetX > sourceX + 24;

  const classes = [
    'gedge',
    `gedge-${kind}`,
    data?.port === 'fail' ? 'gedge-fail' : '',
    data?.unplanned ? 'gedge-unplanned' : '',
    data?.diff ? `gedge-${data.diff}` : '',
    selected || data?.highlighted ? 'is-selected' : '',
    data?.dimmed ? 'is-dimmed' : '',
  ].join(' ');

  const showLabel = data?.traffic !== undefined || data?.unplanned || data?.diff || data?.port === 'fail';
  return (
    <>
      <BaseEdge id={id} path={path} className={classes} markerEnd={markerEnd} markerStart={markerStart} interactionWidth={14} />
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            className={`gedge-label gedge-label-${kind} ${data?.unplanned ? 'is-unplanned' : ''} ${data?.diff ? `is-${data.diff}` : ''} ${data?.dimmed ? 'is-dimmed' : ''}`}
            style={{ transform: `translate(-50%, ${short ? '-130%' : '-50%'}) translate(${lx}px, ${ly}px)` }}
            title={data?.traffic !== undefined ? `${data.traffic} ${TRAFFIC_WORD[kind]}` : undefined}
          >
            {data?.unplanned
              ? `Unplanned · ${data?.traffic ?? 0}`
              : data?.traffic !== undefined
                ? short
                  ? String(data.traffic)
                  : `${data.port === 'fail' ? 'fail · ' : ''}${data.traffic} ${TRAFFIC_WORD[kind]}`
                : data?.diff
                  ? data.diff === 'added'
                    ? 'Added'
                    : 'Removed'
                  : 'fail'}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const RuledEdge = memo(RuledEdgeView);
