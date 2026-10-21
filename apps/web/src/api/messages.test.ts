import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeMessage, groupThreads, receiptText } from './messages';
import { HttpHub } from './client';

const at = (min: number) => new Date(Date.UTC(2026, 9, 21, 12, min)).toISOString();
const msg = (id: string, min: number, extra: object = {}) => decodeMessage({ id, body: id, senderRoleId: 'reviewer', createdAt: at(min), ...extra });

describe('messages', () => {
  it('fills thread, provenance and receipt for messages from older hubs', () => {
    const m = decodeMessage({ id: 'm1', body: 'hi', senderRoleId: 'planner', recipientRoleId: null, createdAt: at(0) });
    expect(m).toMatchObject({ threadId: 'm1', parentId: null, unplanned: false, receipt: null });
    expect(decodeMessage({ id: 'm2', body: 'x', receipt: { state: 'bogus' } as never }).receipt).toBeNull();
  });

  it('groups replies under their root and orders threads by latest activity', () => {
    const threads = groupThreads([
      msg('a', 0),
      msg('b', 1),
      msg('a2', 5, { threadId: 'a', parentId: 'a' }),
      msg('x2', 6, { threadId: 'x', parentId: 'x' }), // root not loaded
    ]);
    expect(threads.map((t) => [t.root.id, t.replies.map((r) => r.id)])).toEqual([
      ['b', []],
      ['a', ['a2']],
      ['x2', []],
    ]);
  });

  it('says what a receipt proves and no more', () => {
    expect(receiptText({ state: 'stored' }, 'reviewer')).toBe('Waiting for reviewer');
    expect(receiptText({ state: 'delivered', deliveredVia: 'steer' }, 'reviewer')).toBe("Delivered into reviewer's running turn");
    expect(receiptText({ state: 'delivered', deliveredVia: 'prompt' }, 'reviewer')).toBe("Delivered in reviewer's first prompt");
    expect(receiptText({ state: 'acked', ackNote: 'On it' }, 'reviewer')).toBe('Acknowledged: On it');
  });
});

describe('HttpHub messaging', () => {
  const hub = new HttpHub({ baseUrl: 'http://localhost:4320', auth: { kind: 'bearer', token: 't' } });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  afterEach(() => vi.unstubAllGlobals());

  it('replies in a thread, acks as the owner, and moves the read cursor', async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        calls.push([String(url), init]);
        const path = new URL(url).pathname;
        if (path.endsWith('/read-cursor')) return json({ roleId: 'owner', lastReadMessageId: 'm9', unreadCount: 0 });
        if (path.endsWith('/unread')) return json({ roleId: 'owner', messages: [], unreadCount: 2, lastReadMessageId: 'm7' });
        return json({ message: { id: 'm9', body: 'ok', threadId: 'm1', parentId: 'm3', receipt: { state: 'stored' } }, duplicate: false });
      }),
    );
    const sent = await hub.sendMessage('prj', 'run-1', { body: 'ok', parentId: 'm3' });
    expect(sent).toMatchObject({ threadId: 'm1', parentId: 'm3', receipt: { state: 'stored' } });
    expect(JSON.parse(String(calls[0][1].body))).toMatchObject({ senderRoleId: 'owner', parentId: 'm3', body: 'ok' });
    await hub.ackMessage('prj', 'run-1', 'm8');
    expect(calls[1][0]).toContain('/messaging/projects/prj/channels/run-1/messages/m8/ack');
    expect(JSON.parse(String(calls[1][1].body))).toMatchObject({ roleId: 'owner' });
    expect(await hub.unread('prj', 'run-1')).toMatchObject({ unreadCount: 2, lastReadMessageId: 'm7' });
    expect(calls[2][0]).toContain('roleId=owner');
    expect(await hub.markRead('prj', 'run-1', 'm9')).toMatchObject({ unreadCount: 0 });
  });

  it('shows no unread counts on hubs without read cursors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }, 404)),
    );
    expect(await hub.unread('prj', 'general')).toBeNull();
  });
});
