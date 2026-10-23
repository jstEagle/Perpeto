import { describe, expect, it } from 'vitest';
import { dagColumns, formatBytes, formatMs, jobCounts, jobElapsedMs, matrixLabel, mergeLogChunks, runElapsedMs } from './ci';
import type { LogChunk } from './ci';
import { CI_DEMO_IDS, DemoCi } from './ci-fixtures';
import { DemoHub } from './demo';

const chunk = (seq: number): LogChunk => ({ seq, id: `l${seq}`, jobId: 'j', chunk: `line ${seq}\n`, at: '2026-10-23T00:00:00Z' });

describe('dagColumns', () => {
  it('places each job one column after its deepest need', () => {
    const jobs = [
      { key: 'lint', needs: [] },
      { key: 'test (node=22)', needs: ['lint'] },
      { key: 'test (node=24)', needs: ['lint'] },
      { key: 'package', needs: ['test (node=22)', 'test (node=24)'] },
      { key: 'docs', needs: [] },
    ];
    expect(dagColumns(jobs).map((c) => c.map((j) => j.key))).toEqual([['lint', 'docs'], ['test (node=22)', 'test (node=24)'], ['package']]);
  });
  it('uses the longest path, ignores unknown needs and survives cycles', () => {
    const jobs = [
      { key: 'a', needs: ['missing'] },
      { key: 'b', needs: ['a'] },
      { key: 'c', needs: ['a', 'b'] },
      { key: 'x', needs: ['y'] },
      { key: 'y', needs: ['x'] },
    ];
    const columns = dagColumns(jobs).map((c) => c.map((j) => j.key));
    expect(columns[0]).toContain('a');
    expect(columns.findIndex((c) => c.includes('c'))).toBe(2);
    expect(columns.flat().sort()).toEqual(['a', 'b', 'c', 'x', 'y']);
  });
});

describe('mergeLogChunks', () => {
  it('appends only chunks after the last one shown', () => {
    const shown = [chunk(1), chunk(2)];
    expect(mergeLogChunks(shown, [chunk(2), chunk(3)]).map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(mergeLogChunks(shown, [])).toBe(shown);
    expect(mergeLogChunks(shown, [chunk(1)])).toBe(shown);
    expect(mergeLogChunks([], [chunk(4)]).map((c) => c.seq)).toEqual([4]);
  });
});

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatMs(undefined)).toBe('—');
    expect(formatMs(820)).toBe('820 ms');
    expect(formatMs(42_000)).toBe('42 s');
    expect(formatMs(185_000)).toBe('3 min 05 s');
    expect(formatMs(72 * 60_000)).toBe('1 h 12 min');
  });
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1_843_200)).toBe('1.8 MB');
    expect(formatBytes(20_000_000_000)).toBe('20 GB');
  });
  it('labels matrix cells', () => {
    expect(matrixLabel(undefined)).toBe('');
    expect(matrixLabel({ node: '22', os: 'linux' })).toBe('node 22, os linux');
  });
  it('measures elapsed time for running and finished work', () => {
    const now = Date.parse('2026-10-23T12:10:00Z');
    expect(jobElapsedMs({ startedAt: '2026-10-23T12:00:00Z' }, now)).toBe(600_000);
    expect(jobElapsedMs({ durationMs: 5 }, now)).toBe(5);
    expect(jobElapsedMs({}, now)).toBeUndefined();
    expect(runElapsedMs({ createdAt: '2026-10-23T12:09:00Z' }, now)).toBe(60_000);
  });
});

describe('demo CI', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  it('has a live three-stage run with a two-way matrix, cache info and a waiting final job', () => {
    const ci = new DemoCi(now);
    const live = ci.run(CI_DEMO_IDS.live);
    expect(dagColumns(live.jobs).map((c) => c.length)).toEqual([1, 2, 1]);
    expect(live.jobs.filter((j) => j.status === 'running')).toHaveLength(1);
    expect(live.jobs.some((j) => j.cache?.some((c) => c.hit))).toBe(true);
    expect(jobCounts(live.jobs)).toMatchObject({ passed: 2, active: 1, waiting: 1, total: 4 });
  });
  it('records a flaky retried job and an artifact', () => {
    const ci = new DemoCi(now);
    const flaky = ci.run(CI_DEMO_IDS.flaky);
    const test = flaky.jobs.find((j) => j.flaky)!;
    expect(test.attempts.map((a) => a.status)).toEqual(['failed', 'passed']);
    const pkg = flaky.jobs.find((j) => j.key === 'package')!;
    expect(ci.artifacts(pkg.jobId!)).toHaveLength(1);
    expect(ci.flaky(CI_DEMO_IDS.project).length).toBeGreaterThan(0);
  });
  it('pages a growing log by cursor', () => {
    const ci = new DemoCi(now);
    const first = ci.log('job_t24a', 0, 4, now);
    expect(first.chunks.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
    expect(first.hasMore).toBe(true);
    const later = ci.log('job_t24a', first.nextCursor, 500, now + 60_000);
    expect(later.chunks[0].seq).toBe(5);
    expect(later.hasMore).toBe(false);
  });
  it('has agents-only, CI-only and mixed runners', () => {
    expect(new DemoCi(now).runners().runners.map((r) => r.mode).sort()).toEqual(['agents', 'both', 'ci']);
  });
  it('starts, cancels and retries runs through the demo hub', async () => {
    const hub = new DemoHub(Date.now());
    const run = await hub.startCiRun({ projectId: CI_DEMO_IDS.project, pipeline: 'default' });
    expect(run.jobs.filter((j) => j.status === 'queued').map((j) => j.key)).toEqual(['lint']);
    expect((await hub.cancelCiRun(run.id)).status).toBe('cancelled');
    const retried = await hub.retryCiRun(CI_DEMO_IDS.failed);
    expect(retried.status).toBe('running');
    expect(retried.jobs.find((j) => j.key === 'lint')!.attempt).toBe(2);
    expect((await hub.ciRuns({ projectId: CI_DEMO_IDS.project }))[0].id).toBe(run.id);
  });
});
