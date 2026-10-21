import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useHub, useResource } from '../app/hub-context';
import { OWNER_ROLE_ID } from '../api/hub';
import type { Channel, HubEvent, Message, Receipt, UnreadState } from '../api/types';
import { groupThreads, receiptText } from '../api/messages';
import type { Thread } from '../api/messages';
import { Async, Button, Empty, ErrorState, Loading, PageHeader } from '../components/ui';
import { LiveDot, StatusLabel } from '../components/status';
import { IconCheck, IconCheckCircle, IconCircle, IconMessages, IconPerson, IconSend } from '../components/icons';
import { NODE_SPECS } from '../workflow/registry';
import { clock, dateTime } from '../lib/format';

/** Events that change a channel's messages, receipts or unread counts. */
const MESSAGE_EVENTS = new Set(['message.created', 'message.delivered', 'message.acked', 'agent.messaged']);
const isMessageEvent = (e: HubEvent) => MESSAGE_EVENTS.has(e.type);
/** Hub run ids are long; show the start and end, with the full id on hover. */
const shortRunId = (id: string) => (id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);

export function MessagesPage() {
  const { projectId } = useParams({ from: '/projects/$projectId/messages' });
  const search = useSearch({ from: '/projects/$projectId/messages' });
  const navigate = useNavigate();
  const channels = useResource((api) => api.listChannels(projectId), [projectId]);
  const runs = useResource(
    (api) => api.listRuns(projectId),
    [projectId],
    (e) => e.projectId === projectId && e.type.startsWith('run'),
  );
  const unread = useResource(
    async (api) => {
      const list = await api.listChannels(projectId);
      const states = await Promise.all(list.map((c) => api.unread(projectId, c.id).catch(() => null)));
      return new Map(list.map((c, i) => [c.id, states[i]] as const));
    },
    [projectId],
    (e) => e.projectId === projectId && isMessageEvent(e),
    { debounceMs: 400, maxWaitMs: 2000 },
  );

  return (
    <div className="page">
      <PageHeader title="Messages" description="Project and run channels. Messages coordinate work; they never assign it or mark it verified." />
      <Async resource={channels} what="channels">
        {(list) => {
          if (list.length === 0)
            return (
              <section className="card">
                <Empty title="No channels yet" icon={<IconMessages />}>
                  Each run gets a channel when it starts.
                </Empty>
              </section>
            );
          const current = list.find((c) => c.id === search.channel) ?? list.find((c) => c.id.startsWith('run-')) ?? list[0];
          const project = list.filter((c) => !c.id.startsWith('run-'));
          const runChannels = list.filter((c) => c.id.startsWith('run-'));
          const open = (c: Channel) => void navigate({ to: '/projects/$projectId/messages', params: { projectId }, search: { channel: c.id } });
          const item = (c: Channel) => {
            const count = unread.data?.get(c.id)?.unreadCount ?? 0;
            const run = runs.data?.find((r) => `run-${r.id}` === c.id);
            return (
              <button key={c.id} type="button" className="nav-link" aria-current={c.id === current.id ? 'page' : undefined} onClick={() => open(c)}>
                <span className="channel-name" title={c.id.startsWith('run-') ? c.id.slice(4) : undefined}>
                  {c.id.startsWith('run-') ? <span className="mono">{shortRunId(c.id.slice(4))}</span> : c.name}
                </span>
                {count > 0 ? (
                  <span className="count channel-unread" aria-label={`${count} unread`}>
                    {count}
                  </span>
                ) : (
                  run?.status === 'running' && <LiveDot label="Run is live" />
                )}
              </button>
            );
          };
          return (
            <div className="messages-layout">
              <nav className="nav channel-list" aria-label="Channels">
                {project.length > 0 && <h2 className="nav-title">Project</h2>}
                {project.map(item)}
                {runChannels.length > 0 && <h2 className="nav-title channel-group">Runs</h2>}
                {runChannels.map(item)}
              </nav>
              <ChannelView key={current.id} projectId={projectId} channel={current} onRead={unread.reload} />
            </div>
          );
        }}
      </Async>
    </div>
  );
}

