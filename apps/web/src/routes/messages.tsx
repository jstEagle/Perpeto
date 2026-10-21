import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useHub, useResource } from '../app/hub-context';
import { OWNER_ROLE_ID } from '../api/hub';
import type { Channel, Message } from '../api/types';
import { Async, Button, Empty, Loading, ErrorState, PageHeader } from '../components/ui';
import { IconSend } from '../components/icons';
import { clock, dateTime } from '../lib/format';

export function MessagesPage() {
  const { projectId } = useParams({ from: '/projects/$projectId/messages' });
  const search = useSearch({ from: '/projects/$projectId/messages' });
  const navigate = useNavigate();
  const channels = useResource((api) => api.listChannels(projectId), [projectId]);

  return (
    <div className="page">
      <PageHeader title="Messages" description="Project and run channels. Messages coordinate work; they never assign it or mark it verified." />
      <Async resource={channels} what="channels">
        {(list) => {
          if (list.length === 0)
            return (
              <div className="panel">
                <Empty title="No channels yet.">Each run gets a channel when it starts.</Empty>
              </div>
            );
          const current = list.find((c) => c.id === search.channel) ?? list.find((c) => c.id.startsWith('run-')) ?? list[0];
          return (
            <div className="panel panel-flush messages-layout">
              <nav className="channel-list" aria-label="Channels">
                {list.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="channel-link"
                    aria-current={c.id === current.id ? 'true' : undefined}
                    onClick={() => void navigate({ to: '/projects/$projectId/messages', params: { projectId }, search: { channel: c.id } })}
                  >
                    {channelLabel(c)}
                  </button>
                ))}
              </nav>
              <Thread key={current.id} projectId={projectId} channel={current} />
            </div>
          );
        }}
      </Async>
    </div>
  );
}

function channelLabel(c: Channel) {
  return c.id.startsWith('run-') ? c.name : `# ${c.name}`;
}

function Thread({ projectId, channel }: { projectId: string; channel: Channel }) {
  const { api, onEvent } = useHub();
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [older, setOlder] = useState<{ cursor: string; hasMore: boolean } | null>(null);
  const [body, setBody] = useState('');
  const [to, setTo] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const loadLatest = () =>
    api
      .readMessages(projectId, channel.id, { latest: true, limit: 50 })
      .then((page) => {
        setMessages(page.messages);
        setOlder({ cursor: page.previousCursor, hasMore: page.hasMore });
        setError(null);
      })
      .catch((e: Error) => setError(e));

  useEffect(() => {
    void loadLatest();
    const off = onEvent((e) => {
      if (e.type === 'message.created' && (e.data as { channelId?: string }).channelId === channel.id) void loadLatest();
    });
    const poll = setInterval(() => void loadLatest(), 15_000);
    return () => {
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
    const page = await api.readMessages(projectId, channel.id, { before: older.cursor, limit: 50 });
    setMessages((m) => [...page.messages, ...(m ?? [])]);
    setOlder({ cursor: page.previousCursor, hasMore: page.hasMore });
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setSending(true);
    setSendError(null);
    try {
      await api.sendMessage(projectId, channel.id, { body: body.trim(), ...(to.trim() ? { recipientRoleId: to.trim() } : {}) });
      setBody('');
      await loadLatest();
    } catch (err) {
      setSendError(`Message not sent. ${(err as Error).message}`);
    } finally {
      setSending(false);
    }
  }

  const roles = [...new Set((messages ?? []).map((m) => m.senderRoleId).filter((r) => r !== OWNER_ROLE_ID))];

  return (
    <section className="thread" aria-label={`Channel ${channel.name}`}>
      <div className="thread-scroll" ref={scroller} aria-live="polite">
        {error ? (
          <ErrorState what="messages" error={error} onRetry={() => void loadLatest()} />
        ) : !messages ? (
          <Loading label="Loading messages" />
        ) : messages.length === 0 ? (
          <Empty title="No messages in this channel yet." />
        ) : (
          <>
            {older?.hasMore && (
              <div className="row" style={{ justifyContent: 'center', padding: 12 }}>
                <Button size="sm" variant="ghost" onClick={() => void loadOlder()}>
                  Load older messages
                </Button>
              </div>
            )}
            {messages.map((m) => (
              <article key={m.id} className={`message ${m.senderRoleId === OWNER_ROLE_ID ? 'message-owner' : ''}`}>
                <div className="message-head">
                  <span className="message-sender">{m.senderRoleId}</span>
                  {m.recipientRoleId && <span className="message-to">to {m.recipientRoleId}</span>}
                </div>
                <time className="feed-time" dateTime={m.createdAt} title={dateTime(m.createdAt)}>
                  {clock(m.createdAt)}
                </time>
                <p className="message-body">{m.body}</p>
              </article>
            ))}
          </>
        )}
      </div>
      <form className="composer" onSubmit={send}>
        <div className="stack-sm" style={{ flex: 1, gap: 8 }}>
          <label className="visually-hidden" htmlFor="msg-body">
            Message
          </label>
          <textarea
            id="msg-body"
            className="input"
            rows={2}
            placeholder={`Message ${channel.name}`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(e);
            }}
          />
          <div className="row" style={{ gap: 8 }}>
            <label className="note" htmlFor="msg-to">
              To role
            </label>
            <input id="msg-to" className="input mono-input composer-to" list="msg-roles" value={to} onChange={(e) => setTo(e.target.value)} placeholder="everyone" spellCheck={false} />
            <datalist id="msg-roles">
              {roles.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
            {sendError && (
              <span className="field-error" role="alert">
                {sendError}
              </span>
            )}
          </div>
        </div>
        <Button variant="primary" type="submit" busy={sending} aria-label="Send message">
          <IconSend /> Send
        </Button>
      </form>
    </section>
  );
}
