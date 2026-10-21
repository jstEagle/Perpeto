import { readFileSync } from 'node:fs';
import { EDGE_KINDS, GRAPH_SCHEMA, LIMITS, NODE_TYPES, SAFE_MAX_ITERATIONS, validateGraph } from './graph.js';
import { WorkflowError, fail, isPlainObject, isText } from './util.js';

export const ARCHITECT_ROLE = 'workflow-architect';
/** The hub returns invalid graphs to the architect with their errors, up to this many attempts in total. */
export const ARCHITECT_MAX_ATTEMPTS = 3;

const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$';
const PROVIDER_PATTERN = '^[A-Za-z][A-Za-z0-9._-]{0,63}$';
const text = { type: 'string', minLength: 1 };
const strings = { type: 'array', items: text, uniqueItems: true };
const harness = {
  type: 'object', required: ['provider', 'model'], additionalProperties: false,
  properties: {
    provider: { type: 'string', pattern: PROVIDER_PATTERN, description: 'T3 driver kind, for example claudeAgent or codex.' },
    model: text,
    options: { type: 'object', additionalProperties: { type: ['string', 'boolean'] } },
  },
};
const requirements = {
  type: 'object', additionalProperties: false,
  properties: { os: { enum: ['darwin', 'linux', 'windows'] }, labels: strings, providers: strings },
};
const policy = {
  type: 'object', additionalProperties: false,
  properties: {
    maxSubagents: { type: 'integer', minimum: 0, maximum: LIMITS.maxSubagents },
    allowedSubagentProviders: { type: 'array', items: { type: 'string', pattern: PROVIDER_PATTERN } },
    maxTurns: { type: 'integer', minimum: 1 }, maxTokens: { type: 'integer', minimum: 1 },
  },
};
const retry = {
  type: 'object', required: ['maxAttempts'], additionalProperties: false,
  properties: {
    maxAttempts: { type: 'integer', minimum: 1, maximum: LIMITS.maxAttempts },
    backoffSec: { type: 'integer', minimum: 0, maximum: LIMITS.backoffSec },
  },
};
const nodeRef = { type: 'string', pattern: ID_PATTERN };
const role = (extra = {}, required = []) => ({
  type: 'object', required: ['harness', 'prompt', ...required],
  properties: {
    harness, prompt: text, concurrency: { type: 'integer', minimum: 1, maximum: LIMITS.concurrency }, policy, requirements,
    role: { type: 'string', pattern: ID_PATTERN }, retry, onExhausted: nodeRef, onBlocked: nodeRef, ...extra,
  },
});
const CONFIG_SCHEMAS = {
  input: { type: 'object', required: ['source'], properties: { source: { enum: ['manual', 'goals', 'issues'] }, docs: strings } },
  planner: role({ maxItems: { type: 'integer', minimum: 1, maximum: LIMITS.maxItems } }),
  agent: role(),
  review: role({ rubric: text }),
  ci: {
    type: 'object', required: ['steps'],
    properties: {
      steps: {
        type: 'array', minItems: 1, maxItems: LIMITS.steps,
        items: { type: 'object', required: ['name', 'run'], additionalProperties: false,
          properties: { name: text, run: text, timeoutSec: { type: 'integer', minimum: 1, maximum: 86400 } } },
      },
      requirements, retry, onExhausted: nodeRef,
    },
  },
  'merge-queue': {
    type: 'object', required: ['strategy', 'method'],
    properties: { strategy: { enum: ['serial', 'batch'] }, method: { enum: ['squash', 'merge', 'rebase'] }, requiredChecks: strings },
  },
  loop: {
    type: 'object', required: ['until', 'maxIterations'],
    properties: {
      until: { enum: ['review-pass', 'ci-pass', 'manual'] },
      maxIterations: { type: 'integer', minimum: 1, maximum: LIMITS.maxIterations },
      expectedIterations: { type: 'number', minimum: 1, maximum: LIMITS.maxIterations },
      onExhausted: nodeRef,
    },
  },
  human: { type: 'object', required: ['prompt'], properties: { prompt: text } },
  output: { type: 'object' },
};

