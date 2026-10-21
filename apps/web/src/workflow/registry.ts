import type { EdgeKind, GraphNode, NodeType } from '../api/types';
import providerConfig from '../config/providers.json';

export interface ProviderOption {
  id: string;
  label: string;
  models: string[];
}

export const PROVIDERS: ProviderOption[] = providerConfig.providers;

export function providerLabel(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

export interface NodeSpec {
  type: NodeType;
  title: string;
  description: string;
  /** Flow input port, if the node accepts work. */
  input: boolean;
  /** Flow output ports. `out` is the unnamed default port. */
  outputs: string[];
  /** Agent roles can delegate and message. */
  role: boolean;
  defaults: () => Record<string, unknown>;
}

const harness = (model = 'claude-sonnet-5-5') => ({ provider: 'claudeAgent', model });

export const NODE_SPECS: Record<NodeType, NodeSpec> = {
  input: {
    type: 'input',
    title: 'Input',
    description: 'Source of work: ideas, backlog, goals or docs.',
    input: false,
    outputs: ['out'],
    role: false,
    defaults: () => ({ source: 'manual', docs: [] }),
  },
  planner: {
    type: 'planner',
    title: 'Planner',
    description: 'Agent that turns input into work items.',
    input: true,
    outputs: ['out'],
    role: true,
    defaults: () => ({ harness: harness('claude-opus-5-5'), prompt: '', maxItems: 12 }),
  },
  agent: {
    type: 'agent',
    title: 'Agent',
    description: 'Agent role that does a work item.',
    input: true,
    outputs: ['out'],
    role: true,
    defaults: () => ({
      harness: harness(),
      prompt: '',
      concurrency: 2,
      policy: { maxSubagents: 2, allowedSubagentProviders: ['claudeAgent'], maxTurns: 60 },
    }),
  },
  review: {
    type: 'review',
    title: 'Review',
    description: 'Agent review gate. Passes or returns work.',
    input: true,
    outputs: ['pass', 'fail'],
    role: true,
    defaults: () => ({ harness: harness('claude-opus-5-5'), prompt: '', rubric: '', concurrency: 1 }),
  },
  ci: {
    type: 'ci',
    title: 'CI',
    description: 'Runs checks on a user-owned machine at the exact head commit.',
    input: true,
    outputs: ['pass', 'fail'],
    role: false,
    defaults: () => ({ steps: [{ name: 'Test', run: 'npm test' }], requirements: {} }),
  },
  'merge-queue': {
    type: 'merge-queue',
    title: 'Merge queue',
    description: 'Serialises merges into the base branch.',
    input: true,
    outputs: ['out'],
    role: false,
    defaults: () => ({ strategy: 'serial', requiredChecks: ['ci'], method: 'squash' }),
  },
  loop: {
    type: 'loop',
    title: 'Loop',
    description: 'Repeats its body until a condition or limit.',
    input: true,
    outputs: ['out'],
    role: false,
    defaults: () => ({ until: 'review-pass', maxIterations: 3 }),
  },
  human: {
    type: 'human',
    title: 'Human',
    description: 'Pauses for a person to approve or return work.',
    input: true,
    outputs: ['pass', 'fail'],
    role: false,
    defaults: () => ({ prompt: '' }),
  },
  output: {
    type: 'output',
    title: 'Output',
    description: 'Terminal. The work item is finished.',
    input: true,
    outputs: [],
    role: false,
    defaults: () => ({}),
  },
};

export const PALETTE_ORDER: NodeType[] = ['input', 'planner', 'agent', 'review', 'loop', 'ci', 'human', 'merge-queue', 'output'];

export const EDGE_KIND_LABEL: Record<EdgeKind, string> = {
  flow: 'Flow',
  delegates: 'Delegates',
  messages: 'Messages',
};

export const EDGE_KIND_HINT: Record<EdgeKind, string> = {
  flow: 'Moves work items',
  delegates: 'Grants authority to assign or spawn subagents',
  messages: 'Lets two roles message each other',
};

export function isRole(node: GraphNode | undefined): boolean {
  return !!node && NODE_SPECS[node.type].role;
}

/** Port id used in the graph for a flow output; the default port is omitted. */
export function graphPort(port: string | null | undefined): string | undefined {
  return !port || port === 'out' || port === 'in' ? undefined : port;
}

export interface HarnessConfig {
  provider: string;
  model: string;
}

export interface PolicyConfig {
  maxSubagents: number;
  allowedSubagentProviders: string[];
  maxTurns?: number;
  maxTokens?: number;
}

export function readHarness(node: GraphNode): HarnessConfig | undefined {
  const h = node.config.harness as HarnessConfig | undefined;
  return h && typeof h === 'object' ? h : undefined;
}

export function readPolicy(node: GraphNode): PolicyConfig | undefined {
  const p = node.config.policy as PolicyConfig | undefined;
  return p && typeof p === 'object' ? p : undefined;
}

/** Short one-line summary shown on the node card. */
export function nodeSummary(node: GraphNode): string {
  const c = node.config;
  switch (node.type) {
    case 'input':
      return `Source: ${String(c.source ?? 'manual')}`;
    case 'planner':
    case 'agent':
    case 'review': {
      const h = readHarness(node);
      return h ? `${providerLabel(h.provider)} · ${h.model}` : 'No harness set';
    }
    case 'ci': {
      const steps = Array.isArray(c.steps) ? c.steps.length : 0;
      return `${steps} ${steps === 1 ? 'step' : 'steps'}`;
    }
    case 'merge-queue':
      return `${String(c.strategy ?? 'serial')} · ${String(c.method ?? 'squash')}`;
    case 'loop':
      return `Until ${String(c.until ?? 'review-pass')} · max ${String(c.maxIterations ?? '?')}`;
    case 'human':
      return 'Waits for a person';
    case 'output':
      return 'Work item finished';
  }
}
