import { WorkflowError, canonicalJson, isPlainObject, isText, sha256 } from './util.js';

export const GRAPH_SCHEMA = 'perpeto.workflow/1';
export const PLAN_SCHEMA = 'perpeto.plan/1';
export const NODE_TYPES = Object.freeze(['input', 'planner', 'agent', 'review', 'ci', 'merge-queue', 'loop', 'human', 'output']);
export const EDGE_KINDS = Object.freeze(['flow', 'delegates', 'messages']);
/** Gates must wire both `pass` and `fail`. The merge queue routes `pass` and optionally `fail`. */
export const GATE_TYPES = Object.freeze(['review', 'ci', 'human']);
/** Node types that run as an agent assignment and therefore have a role, harness and policy. */
export const ROLE_TYPES = Object.freeze(['planner', 'agent', 'review']);
export const LIMITS = Object.freeze({
  nodes: 500, edges: 2000, maxIterations: 100, concurrency: 1000, maxItems: 100, maxSubagents: 100, steps: 50,
  maxAttempts: 10, backoffSec: 86400,
});
/** Node types an `onExhausted` escalation may target. `onBlocked` must target a human node. */
export const ESCALATION_TARGET_TYPES = Object.freeze(['human', 'agent', 'review']);

const PORTED = new Set([...GATE_TYPES, 'merge-queue']);
/** Node types that accept a `retry` policy for infrastructure and agent errors. */
const RETRY_TYPES = Object.freeze([...ROLE_TYPES, 'ci']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
/** Ids become keys of plain objects in plans and run state, so they must not shadow `Object.prototype` members. */
const RESERVED_IDS = new Set(Object.getOwnPropertyNames(Object.prototype));
const isId = value => typeof value === 'string' && ID.test(value) && !RESERVED_IDS.has(value);
const reservedNote = value => RESERVED_IDS.has(value) ? ` "${value}" is reserved.` : '';
const PROVIDER = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

// Config field checkers return null when valid, or [code, message].
const invalid = (message, code = 'INVALID_CONFIG') => [code, message];
const oneOf = values => value => values.includes(value) ? null : invalid(`must be one of ${values.join(', ')}.`);
const text = max => value => isText(value, max) ? null : invalid(`must be a nonblank string of at most ${max} characters.`);
const integer = (min, max, code) => value =>
  Number.isSafeInteger(value) && value >= min && value <= max ? null : invalid(`must be an integer from ${min} to ${max}.`, code);
const stringArray = (max = 100) => value =>
  Array.isArray(value) && value.length <= max && value.every(item => isText(item, 200)) && new Set(value).size === value.length
    ? null : invalid(`must be an array of at most ${max} distinct nonblank strings.`);
const exactKeys = (value, allowed) => Object.keys(value).find(key => !allowed.includes(key));

function harness(value) {
  const bad = message => invalid(message, 'INVALID_HARNESS');
  if (!isPlainObject(value)) return bad('must be an object { provider, model, options? }.');
  const extra = exactKeys(value, ['provider', 'model', 'options']);
  if (extra) return bad(`has unknown key "${extra}".`);
  if (typeof value.provider !== 'string' || !PROVIDER.test(value.provider)) return bad('provider must be a T3 driver kind such as "claudeAgent" or "codex".');
  if (!isText(value.model, 200)) return bad('model must be a nonblank string.');
  if (value.options !== undefined) {
    if (!isPlainObject(value.options) || Object.keys(value.options).length > 50) return bad('options must be an object with at most 50 keys.');
    for (const [key, option] of Object.entries(value.options)) {
      if (!isText(key, 100) || !(typeof option === 'boolean' || (typeof option === 'string' && option.length <= 1000))) {
        return bad('options values must be strings or booleans.');
      }
    }
  }
  return null;
}

function policy(value) {
  const bad = message => invalid(message, 'INVALID_POLICY');
  if (!isPlainObject(value)) return bad('must be an object.');
  const extra = exactKeys(value, ['maxSubagents', 'allowedSubagentProviders', 'maxTurns', 'maxTokens', 'canMessage']);
  if (extra) return bad(`has unknown key "${extra}".`);
  if (value.maxSubagents !== undefined && integer(0, LIMITS.maxSubagents)(value.maxSubagents)) return bad(`maxSubagents must be an integer from 0 to ${LIMITS.maxSubagents}.`);
  if (value.allowedSubagentProviders !== undefined &&
      !(Array.isArray(value.allowedSubagentProviders) && value.allowedSubagentProviders.every(item => typeof item === 'string' && PROVIDER.test(item)))) {
    return bad('allowedSubagentProviders must be an array of T3 driver kinds.');
  }
  if (value.maxTurns !== undefined && integer(1, 100000)(value.maxTurns)) return bad('maxTurns must be a positive integer.');
  if (value.maxTokens !== undefined && integer(1, 1e12)(value.maxTokens)) return bad('maxTokens must be a positive integer.');
  if (value.canMessage !== undefined && !Array.isArray(value.canMessage)) return bad('canMessage must be an array.');
  return null;
}

function requirements(value) {
  if (!isPlainObject(value)) return invalid('must be an object { os?, labels?, providers? }.');
  const extra = exactKeys(value, ['os', 'labels', 'providers']);
  if (extra) return invalid(`has unknown key "${extra}".`);
  if (value.os !== undefined && oneOf(['darwin', 'linux', 'windows'])(value.os)) return invalid('os must be darwin, linux or windows.');
  if (value.labels !== undefined && stringArray()(value.labels)) return invalid('labels must be an array of distinct strings.');
  if (value.providers !== undefined && stringArray()(value.providers)) return invalid('providers must be an array of distinct strings.');
  return null;
}

function steps(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > LIMITS.steps) return invalid(`must be an array of 1 to ${LIMITS.steps} steps.`);
  const names = new Set();
  for (const step of value) {
    if (!isPlainObject(step) || exactKeys(step, ['name', 'run', 'timeoutSec'])) return invalid('each step must be { name, run, timeoutSec? }.');
    if (!isText(step.name, 100) || !isText(step.run, 10000)) return invalid('each step needs a nonblank name and run command.');
    if (step.timeoutSec !== undefined && integer(1, 86400)(step.timeoutSec)) return invalid('timeoutSec must be an integer from 1 to 86400.');
    if (names.has(step.name)) return invalid(`step name "${step.name}" is repeated.`);
    names.add(step.name);
  }
  return null;
}

