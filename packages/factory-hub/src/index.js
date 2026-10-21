import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { Hub } from './hub.js';
import { HubError, fail, integer, object } from './errors.js';
import { createWorkflowAdapter } from './engine/workflow-adapter.js';

async function readBody(request, limit) {
  if (request.headers['content-length'] && Number(request.headers['content-length']) > limit) fail(413, 'REQUEST_TOO_LARGE', 'Request body exceeds the configured limit.');
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) fail(413, 'REQUEST_TOO_LARGE', 'Request body exceeds the configured limit.');
    chunks.push(chunk);
  }
  if (!size) return {};
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json for request bodies.');
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'INVALID_JSON', 'Request body must be valid JSON.'); }
  return object(body);
}

/** Create a hub without opening a port. All paths resolve relative to configPath.
 * @param {{configPath: string, engine?: import('./engine/workflow-adapter.js').WorkflowEngine}} options
 */
export async function createHub({ configPath, engine = createWorkflowAdapter() }) {
  const config = loadConfig(configPath); const hub = new Hub(config, engine);
  const streams = new Set(); const polls = new Set(); let closing = false; let maintenanceBusy = false;
  const json = (response, status, body) => {
    if (response.destroyed) return;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  async function lease(request, response, args) {
    const deadline = Date.now() + config.longPollMs;
    while (!closing && !response.destroyed) {
      let wake;
      const notified = new Promise(resolve => { wake = resolve; });
      hub.listeners.add(wake); polls.add(wake);
      const timer = setTimeout(wake, Math.max(0, deadline - Date.now()));
      const abort = () => wake(); response.once('close', abort);
      try {
        const finalLease = Date.now() >= deadline;
        const result = await hub.request({ ...args, finalLease });
        if (result.body.assignments.length || result.body.jobs.length || finalLease) return json(response, result.status, result.body);
        await notified;
      } finally { clearTimeout(timer); hub.listeners.delete(wake); polls.delete(wake); response.off('close', abort); }
    }
    if (!response.destroyed) json(response, 503, { error: { code: 'SHUTTING_DOWN', message: 'Hub is shutting down.' } });
  }
  async function stream(request, response, args, url) {
    let cursor = integer(Number(url.searchParams.get('after') ?? request.headers['last-event-id'] ?? 0), 'after');
    await hub.request({ ...args, method: 'GET', path: `/events?after=${cursor}&limit=1` });
    if (closing) fail(503, 'SHUTTING_DOWN', 'Hub is shutting down.');
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    response.flushHeaders(); response.write(': connected\n\n'); streams.add(response);
    let pumping = false; let dirty = false;
    const pump = async () => {
      dirty = true;
      if (pumping) return;
      pumping = true;
      try {
        while (dirty && !response.destroyed && !closing) {
          dirty = false;
          const result = await hub.request({ ...args, method: 'GET', path: `/events?after=${cursor}&limit=100` });
          for (const event of result.body.events) {
            if (response.destroyed || closing) break;
            const writable = response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            cursor = event.seq;
            if (!writable) {
              // Bound per-client buffering. A slow reader can reconnect using its last ID.
              response.destroy(); break;
            }
          }
          if (result.body.events.length === 100) dirty = true;
        }
      } catch { response.destroy(); }
      finally { pumping = false; }
    };
    hub.listeners.add(pump);
    const timer = setInterval(() => { if (!response.write(': heartbeat\n\n')) response.destroy(); }, 15000); timer.unref();
    response.once('close', () => { clearInterval(timer); hub.listeners.delete(pump); streams.delete(response); });
    await pump();
  }
  const server = createServer(async (request, response) => {
    try {
      const origin = request.headers.origin;
      if (origin) {
        if (!config.corsOrigins.includes(origin)) fail(403, 'ORIGIN_FORBIDDEN', 'This origin is not allowed.');
        response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, Last-Event-ID');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
      }
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      const url = new URL(request.url, 'http://hub');
      if ((url.pathname === '/health' || url.pathname === '/api/v1/health') && request.method === 'GET') return json(response, 200, { status: 'ok', version: '0.1.0' });
      if (!url.pathname.startsWith('/api/v1/')) fail(404, 'NOT_FOUND', 'Route not found.');
      if (closing) fail(503, 'SHUTTING_DOWN', 'Hub is shutting down.');
      const body = ['POST', 'PUT', 'PATCH'].includes(request.method) ? await readBody(request, config.requestMaxBytes) : {};
      const args = { method: request.method, path: `${url.pathname.slice('/api/v1'.length)}${url.search}`, body, authorization: request.headers.authorization, key: request.headers['idempotency-key'] };
      if (args.path.split('?')[0] === '/events' && request.method === 'GET' && request.headers.accept?.split(',').some(value => value.trim() === 'text/event-stream')) return await stream(request, response, args, url);
      if (args.path === '/nodes/lease' && request.method === 'POST') return await lease(request, response, args);
      const result = await hub.request(args); json(response, result.status, result.body);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const expected = error instanceof HubError;
      json(response, expected ? error.status : 500, { error: { code: expected ? error.code : 'INTERNAL_ERROR', message: expected ? error.message : 'The hub could not complete this request.' } });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  const timer = setInterval(() => {
    if (maintenanceBusy || closing) return;
    maintenanceBusy = true;
    hub.maintenance().catch(() => { /* State remains durable; later requests still validate lease deadlines. */ }).finally(() => { maintenanceBusy = false; });
  }, config.maintenanceIntervalMs); timer.unref();
  await hub.maintenance();
  return {
    server, config,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); }); });
      const address = server.address(); return `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${address.port}`;
    },
    async close() {
      if (closing) return;
      closing = true; clearInterval(timer);
      for (const wake of polls) wake(); for (const response of streams) response.end();
      if (server.listening) await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
      await hub.close();
    },
  };
}
