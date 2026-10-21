import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplate, createFactoryExecutor, eventually, startFactory } from './support.js';

const reply = (rationale, graph) => `Here is the proposal.\n\n\`\`\`json\n${JSON.stringify({ rationale, graph })}\n\`\`\`\n`;

test('workflow architect drafts through a real node, retries an invalid graph, and the user activates versions', async t => {
  const template = await buildTemplate();
  const architect = (assignment, call) => {
    assert.deepEqual(assignment.repo, { url: '/tmp/architect.git', defaultBranch: 'main' });
    // The architect answers in text, as a T3 thread would; the hub parses the fenced json block.
    if (call === 1) return { outcome: 'success', summary: reply('First try.', { ...template, nodes: template.nodes.filter(node => node.type !== 'output') }) };
    if (call === 2) {
      assert.match(assignment.prompt, /Your previous graph was invalid/);
      return { outcome: 'success', summary: reply('Build with review, CI and a serial merge queue.', template) };
    }
    assert.match(assignment.prompt, /## Current workflow/);
    const graph = structuredClone(template); graph.nodes.find(node => node.id === 'reviewer').config.concurrency = 4;
    return { outcome: 'success', summary: reply('Review is the bottleneck; allow four reviewers.', graph) };
  };
  const executor = createFactoryExecutor({ architect });
  const { request } = await startFactory(t, { executor, hub: { architectHarness: { provider: 'fake', model: 'fake-architect' } } });
  const project = await request('POST', '/projects', { name: 'Architect', repo: { url: '/tmp/architect.git', defaultBranch: 'main' }, goals: ['Ship weekly'] });

  const draft = await request('POST', `/projects/${project.id}/workflows/drafts`, { prompt: 'Describe how this project should be built.' });
  assert.deepEqual(draft.repo, project.repo);
  assert.equal(draft.role, 'workflow-architect'); assert.equal(draft.runId, undefined);
  const invalid = await eventually(async () => { const value = await request('GET', `/assignments/${draft.id}`); return value.status === 'failed' && value; });
  assert.ok(invalid.architectErrors.some(error => error.code === 'NO_OUTPUT'));
  const accepted = await eventually(async () => { const value = await request('GET', `/assignments/${invalid.retryAssignmentId}`); return value.draftVersion && value; });
  assert.equal(accepted.status, 'succeeded'); assert.equal(accepted.machineId, (await request('GET', '/machines')).machines[0].id);

  const workflowId = accepted.draftWorkflowId;
  const saved = await request('GET', `/workflows/${workflowId}`);
  assert.equal(saved.status, 'draft'); assert.equal(saved.authoredBy.kind, 'agent'); assert.equal(saved.authoredBy.assignmentId, accepted.id);
  assert.equal(saved.rationale, 'Build with review, CI and a serial merge queue.'); assert.deepEqual(saved.graph, template);
  await assert.rejects(request('POST', `/workflows/${workflowId}/runs`, {}), { status: 409 });
  assert.equal((await request('POST', `/workflows/${workflowId}/activate`, { version: accepted.draftVersion })).status, 'active');

  // A follow-up proposal from the active version is a new draft with a reviewable diff; activation is explicit.
  const change = await request('POST', `/projects/${project.id}/workflows/drafts`, { prompt: 'Reviews are slow.', baseWorkflowId: workflowId });
  const second = await eventually(async () => { const value = await request('GET', `/assignments/${change.id}`); return value.draftVersion && value; });
  assert.equal(second.draftWorkflowId, workflowId); assert.equal(second.draftVersion, 2);
  const head = await request('GET', `/workflows/${workflowId}`);
  assert.equal(head.status, 'draft'); assert.equal(head.activeVersion, 1); assert.equal(head.parentVersion, 1);
  const diff = await request('GET', `/workflows/${workflowId}/diff?from=1&to=2`);
  assert.deepEqual(diff.summary, { nodesAdded: 0, nodesRemoved: 0, nodesChanged: 1, edgesAdded: 0, edgesRemoved: 0, edgesChanged: 0 });
  assert.deepEqual(diff.nodes.changed[0].changes, [{ path: 'config.concurrency', before: 2, after: 4 }]);
  const activated = await request('POST', `/workflows/${workflowId}/activate`, { version: 2 });
  assert.equal(activated.activeVersion, 2); assert.equal(activated.graph.nodes.find(node => node.id === 'reviewer').config.concurrency, 4);
  assert.deepEqual((await request('GET', `/workflows/${workflowId}/versions`)).versions.map(value => [value.version, value.authoredBy.kind]), [[1, 'agent'], [2, 'agent']]);
});