function retry(value) {
  const bad = message => invalid(message, 'INVALID_RETRY');
  if (!isPlainObject(value)) return bad('must be an object { maxAttempts, backoffSec? }.');
  const extra = exactKeys(value, ['maxAttempts', 'backoffSec']);
  if (extra) return bad(`has unknown key "${extra}".`);
  if (integer(1, LIMITS.maxAttempts)(value.maxAttempts)) return bad(`maxAttempts must be an integer from 1 to ${LIMITS.maxAttempts}.`);
  if (value.backoffSec !== undefined && integer(0, LIMITS.backoffSec)(value.backoffSec)) return bad(`backoffSec must be an integer from 0 to ${LIMITS.backoffSec}.`);
  return null;
}

const role = value => isId(value) ? null : invalid(`must be a role id of letters, digits, ".", "_", ":" or "-".${reservedNote(value)}`);
const nodeRef = value => isId(value) ? null : invalid('must be a node id.', 'INVALID_ESCALATION');
const optional = check => ({ required: false, check });
const required = check => ({ required: true, check });
const agentRole = {
  harness: required(harness), prompt: required(text(20000)), concurrency: optional(integer(1, LIMITS.concurrency)),
  policy: optional(policy), requirements: optional(requirements), role: optional(role),
  retry: optional(retry), onExhausted: optional(nodeRef), onBlocked: optional(nodeRef),
};

