import type { WorkflowGraph, WorkflowTemplate } from './types';

/**
 * The workflow package's template library, for the demo hub. Graphs are the
 * canonical files in packages/workflow/templates; descriptions mirror
 * packages/workflow/src/templates.js, which reads them from disk and so
 * cannot load in a browser.
 */
const DESCRIPTIONS: Record<string, string> = {
  build: 'Plan and build features with bounded review, CI and a serial merge queue.',
  improve: 'Continuously propose measurable improvements against unfinished goals, metrics and prior outcomes.',
  bugfix: 'Triage a bug, reproduce it in a failing test, fix it, review, run CI and merge.',
  docs: 'Write and verify documentation, review accuracy and links, then merge.',
  'security-audit': 'Audit for vulnerabilities, verify findings, fix confirmed issues, review, run CI and merge.',
  'dependency-upgrade': 'Plan scoped dependency upgrades, apply migrations, review compatibility, run CI and merge.',
};

const GRAPHS = import.meta.glob<WorkflowGraph>('../../../../packages/workflow/templates/*.json', { eager: true, import: 'default' });

export function libraryTemplates(): WorkflowTemplate[] {
  const byId = new Map(Object.entries(GRAPHS).map(([path, graph]) => [path.split('/').pop()!.replace(/\.json$/, ''), graph]));
  return Object.entries(DESCRIPTIONS)
    .filter(([id]) => byId.has(id))
    .map(([id, description]) => ({ id, description, graph: structuredClone(byId.get(id)!) }));
}
