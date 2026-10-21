import { describe, expect, it } from 'vitest';
import type { Run, WorkItem } from '../api/types';
import { budgetFill, countActive, budgetRows, intakeSummary, nextUtcMidnight, pauseDetail, resumeText } from './budget';

const base: Run = { id: 'run_1', projectId: 'p', workflowId: 'w', workflowVersion: 1, status: 'running', startedAt: '2026-10-21T08:00:00Z' };

describe('run budget', () => {
  it('lists only the limits the run has, against today’s use', () => {
    const run: Run = { ...base, budget: { maxTokensPerDay: 400_000, maxItemsPerDay: 6 }, budgetUsage: { day: '2026-10-21', tokens: 100_000, items: 3 } };
    const rows = budgetRows(run);
    expect(rows.map((r) => r.text)).toEqual(['100K of 400K tokens', '3 of 6 items']);
    expect(budgetFill(rows)).toBe(0.5);
    expect(budgetRows(base)).toEqual([]);
  });

  it('shows active items only when it knows them', () => {
    const run: Run = { ...base, budget: { maxActiveItems: 3 }, budgetUsage: { day: '2026-10-21', tokens: 0, items: 0 } };
    expect(budgetRows(run)).toEqual([]);
    expect(budgetRows(run, 2)[0].text).toBe('2 of 3 active');
    const paused: Run = { ...run, intake: { paused: true, reason: { limit: 'maxActiveItems', used: 3, maximum: 3, day: '2026-10-21' } } };
    expect(budgetFill(budgetRows(paused))).toBe(1);
  });

  it('says when a daily limit resumes: midnight UTC in local time', () => {
    const now = new Date('2026-10-21T15:00:00Z');
    expect(nextUtcMidnight(now).toISOString()).toBe('2026-10-22T00:00:00.000Z');
    const tokens = { paused: true, reason: { limit: 'maxTokensPerDay' as const, used: 412_000, maximum: 400_000, day: '2026-10-21' } };
    expect(resumeText(tokens, now)).toMatch(/^Resumes (today|tomorrow) at \d\d:\d\d$/);
    expect(pauseDetail(tokens)).toBe('412K of 400K tokens used today. Work already started keeps going; no new work is taken in.');
    expect(resumeText({ paused: true, reason: { limit: 'maxActiveItems', used: 3, maximum: 3, day: '2026-10-21' } }, now)).toBe('Resumes when an active item finishes');
    expect(resumeText({ paused: false }, now)).toBe('');
  });

  it('summarises how the run takes in work', () => {
    expect(intakeSummary({ ...base, keepOpen: true, source: 'goals' })).toBe('Keeps running · New work from the project goals');
    expect(intakeSummary(base)).toBe('Finishes when the work is done · Work you add');
    expect(intakeSummary({ ...base, keepOpen: true, source: 'schedule', schedule: '*/5 * * * *' })).toBe('Keeps running · New work on schedule */5 * * * * (UTC)');
  });

  it('counts leaf work in progress, not parents waiting on children', () => {
    const item = (id: string, status: WorkItem['status'], parentId?: string): WorkItem => ({ id, runId: 'run_1', title: id, body: '', nodeId: 'n', status, iteration: 1, parentId });
    expect(countActive([item('a', 'active'), item('b', 'queued', 'a'), item('c', 'active', 'a'), item('d', 'done'), item('e', 'failed')])).toBe(2);
  });
});