/** Config fields per node type. Unknown keys produce a warning, not an error, so drafts survive editor upgrades. */
export const NODE_CONFIG = Object.freeze({
  input: { source: required(oneOf(['manual', 'goals', 'issues'])), docs: optional(stringArray(200)) },
  planner: { ...agentRole, maxItems: optional(integer(1, LIMITS.maxItems)) },
  agent: agentRole,
  review: { ...agentRole, rubric: optional(text(20000)) },
  ci: { steps: required(steps), requirements: optional(requirements), retry: optional(retry), onExhausted: optional(nodeRef) },
  'merge-queue': {
    strategy: required(oneOf(['serial', 'batch'])), method: required(oneOf(['squash', 'merge', 'rebase'])),
    requiredChecks: optional(stringArray()),
  },
  loop: {
    until: required(oneOf(['review-pass', 'ci-pass', 'manual'])),
    maxIterations: required(integer(1, LIMITS.maxIterations, 'LOOP_BOUNDS')),
    expectedIterations: optional(value => typeof value === 'number' && value >= 1 && value <= LIMITS.maxIterations
      ? null : invalid('must be a number from 1 to maxIterations.', 'LOOP_BOUNDS')),
    onExhausted: optional(nodeRef),
  },
  human: { prompt: required(text(20000)) },
  output: {},
});

const UNTIL_GATE = { 'review-pass': 'review', 'ci-pass': 'ci', manual: 'human' };

/**
 * Validate a `perpeto.workflow/1` graph. Never throws for malformed input.
 * @param {unknown} graph
 * @param {{ providers?: string[] }} [options] When `providers` is given, harness providers outside it are errors.
 * @returns {{ ok: boolean, errors: Issue[], warnings: Issue[] }}
 * @typedef {{ code: string, message: string, nodeId?: string, edgeId?: string }} Issue
 */
export function validateGraph(graph, options = {}) {
  return analyse(graph, options).result;
}