/**
 * JSON Schema (2020-12) for the structure of a `perpeto.workflow/1` graph. Structural only: routing, reachability,
 * loop and delegation rules are enforced by `validateGraph`.
 */
export const GRAPH_JSON_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://perpeto.dev/schemas/workflow-1.json',
  title: 'Perpeto workflow graph v1',
  type: 'object', required: ['schema', 'nodes', 'edges'], additionalProperties: false,
  properties: {
    schema: { const: GRAPH_SCHEMA },
    nodes: {
      type: 'array', maxItems: LIMITS.nodes,
      items: {
        type: 'object', required: ['id', 'type', 'label', 'position', 'config'],
        properties: {
          id: { type: 'string', pattern: ID_PATTERN }, type: { enum: [...NODE_TYPES] }, label: text,
          position: { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
          config: { type: 'object' },
        },
        allOf: NODE_TYPES.map(type => ({ if: { properties: { type: { const: type } } }, then: { properties: { config: CONFIG_SCHEMAS[type] } } })),
      },
    },
    edges: {
      type: 'array', maxItems: LIMITS.edges,
      items: {
        type: 'object', required: ['id', 'from', 'to', 'kind'], additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: ID_PATTERN }, kind: { enum: [...EDGE_KINDS] },
          from: { type: 'object', required: ['node'], additionalProperties: false, properties: { node: text, port: { enum: ['pass', 'fail'] } } },
          to: { type: 'object', required: ['node'], additionalProperties: false, properties: { node: text } },
        },
      },
    },
  },
});

const GRAPH_GUIDE = `A workflow is a JSON object { "schema": "${GRAPH_SCHEMA}", "nodes": [...], "edges": [...] }.

Nodes are { "id", "type", "label", "position": { "x", "y" }, "config" }. Ids use letters, digits, ".", "_", ":" or "-".

| type | meaning | config (* = required) |
| --- | --- | --- |
| input | where work enters | source* ("manual", "goals" or "issues"), docs (doc ids) |
| planner | agent that splits input into work items | harness*, prompt*, maxItems (1-${LIMITS.maxItems}, default 20), concurrency, policy, requirements, role, retry, onExhausted, onBlocked |
| agent | agent role that does a work item | harness*, prompt*, concurrency (default 1), policy, requirements, role, retry, onExhausted, onBlocked |
| review | agent review gate; the reviewer reports verdict "pass" or "fail" | harness*, prompt*, rubric, concurrency, policy, requirements, role, retry, onExhausted, onBlocked |
| ci | CI gate run on a user machine at the exact head commit | steps* ([{ name, run, timeoutSec? }]), requirements, retry, onExhausted |
| merge-queue | serialises merges into the base branch | strategy* ("serial" or "batch"), method* ("squash", "merge" or "rebase"), requiredChecks |
| loop | repeats its body; after maxIterations passes the item escalates to onExhausted or fails | until* ("review-pass", "ci-pass" or "manual"), maxIterations* (1-${LIMITS.maxIterations}), expectedIterations, onExhausted |
| human | waits for a person to pass or fail the item | prompt* |
| output | terminal: work item finished | none |

harness is { "provider": T3 driver kind such as "claudeAgent" or "codex", "model": model id, "options"?: { string: string | boolean } }.
policy is { "maxSubagents"?, "allowedSubagentProviders"?, "maxTurns"?, "maxTokens"? }. Do not set canMessage; it comes from messages edges.
requirements is { "os"?: "darwin" | "linux" | "windows", "labels"?: [string], "providers"?: [string] }.
retry is { "maxAttempts": 1-${LIMITS.maxAttempts} (total attempts, default 1), "backoffSec"?: 0-${LIMITS.backoffSec} }. It covers errors, not verdicts: an agent reporting failure, a review without a verdict, or a CI job that errored or was cancelled. Retry n waits backoffSec × 2^(n-1) seconds.
onExhausted names a human, agent or review node that takes the item once retries or loop iterations run out; without it the item fails. onBlocked names a human node for items an agent reports as blocked; it defaults to onExhausted when that is a human node, otherwise blocked items wait in place for a person. A human node used as an escalation target may leave "fail" unwired: failing there ends the item.

Edges are { "id", "kind", "from": { "node", "port"? }, "to": { "node" } }:
- "flow" moves work items. review, ci and human nodes need exactly one flow edge on port "pass" and one on port "fail". merge-queue needs "pass" and may have "fail" (without it a rejected merge fails the item). Every other node except output has exactly one unported flow edge out. Nothing flows into input or out of output.
- "delegates" runs from a planner or agent to an agent and lets the source assign work or spawn subagents in the target role, bounded by the target's concurrency and the source's policy.maxSubagents. An agent reached only by delegates edges is a helper role and needs no flow edges.
- "messages" connects planner, agent or review roles that may message each other, in both directions.

Rules: every node must be reachable from an input, through flow edges or escalation targets; every cycle, including one through an escalation, must return into a loop node from inside that loop's body; a loop with until "review-pass" needs a review gate in its body whose fail edge returns to the loop ("ci-pass" needs a ci gate, "manual" a human gate). Work items carry branch, pull request URL and head commit from the agent that built them; ci and merge-queue nodes need those, so put an agent before them.`;

