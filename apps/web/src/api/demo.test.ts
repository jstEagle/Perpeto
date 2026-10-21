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

  it('pauses intake when a budget is used and says which limit', async () => {
    const hub = new DemoHub();
    const run = await hub.getRun(DEMO_IDS.improveRun);
    expect(run.keepOpen).toBe(true);
    expect(run.intake).toMatchObject({ paused: true, reason: { limit: 'maxTokensPerDay', maximum: 400_000 } });
    expect(run.budgetUsage!.tokens).toBeGreaterThan(400_000);
    const raised = await hub.updateRun(DEMO_IDS.improveRun, { budget: { maxTokensPerDay: 2_000_000 } });
    expect(raised.intake?.paused).toBe(false);
    const removed = await hub.updateRun(DEMO_IDS.improveRun, { budget: {} });
    expect(removed.budget).toBeUndefined();
    expect((await hub.overview(DEMO_IDS.perpeto)).runs?.map((r) => r.workflowId).sort()).toEqual([DEMO_IDS.build, DEMO_IDS.improve].sort());
  });

  it('refuses settings the hub would refuse', async () => {
    const hub = new DemoHub();
    await expect(hub.updateRun(DEMO_IDS.run, { source: 'schedule' })).rejects.toMatchObject({ status: 400 });
    await expect(hub.updateRun(DEMO_IDS.run, { budget: { maxItemsPerDay: 0 } })).rejects.toMatchObject({ status: 400 });
    await expect(hub.updateRun(DEMO_IDS.runOld, { keepOpen: true })).rejects.toMatchObject({ status: 400 });
  });

  it('groups usage by role and lists the template library', async () => {
    const hub = new DemoHub();
    const roles = (await hub.usage({ groupBy: 'role', projectId: DEMO_IDS.perpeto })).rows.map((r) => r.key);
    expect(roles).toEqual(expect.arrayContaining(['builder', 'reviewer', 'planner', 'auditor', 'improver']));
    expect((await hub.listTemplates()).map((t) => t.id)).toEqual(['build', 'improve', 'bugfix', 'docs', 'security-audit', 'dependency-upgrade']);
  });

  it('saves the architect’s extra proposal as its own draft', async () => {
    vi.useFakeTimers();
    const hub = new DemoHub();
    const assignment = await settle(hub.requestDraft(DEMO_IDS.notes, { prompt: 'Build from the goals.' }));
    await vi.advanceTimersByTimeAsync(8000);
    const done = await settle(hub.getAssignment(assignment.id));
    expect(done.drafts).toHaveLength(2);
    expect(done.drafts![0].workflowId).toBe(done.draftWorkflowId);
    expect(done.result?.additionalWorkflows?.[0]).toMatchObject({ name: 'Improve', templateId: 'improve' });
    const workflows = await settle(hub.listWorkflows(DEMO_IDS.notes));
    expect(workflows.map((w) => w.status)).toEqual(['draft', 'draft']);
  });
});