function analyse(graph, { providers } = {}) {
  const errors = [], warnings = [];
  const issue = (list, code, message, at = {}) => list.push({ code, message, ...at });
  const error = (code, message, at) => issue(errors, code, message, at);
  const warn = (code, message, at) => issue(warnings, code, message, at);
  const done = () => ({ result: { ok: errors.length === 0, errors, warnings } });

  if (!isPlainObject(graph)) { error('INVALID_GRAPH', 'Graph must be an object.'); return done(); }
  if (graph.schema !== GRAPH_SCHEMA) error('INVALID_SCHEMA', `Graph schema must be "${GRAPH_SCHEMA}".`);
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) { error('INVALID_GRAPH', 'Graph needs nodes and edges arrays.'); return done(); }
  if (graph.nodes.length > LIMITS.nodes) { error('LIMIT_EXCEEDED', `Graph has more than ${LIMITS.nodes} nodes.`); return done(); }
  if (graph.edges.length > LIMITS.edges) { error('LIMIT_EXCEEDED', `Graph has more than ${LIMITS.edges} edges.`); return done(); }
  const extraTop = exactKeys(graph, ['schema', 'nodes', 'edges']);
  if (extraTop) warn('UNKNOWN_KEY', `Graph has unknown key "${extraTop}".`);

  /** @type {Map<string, any>} */
  const nodes = new Map();
  for (const node of graph.nodes) {
    if (!isPlainObject(node) || !isId(node.id)) {
      error('INVALID_NODE', `Each node needs an id of letters, digits, ".", "_", ":" or "-" (at most 100 characters).${reservedNote(node?.id)}`);
      continue;
    }
    const at = { nodeId: node.id };
    if (nodes.has(node.id)) { error('DUPLICATE_ID', `Node id "${node.id}" is repeated.`, at); continue; }
    if (!NODE_TYPES.includes(node.type)) { error('UNKNOWN_NODE_TYPE', `Node "${node.id}" has unknown type ${JSON.stringify(node.type)}.`, at); continue; }
    if (!isText(node.label, 200)) error('INVALID_NODE', `Node "${node.id}" needs a nonblank label.`, at);
    if (!isPlainObject(node.position) || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) {
      error('INVALID_NODE', `Node "${node.id}" needs a numeric position { x, y }.`, at);
    }
    const config = node.config ?? {};
    if (!isPlainObject(config)) { error('INVALID_CONFIG', `Node "${node.id}" config must be an object.`, at); continue; }
    const spec = NODE_CONFIG[node.type];
    for (const [key, field] of Object.entries(spec)) {
      if (config[key] === undefined) {
        if (field.required) error('MISSING_CONFIG', `${node.type} node "${node.id}" requires config.${key}.`, at);
        continue;
      }
      const problem = field.check(config[key]);
      if (problem) error(problem[0], `${node.type} node "${node.id}" config.${key} ${problem[1]}`, at);
    }
    for (const key of Object.keys(config)) {
      if (!Object.hasOwn(spec, key)) warn('UNKNOWN_CONFIG_KEY', `${node.type} node "${node.id}" has unknown config key "${key}".`, at);
    }
    if (node.type === 'loop' && typeof config.expectedIterations === 'number' && Number.isSafeInteger(config.maxIterations) &&
        config.expectedIterations > config.maxIterations) {
      error('LOOP_BOUNDS', `loop node "${node.id}" expectedIterations cannot exceed maxIterations.`, at);
    }
    if (config.policy?.canMessage !== undefined) {
      warn('POLICY_CANMESSAGE_DERIVED', `Node "${node.id}" policy.canMessage is ignored; it is derived from messages edges.`, at);
    }
    if (providers && isPlainObject(config.harness) && typeof config.harness.provider === 'string' && !providers.includes(config.harness.provider)) {
      error('UNAVAILABLE_PROVIDER', `Node "${node.id}" uses provider "${config.harness.provider}", which no machine offers.`, at);
    }
    nodes.set(node.id, { ...node, config });
  }

  // Escalation links: where work goes when a node exhausts its retries or iterations, or reports blocked.
  const escalations = [];
  for (const node of nodes.values()) {
    for (const key of ['onExhausted', 'onBlocked']) {
      const target = node.config[key];
      if (!isId(target)) continue;
      const to = nodes.get(target), at = { nodeId: node.id };
      if (!to) error('INVALID_ESCALATION', `${node.type} node "${node.id}" config.${key} names missing node "${target}".`, at);
      else if (to.id === node.id) error('INVALID_ESCALATION', `${node.type} node "${node.id}" config.${key} cannot name the node itself.`, at);
      else if (key === 'onBlocked' && to.type !== 'human') error('INVALID_ESCALATION', `${node.type} node "${node.id}" config.onBlocked must name a human node (got ${to.type}).`, at);
      else if (!ESCALATION_TARGET_TYPES.includes(to.type)) {
        error('INVALID_ESCALATION', `${node.type} node "${node.id}" config.${key} must name a human, agent or review node (got ${to.type}).`, at);
      } else escalations.push({ from: { node: node.id }, to: { node: target }, key });
    }
  }
  const escalationTargets = new Set(escalations.map(link => link.to.node));

  const roles = new Map();
  for (const node of nodes.values()) {
    if (!ROLE_TYPES.includes(node.type)) continue;
    const id = typeof node.config.role === 'string' ? node.config.role : node.id;
    if (roles.has(id)) error('DUPLICATE_ROLE', `Role "${id}" is used by nodes "${roles.get(id)}" and "${node.id}".`, { nodeId: node.id });
    else roles.set(id, node.id);
  }

  const edgeIds = new Set();
  const flow = [], delegates = [], messages = [];
  const seen = new Set();
  for (const edge of graph.edges) {
    if (!isPlainObject(edge) || !isId(edge.id)) {
      error('INVALID_EDGE', `Each edge needs an id of letters, digits, ".", "_", ":" or "-" (at most 100 characters).${reservedNote(edge?.id)}`);
      continue;
    }
    const at = { edgeId: edge.id };
    if (edgeIds.has(edge.id)) { error('DUPLICATE_ID', `Edge id "${edge.id}" is repeated.`, at); continue; }
    edgeIds.add(edge.id);
    if (!EDGE_KINDS.includes(edge.kind)) { error('INVALID_EDGE_KIND', `Edge "${edge.id}" has unknown kind ${JSON.stringify(edge.kind)}.`, at); continue; }
    if (!isPlainObject(edge.from) || !isPlainObject(edge.to) || typeof edge.from.node !== 'string' || typeof edge.to.node !== 'string') {
      error('INVALID_EDGE', `Edge "${edge.id}" needs from.node and to.node.`, at);
      continue;
    }
    const from = nodes.get(edge.from.node), to = nodes.get(edge.to.node);
    if (!from || !to) {
      const missing = !from ? edge.from.node : edge.to.node;
      error('DANGLING_EDGE', `Edge "${edge.id}" references missing or invalid node "${missing}".`, at);
      continue;
    }
    if (edge.to.port !== undefined) { error('INVALID_PORT', `Edge "${edge.id}" cannot target a port; only gate outputs have ports.`, at); continue; }
    const port = edge.from.port;
    if (edge.kind !== 'flow') {
      if (port !== undefined) { error('INVALID_PORT', `${edge.kind} edge "${edge.id}" cannot use a port.`, at); continue; }
      if (edge.kind === 'delegates') {
        if (!['planner', 'agent'].includes(from.type) || to.type !== 'agent') {
          error('INVALID_DELEGATION', `delegates edge "${edge.id}" must run from a planner or agent node to an agent node (got ${from.type} → ${to.type}).`, at);
          continue;
        }
        delegates.push(edge);
      } else {
        if (!ROLE_TYPES.includes(from.type) || !ROLE_TYPES.includes(to.type)) {
          error('INVALID_MESSAGES_EDGE', `messages edge "${edge.id}" must connect planner, agent or review roles (got ${from.type} → ${to.type}).`, at);
          continue;
        }
        messages.push(edge);
      }
    } else {
      if (to.type === 'input') { error('INVALID_FLOW', `Flow edge "${edge.id}" cannot enter input node "${to.id}".`, at); continue; }
      if (from.type === 'output') { error('INVALID_FLOW', `Flow edge "${edge.id}" cannot leave output node "${from.id}".`, at); continue; }
      if (PORTED.has(from.type)) {
        if (port !== undefined && port !== 'pass' && port !== 'fail') { error('INVALID_PORT', `Edge "${edge.id}" port must be "pass" or "fail".`, at); continue; }
        if (port === undefined && from.type !== 'merge-queue') {
          error('INVALID_PORT', `Flow edge "${edge.id}" leaves ${from.type} node "${from.id}" and must use port "pass" or "fail".`, at);
          continue;
        }
      } else if (port !== undefined) {
        error('INVALID_PORT', `${from.type} node "${from.id}" has no ports; remove port from edge "${edge.id}".`, at);
        continue;
      }
      flow.push({ ...edge, port: from.type === 'merge-queue' ? port ?? 'pass' : port });
    }
    const key = canonicalJson([edge.kind, edge.from.node, edge.from.port, edge.to.node]);
    if (seen.has(key)) warn('DUPLICATE_EDGE', `Edge "${edge.id}" repeats another ${edge.kind} edge.`, at);
    seen.add(key);
  }

  const inputs = [...nodes.values()].filter(node => node.type === 'input');
  if (!inputs.length) error('NO_INPUT', 'Graph needs at least one input node.');
  if (![...nodes.values()].some(node => node.type === 'output')) error('NO_OUTPUT', 'Graph needs at least one output node.');

  const outgoing = new Map([...nodes.keys()].map(id => [id, []]));
  const incoming = new Map([...nodes.keys()].map(id => [id, []]));
  for (const edge of flow) { outgoing.get(edge.from.node).push(edge); incoming.get(edge.to.node).push(edge); }
  // Reachability, dominators and cycle checks follow flow edges plus escalation links.
  const linksOut = new Map([...outgoing].map(([id, list]) => [id, [...list]]));
  const linksIn = new Map([...incoming].map(([id, list]) => [id, [...list]]));
  for (const link of escalations) { linksOut.get(link.from.node).push(link); linksIn.get(link.to.node).push(link); }
  const delegateOnly = new Set([...nodes.values()]
    .filter(node => node.type === 'agent' && !incoming.get(node.id).length && !escalationTargets.has(node.id) &&
      delegates.some(edge => edge.to.node === node.id))
    .map(node => node.id));

  /** @type {Map<string, Record<string, { node: string, edgeId: string } | null>>} */
  const routes = new Map();
  for (const node of nodes.values()) {
    const out = outgoing.get(node.id), at = { nodeId: node.id };
    const ports = GATE_TYPES.includes(node.type) || node.type === 'merge-queue' ? ['pass', 'fail'] : node.type === 'output' ? [] : ['next'];
    const table = {};
    for (const port of ports) {
      const matching = out.filter(edge => (edge.port ?? 'next') === port);
      if (matching.length > 1) error('AMBIGUOUS_ROUTE', `${node.type} node "${node.id}" has ${matching.length} flow edges on ${port === 'next' ? 'its output' : `port "${port}"`}; v1 routes each work item along one edge.`, at);
      if (matching.length === 0) {
        if (node.type === 'human' && port === 'fail' && escalationTargets.has(node.id)) { /* A fail decision fails the item. */ }
        else if (GATE_TYPES.includes(node.type)) error('GATE_UNWIRED', `${node.type} gate "${node.id}" needs a flow edge on port "${port}".`, at);
        else if (node.type === 'merge-queue' && port === 'pass') error('GATE_UNWIRED', `merge-queue "${node.id}" needs a flow edge on port "pass".`, at);
        else if (port === 'next' && !delegateOnly.has(node.id)) error('MISSING_FLOW_OUT', `${node.type} node "${node.id}" needs one outgoing flow edge.`, at);
      }
      table[port] = matching[0] ? { node: matching[0].to.node, edgeId: matching[0].id } : null;
    }
    routes.set(node.id, table);
  }

  const reach = (starts, next) => {
    const found = new Set(starts), stack = [...starts];
    while (stack.length) for (const id of next(stack.pop())) if (!found.has(id)) { found.add(id); stack.push(id); }
    return found;
  };
  const successors = id => linksOut.get(id).map(edge => edge.to.node);
  const predecessors = id => linksIn.get(id).map(edge => edge.from.node);
  const reachable = reach(inputs.map(node => node.id), successors);
  for (const id of delegateOnly) {
    if (delegates.some(edge => edge.to.node === id && reachable.has(edge.from.node))) reachable.add(id);
  }
  for (const node of nodes.values()) {
    if (!reachable.has(node.id)) error('UNREACHABLE_NODE', `${node.type} node "${node.id}" cannot be reached from an input.`, { nodeId: node.id });
  }
  const reachesOutput = reach([...nodes.values()].filter(node => node.type === 'output').map(node => node.id), predecessors);
  for (const id of reachable) {
    if (!reachesOutput.has(id) && !delegateOnly.has(id)) warn('NO_PATH_TO_OUTPUT', `Work reaching "${id}" can never reach an output.`, { nodeId: id });
  }

  // Dominators over the flow graph decide which edges return into a loop (natural loops). An edge u → loop is a
  // back edge when every path from an input to u passes through the loop, so iterations are counted reliably.
  const order = [...reachable].filter(id => !delegateOnly.has(id));
  const dominators = new Map(order.map(id => [id, new Set(nodes.get(id).type === 'input' ? [id] : order)]));
  for (let changed = true; changed;) {
    changed = false;
    for (const id of order) {
      if (nodes.get(id).type === 'input') continue;
      const preds = predecessors(id).filter(pred => dominators.has(pred));
      const next = new Set(preds.length ? [...dominators.get(preds[0])].filter(dom => preds.every(pred => dominators.get(pred).has(dom))) : []);
      next.add(id);
      if (next.size !== dominators.get(id).size) { dominators.set(id, next); changed = true; }
    }
  }

  // Every flow cycle must cross a counted back edge into a loop, otherwise work could circulate forever.
  const isBackEdge = edge => edge.kind === 'flow' && nodes.get(edge.to.node).type === 'loop' && Boolean(dominators.get(edge.from.node)?.has(edge.to.node));
  const colour = new Map(), path = [];
  const reported = new Set();
  const visit = id => {
    colour.set(id, 1); path.push(id);
    for (const edge of linksOut.get(id)) {
      if (isBackEdge(edge)) continue;
      const next = edge.to.node;
      if (colour.get(next) === 1) {
        const cycle = path.slice(path.indexOf(next));
        const key = [...cycle].sort().join('|');
        if (reported.has(key)) continue;
        reported.add(key);
        const loop = cycle.find(member => nodes.get(member).type === 'loop');
        if (loop) {
          error('LOOP_UNCOUNTED', `Flow cycle ${[...cycle, next].join(' → ')} re-enters loop "${loop}" from outside its body, so iterations would not be counted.`, { nodeId: loop });
        } else {
          error('FLOW_CYCLE', `Flow cycle ${[...cycle, next].join(' → ')} does not pass through a loop node.`, { nodeId: next });
        }
      } else if (!colour.has(next)) visit(next);
    }
    path.pop(); colour.set(id, 2);
  };
  for (const node of nodes.values()) if (!colour.has(node.id)) visit(node.id);

  const loops = new Map();
  for (const node of nodes.values()) {
    if (node.type !== 'loop') continue;
    const backSources = incoming.get(node.id).filter(isBackEdge).map(edge => edge.from.node);
    const body = [...reach(backSources.filter(id => id !== node.id), id => id === node.id ? [] : predecessors(id))].filter(id => id !== node.id);
    if (!backSources.length) warn('LOOP_NEVER_REPEATS', `loop "${node.id}" has no flow edge returning from its body.`, { nodeId: node.id });
    const gateType = Object.hasOwn(UNTIL_GATE, node.config.until) ? UNTIL_GATE[node.config.until] : undefined;
    if (gateType) {
      const ok = body.some(id => {
        const candidate = nodes.get(id);
        const failRoute = routes.get(id)?.fail;
        return candidate.type === gateType && failRoute && (failRoute.node === node.id || body.includes(failRoute.node));
      });
      if (!ok) {
        error('LOOP_CONDITION_UNMATCHED', `loop "${node.id}" repeats until ${node.config.until}, but no ${gateType} gate in its body sends failures back to it.`, { nodeId: node.id });
      }
    }
    loops.set(node.id, { body, backSources: [...new Set(backSources)] });
  }

  for (const node of nodes.values()) {
    if (!ROLE_TYPES.includes(node.type)) continue;
    const out = delegates.filter(edge => edge.from.node === node.id);
    const max = node.config.policy?.maxSubagents;
    if (out.length && max === 0) warn('DELEGATION_UNUSED', `Node "${node.id}" has delegates edges but policy.maxSubagents is 0.`, { nodeId: node.id });
    if (!out.length && max > 0) warn('POLICY_SUBAGENTS_WITHOUT_DELEGATION', `Node "${node.id}" allows subagents but has no delegates edge; it gets none.`, { nodeId: node.id });
    const allowed = node.config.policy?.allowedSubagentProviders;
    for (const edge of out) {
      const target = nodes.get(edge.to.node).config.harness?.provider;
      if (allowed && target && !allowed.includes(target)) {
        warn('DELEGATE_PROVIDER_NOT_ALLOWED', `Node "${node.id}" delegates to "${edge.to.node}" on ${target}, which its allowedSubagentProviders excludes.`, { nodeId: node.id, edgeId: edge.id });
      }
    }
  }

  return { ...done(), nodes, routes, loops, delegates, messages, delegateOnly, roles, escalations };
}