const DEFAULTS_GUIDE = `Unless the request says otherwise, use these values. Runs are unattended, so a single transient error should never end an item.

- Retries: every planner, agent and review node gets "retry": { "maxAttempts": 3, "backoffSec": 30 }; every ci node gets "retry": { "maxAttempts": 2, "backoffSec": 30 }. Never set retry.maxAttempts to 1 unless the node has an onExhausted target. A request for fewer loop passes or lower cost is not a request for fewer retries: retries cover errors, not verdicts.
- Loops: a review loop with maxIterations 3 and a delivery loop (until ci-pass) with maxIterations 3. Stay between 2 and 5; above ${SAFE_MAX_ITERATIONS} rework rarely converges.
- Concurrency: keep the sum of agent concurrency within the machines' capacity. Planner 1. Builders up to the planner's maxItems. One reviewer per two or three builders.
- Models: give the strongest model and higher reasoning effort to builders and to escalation targets such as a senior reviewer. Planners, first-pass reviewers and triage can use a cheaper, faster model or lower effort when one is available.
- Escalation: when the request allows a person in the loop, send exhausted and blocked work to a human triage node through onExhausted and onBlocked.`;

const repoIsLocal = repo => [repo?.url, repo?.localPath].some(value => typeof value === 'string' && (value.startsWith('/') || value.startsWith('file://'))) &&
  !/^(?:https:\/\/|ssh:\/\/git@|git@)/.test(repo?.url ?? '');

const LOCAL_DELIVERY = 'This project uses a local repository, not a forge such as GitHub. There are no pull requests: the factory publishes each work branch to the local origin, ' +
  'addresses it as local:<branch>, and the merge queue merges it after review and CI. Write prompts that ask builders to commit on their work branch and report what they did; ' +
  'do not ask agents to open, register or merge pull requests, or to push.';

/** Plain-language description of graph v1 for agent prompts. */
export function describeGraphSchema() { return GRAPH_GUIDE; }

let example;
const buildExample = () => example ??= JSON.stringify(JSON.parse(readFileSync(new URL('../templates/build.json', import.meta.url), 'utf8')));
const clip = (value, max) => value.length > max ? `${value.slice(0, max)}\n[truncated ${value.length - max} characters]` : value;
const list = items => items.map(item => `- ${item}`).join('\n');

