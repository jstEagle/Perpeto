import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpHub, readSse } from './client';
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
  const hub = new HttpHub({ baseUrl: 'http://localhost:7300/', token: 'secret-token' });

  it('sends the bearer token and an idempotency key on writes', async () => {
    const fetch = vi.fn(async () => json({ run: { id: 'run_1' } }));
    vi.stubGlobal('fetch', fetch);
    const run = await hub.pauseRun('run_1');
    expect(run.id).toBe('run_1');
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://localhost:7300/api/v1/runs/run_1/pause');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
    expect(JSON.parse(String(init.body)).idempotencyKey).toMatch(/[0-9a-f-]{36}/);
  });

  it('unwraps list envelopes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ machines: [{ id: 'mch_1' }] })));
    expect(await hub.listMachines()).toEqual([{ id: 'mch_1' }]);
  });

  it('surfaces contract error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'LEASE_LOST', message: 'Lease lost.' } }, 409)));
    await expect(hub.getRun('x')).rejects.toMatchObject({ status: 409, code: 'LEASE_LOST' });
  });

  it('rebuilds the run list from events when the hub has no run list route', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        const path = new URL(url).pathname;
        if (path.endsWith('/projects/prj_1/runs')) return json({ error: { code: 'NOT_FOUND', message: 'nope' } }, 404);
        if (path.endsWith('/events'))
          return json({ events: [{ seq: 1, at: '', type: 'run.started', projectId: 'prj_1', subject: { kind: 'run', id: 'run_a' }, data: {} }] });
        if (path.endsWith('/runs/run_a')) return json({ id: 'run_a', startedAt: '2026-10-20T00:00:00Z' });
        return json({}, 500);
      }),
    );
    const runs = await hub.listRuns('prj_1');
    expect(runs.map((r) => r.id)).toEqual(['run_a']);
  });

  it('reports unreachable hubs as network errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('failed'))));
    const err = await hub.health().catch((e) => e);
    expect(err).toBeInstanceOf(HubError);
    expect(err.status).toBe(0);
  });
});
