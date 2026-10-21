import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemoHub } from './demo';
import { DEMO_IDS } from './fixtures';

/** The demo adapter simulates latency; advance fake time until the call settles. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(300);
  return promise;
}

afterEach(() => vi.useRealTimers());

describe('DemoHub', () => {
  it('drafts a new version through the architect and activates it', async () => {
    vi.useFakeTimers();
    const hub = new DemoHub();
    const events: { id: string; state: string }[] = [];
    const stop = hub.subscribe(0, (e) => e.type === 'assignment.state' && events.push({ id: e.subject.id, state: String(e.data.state) }), () => {});
    const states = (id: string) => events.filter((e) => e.id === id).map((e) => e.state);
    const assignment = await settle(hub.requestDraft(DEMO_IDS.perpeto, { prompt: 'Nothing merges without my approval.', baseWorkflowId: DEMO_IDS.build }));
    expect(states(assignment.id)).toEqual(['queued']);
    await vi.advanceTimersByTimeAsync(8000);
    expect(states(assignment.id)).toEqual(['queued', 'leased', 'running', 'running', 'running', 'running', 'succeeded']);
    expect((await settle(hub.getAssignment(assignment.id))).status).toBe('succeeded');

    const versions = await settle(hub.listVersions(DEMO_IDS.build));
    const draft = versions[0];
    expect(draft.version).toBe(5);
    expect(draft.status).toBe('draft');
    expect(draft.authoredBy).toMatchObject({ kind: 'agent', assignmentId: assignment.id });
    expect(draft.graph.nodes.some((n) => n.type === 'human')).toBe(true);

    expect((await settle(hub.activateVersion(DEMO_IDS.build, 5))).status).toBe('active');
    const after = await settle(hub.listVersions(DEMO_IDS.build));
    expect(after.filter((v) => v.status === 'active').map((v) => v.version)).toEqual([5]);
    stop();
  });

  it('refuses invalid saves', async () => {
    const hub = new DemoHub();
    const wf = await hub.getWorkflow(DEMO_IDS.build);
    await expect(hub.saveWorkflow(wf.id, { graph: { ...wf.graph, edges: [] } })).rejects.toMatchObject({ status: 422 });
  });

  it('cannot resume a stopped run', async () => {
    const hub = new DemoHub();
    await hub.stopRun(DEMO_IDS.run);
    await expect(hub.resumeRun(DEMO_IDS.run)).rejects.toMatchObject({ status: 409 });
  });
});