/**
 * Build the prompt for a `workflow-architect` assignment. Deterministic for the same input.
 * @param {{ project: { name: string, repo?: { url?: string, defaultBranch?: string } }, docs?: Array<{ title: string, kind?: string, path?: string, url?: string, excerpt?: string }>,
 *   goals?: string[], machines?: Array<{ name?: string, id?: string, os?: string, arch?: string, labels?: string[], providers?: string[], capacity?: { maxAgents?: number, maxJobs?: number }, status?: string }>,
 *   providers?: Array<string | { provider: string, models?: string[] }>, existingWorkflow?: { name?: string, version?: number, graph: object },
 *   userPrompt: string, previousErrors?: Array<{ code: string, message: string, nodeId?: string, edgeId?: string }> }} input
 */
export function buildArchitectPrompt({ project, docs = [], goals = [], machines = [], providers = [], existingWorkflow, userPrompt, previousErrors = [] }) {
  if (!isText(userPrompt, 20000)) fail('INVALID_INPUT', 'userPrompt must be a nonblank string of at most 20000 characters.');
  if (!isPlainObject(project) || !isText(project.name, 200)) fail('INVALID_INPUT', 'project needs a name.');
  for (const [label, value] of [['docs', docs], ['goals', goals], ['machines', machines], ['providers', providers], ['previousErrors', previousErrors]]) {
    if (!Array.isArray(value)) fail('INVALID_INPUT', `${label} must be an array.`);
  }
  if (existingWorkflow !== undefined && !(isPlainObject(existingWorkflow) && isPlainObject(existingWorkflow.graph))) {
    fail('INVALID_INPUT', 'existingWorkflow needs a graph.');
  }

  const parts = [
    `You are the ${ARCHITECT_ROLE} for the Perpeto project "${project.name}". Design how this project's software should be built as a ${GRAPH_SCHEMA} workflow graph. ` +
    'Perpeto saves your graph as a draft. Nothing runs until a person reviews and activates it.',
    `## Request\n\n${userPrompt}`,
  ];
  const repo = project.repo ?? {};
  const repoLine = [repo.url ?? repo.localPath, repo.defaultBranch && `default branch ${repo.defaultBranch}`].filter(Boolean).join(', ');
  parts.push(`## Project\n\nName: ${project.name}${repoLine ? `\nRepository: ${repoLine}` : ''}${repoIsLocal(repo) ? `\n\n${LOCAL_DELIVERY}` : ''}`);
  if (goals.length) parts.push(`## Goals\n\n${list(goals.map(String))}`);
  if (docs.length) {
    parts.push(`## Docs\n\n${docs.map(doc => {
      const where = doc.path ?? doc.url;
      const head = `- ${doc.title}${doc.kind ? ` (${doc.kind})` : ''}${where ? `: ${where}` : ''}`;
      return doc.excerpt ? `${head}\n\n${clip(String(doc.excerpt), 4000)}\n` : head;
    }).join('\n')}`);
  }
  if (machines.length) {
    parts.push(`## Machines\n\n${list(machines.map(machine => {
      const facts = [
        [machine.os, machine.arch].filter(Boolean).join('/'),
        machine.status,
        machine.labels?.length && `labels ${machine.labels.join(', ')}`,
        machine.providers?.length && `providers ${machine.providers.join(', ')}`,
        machine.capacity && `capacity ${machine.capacity.maxAgents ?? '?'} agents, ${machine.capacity.maxJobs ?? '?'} CI jobs`,
      ].filter(Boolean);
      return `${machine.name ?? machine.id ?? 'machine'}: ${facts.join('; ')}`;
    }))}`);
  }
  if (providers.length) {
    parts.push(`## Providers you may use\n\n${list(providers.map(entry => typeof entry === 'string'
      ? entry : `${entry.provider}${entry.models?.length ? `: models ${entry.models.join(', ')}` : ''}`))}`);
  }
  if (existingWorkflow) {
    const title = [existingWorkflow.name, existingWorkflow.version && `version ${existingWorkflow.version}`].filter(Boolean).join(', ');
    parts.push(`## Current workflow${title ? ` (${title})` : ''}\n\nChange it only where the request or the evidence calls for it, and keep ids of unchanged nodes and edges so people can review the diff.\n\n\`\`\`json\n${JSON.stringify(existingWorkflow.graph)}\n\`\`\``);
  }
  if (previousErrors.length) {
    parts.push(`## Your previous graph was invalid\n\nFix every error below and return the complete corrected graph.\n\n${list(previousErrors.map(error =>
      `${error.code}${error.nodeId ? ` at node ${error.nodeId}` : ''}${error.edgeId ? ` at edge ${error.edgeId}` : ''}: ${error.message}`))}`);
  }
  parts.push(`## Graph format\n\n${GRAPH_GUIDE}`);
  parts.push(`## Defaults\n\n${DEFAULTS_GUIDE}`);
  parts.push(`## Example: the default build workflow\n\n\`\`\`json\n${buildExample()}\n\`\`\``);
  parts.push('## Answer format\n\n' +
    'Reply with exactly one fenced json block containing { "rationale": string, "graph": object }. The rationale explains, in a few short paragraphs, ' +
    'why this shape suits the project: roles, models, concurrency, gates and loop limits. ' +
    (providers.length ? 'Use only the providers listed above. ' : '') +
    (machines.length ? 'Keep total agent concurrency within the machines\' capacity and give CI requirements that some machine meets. ' : '') +
    'Prefer review and CI gates before any merge queue, and bounded loops for rework.');
  return parts.join('\n\n');
}

