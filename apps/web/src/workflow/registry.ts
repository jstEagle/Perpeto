import type { EdgeKind, GraphNode, NodeType } from '../api/types';
import providerConfig from '../config/providers.json';

export interface ProviderOption {
  id: string;
  label: string;
  models: string[];
  /** Subscription plans offered when naming an account; any text is accepted. */
  plans?: string[];
}

export const PROVIDERS: ProviderOption[] = providerConfig.providers;

export function planSuggestions(provider: string): string[] {
  return PROVIDERS.find((p) => p.id === provider)?.plans ?? [];
}

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
    // `fail` is optional: unwired, a rejected merge fails the item.
    outputs: ['out', 'fail'],
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

/**
 * The port an edge leaves from, as the canvas and validator name it. A
 * merge queue's `pass` is its default port, as in @perpeto/workflow.
 */
export function sourcePort(type: NodeType | undefined, port?: string): string {
  return !port || (port === 'pass' && type === 'merge-queue') ? 'out' : port;
}

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

/**
 * Display name for a model id: "claude-opus-5-5" reads "Claude Opus 5.5",
 * "gpt-5.5-codex" reads "GPT 5.5 Codex". Ids stay in mono where exactness matters.
 */
export function modelName(id: string): string {
  const words: string[] = [];
  for (const part of id.split('-')) {
    const prev = words.at(-1);
    if (/^\d+(\.\d+)?$/.test(part) && prev && /^\d+$/.test(prev)) words[words.length - 1] = `${prev}.${part}`;
    else words.push(/^gpt$/i.test(part) ? 'GPT' : part.charAt(0).toUpperCase() + part.slice(1));
  }
  return words.join(' ');
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ');

/** Short one-line summary shown on the node card. */
export function nodeSummary(node: GraphNode): string {
  const c = node.config;
  switch (node.type) {
    case 'input':
      return `${sentence(String(c.source ?? 'manual'))} input`;
    case 'planner':
    case 'agent':
    case 'review': {
      const h = readHarness(node);
      if (!h) return 'No harness set';
      const n = typeof c.concurrency === 'number' && node.type === 'review' ? ` · ${c.concurrency} at a time` : '';
      return `${modelName(h.model)}${n}`;
    }
    case 'ci': {
      const steps = Array.isArray(c.steps) ? c.steps.length : 0;
      return `${steps} ${steps === 1 ? 'step' : 'steps'}`;
    }
    case 'merge-queue':
      // A node naming a project merge queue takes its strategy and method from the project settings.
      if (typeof c.queue === 'string' && c.queue) return `Project queue ${c.queue}`;
      return `${sentence(String(c.strategy ?? 'serial'))} · ${String(c.method ?? 'squash')}`;
    case 'loop':
      return `Until ${String(c.until ?? 'review-pass').replace(/-/g, ' ')} · max ${String(c.maxIterations ?? '?')}`;
    case 'human':
      return 'Waits for a person';
    case 'output':
      return 'Work item finished';
  }
}
