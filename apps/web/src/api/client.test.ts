import { afterEach, describe, expect, it, vi } from 'vitest';
import { cookieAdvice, HttpHub, readSse } from './client';
import { HubError } from './hub';

function stream(chunks: string[]) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('readSse', () => {
  it('joins frames split across chunks and ignores comments', async () => {
    const got: string[] = [];
    await readSse(stream([': hello\n\n', 'data: {"seq":1}\n', '\ndata: {"se', 'q":2}\r\n\r\n']), (d) => got.push(d));
    expect(got).toEqual(['{"seq":1}', '{"seq":2}']);
  });
});

describe('HttpHub', () => {
  const hub = new HttpHub({ baseUrl: 'http://localhost:4320/', auth: { kind: 'bearer', token: 'secret-token' } });

  it('sends the bearer token and an idempotency key on writes', async () => {
    const fetch = vi.fn(async () => json({ id: 'run_1', status: 'paused' }));
    vi.stubGlobal('fetch', fetch);
    const run = await hub.pauseRun('run_1');
    expect(run.id).toBe('run_1');
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://localhost:4320/api/v1/runs/run_1/pause');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
    expect(init.credentials).toBeUndefined();
    expect(JSON.parse(String(init.body)).idempotencyKey).toMatch(/[0-9a-f-]{36}/);
  });

  it('starts runs with settings and patches them later', async () => {
    const fetch = vi.fn(async () => json({ id: 'run_1', status: 'running' }));
    vi.stubGlobal('fetch', fetch);
    await hub.startRun('wf_1', { keepOpen: true, source: 'schedule', schedule: '0 7 * * 1-5', budget: { maxTokensPerDay: 500_000 } });
    await hub.updateRun('run_1', { budget: {} });
    const [startUrl, start] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    const [patchUrl, patch] = fetch.mock.calls[1] as unknown as [URL, RequestInit];
    expect(String(startUrl)).toBe('http://localhost:4320/api/v1/workflows/wf_1/runs');
    expect(JSON.parse(String(start.body))).toMatchObject({ keepOpen: true, source: 'schedule', schedule: '0 7 * * 1-5', budget: { maxTokensPerDay: 500_000 } });
    expect(String(patchUrl)).toBe('http://localhost:4320/api/v1/runs/run_1');
    expect(patch.method).toBe('PATCH');
    expect(JSON.parse(String(patch.body))).toMatchObject({ budget: {} });
  });

  it('reads the template library, or the local templates from an older hub', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ templates: [{ id: 'docs', description: 'Write docs.', graph: { schema: 'perpeto.workflow/1', nodes: [], edges: [] } }] })));
    expect((await hub.listTemplates()).map((t) => t.id)).toEqual(['docs']);
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }, 404)));
    expect((await hub.listTemplates()).map((t) => t.id)).toEqual(['build', 'improve']);
  });

  it('uses the session cookie instead of a token in cookie mode', async () => {
    const fetch = vi.fn(async () => json({ projects: [] }));
    vi.stubGlobal('fetch', fetch);
    await new HttpHub({ baseUrl: 'http://localhost:4320', auth: { kind: 'cookie' } }).listProjects();
    const [, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('falls back when the hub has no session route', async () => {
    const fetch = vi.fn(async () => json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }, 404));
    vi.stubGlobal('fetch', fetch);
    expect(await HttpHub.startSession('http://localhost:4320', 'secret-token')).toBe(false);
    // The probe sends no credentials, so a hub without credentialed CORS still answers it.
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].credentials).toBeUndefined();
  });

  it('asks for the cookie once the hub has the session route', async () => {
    const fetch = vi.fn(async (_: string, init?: RequestInit) => (init?.method === 'POST' ? json({ expiresAt: '2026-10-22T00:00:00Z' }, 201) : json({ kind: 'owner' })));
    vi.stubGlobal('fetch', fetch);
    expect(await HttpHub.startSession('http://localhost:4320', 'secret-token')).toBe(true);
    expect((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].credentials).toBe('include');
  });

  it('proves the cookie works without the token, and refuses to fall back when it does not', async () => {
    const calls: RequestInit[] = [];
    let kept = true;
    const fetch = vi.fn(async (_: string, init: RequestInit = {}) => {
      calls.push(init);
      if (init.method === 'POST') return json({ expiresAt: '2026-10-22T00:00:00Z' }, 201);
      const bearer = !!(init.headers as Record<string, string>)?.Authorization;
      return bearer || kept ? json({ kind: 'owner' }) : json({ error: { code: 'UNAUTHORIZED', message: 'Missing credentials.' } }, 401);
    });
    vi.stubGlobal('fetch', fetch);
    expect(await HttpHub.startSession('http://localhost:4320', 'secret-token')).toBe(true);
    expect(calls[2].credentials).toBe('include');
    expect((calls[2].headers as Record<string, string>).Authorization).toBeUndefined();

    // SameSite=Strict drops the cookie when the app and hub are on different sites.
    kept = false;
    const err = await HttpHub.startSession('http://127.0.0.1:4320', 'secret-token').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'COOKIE_BLOCKED' });
    expect(cookieAdvice('http://127.0.0.1:4320', 'localhost')).toContain('Connect to http://localhost:4320 instead');
  });

  it('reads named list envelopes and rejects others', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ machines: [{ id: 'mch_1' }] })));
    expect(await hub.listMachines()).toEqual([{ id: 'mch_1' }]);
    vi.stubGlobal('fetch', vi.fn(async () => json([{ id: 'mch_1' }])));
    await expect(hub.listMachines()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('surfaces contract error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'lease_lost', message: 'Lease lost.' } }, 409)));
    await expect(hub.getRun('x')).rejects.toMatchObject({ status: 409, code: 'lease_lost' });
  });

  it('converts hub validation, diff, usage, job log and versions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        const path = new URL(url).pathname;
        if (path.endsWith('/validate')) return json({ valid: false, errors: [{ code: 'NO_OUTPUT', message: 'No output.' }], warnings: [{ code: 'UNKNOWN_KEY', message: 'Unknown.' }] });
        if (path.endsWith('/diff'))
          return json({ identical: false, nodes: { added: [{ id: 'fast' }], removed: [], changed: [{ id: 'reviewer', changes: [] }, { id: 'ci', layoutOnly: true }] }, edges: { added: [{ id: 'e1' }], removed: [{ id: 'e0' }], changed: [] } });
        if (path.endsWith('/usage')) return json({ groupBy: 'model', groups: [{ key: 'gpt', inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, records: 1 }], totals: {} });
        if (path.endsWith('/log')) return json({ jobId: 'job_1', chunks: [{ chunk: 'a\n' }, { chunk: 'b' }] });
        if (path.endsWith('/versions')) return json({ versions: [1, 2, 3].map((version) => ({ id: 'wf', version, status: 'draft' })) });
        if (path.endsWith('/workflows/wf')) return json({ id: 'wf', version: 3, status: 'draft', activeVersion: 2 });
        return json({}, 500);
      }),
    );
    const validation = await hub.validateWorkflow('wf', { schema: 'perpeto.workflow/1', nodes: [], edges: [] });
    expect(validation.issues.map((i) => i.severity)).toEqual(['error', 'warning']);
    expect(await hub.diffVersions('wf', 1, 2)).toEqual({ nodes: { added: ['fast'], removed: [], changed: ['reviewer'] }, edges: { added: ['e1'], removed: ['e0'], changed: [] } });
    expect((await hub.usage({ groupBy: 'model' })).rows[0].key).toBe('gpt');
    expect(await hub.getJobLog('job_1')).toBe('a\nb');
    expect((await hub.listVersions('wf')).map((v) => v.status)).toEqual(['paused', 'active', 'draft']);
  });

  it('sends run input as items and human decisions as pass or fail', async () => {
    const fetch = vi.fn(async () => json({ accepted: true }, 202));
    vi.stubGlobal('fetch', fetch);
    await hub.addRunInput('run_1', { title: 'Add a CLI flag' });
    await hub.decideWorkItem('wi_1', { decision: 'return', note: 'Needs tests' });
    const bodies = fetch.mock.calls.map((c) => JSON.parse(String((c as unknown as [URL, RequestInit])[1].body)));
    expect(bodies[0].items).toEqual([{ title: 'Add a CLI flag' }]);
    expect(bodies[1]).toMatchObject({ decision: 'fail', note: 'Needs tests' });
  });

  it('binds a human decision to its wait and surfaces a stale one', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ accepted: true, decisionId: 'dec_2' }))
      .mockResolvedValueOnce(json({ error: { code: 'STALE_DECISION', message: 'This decision answers an earlier wait.' } }, 409));
    vi.stubGlobal('fetch', fetch);
    await hub.decideWorkItem('wi_1', { decision: 'approve', decisionId: 'dec_2' });
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [URL, RequestInit])[1].body))).toMatchObject({ decision: 'pass', decisionId: 'dec_2' });
    const refused = await hub.decideWorkItem('wi_1', { decision: 'approve', decisionId: 'dec_1' }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HubError);
    expect(refused).toMatchObject({ status: 409, code: 'STALE_DECISION' });
  });

  it('reads the newest events first, per run, and pages back with before', async () => {
    const urls: URLSearchParams[] = [];
    const fetch = vi.fn(async (url: URL) => {
      const q = new URL(url).searchParams;
      urls.push(q);
      if (q.get('limit') === '1') return json({ events: [{ seq: 1500 }], previousCursor: 1500, nextCursor: 1500, hasMore: true });
      const top = q.has('before') ? Number(q.get('before')) - 1 : 1500;
      const events = [top - 1, top].map((seq) => ({ seq, at: '', type: 'x', runId: 'run_1', subject: { kind: 'run', id: 'run_1' }, data: {} }));
      return json({ events, previousCursor: top - 1, nextCursor: top, hasMore: true });
    });
    vi.stubGlobal('fetch', fetch);
    const fresh = new HttpHub({ baseUrl: 'http://localhost:4320', auth: { kind: 'bearer', token: 't' } });
    expect(await fresh.latestSeq()).toBe(1500);
    expect(urls[0].get('latest')).toBe('true');
    const page = await fresh.eventPage({ runId: 'run_1', limit: 2 });
    expect(page.events.map((e) => e.seq)).toEqual([1500, 1499]);
    expect(Object.fromEntries(urls[1])).toEqual({ latest: 'true', limit: '2', runId: 'run_1' });
    const older = await fresh.eventPage({ runId: 'run_1', before: page.before, limit: 2 });
    expect(urls[2].get('before')).toBe('1499');
    expect(urls[2].has('latest')).toBe(false);
    expect(older.events.map((e) => e.seq)).toEqual([1498, 1497]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('reports unreachable hubs as network errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('failed'))));
    const err = await hub.health().catch((e) => e);
    expect(err).toBeInstanceOf(HubError);
    expect(err.status).toBe(0);
  });
});
