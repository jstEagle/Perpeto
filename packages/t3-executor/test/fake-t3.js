import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { WsRpcGroup } from '../../../vendor/t3code/packages/contracts/src/rpc.ts';

// Resolve Effect from the contracts themselves so an installed upstream workspace
// and a factory-only npm install both use the same Effect instance as the schemas.
const requireContracts = createRequire(new URL('../../../vendor/t3code/packages/contracts/package.json', import.meta.url));
const Schema = await import(requireContracts.resolve('effect/Schema'));
// Use the same schemas and JSON codec as T3's real WebSocket transport.
const decodeRequests = new Map([...WsRpcGroup.requests].map(([tag, rpc]) =>
  [tag, Schema.decodeUnknownSync(Schema.toCodecJson(rpc.payloadSchema))]));
// Shell stream items the fake sends are checked against T3's real wire schema, so observer fixtures stay honest.
const { OrchestrationV2ShellStreamItem } = await import('../../../vendor/t3code/packages/contracts/src/orchestrationV2.ts');
export const checkShellItem = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ShellStreamItem));
import { AgentPolicyStore, AgentPolicyError } from '../src/policy-store.js';

/** Minimal server-side WebSocket (RFC 6455): unfragmented text frames only. */
class FakeSocket {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.onMessage = () => {};
    this.closed = false;
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.#drain(); });
    socket.on('close', () => { this.closed = true; });
    socket.on('error', () => { this.closed = true; });
  }
  #drain() {
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0] & 0x0f;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (this.buffer.length < 10) return; length = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      const masked = (this.buffer[1] & 0x80) !== 0;
      const total = offset + (masked ? 4 : 0) + length;
      if (this.buffer.length < total) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(this.buffer.subarray(offset + (masked ? 4 : 0), total));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buffer = this.buffer.subarray(total);
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.#frame(0xa, payload); continue; }
      if (opcode === 0x1) this.onMessage(JSON.parse(payload.toString('utf8')));
    }
  }
  #frame(opcode, payload) {
    if (this.closed) return;
    const header = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length])
      : payload.length < 65536 ? Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff])
        : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(payload.length), 2); return b; })();
    this.socket.write(Buffer.concat([header, payload]));
  }
  send(message) { this.#frame(0x1, Buffer.from(JSON.stringify(message))); }
  close() { if (this.closed) return; this.#frame(0x8, Buffer.alloc(0)); this.closed = true; this.socket.end(); }
  destroy() { this.closed = true; this.socket.destroy(); }
}

const now = () => new Date().toISOString();

/**
 * In-process stand-in for a T3 environment server. Tests script thread
 * behavior with `onLaunch(thread, fake)` and `emit(threadId, type, payload)`.
 */
export async function startFakeT3({ token = 'test-token', policyRoutes = true, providers } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fake-t3-'));
  // A stand-in for the operator's Codex home, so factory isolation never links a real login in tests.
  const operatorCodexHome = join(directory, 'operator-codex');
  mkdirSync(operatorCodexHome);
  writeFileSync(join(operatorCodexHome, 'auth.json'), '{}');
  const policies = new AgentPolicyStore(join(directory, 'policy.sqlite'));
  const state = {
    token,
    providers: providers ?? [
      { instanceId: 'codex', driver: 'codex', enabled: true, status: 'ready', models: [{ slug: 'gpt-test' }] },
      { instanceId: 'claudeAgent', driver: 'claudeAgent', enabled: true, status: 'ready', models: [{ slug: 'claude-test' }] },
      { instanceId: 'cursor', driver: 'cursor', enabled: false, status: 'disabled', models: [] },
    ],
    providerInstances: { codex: { driver: 'codex', config: { homePath: operatorCodexHome } } },
    projects: [],
    threads: new Map(),
    sequence: 0,
    commands: [],
    requests: [],
    sockets: new Set(),
    subscribers: new Map(),
    onLaunch: () => {},
    onCommand: () => {},
    tickets: 0,
    // Every RPC tag a client sent, in order, so tests can assert an observer never sends a mutating one.
    rpcs: [],
    shell: { projects: [], threads: new Map(), sequence: 0 },
    shellSubscribers: new Set(),
  };

  function thread(threadId) {
    let value = state.threads.get(threadId);
    if (!value) {
      value = { id: threadId, thread: { id: threadId }, runs: new Map(), attempts: new Map(), providerTurns: new Map(), turnItems: new Map(), subagents: new Map(), runtimeRequests: new Map(), providerThreads: new Map(), sequence: 0, log: [] };
      state.threads.set(threadId, value);
    }
    return value;
  }
  const collections = { 'run.created': 'runs', 'run.updated': 'runs', 'run-attempt.created': 'attempts', 'run-attempt.updated': 'attempts', 'provider-turn.updated': 'providerTurns', 'turn-item.updated': 'turnItems', 'subagent.updated': 'subagents', 'runtime-request.updated': 'runtimeRequests', 'provider-thread.updated': 'providerThreads' };
  function projection(value) {
    return { thread: value.thread, ...Object.fromEntries(Object.values(collections).map(name => [name, [...value[name].values()]])) };
  }
  function emit(threadId, type, payload) {
    const value = thread(threadId);
    const collection = collections[type];
    if (collection) value[collection].set(payload.id, payload);
    const sequence = ++state.sequence;
    value.sequence = sequence;
    const item = { kind: 'event', sequence, event: { id: `evt-${sequence}`, threadId, type, payload, occurredAt: now() } };
    value.log.push(item);
    for (const subscriber of state.subscribers.get(threadId) ?? []) subscriber.push([item]);
    return sequence;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fake');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    state.requests.push({ method: request.method, path: url.pathname, body, orchestration: request.headers['x-t3-orchestration-protocol'] });
    const json = (status, payload) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload)); };
    if (request.headers.authorization !== `Bearer ${state.token}`) return json(401, { error: { code: 'UNAUTHORIZED', message: 'nope' } });
    if (request.method === 'POST' && url.pathname === '/api/auth/websocket-ticket') return json(200, { ticket: `ticket-${++state.tickets}`, expiresAt: now() });
    if (request.method === 'GET' && url.pathname === '/api/projects') return json(200, { projects: state.projects });
    const threadMatch = url.pathname.match(/^\/api\/orchestration\/threads\/([^/]+)$/);
    if (request.method === 'GET' && threadMatch) {
      if (request.headers['x-t3-orchestration-protocol'] !== '2') return json(426, {});
      const value = state.threads.get(decodeURIComponent(threadMatch[1]));
      return value ? json(200, { snapshotSequence: value.sequence, projection: projection(value) }) : json(404, {});
    }
    const policy = url.pathname.match(/^\/api\/perpeto\/agent-policies\/([^/]+)(?:\/([^/]+))?$/);
    if (policy && policyRoutes) {
      const threadId = decodeURIComponent(policy[1]);
      try {
        if (!policy[2] && request.method === 'PUT') return json(200, policies.setPolicy({ threadId, ...body }));
        if (policy[2] === 'decisions') return json(200, policies.decisions({ threadId, after: Number(url.searchParams.get('after') ?? 0) }));
        if (policy[2] === 'native-subagents') return json(200, policies.authorize({ requestKey: `native:${body.subagentId}`, callerThreadId: body.callerThreadId ?? threadId, rootThreadId: threadId, kind: 'provider_native', providerInstanceId: body.providerInstanceId, driver: body.driver, model: body.model, childRef: body.subagentId }));
      } catch (error) {
        if (error instanceof AgentPolicyError) return json(error.code === 'CONFLICT' ? 409 : error.code === 'NOT_FOUND' ? 404 : 400, { error: { code: error.code, message: error.message } });
        throw error;
      }
    }
    return json(404, { error: { code: 'NOT_FOUND', message: 'Messaging route not found.' } });
  });

  server.on('upgrade', (request, socket) => {
    const url = new URL(request.url, 'http://fake');
    if (url.pathname !== '/ws' || url.searchParams.get('orchestrationProtocol') !== '2' || !url.searchParams.get('wsTicket')?.startsWith('ticket-')) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return;
    }
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const ws = new FakeSocket(socket);
    state.sockets.add(ws);
    const streams = new Map();
    ws.onMessage = message => {
      if (message._tag === 'Ping') return ws.send({ _tag: 'Pong' });
      if (message._tag === 'Ack') { streams.get(message.requestId)?.ack(); return; }
      if (message._tag === 'Interrupt') { streams.get(message.requestId)?.stop(); return; }
      if (message._tag !== 'Request') return;
      state.rpcs.push(message.tag);
      const reply = value => ws.send({ _tag: 'Exit', requestId: message.id, exit: { _tag: 'Success', value } });
      const fail = (tag, text) => ws.send({ _tag: 'Exit', requestId: message.id, exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { _tag: tag, message: text } }] } });
      const payload = message.payload;
      const decode = decodeRequests.get(message.tag);
      if (!decode) return fail('UnknownRpc', `Unknown ${message.tag}`);
      try { decode(payload); }
      catch (error) { return fail('InvalidRequest', error.message); }
      switch (message.tag) {
        case 'server.getConfig': return reply({ providers: state.providers });
        case 'server.getSettings': return reply({ providerInstances: state.providerInstances ?? {} });
        case 'server.updateSettings': {
          state.commands.push({ tag: message.tag, payload });
          const mutation = payload.providerInstanceMutation;
          if (mutation?.operation === 'upsert') {
            state.providerInstances = { ...(state.providerInstances ?? {}), [mutation.instanceId]: mutation.instance };
            state.providers = state.providers.filter(item => item.instanceId !== mutation.instanceId);
            state.providers.push({ instanceId: mutation.instanceId, driver: mutation.instance.driver, enabled: mutation.instance.enabled !== false,
              status: state.newInstanceStatus ?? 'ready', auth: { status: state.newInstanceAuth ?? 'authenticated' }, models: [] });
          }
          return reply({});
        }
        case 'server.refreshProviders': state.refreshed = [...(state.refreshed ?? []), payload.instanceId]; return reply({ providers: state.providers });
        case 'projects.mutate': {
          const project = { id: payload.projectId, title: payload.title, workspaceRoot: payload.workspaceRoot, deletedAt: null };
          state.projects.push(project);
          return reply(project);
        }
        case 'orchestration.launchThread': {
          state.commands.push({ tag: message.tag, payload });
          const value = thread(payload.threadId);
          value.thread = { id: payload.threadId, projectId: payload.projectId, modelSelection: payload.modelSelection, branch: payload.workspaceStrategy?.branch ?? null, worktreePath: null };
          reply({ threadId: payload.threadId, projection: projection(value), resumed: false });
          setImmediate(() => state.onLaunch(payload, api));
          return;
        }
        case 'orchestration.dispatchCommand': {
          state.commands.push({ tag: message.tag, payload });
          reply({ sequence: state.sequence });
          setImmediate(() => state.onCommand(payload, api));
          return;
        }
        case 'orchestration.subscribeThread': {
          const value = thread(payload.threadId);
          const queue = [];
          let waiting = 0;
          const subscriber = {
            push(values) { queue.push(values); flush(); },
          };
          function flush() {
            while (waiting === 0 && queue.length) { waiting++; ws.send({ _tag: 'Chunk', requestId: message.id, values: queue.shift() }); }
          }
          streams.set(message.id, {
            ack() { waiting = Math.max(0, waiting - 1); state.acks = (state.acks ?? 0) + 1; flush(); },
            stop() { state.subscribers.get(payload.threadId)?.delete(subscriber); streams.delete(message.id); },
          });
          if (!state.subscribers.has(payload.threadId)) state.subscribers.set(payload.threadId, new Set());
          state.subscribers.get(payload.threadId).add(subscriber);
          state.subscriptions = [...(state.subscriptions ?? []), { threadId: payload.threadId, afterSequence: payload.afterSequence }];
          if (payload.afterSequence === undefined) subscriber.push([{ kind: 'snapshot', snapshotSequence: value.sequence, projection: projection(value) }, { kind: 'synchronized' }]);
          else {
            const missed = value.log.filter(item => item.sequence > payload.afterSequence);
            subscriber.push([...missed, { kind: 'synchronized' }]);
          }
          return;
        }
        case 'orchestration.subscribeShell': {
          const queue = [];
          let waiting = 0;
          const subscriber = { push(values) { queue.push(values); flush(); } };
          function flush() {
            while (waiting === 0 && queue.length) { waiting++; ws.send({ _tag: 'Chunk', requestId: message.id, values: queue.shift() }); }
          }
          streams.set(message.id, {
            ack() { waiting = Math.max(0, waiting - 1); flush(); },
            stop() { state.shellSubscribers.delete(subscriber); streams.delete(message.id); },
          });
          state.shellSubscribers.add(subscriber);
          const snapshot = { kind: 'snapshot', snapshot: { schemaVersion: 2, snapshotSequence: state.shell.sequence, projects: state.shell.projects,
            threads: [...state.shell.threads.values()], archivedThreads: [] } };
          checkShellItem(snapshot);
          subscriber.push([snapshot, ...(payload.requestCompletionMarker ? [{ kind: 'synchronized' }] : [])]);
          return;
        }
        default: return fail('UnknownRpc', `Unknown ${message.tag}`);
      }
    };
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const api = {
    state, policies, emit, thread,
    url: `http://127.0.0.1:${server.address().port}`,
    /** Pass as the executor's `agentHomesDir` so factory homes stay inside the fake's directory. */
    homes: join(directory, 'agent-homes'),
    /** Drop every live WebSocket to exercise reconnection. */
    dropSockets() { for (const ws of state.sockets) ws.destroy(); state.sockets.clear(); state.subscribers.clear(); state.shellSubscribers.clear(); },
    /** Send one shell stream item (checked against T3's schema) to every shell subscriber. */
    shellEmit(item) { checkShellItem(item); for (const subscriber of state.shellSubscribers) subscriber.push([item]); },
    /** Add or replace a thread in the shell and announce it as `thread.updated`. */
    setShellThread(value) {
      state.shell.threads.set(value.id, value);
      api.shellEmit({ kind: 'thread.updated', sequence: ++state.shell.sequence, location: 'active', thread: value });
    },
    removeShellThread(threadId) {
      state.shell.threads.delete(threadId);
      api.shellEmit({ kind: 'thread.removed', sequence: ++state.shell.sequence, location: 'active', threadId });
    },
    commandsOf(type) { return state.commands.filter(item => item.payload?.type === type); },
    async close() {
      for (const ws of state.sockets) ws.destroy();
      await new Promise(resolve => server.close(resolve));
      policies.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  return api;
}

/** Common entity builders matching orchestration v2 shapes. */
export const build = {
  run: (threadId, ordinal, status, extra = {}) => ({ id: `run:${threadId}:${ordinal}`, threadId, ordinal, status, startedAt: status === 'queued' ? null : '2026-10-21T00:00:00.000Z', completedAt: ['completed', 'failed', 'interrupted', 'cancelled'].includes(status) ? '2026-10-21T00:00:05.000Z' : null, ...extra }),
  assistant: (threadId, ordinal, text, id = `item:${threadId}:${ordinal}:assistant`) => ({ id, threadId, runId: `run:${threadId}:${ordinal}`, type: 'assistant_message', status: 'completed', text, streaming: false }),
  /** A project shell as T3's subscribeShell sends it. */
  project: (id, extra = {}) => ({ id, title: `Project ${id}`, workspaceRoot: `/Users/operator/code/${id}`, defaultModelSelection: null, scripts: [],
    createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z', ...extra }),
  /** A thread shell (OrchestrationV2ThreadShell) with every required field; `extra` overrides. */
  shellThread: (id, extra = {}) => ({ createdBy: 'user', creationSource: 'web', id, projectId: 'p1', title: `Thread ${id}`,
    providerInstanceId: 'claudeAgent', modelSelection: { instanceId: 'claudeAgent', model: 'claude-test' }, runtimeMode: 'full-access', interactionMode: 'default',
    branch: null, worktreePath: null, lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id }, forkedFrom: null,
    activeProviderThreadId: null, latestRunId: null, activeRunId: null, status: 'idle', pendingRuntimeRequest: null,
    latestVisibleMessage: null, latestUserMessageAt: null, hasActionableProposedPlan: false, itemCount: 0, visibleItemCount: 0,
    createdAt: '2026-10-22T08:00:00.000Z', updatedAt: '2026-10-22T08:00:00.000Z', archivedAt: null, settledOverride: null, settledAt: null, deletedAt: null, ...extra }),
  usage: (threadId, ordinal, usage) => ({ id: `turn:${threadId}:${ordinal}`, status: 'completed', completedAt: '2026-10-21T00:00:05.000Z', turnTokenUsage: { usageScope: 'main_agent', usageStatus: 'complete', hasSubagents: false, ...usage } }),
};
