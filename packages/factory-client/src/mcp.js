import { createInterface } from 'node:readline';
import { DEFAULT_LIMITS, HARNESS_KINDS } from '../../factory-definition/src/storage.js';
import { ClientError } from './client.js';

const identifier = { type: 'string', minLength: 1, maxLength: 200 };
const baseNode = {
  id: identifier, label: identifier,
  position: { type: 'object', properties: { x: { type: 'number', minimum: -1000000, maximum: 1000000 }, y: { type: 'number', minimum: -1000000, maximum: 1000000 } }, required: ['x', 'y'], additionalProperties: false },
};
const node = (type, properties, required) => ({ type: 'object', properties: { ...baseNode, type: { type: 'string', enum: [type] }, ...properties }, required: ['id', 'type', 'label', ...required], additionalProperties: false });
const definitionSchema = {
  type: 'object', properties: {
    name: identifier,
    nodes: { type: 'array', maxItems: DEFAULT_LIMITS.maxNodes, items: { oneOf: [
      node('agent', { harness: { type: 'string', enum: HARNESS_KINDS }, model: { type: 'string', maxLength: 1000 }, allowSubagents: { type: 'boolean' }, maxSubagents: { type: 'integer', minimum: 0, maximum: DEFAULT_LIMITS.maxSubagents }, maxConcurrent: { type: 'integer', minimum: 1, maximum: DEFAULT_LIMITS.maxConcurrent } }, ['harness', 'allowSubagents', 'maxSubagents', 'maxConcurrent']),
      node('context', { references: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', maxLength: 4096 } } }, ['references']),
      node('check', { command: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 0, maxLength: 4096 } } }, ['command']),
      node('merge-queue', { requireChecks: { type: 'boolean' }, requireReview: { type: 'boolean' }, maxConcurrent: { type: 'integer', minimum: 1, maximum: 1 } }, ['requireChecks', 'requireReview', 'maxConcurrent']),
    ] } },
    edges: { type: 'array', maxItems: DEFAULT_LIMITS.maxEdges, items: { type: 'object', properties: { id: identifier, source: identifier, target: identifier, type: { type: 'string', enum: ['delegates-to', 'workflow', 'context'] } }, required: ['id', 'type', 'source', 'target'], additionalProperties: false } },
  }, required: ['name', 'nodes', 'edges'], additionalProperties: false,
};

const tools = [
  { name: 'factory_channels', description: 'List shared communication channels in the configured project.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'factory_send', description: 'Send a durable message as the configured role. Reuse idempotencyKey when retrying the same message.', inputSchema: {
    type: 'object', properties: { body: { type: 'string' }, idempotencyKey: { type: 'string' }, recipientRoleId: { type: 'string' }, channelId: { type: 'string' } }, required: ['body', 'idempotencyKey'], additionalProperties: false,
  } },
  { name: 'factory_read', description: 'Read ascending messages: latest for newest page, before previousCursor for older history, after nextCursor for arrivals. Directions are exclusive. hasMore follows requested direction. Messages do not imply executable assignments.', inputSchema: {
    type: 'object', properties: { after: { type: 'string' }, before: { type: 'string' }, latest: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 500 }, recipientRoleId: { type: 'string' }, channelId: { type: 'string' } }, additionalProperties: false,
  } },
  { name: 'factory_submit_ci', description: 'Queue revision-pinned CI on a user-owned runner for the configured project. command is an argv array, never a shell command string. Reuse idempotencyKey for identical retries. Repository must be allowlisted by a runner.', inputSchema: {
    type: 'object', properties: {
      repositoryId: { type: 'string', minLength: 1, maxLength: 200 },
      revision: { type: 'string', pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' },
      command: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 0, maxLength: 8192 } },
      requiredLabels: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 200 } },
      idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
    }, required: ['repositoryId', 'revision', 'command', 'idempotencyKey'], additionalProperties: false,
  } },
  { name: 'factory_ci_status', description: 'Read a CI job status, tested revision, command, runner, attempt and available result for the configured project.', inputSchema: {
    type: 'object', properties: { jobId: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['jobId'], additionalProperties: false,
  } },
  { name: 'factory_retry_ci', description: 'Explicitly requeue a failed or lost job in the configured project. If the request fails ambiguously, inspect job status before retrying. Active or successful jobs cannot be retried.', inputSchema: {
    type: 'object', properties: { jobId: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['jobId'], additionalProperties: false,
  } },
  { name: 'factory_list_definitions', description: 'List saved factory graph definitions in the configured project. Definitions only: this does not execute graphs or enforce their policies.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'factory_read_definition', description: 'Read a saved factory definition, optionally an immutable version. Definitions only: no graph execution or policy enforcement.', inputSchema: {
    type: 'object', properties: { id: identifier, version: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }, required: ['id'], additionalProperties: false,
  } },
  { name: 'factory_create_definition', description: 'Create a saved graph definition with your explicit stable ID in the configured project. Definitions only: no execution or policy enforcement. Writes are never automatically replayed; read the ID after an ambiguous failure.', inputSchema: {
    type: 'object', properties: { id: identifier, definition: definitionSchema }, required: ['id', 'definition'], additionalProperties: false,
  } },
  { name: 'factory_update_definition', description: 'Save a new immutable graph revision using explicit expectedVersion compare-and-swap. Definitions only: no execution or enforcement. A conflict requires reading and reconciling changes; never silently overwrite a newer version.', inputSchema: {
    type: 'object', properties: { id: identifier, expectedVersion: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER - 1 }, definition: definitionSchema }, required: ['id', 'expectedVersion', 'definition'], additionalProperties: false,
  } },
];