// One whitespace run before the optional language tag, so an unclosed fence followed by spaces cannot backtrack quadratically.
const FENCE = /```[ \t]*(?:(?:json|JSON)[ \t]*)?\r?\n([\s\S]*?)```/g;

/**
 * Extract `{ graph, rationale }` from an architect's reply. Accepts a fenced json block holding `{ graph, rationale }`,
 * or a fenced bare graph with the rationale written as prose outside the block. The last usable block wins.
 * Also accepts an already-parsed `{ graph, rationale }` object. Throws `WorkflowError('ARCHITECT_PARSE_ERROR')`.
 */
export function parseArchitectResult(text) {
  if (isPlainObject(text)) return checked(text.graph, text.rationale);
  if (typeof text !== 'string' || !text.trim()) fail('ARCHITECT_PARSE_ERROR', 'Architect reply is empty.');
  if (text.length > 2_000_000) fail('ARCHITECT_PARSE_ERROR', 'Architect reply is too large.');
  const blocks = [...text.matchAll(FENCE)];
  const candidates = blocks.length ? blocks.map(match => match[1]).reverse() : [text.trim()];
  let parsedAny = false;
  for (const candidate of candidates) {
    let value;
    try { value = JSON.parse(candidate); } catch { continue; }
    parsedAny = true;
    if (isPlainObject(value) && isPlainObject(value.graph)) return checked(value.graph, value.rationale);
    if (isPlainObject(value) && value.schema === GRAPH_SCHEMA) {
      return checked(value, text.replace(FENCE, '').trim());
    }
  }
  fail('ARCHITECT_PARSE_ERROR', parsedAny
    ? 'No JSON block contained { "graph": …, "rationale": … } or a workflow graph.'
    : 'Reply did not contain a parseable fenced json block.');
}

function checked(graph, rationale) {
  if (!isPlainObject(graph)) fail('ARCHITECT_PARSE_ERROR', 'Reply has no graph object.');
  if (!isText(rationale, 20000)) fail('ARCHITECT_PARSE_ERROR', 'Reply needs a nonblank rationale of at most 20000 characters.');
  return { graph, rationale: rationale.trim() };
}

/**
 * Parse and validate an architect reply in one step, for the hub's retry loop.
 * @returns {{ ok: boolean, graph?: object, rationale?: string, errors: object[], warnings: object[] }}
 */
export function evaluateArchitectResult(text, options) {
  let parsed;
  try { parsed = parseArchitectResult(text); } catch (error) {
    if (!(error instanceof WorkflowError)) throw error;
    return { ok: false, errors: [{ code: error.code, message: error.message }], warnings: [] };
  }
  return { ...validateGraph(parsed.graph, options), ...parsed };
}
