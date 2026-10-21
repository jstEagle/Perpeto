import { describe, expect, it } from 'vitest';
import { validateGraph } from './validate';
import { diffGraphs, diffIsEmpty } from './diff';
import { buildTemplate, improveTemplate, blankTemplate } from './templates';
import { createDemoState, DEMO_IDS } from '../api/fixtures';

const errors = (g: Parameters<typeof validateGraph>[0]) => validateGraph(g).filter((i) => i.severity === 'error');

describe('validateGraph', () => {
  it('accepts the build and improve templates', () => {
    expect(errors(buildTemplate())).toEqual([]);
    expect(errors(improveTemplate())).toEqual([]);
  });

  it('reports open ports on the blank template', () => {
    const codes = errors(blankTemplate()).map((i) => i.code);
    expect(codes).toContain('open_port');
  });

  it('rejects a flow cycle that bypasses every loop node', () => {
    const g = buildTemplate();
    g.edges.push({ id: 'cycle', kind: 'flow', from: { node: 'reviewer', port: 'fail' }, to: { node: 'builder' } });
    g.edges = g.edges.filter((e) => e.id !== 'e-reviewer-fail-loop');
    expect(errors(g).map((i) => i.code)).toContain('unbounded_cycle');
  });

  it('rejects delegation from an agent whose policy allows no subagents', () => {
    const g = buildTemplate();
    const builder = g.nodes.find((n) => n.id === 'builder')!;
    builder.config = { ...builder.config, policy: { maxSubagents: 0, allowedSubagentProviders: [] } };
    g.edges.push({ id: 'd-builder-reviewer', kind: 'delegates', from: { node: 'builder' }, to: { node: 'reviewer' } });
    expect(errors(g).map((i) => i.code)).toContain('policy_conflict');
  });

  it('requires a harness on agent roles', () => {
    const g = buildTemplate();
    g.nodes.find((n) => n.id === 'reviewer')!.config.harness = { provider: '', model: '' };
    expect(errors(g).map((i) => i.code)).toContain('missing_harness');
  });

  it('keeps every demo workflow version valid', () => {
    for (const v of createDemoState(0).versions) expect(errors(v.graph), `${v.name} v${v.version}`).toEqual([]);
  });
});

describe('diffGraphs', () => {
  it('finds the demo proposal changes against the active version', () => {
    const versions = createDemoState(0).versions.filter((v) => v.id === DEMO_IDS.build);
    const v3 = versions.find((v) => v.version === 3)!;
    const v4 = versions.find((v) => v.version === 4)!;
    const d = diffGraphs(v3.graph, v4.graph);
    expect(d.nodes.added).toEqual(['checks']);
    expect(d.nodes.changed).toEqual(['reviewer']);
    expect(d.nodes.removed).toEqual([]);
    expect(d.edges.added).toHaveLength(3);
    expect(d.edges.removed).toEqual(['e-builder-out-reviewer']);
  });

  it('ignores moved nodes', () => {
    const a = buildTemplate();
    const b = buildTemplate();
    b.nodes[0].position = { x: 999, y: 999 };
    expect(diffIsEmpty(diffGraphs(a, b))).toBe(true);
  });
});