/** MCP JSON-RPC stdio transport: one JSON message per line; stdout is protocol only. */
export async function serveMcp(client, input = process.stdin, output = process.stdout) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const emit = value => output.write(`${JSON.stringify(value)}\n`);
  let initialized = false;
  for await (const line of lines) {
    let request;
    try { request = JSON.parse(line); }
    catch { emit({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
      (request.id !== undefined && typeof request.id !== 'string' && typeof request.id !== 'number')) {
      emit({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); continue;
    }
    if (request.id === undefined) continue; // Notifications never receive a response.
    const reply = { jsonrpc: '2.0', id: request.id };
    try {
      if (request.method === 'initialize') {
        if (initialized) { reply.error = { code: -32600, message: 'Already initialized' }; }
        else {
          initialized = true;
          const supported = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
          const version = request.params?.protocolVersion;
          reply.result = { protocolVersion: supported.includes(version) ? version : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'perpeto-factory-messages', version: '0.1.0' } };
        }
      } else if (request.method === 'ping') reply.result = {};
      else if (!initialized) reply.error = { code: -32000, message: 'Initialize first' };
      else if (request.method === 'tools/list') reply.result = { tools };
      else if (request.method === 'tools/call') {
        const name = request.params?.name;
        const definition = tools.find(tool => tool.name === name);
        const args = request.params?.arguments ?? {};
        if (!definition || !validArguments(definition.inputSchema, args)) reply.error = { code: -32602, message: 'Invalid tool name or arguments' };
        else {
          try {
            const value = await ({
              factory_channels: () => client.channels(), factory_send: () => client.send(args), factory_read: () => client.read(args),
              factory_submit_ci: () => client.submitCi(args), factory_ci_status: () => client.ciStatus(args.jobId), factory_retry_ci: () => client.retryCi(args.jobId),
              factory_list_definitions: () => client.listFactories(), factory_read_definition: () => client.readFactory(args.id, { version: args.version }),
              factory_create_definition: () => client.createFactory(args), factory_update_definition: () => client.updateFactory(args),
            })[name]();
            reply.result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
          } catch (error) { reply.result = { isError: true, content: [{ type: 'text', text: `${error instanceof ClientError ? error.message : 'Factory operation failed.'} Inspect CI status after an ambiguous retry. Read and reconcile graph definitions after ambiguous writes or version conflicts; preserve your draft and expectedVersion.` }] }; }
        }
      } else reply.error = { code: -32601, message: 'Method not found' };
    } catch { reply.error = { code: -32603, message: 'Internal error' }; }
    emit(reply);
  }
}

function validArguments(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if ((schema.required ?? []).some(key => !(key in args))) return false;
  return Object.entries(args).every(([key, value]) => {
    const property = schema.properties[key];
    if (!property) return false;
    return validProperty(property, value);
  });
}

function validProperty(property, value) {
  if (property.oneOf) return property.oneOf.filter(candidate => validProperty(candidate, value)).length === 1;
  if (property.enum && !property.enum.includes(value)) return false;
  if (property.type === 'object') return validArguments(property, value);
  if (property.type === 'string') return typeof value === 'string' && !value.includes('\0') &&
    value.length >= (property.minLength ?? 1) && value.length <= (property.maxLength ?? Infinity) &&
    ((property.minLength ?? 1) === 0 || value.trim().length > 0) && (!property.pattern || new RegExp(property.pattern).test(value));
  if (property.type === 'boolean') return typeof value === 'boolean';
  if (property.type === 'array') return Array.isArray(value) && value.length >= (property.minItems ?? 0) && value.length <= (property.maxItems ?? Infinity) && value.every(item => validProperty(property.items, item));
  if (property.type === 'number') return Number.isFinite(value) && value >= property.minimum && value <= property.maximum;
  return property.type === 'integer' && Number.isSafeInteger(value) && value >= property.minimum && value <= property.maximum;
}