/** Roles the owner can address: the run's agent roles, plus anyone who has spoken in the channel. */
function useRoles(projectId: string, channel: Channel, messages: Message[] | null) {
  const runId = channel.id.startsWith('run-') ? channel.id.slice(4) : null;
  const graphRoles = useResource(
    async (api) => {
      if (!runId) return [] as { id: string; label: string }[];
      const run = await api.getRun(runId);
      const version = (await api.listVersions(run.workflowId)).find((v) => v.version === run.workflowVersion);
      return (version?.graph.nodes ?? []).filter((n) => NODE_SPECS[n.type].role).map((n) => ({ id: typeof n.config.role === 'string' ? n.config.role : n.id, label: n.label }));
    },
    [projectId, runId],
  );
  return useMemo(() => {
    const roles = new Map((graphRoles.data ?? []).map((r) => [r.id, r.label]));
    for (const m of messages ?? []) for (const id of [m.senderRoleId, m.recipientRoleId]) if (id && id !== OWNER_ROLE_ID && !roles.has(id)) roles.set(id, id);
    return [...roles].map(([id, label]) => ({ id, label }));
  }, [graphRoles.data, messages]);
}

function ChannelView({ projectId, channel, onRead }: { projectId: string; channel: Channel; onRead(): void }) {
  const { api, onEvent } = useHub();
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [older, setOlder] = useState<{ cursor: string; hasMore: boolean } | null>(null);
  // The read cursor as it was when the channel opened, so new messages stay marked while you read them.
  const [seenUpTo, setSeenUpTo] = useState<UnreadState | null | undefined>(undefined);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const loadLatest = useCallback(
    () =>
      api
        .readMessages(projectId, channel.id, { latest: true, limit: 100 })
        .then((page) => {
          setMessages(page.messages);
          setOlder({ cursor: page.previousCursor, hasMore: page.hasMore });
          setError(null);
          return page.messages;
        })
        .catch((e: Error) => {
          setError(e);
          return [] as Message[];
        }),
    [api, projectId, channel.id],
  );

  useEffect(() => {
    let cancelled = false;
    void api
      .unread(projectId, channel.id)
      .catch(() => null)
      .then((state) => {
        if (cancelled) return;
        setSeenUpTo(state);
        return loadLatest();
      })
      .then((list) => {
        // Reading the channel moves the owner's read cursor to its newest message.
        const newest = list?.at(-1);
        if (!cancelled && newest) void api.markRead(projectId, channel.id, newest.id).then(onRead, () => undefined);
      });
    const off = onEvent((e) => {
      if (e.projectId === projectId && isMessageEvent(e)) void loadLatest();
    });
    const poll = setInterval(() => void loadLatest(), 15_000);
    return () => {
      cancelled = true;
      off();
      clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectId, channel.id]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages?.length]);

  async function loadOlder() {
    if (!older) return;
    const page = await api.readMessages(projectId, channel.id, { before: older.cursor, limit: 100 });
    setMessages((m) => [...page.messages, ...(m ?? [])]);
    setOlder({ cursor: page.previousCursor, hasMore: page.hasMore });
  }

  const roles = useRoles(projectId, channel, messages);
  const roleLabel = (id: string | null) => (id === null ? 'everyone' : id === OWNER_ROLE_ID ? 'you' : (roles.find((r) => r.id === id)?.label ?? id));
  const threads = useMemo(() => groupThreads(messages ?? []), [messages]);

  // Unread: after the cursor, addressed to the owner or the channel, not sent by the owner.
  const unreadIds = useMemo(() => {
    if (!messages || seenUpTo === undefined || seenUpTo === null) return new Set<string>();
    const ordered = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const from = seenUpTo.lastReadMessageId ? ordered.findIndex((m) => m.id === seenUpTo.lastReadMessageId) + 1 : 0;
    return new Set(
      ordered
        .slice(from)
        .filter((m) => m.senderRoleId !== OWNER_ROLE_ID && (m.recipientRoleId === OWNER_ROLE_ID || m.recipientRoleId === null))
        .map((m) => m.id),
    );
  }, [messages, seenUpTo]);

  const ack = async (m: Message) => {
    const updated = await api.ackMessage(projectId, channel.id, m.id);
    setMessages((list) => list?.map((x) => (x.id === m.id ? updated : x)) ?? null);
  };

  return (
    <section className="thread" aria-label={`Channel ${channel.name}`}>
      <header className="thread-head">
        <h2 className="card-title" title={channel.id.startsWith('run-') ? channel.id.slice(4) : undefined}>
          {channel.id.startsWith('run-') ? (
            <>
              Run <span className="mono">{shortRunId(channel.id.slice(4))}</span>
            </>
          ) : (
            channel.name
          )}
        </h2>
        <span className="card-aside">{messages ? `${threads.length} ${threads.length === 1 ? 'thread' : 'threads'}` : ''}</span>
      </header>
      <div className="thread-scroll" ref={scroller} aria-live="polite">
        {error ? (
          <ErrorState what="messages" error={error} onRetry={() => void loadLatest()} />
        ) : !messages ? (
          <Loading label="Loading messages" />
        ) : messages.length === 0 ? (
          <Empty title="No messages yet" icon={<IconMessages />}>
            Agents and you post here while the work runs.
          </Empty>
        ) : (
          <>
            {older?.hasMore && (
              <div className="thread-older">
                <button type="button" className="text-btn" onClick={() => void loadOlder()}>
                  Show older messages
                </button>
              </div>
            )}
            <ol className="threads">
              {threads.map((t) => (
                <ThreadItem
                  key={t.root.id}
                  thread={t}
                  unread={unreadIds}
                  roleLabel={roleLabel}
                  onAck={ack}
                  replying={replyTo === t.root.threadId}
                  onReply={() => setReplyTo(replyTo === t.root.threadId ? null : t.root.threadId)}
                  composer={
                    <Composer
                      projectId={projectId}
                      channel={channel}
                      roles={roles}
                      reply={t.last.senderRoleId === OWNER_ROLE_ID ? t.root : t.last}
                      roleLabel={roleLabel}
                      onSent={(m) => {
                        setMessages((list) => [...(list ?? []), m]);
                        setReplyTo(null);
                      }}
                      onCancel={() => setReplyTo(null)}
                    />
                  }
                />
              ))}
            </ol>
          </>
        )}
      </div>
      <Composer projectId={projectId} channel={channel} roles={roles} roleLabel={roleLabel} onSent={(m) => setMessages((list) => [...(list ?? []), m])} />
    </section>
  );
}

