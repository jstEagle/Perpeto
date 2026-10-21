import type { Message, Receipt } from './types';

/** Messages from any hub: older ones carry no thread, provenance or receipt. */
export function decodeMessage(raw: Partial<Message> & Pick<Message, 'id' | 'body'>): Message {
  const receipt = raw.receipt && typeof raw.receipt === 'object' && ['stored', 'delivered', 'acked'].includes((raw.receipt as Receipt).state) ? (raw.receipt as Receipt) : null;
  return {
    projectId: '',
    channelId: '',
    senderRoleId: '',
    recipientRoleId: null,
    createdAt: '',
    senderKind: null,
    senderAssignmentId: null,
    ...raw,
    threadId: raw.threadId ?? raw.id,
    parentId: raw.parentId ?? null,
    unplanned: raw.unplanned === true,
    receipt,
  };
}

export interface Thread {
  root: Message;
  /** Replies, oldest first. */
  replies: Message[];
  /** The newest message in the thread, for ordering and unread marks. */
  last: Message;
}

/**
 * Messages grouped into threads, ordered by their latest activity. A reply
 * whose root is not loaded (an older page) starts its own group so nothing
 * is hidden.
 */
export function groupThreads(messages: Message[]): Thread[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const threads = new Map<string, Thread>();
  for (const m of [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    const key = byId.has(m.threadId) ? m.threadId : m.id === m.threadId ? m.id : `orphan:${m.threadId}`;
    const t = threads.get(key);
    if (!t) threads.set(key, { root: m, replies: [], last: m });
    else {
      t.replies.push(m);
      t.last = m;
    }
  }
  return [...threads.values()].sort((a, b) => a.last.createdAt.localeCompare(b.last.createdAt));
}

/** What a receipt says, in words: delivery evidence, never proof of understanding. */
export function receiptText(r: Receipt, recipient: string): string {
  if (r.state === 'acked') return r.ackNote ? `Acknowledged: ${r.ackNote}` : `Acknowledged by ${recipient}`;
  if (r.state === 'delivered')
    return r.deliveredVia === 'prompt' ? `Delivered in ${recipient}'s first prompt` : r.deliveredVia === 'steer' ? `Delivered into ${recipient}'s running turn` : `Read by ${recipient}`;
  return `Waiting for ${recipient}`;
}