const roleOf = node => typeof node.config.role === 'string' ? node.config.role : node.id;

/**
 * Compile a valid graph into the execution plan the run engine reads.
 * Throws `WorkflowError('INVALID_GRAPH')` with `details.errors` when validation fails.
 */
export function compileGraph(graph, options = {}) {
  const analysis = analyse(graph, options);
  if (!analysis.result.ok) {
    throw new WorkflowError('INVALID_GRAPH', `Workflow graph has ${analysis.result.errors.length} validation error(s).`, analysis.result);
  }
  const { nodes, routes, loops, delegates, messages, delegateOnly, escalations } = analysis;
  const canMessage = new Map(), delegatesTo = new Map();
  const add = (map, key, value) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(value); };
  for (const edge of messages) {
    const a = roleOf(nodes.get(edge.from.node)), b = roleOf(nodes.get(edge.to.node));
    add(canMessage, a, b); add(canMessage, b, a);
  }
  for (const edge of delegates) add(delegatesTo, edge.from.node, edge.to.node);

  const planNodes = {}, roles = {}, planLoops = {};
  for (const node of nodes.values()) {
    const config = structuredClone(node.config);
    if (node.type === 'input') config.docs ??= [];
    if (node.type === 'planner') config.maxItems ??= 20;
    if (node.type === 'ci') config.requirements ??= {};
    if (node.type === 'merge-queue') config.requiredChecks ??= [];
    if (node.type === 'loop') config.expectedIterations ??= Math.min(2, config.maxIterations);
    if (RETRY_TYPES.includes(node.type)) config.retry = { maxAttempts: config.retry?.maxAttempts ?? 1, backoffSec: config.retry?.backoffSec ?? 0 };
    const entry = { id: node.id, type: node.type, label: node.label, config, routes: routes.get(node.id) };
    if (RETRY_TYPES.includes(node.type) || node.type === 'loop') {
      const exhausted = config.onExhausted ?? null;
      const blocked = ROLE_TYPES.includes(node.type)
        ? config.onBlocked ?? (exhausted && nodes.get(exhausted).type === 'human' ? exhausted : null) : null;
      entry.escalation = { exhausted, blocked };
    }
    if (ROLE_TYPES.includes(node.type)) {
      const id = roleOf(node);
      entry.role = id;
      const targets = [...(delegatesTo.get(node.id) ?? [])].map(target => nodes.get(target));
      const capacity = targets.reduce((sum, target) => sum + (target.config.concurrency ?? 1), 0);
      const policyConfig = config.policy ?? {};
      const policy = {
        maxSubagents: targets.length ? Math.min(policyConfig.maxSubagents ?? capacity, capacity) : 0,
        allowedSubagentProviders: targets.length
          ? [...new Set(policyConfig.allowedSubagentProviders ?? targets.map(target => target.config.harness.provider))].sort()
          : [],
        canMessage: [...(canMessage.get(id) ?? [])].sort(),
      };
      if (policyConfig.maxTurns !== undefined) policy.maxTurns = policyConfig.maxTurns;
      if (policyConfig.maxTokens !== undefined) policy.maxTokens = policyConfig.maxTokens;
      const requirements = structuredClone(config.requirements ?? {});
      requirements.providers = [...new Set([...(requirements.providers ?? []), config.harness.provider])].sort();
      roles[id] = {
        role: id, nodeId: node.id, type: node.type, harness: structuredClone(config.harness), prompt: config.prompt,
        concurrency: config.concurrency ?? 1, requirements, policy,
        delegatesTo: targets.map(roleOf).sort(), delegateOnly: delegateOnly.has(node.id),
      };
    }
    if (node.type === 'loop') {
      const { body, backSources } = loops.get(node.id);
      planLoops[node.id] = {
        until: config.until, maxIterations: config.maxIterations, expectedIterations: config.expectedIterations,
        body: [...body].sort(), backSources: [...backSources].sort(),
      };
    }
    planNodes[node.id] = entry;
  }
  return {
    plan: PLAN_SCHEMA, schema: GRAPH_SCHEMA, graphHash: sha256(canonicalJson(graph)),
    inputs: [...nodes.values()].filter(node => node.type === 'input').map(node => node.id),
    nodes: planNodes, roles, loops: planLoops,
    escalations: escalations.map(link => ({ from: link.from.node, to: link.to.node, on: link.key === 'onBlocked' ? 'blocked' : 'exhausted' })),
    edges: graph.edges.map(edge => ({ id: edge.id, kind: edge.kind, from: edge.from.node, to: edge.to.node, ...(edge.from.port ? { port: edge.from.port } : {}) })),
    warnings: analysis.result.warnings,
  };
}

/**
 * Match an observed interaction to a graph edge so the hub can log it with `edgeId` or `unplanned: true`.
 * `from` and `to` may be node ids or role ids. Messages match in either direction.
 * @param {ReturnType<typeof compileGraph>} plan
 * @param {{ kind: 'flow'|'delegates'|'messages', from: string, to: string }} interaction
 * @returns {{ kind: string, from: string, to: string, edgeId: string | null, unplanned: boolean }}
 */
export function classifyInteraction(plan, { kind, from, to }) {
  const nodeFor = id => Object.hasOwn(plan.nodes, id) ? id : Object.hasOwn(plan.roles, id) ? plan.roles[id].nodeId : id;
  const a = nodeFor(from), b = nodeFor(to);
  const edge = plan.edges.find(candidate => candidate.kind === kind &&
    ((candidate.from === a && candidate.to === b) || (kind === 'messages' && candidate.from === b && candidate.to === a)));
  return { kind, from: a, to: b, edgeId: edge?.id ?? null, unplanned: !edge };
}