/** A thread: its first message, the latest reply, and earlier replies on request. */
function ThreadItem({
  thread,
  unread,
  roleLabel,
  onAck,
  replying,
  onReply,
  composer,
}: {
  thread: Thread;
  unread: Set<string>;
  roleLabel(id: string | null): string;
  onAck(m: Message): Promise<void>;
  replying: boolean;
  onReply(): void;
  composer: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const earlier = thread.replies.slice(0, -1);
  const shown = expanded ? thread.replies : thread.replies.slice(-1);
  return (
    <li className="thread-item">
      <MessageItem m={thread.root} unread={unread.has(thread.root.id)} roleLabel={roleLabel} onAck={onAck} reply={thread.replies.length === 0 ? { replying, onReply } : undefined} />
      {thread.replies.length > 0 && (
        <div className="thread-replies">
          {earlier.length > 0 && !expanded && (
            <button type="button" className="text-btn thread-more" onClick={() => setExpanded(true)}>
              {earlier.length === 1 ? '1 earlier reply' : `${earlier.length} earlier replies`}
            </button>
          )}
          {shown.map((m) => (
            <MessageItem key={m.id} m={m} unread={unread.has(m.id)} roleLabel={roleLabel} onAck={onAck} reply={m === thread.last ? { replying, onReply } : undefined} />
          ))}
        </div>
      )}
      {replying && <div className="thread-reply">{composer}</div>}
    </li>
  );
}

function MessageItem({
  m,
  unread,
  roleLabel,
  onAck,
  reply,
}: {
  m: Message;
  unread: boolean;
  roleLabel(id: string | null): string;
  onAck(m: Message): Promise<void>;
  /** On the thread's newest message: answer in the thread. */
  reply?: { replying: boolean; onReply(): void };
}) {
  const [busy, setBusy] = useState(false);
  const owner = m.senderRoleId === OWNER_ROLE_ID;
  const toOwner = m.recipientRoleId === OWNER_ROLE_ID;
  return (
    <article className={`message ${owner ? 'message-owner' : ''} ${unread ? 'is-unread' : ''}`}>
      <span className="avatar" aria-hidden="true">
        {owner ? <IconPerson size={16} /> : m.senderRoleId.slice(0, 2).toUpperCase()}
      </span>
      <div className="message-main">
        <div className="message-head">
          <span className="message-sender">{owner ? 'You' : roleLabel(m.senderRoleId)}</span>
          <span className="message-to">to {roleLabel(m.recipientRoleId)}</span>
          <time className="message-time" dateTime={m.createdAt} title={dateTime(m.createdAt)}>
            {clock(m.createdAt)}
          </time>
          {unread && <span className="chip-quiet">New</span>}
          {m.unplanned && (
            <span title="Sent outside this workflow's messages connections. The workflow flags rather than blocks it.">
              <StatusLabel tone="attention">Unplanned</StatusLabel>
            </span>
          )}
        </div>
        <p className="message-body">{m.body}</p>
        {(m.receipt || toOwner || reply) && (
          <div className="message-foot">
            {m.receipt && <ReceiptLabel receipt={m.receipt} recipient={roleLabel(m.recipientRoleId)} />}
            {toOwner && m.receipt?.state !== 'acked' && (
              <button
                type="button"
                className="text-btn"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void onAck(m).finally(() => setBusy(false));
                }}
              >
                Acknowledge
              </button>
            )}
            {reply && (
              <button type="button" className="text-btn" onClick={reply.onReply} aria-expanded={reply.replying}>
                {reply.replying ? 'Cancel reply' : 'Reply'}
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

/** Delivery evidence as a quiet icon and words: stored, delivered (prompt, running turn or read), acknowledged. */
function ReceiptLabel({ receipt, recipient }: { receipt: Receipt; recipient: string }) {
  const Icon = receipt.state === 'acked' ? IconCheckCircle : receipt.state === 'delivered' ? IconCheck : IconCircle;
  const when = receipt.state === 'acked' ? receipt.ackedAt : receipt.state === 'delivered' ? receipt.deliveredAt : null;
  return (
    <span className={`receipt receipt-${receipt.state}`} title={when ? dateTime(when) : 'Stored by the hub; not yet in front of the agent'}>
      <Icon size={14} />
      {receiptText(receipt, recipient)}
    </span>
  );
}

/** The owner can message any role or the whole channel, or answer in a thread. */
function Composer({
  projectId,
  channel,
  roles,
  reply,
  roleLabel,
  onSent,
  onCancel,
}: {
  projectId: string;
  channel: Channel;
  roles: { id: string; label: string }[];
  reply?: Message;
  roleLabel(id: string | null): string;
  onSent(m: Message): void;
  onCancel?(): void;
}) {
  const { api } = useHub();
  const [body, setBody] = useState('');
  const [to, setTo] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `msg-${reply?.id ?? 'new'}`;
  // A reply answers the latest other speaker in the thread unless you pick someone else.
  const replyTo = reply ? (reply.senderRoleId === OWNER_ROLE_ID ? reply.recipientRoleId : reply.senderRoleId) : null;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setSending(true);
    setError(null);
    try {
      const m = await api.sendMessage(projectId, channel.id, {
        body: body.trim(),
        ...(reply ? { parentId: reply.id } : {}),
        ...(to ? { recipientRoleId: to === '*' ? null : to } : reply ? {} : { recipientRoleId: null }),
      });
      setBody('');
      setTo('');
      onSent(m);
    } catch (err) {
      setError(`Message not sent. ${(err as Error).message}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <form className={`composer ${reply ? 'composer-reply' : ''}`} onSubmit={send} aria-label={reply ? 'Reply in thread' : `Message ${channel.name}`}>
      <div className="composer-main">
        <label className="visually-hidden" htmlFor={id}>
          {reply ? 'Reply' : 'Message'}
        </label>
        <textarea
          id={id}
          className="input"
          rows={2}
          placeholder={reply ? `Reply to ${roleLabel(replyTo)}` : `Message ${channel.id.startsWith('run-') ? 'this run' : channel.name}`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(e);
          }}
        />
        <div className="row composer-meta">
          <label className="note" htmlFor={`${id}-to`}>
            To
          </label>
          <span className="select">
            <select id={`${id}-to`} className="input composer-to" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">{reply ? roleLabel(replyTo) : 'Everyone in this channel'}</option>
              {reply && <option value="*">Everyone in this channel</option>}
              {roles
                .filter((r) => r.id !== (reply ? replyTo : null))
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
            </select>
          </span>
          {error && (
            <span className="field-error" role="alert">
              {error}
            </span>
          )}
        </div>
      </div>
      <div className="composer-actions">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button variant={reply ? 'secondary' : 'primary'} type="submit" busy={sending}>
          <IconSend /> {reply ? 'Reply' : 'Send'}
        </Button>
      </div>
    </form>
  );
}
