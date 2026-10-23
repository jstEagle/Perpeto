import { describe, expect, it } from 'vitest';
import { normalizeMergeQueueConfig } from '@perpeto/delivery/queue-config';
import { DemoMergeQueues } from '../api/merge-queue-fixtures';
import { HubError } from '../api/hub';
import { attemptLabel, configFromDrafts, fromDraft, newDraftQueue, problemAt, queuePath, toDraft, unplacedProblems } from './merge-queue';

const NOW = Date.parse('2026-10-23T14:00:00Z');

describe('merge queue settings drafts', () => {
  it('round-trips a normalized queue through the form draft', () => {
    const queue = normalizeMergeQueueConfig({ queues: [{ name: 'main', strategy: 'batch', maxBatchSize: 4, lanes: [{ name: 'hotfix', priority: 100, branches: ['hotfix/*'] }, { name: 'normal', priority: 50 }],
      freeze: { windows: [{ cron: '0 17 * * 5', durationMinutes: 3840 }, { start: '2026-12-20T00:00:00.000Z', end: '2027-01-02T00:00:00.000Z' }] }, ejectAfterMinutes: 240 }] }).config.queues[0];
    const again = normalizeMergeQueueConfig({ queues: [fromDraft(toDraft(queue))] });
    expect(again.ok).toBe(true);
    expect(again.config.queues[0]).toEqual(queue);
  });

  it('keeps unparseable numbers so the shared validator names them at their path', () => {
    const draft = { ...newDraftQueue('main'), flakyRetries: 'two', maxInFlight: '', lanes: [{ name: 'a', priority: 'high', labels: '', branches: '' }] };
    const result = normalizeMergeQueueConfig(configFromDrafts([draft]));
    expect(problemAt(result.errors, queuePath(0, 'flakyRetries'))).toMatch(/integer from 0 to 5/);
    expect(problemAt(result.errors, `${queuePath(0, 'lanes')}[0].priority`)).toMatch(/0 to 1000/);
    expect(fromDraft(draft).maxInFlight).toBeNull();
    expect(unplacedProblems([{ path: '$.version', message: 'must be 1.' }, { path: '$.queues[0].strategy', message: 'x' }], [queuePath(0, 'strategy')])).toEqual([{ path: '$.version', message: 'must be 1.' }]);
  });
});

describe('demo merge queues', () => {
  it('orders entries by lane, estimates arrival and applies owner commands', () => {
    const demo = new DemoMergeQueues('prj_demo', NOW, () => NOW);
    const settings = demo.settings('prj_demo');
    expect(settings.repo.applied).toBe(true);
    expect(settings.queues.map((q) => [q.name, q.source])).toEqual([['main', 'merged'], ['release', 'hub']]);
    const main = demo.view(settings.queues[0].id);
    expect(main.config?.maxBatchSize).toBe(3);
    expect(main.entries.map((e) => e.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(main.entries.slice(3).map((e) => e.lane)).toEqual(['normal', 'normal', 'dependencies', 'dependencies']);
    expect(attemptLabel(main.attempts[0], main.strategy)).toBe('Batch of 3 · CI running');
    const deps = main.entries.find((e) => e.lane === 'dependencies')!;
    demo.command(deps.id, { action: 'priority', lane: 'hotfix' });
    expect(demo.view(main.id).entries.find((e) => e.status === 'queued')?.id).toBe(deps.id);
    demo.command(main.entries[0].id, { action: 'eject' });
    const after = demo.view(main.id);
    expect(after.attempts).toEqual([]);
    expect(after.recent[0].cause).toBe('manual');
    const release = demo.view(settings.queues[1].id);
    expect(release.frozen?.reason).toMatch(/Release/);
    expect(release.entries[0].etaAt).toBeUndefined();
    expect(demo.unfreeze(release.id).frozen).toBeNull();
  });

  it('validates saves with inline details and refuses a stale version', () => {
    const demo = new DemoMergeQueues('prj_demo', NOW, () => NOW);
    const bad = { version: 1, queues: [{ name: 'main', flakyRetries: 9 }] } as never;
    try {
      demo.save('prj_demo', bad, 3);
      throw new Error('expected a failure');
    } catch (e) {
      expect(e).toBeInstanceOf(HubError);
      expect((e as HubError).details?.[0].path).toBe('$.queues[0].flakyRetries');
    }
    expect(() => demo.save('prj_demo', { version: 1, queues: [] }, 1)).toThrow(/version 3/);
    expect(demo.save('prj_demo', { version: 1, queues: [] }, 3).version).toBe(4);
  });
});
