import type { WorkflowTemplate, GraphEdge, GraphNode, WorkflowGraph, WorkflowPurpose } from '../api/types';
import { NODE_SPECS } from './registry';

/**
 * Local copies of the default templates described in docs/architecture/README.md.
 * The hub's packages/workflow/templates/ are canonical; these seed
 * the editor and the demo data.
 */

export const COL = 304;
export const ROW = 320;

/** Template nodes carry no positions; the canvas lays them out along the main flow (layout.ts). */
function node(id: string, type: GraphNode['type'], label: string, config: Record<string, unknown> = {}): GraphNode {
  return { id, type, label, position: { x: 0, y: 0 }, config: { ...NODE_SPECS[type].defaults(), ...config } };
}

function flow(from: string, to: string, port?: string): GraphEdge {
  return { id: `e-${from}-${port ?? 'out'}-${to}`, from: { node: from, ...(port ? { port } : {}) }, to: { node: to }, kind: 'flow' };
}

function role(kind: 'delegates' | 'messages', from: string, to: string): GraphEdge {
  return { id: `${kind === 'delegates' ? 'd' : 'm'}-${from}-${to}`, from: { node: from }, to: { node: to }, kind };
}

export function buildTemplate(): WorkflowGraph {
  return {
    schema: 'perpeto.workflow/1',
    nodes: [
      node('input', 'input', 'Ideas and goals', { source: 'manual' }),
      node('planner', 'planner', 'Planner', {
        harness: { provider: 'claudeAgent', model: 'claude-opus-5-5' },
        prompt: 'Break the input into independently reviewable work items with acceptance criteria.',
        maxItems: 12,
      }),
      node('loop', 'loop', 'Review loop', { until: 'review-pass', maxIterations: 3 }),
      node('builder', 'agent', 'Builder', {
        harness: { provider: 'claudeAgent', model: 'claude-sonnet-5-5' },
        prompt: 'Implement the work item on its own branch and open a pull request.',
        concurrency: 4,
        policy: { maxSubagents: 2, allowedSubagentProviders: ['claudeAgent', 'codex'], maxTurns: 80 },
      }),
      node('reviewer', 'review', 'Reviewer', {
        harness: { provider: 'codex', model: 'gpt-5.5-codex' },
        prompt: 'Review the pull request against the acceptance criteria.',
        rubric: 'Correctness, tests, scope.',
        concurrency: 1,
      }),
      node('ci', 'ci', 'CI', {
        steps: [
          { name: 'Install', run: 'npm ci' },
          { name: 'Test', run: 'npm test' },
          { name: 'Build', run: 'npm run build' },
        ],
        requirements: { os: 'darwin' },
      }),
      node('merge', 'merge-queue', 'Merge queue', { strategy: 'serial', requiredChecks: ['ci'], method: 'squash' }),
      node('done', 'output', 'Merged'),
    ],
    edges: [
      flow('input', 'planner'),
      flow('planner', 'loop'),
      flow('loop', 'builder'),
      flow('builder', 'reviewer'),
      flow('reviewer', 'ci', 'pass'),
      flow('reviewer', 'loop', 'fail'),
      flow('ci', 'merge', 'pass'),
      flow('ci', 'loop', 'fail'),
      flow('merge', 'done'),
      role('delegates', 'planner', 'builder'),
      role('messages', 'builder', 'reviewer'),
    ],
  };
}

export function improveTemplate(): WorkflowGraph {
  return {
    schema: 'perpeto.workflow/1',
    nodes: [
      node('goals', 'input', 'Project goals', { source: 'goals' }),
      node('auditor', 'planner', 'Auditor', {
        harness: { provider: 'claudeAgent', model: 'claude-opus-5-5' },
        prompt: 'Audit the codebase against the goals and propose small, verifiable improvements.',
        maxItems: 6,
      }),
      node('loop', 'loop', 'Rework loop', { until: 'ci-pass', maxIterations: 2 }),
      node('improver', 'agent', 'Improver', {
        harness: { provider: 'codex', model: 'gpt-5.5-codex' },
        prompt: 'Make the improvement with tests.',
        concurrency: 2,
        policy: { maxSubagents: 0, allowedSubagentProviders: [], maxTurns: 40 },
      }),
      node('reviewer', 'review', 'Reviewer', {
        harness: { provider: 'claudeAgent', model: 'claude-opus-5-5' },
        prompt: 'Check the change is an improvement and does not widen scope.',
        rubric: 'Behaviour preserved, measurable benefit.',
        concurrency: 1,
      }),
      node('ci', 'ci', 'CI', { steps: [{ name: 'Test', run: 'npm test' }] }),
      node('merge', 'merge-queue', 'Merge queue', { strategy: 'serial', requiredChecks: ['ci'], method: 'squash' }),
      node('done', 'output', 'Merged'),
    ],
    edges: [
      flow('goals', 'auditor'),
      flow('auditor', 'loop'),
      flow('loop', 'improver'),
      flow('improver', 'reviewer'),
      flow('reviewer', 'ci', 'pass'),
      flow('reviewer', 'loop', 'fail'),
      flow('ci', 'merge', 'pass'),
      flow('ci', 'loop', 'fail'),
      flow('merge', 'done'),
      role('delegates', 'auditor', 'improver'),
      role('messages', 'improver', 'reviewer'),
    ],
  };
}

export function blankTemplate(): WorkflowGraph {
  return {
    schema: 'perpeto.workflow/1',
    nodes: [node('input', 'input', 'Input'), { ...node('done', 'output', 'Output'), position: { x: 2 * COL, y: 0 } }],
    edges: [],
  };
}

export const TEMPLATES: { purpose: WorkflowPurpose; name: string; description: string; graph: () => WorkflowGraph }[] = [
  { purpose: 'build', name: 'Build', description: 'Input, planner, builder pool, review loop, CI, merge queue.', graph: buildTemplate },
  { purpose: 'improve', name: 'Improve', description: 'Goals, auditor, improver, review, CI, merge queue.', graph: improveTemplate },
  { purpose: 'custom', name: 'Blank', description: 'An input and an output. Add the rest yourself.', graph: blankTemplate },
];

/** Library template ids as names: `security-audit` reads "Security audit". */
export function templateName(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The web's own templates, for hubs that predate GET /workflow-templates. */
export function localTemplates(): WorkflowTemplate[] {
  return TEMPLATES.filter((t) => t.purpose !== 'custom').map((t) => ({ id: t.purpose, description: t.description, graph: t.graph() }));
}
