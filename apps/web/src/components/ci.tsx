import { useEffect, useRef, useState } from 'react';
import { useHub } from '../app/hub-context';
import { formatBytes, formatMs, isJobActive, mergeLogChunks } from '../api/ci';
import type { LogChunk, PipelineInsight, PipelineJobStatus, PipelineRunStatus } from '../api/ci';
import { StatusLabel, StatusChip } from './status';
import type { Tone } from './status';
import { dateTime } from '../lib/format';

const RUN: Record<PipelineRunStatus, [Tone, string]> = {
  queued: ['quiet', 'Queued'],
  running: ['live', 'Running'],
  passed: ['done', 'Passed'],
  failed: ['failed', 'Failed'],
  cancelled: ['stopped', 'Cancelled'],
  error: ['failed', 'Error'],
};
const JOB: Record<PipelineJobStatus, [Tone, string]> = {
  waiting: ['quiet', 'Waiting'],
  queued: ['quiet', 'Queued'],
  leased: ['waiting', 'Starting'],
  running: ['live', 'Running'],
  passed: ['done', 'Passed'],
  failed: ['failed', 'Failed'],
  cancelled: ['stopped', 'Cancelled'],
  error: ['failed', 'Error'],
  skipped: ['stopped', 'Skipped'],
};

export const pipelineRunTone = (status: PipelineRunStatus): Tone => RUN[status]?.[0] ?? 'quiet';
export const pipelineJobTone = (status: PipelineJobStatus): Tone => JOB[status]?.[0] ?? 'quiet';

export function PipelineRunStatusLabel({ status }: { status: PipelineRunStatus }) {
  const [tone, label] = RUN[status] ?? ['quiet', status];
  return <StatusLabel tone={tone}>{label}</StatusLabel>;
}
export function PipelineRunStatusChip({ status }: { status: PipelineRunStatus }) {
  const [tone, label] = RUN[status] ?? ['quiet', status];
  return <StatusChip tone={tone}>{label}</StatusChip>;
}
export function PipelineJobStatusLabel({ status }: { status: PipelineJobStatus }) {
  const [tone, label] = JOB[status] ?? ['quiet', status];
  return <StatusLabel tone={tone}>{label}</StatusLabel>;
}

/** Re-run `fn` every `ms` while `active`; stops when the screen leaves or work ends. */
export function usePoll(fn: () => void, active: boolean, ms = 2000) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => ref.current(), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
}

/**
 * Durations of recent runs as bars, oldest left. Ink bars for passes, red
 * for failures; height is relative to the longest run shown.
 */
export function DurationTrend({ insight, label }: { insight: PipelineInsight; label: string }) {
  const points = insight.trend.slice(-20);
  const max = Math.max(1, ...points.map((p) => p.durationMs));
  return (
    <figure className="ci-trend" aria-label={label}>
      <div className="ci-trend-bars" role="list">
        {points.map((p) => (
          <span
            key={p.runId}
            role="listitem"
            className={`ci-trend-bar ${p.status === 'failed' || p.status === 'error' ? 'ci-trend-bar-failed' : ''}`}
            style={{ height: `${Math.max(8, (p.durationMs / max) * 100)}%` }}
            title={`${dateTime(p.at)} · ${formatMs(p.durationMs)} · ${p.status}`}
          />
        ))}
      </div>
      <figcaption className="ci-trend-caption">
        <span>Average {formatMs(insight.avgDurationMs)}</span>
        <span>p90 {formatMs(insight.p90DurationMs)}</span>
      </figcaption>
    </figure>
  );
}

/**
 * A job's log, followed while the job runs: each poll asks only for chunks
 * after the last one shown. Pages are read until the hub says there are no
 * more, so a long finished log arrives whole.
 */
export function JobLog({ jobId, status }: { jobId: string; status: PipelineJobStatus }) {
  const { api } = useHub();
  const [chunks, setChunks] = useState<LogChunk[]>([]);
  const [meta, setMeta] = useState<{ truncated: boolean; bytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cursor = useRef(0);
  const busy = useRef(false);
  const box = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const active = isJobActive({ status });

  const fetchMore = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      for (let page = 0; page < 20; page++) {
        const result = await api.ciJobLog(jobId, cursor.current, 500);
        cursor.current = Math.max(cursor.current, result.nextCursor);
        setChunks((current) => mergeLogChunks(current, result.chunks));
        setMeta({ truncated: result.truncated, bytes: result.bytes });
        setError(null);
        if (!result.hasMore) break;
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      busy.current = false;
    }
  };

  useEffect(() => {
    cursor.current = 0;
    follow.current = true;
    setChunks([]);
    setMeta(null);
    void fetchMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, status]);
  usePoll(() => void fetchMore(), active, 2000);

  useEffect(() => {
    const el = box.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [chunks]);

  const text = chunks.map((c) => c.chunk).join('');
  return (
    <div className="ci-log-wrap">
      <div className="ci-log-head">
        <span className="row">
          {active && <span className="dot" aria-hidden="true" />}
          <span>{active ? 'Following live output' : 'Output'}</span>
        </span>
        {meta && <span className="muted tabular">{meta.truncated ? 'Truncated at the hub’s log limit' : formatBytes(meta.bytes)}</span>}
      </div>
      {error && <p className="field-error">The log could not be read. {error}</p>}
      <pre
        className="log ci-log"
        ref={box}
        tabIndex={0}
        aria-label={`Log for job ${jobId}`}
        aria-live={active ? 'polite' : undefined}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {text || (active ? 'Waiting for output…' : 'No output was recorded.')}
      </pre>
    </div>
  );
}
