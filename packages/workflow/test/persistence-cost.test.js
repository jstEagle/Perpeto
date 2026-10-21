import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { RunStore } from '../src/index.js';

const node = (id, type, config = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const flow = (id, from, to) => ({ id, kind: 'flow', from: { node: from }, to: { node: to } });
const graph = {
  schema: 'perpeto.workflow/1',
  nodes: [
    node('ideas', 'input', { source: 'manual' }),
    node('builder', 'agent', { harness: { provider: 'codex', model: 'm' }, prompt: 'Build it.', concurrency: 1000 }),
    node('shipped', 'output'),
  ],
  edges: [flow('ideas-builder', 'ideas', 'builder'), flow('builder-shipped', 'builder', 'shipped')],
};
const BODY = 'x'.repeat(4096);

/**
 * Per-event cost of `RunStore.apply` as a run accumulates finished work. Each finished item keeps a 4 KB body, a
 * 4 KB prompt and a 4 KB result, as in the wave 3 review's M15 measurement. The cost per event should not grow with
 * the number of finished items.
 */
test('per-event persistence cost stays flat as a run grows', t => {
  const directory = mkdtempSync(join(tmpdir(), 'perpeto-workflow-cost-'));
  const store = new RunStore(join(directory, 'runs.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const runId = 'run_cost';
  let seq = 0;
  const at = () => new Date(Date.UTC(2026, 9, 21) + seq * 1000).toISOString();
  const apply = (type, data) => { seq += 1; return store.apply(runId, { id: `evt_${seq}`, type, at: at(), data }); };
  apply('run.started', { runId, projectId: 'prj_1', workflowId: 'wf_1', workflowVersion: 1, graph, keepOpen: true });

  let finished = 0;
  /** Add and finish `count` items; returns milliseconds per event. */
  const finish = count => {
    const started = performance.now();
    for (let index = 0; index < count; index += 1) {
      const { effects } = apply('input.added', { items: [{ title: `Item ${finished}`, body: BODY }] });
      const assignment = effects.find(effect => effect.type === 'create-assignment').assignment;
      apply('assignment.completed', { assignmentId: assignment.id, result: { outcome: 'success', summary: BODY } });
      finished += 1;
    }
    return (performance.now() - started) / (count * 2);
  };

  // The fastest of several batches, so a busy machine (tests run in parallel) does not skew one size.
  const measure = () => Math.min(...Array.from({ length: 5 }, () => finish(10)));
  finish(50);
  const small = measure();
  finish(2000 - finished - 50);
  const large = measure();
  t.diagnostic(`per-event apply: ${small.toFixed(3)} ms at 100 finished items, ${large.toFixed(3)} ms at 2000 (×${(large / small).toFixed(2)})`);
  assert.equal(store.listWorkItems(runId, { status: 'done' }).length, 2000);
  // Generous for noisy CI machines; before the fix the ratio was about 15 at 1000 items.
  assert.ok(large < small * 2 + 0.25, `per-event cost grew from ${small.toFixed(3)} ms to ${large.toFixed(3)} ms`);
  assert.equal(store.verify(runId).ok, true);
});
