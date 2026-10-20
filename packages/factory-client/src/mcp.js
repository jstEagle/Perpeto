import { createInterface } from 'node:readline';

const tools = [
  { name: 'factory_channels', description: 'List shared communication channels in the configured project.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'factory_send', description: 'Send a durable message as the configured role. Reuse idempotencyKey when retrying the same message.', inputSchema: {
    type: 'object', properties: { body: { type: 'string' }, idempotencyKey: { type: 'string' }, recipientRoleId: { type: 'string' }, channelId: { type: 'string' } }, required: ['body', 'idempotencyKey'], additionalProperties: false,
  } },
  { name: 'factory_read', description: 'Read channel messages in insertion order. Save nextCursor for subsequent reads; messages do not imply executable assignments.', inputSchema: {
    type: 'object', properties: { after: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 }, recipientRoleId: { type: 'string' }, channelId: { type: 'string' } }, additionalProperties: false,
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
            const value = name === 'factory_channels' ? await client.channels() : name === 'factory_send' ? await client.send(args) : await client.read(args);
            reply.result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
          } catch { reply.result = { isError: true, content: [{ type: 'text', text: 'Factory operation failed. Check connection, credentials, scope, and message idempotency key.' }] }; }
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
    if (property.type === 'string') return typeof value === 'string' && value.trim().length > 0;
    return Number.isSafeInteger(value) && value >= property.minimum && value <= property.maximum;
  });
}
