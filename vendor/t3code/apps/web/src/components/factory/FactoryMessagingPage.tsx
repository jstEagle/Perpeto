import { useEffect, useRef, useState, type FormEvent } from "react";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useProjects } from "../../state/entities";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { applyMessageWindow, emptyMessageWindow, MESSAGE_PAGE_SIZE, windowMessages, messagingConfig, messagingRequest, type FactoryChannel, type MessagePage } from "./messaging";
import workshopTokens from "../../../../../../../brand/tokens.css?inline";
import "./factory-messaging.css";
import { randomUUID } from "../../lib/utils";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import * as Schema from "effect/Schema";

const messageError = (error: unknown) => error instanceof Error ? error.message : "Request failed. Please retry.";

export function FactoryMessagingPage() {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const [projectKey, setProjectKey] = useState("");
  const project = projects.find((item) => `${item.environmentId}:${item.id}` === projectKey)
    ?? projects.find((item) => item.environmentId === primaryId) ?? projects[0];
  const environment = useEnvironment(project?.environmentId ?? null);
  const connection = usePreparedConnection(project?.environmentId ?? null);
  const canOperate = useEnvironmentScope(project?.environmentId ?? null, AuthOrchestrationOperateScope);
  return <section className="perpeto-messaging" aria-label="Factory messaging">
    <style>{workshopTokens.replace(":root", ".perpeto-messaging")}</style>
    <header className="factory-heading">
      <div><h1>Factory messages</h1><p>{environment?.label ?? "Select an environment"}</p></div>
      <label className="factory-project">Project
        <select value={project ? `${project.environmentId}:${project.id}` : ""} onChange={(event) => setProjectKey(event.target.value)}>
          {!project && <option value="">No projects</option>}
          {projects.map((item) => <option key={`${item.environmentId}:${item.id}`} value={`${item.environmentId}:${item.id}`}>
            {item.title} · {environments.find((entry) => entry.environmentId === item.environmentId)?.label ?? "Environment"}
          </option>)}
        </select>
      </label>
    </header>
    {!project ? <div className="factory-empty">Add a project from the sidebar to start messaging.</div>
      : connection._tag === "None" ? <div className="factory-empty" role="status">Connect this project's environment to read messages.</div>
      : <ProjectMessages key={`${project.environmentId}:${project.id}`} projectId={project.id} projectName={project.title}
          prepared={connection.value} canOperate={canOperate} />}
  </section>;
}

type Prepared = Extract<ReturnType<typeof usePreparedConnection>, { _tag: "Some" }>["value"];
function ProjectMessages({ projectId, projectName, prepared, canOperate }: {
  projectId: string; projectName: string; prepared: Prepared; canOperate: boolean;
}) {
  const [channels, setChannels] = useState<FactoryChannel[]>([]);
  const pendingChannels = useRef(new Map<string, FactoryChannel>());
  const [selectedId, setSelectedId] = useState("");
  const [channelName, setChannelName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const base = `/api/perpeto/projects/${encodeURIComponent(projectId)}`;
  const selected = channels.find((channel) => channel.id === selectedId) ?? channels[0];
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await messagingRequest<{ channels: FactoryChannel[] }>({ prepared, path: `${base}/channels`, signal: controller.signal });
        if (!controller.signal.aborted) {
          for (const channel of result.channels) pendingChannels.current.delete(channel.id);
          setChannels([...result.channels, ...pendingChannels.current.values()]); setError(null);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          if (cause && typeof cause === "object" && "code" in cause && cause.code === "NOT_FOUND") { setChannels([...pendingChannels.current.values()]); setError(null); }
          else setError(messageError(cause));
        }
      }
      finally {
        if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(() => void refresh(), messagingConfig.channelPollIntervalMs); }
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [base, prepared]);
  async function createChannel(event: FormEvent) {
    event.preventDefault();
    if (creating || !channelName.trim()) return;
    setCreating(true); setError(null);
    try {
      const create = () => messagingRequest<FactoryChannel>({ prepared, path: `${base}/channels`, method: "POST", body: { id: channelName.trim(), name: channelName.trim() } });
      let channel: FactoryChannel;
      try { channel = await create(); }
      catch (cause) {
        if (!(cause && typeof cause === "object" && "code" in cause && cause.code === "NOT_FOUND")) throw cause;
        await messagingRequest({ prepared, path: base, method: "PUT", body: { name: projectName } });
        channel = await create();
      }
      pendingChannels.current.set(channel.id, channel);
      setChannels((current) => current.some((item) => item.id === channel.id) ? current : [...current, channel]);
      setSelectedId(channel.id); setChannelName("");
    } catch (cause) { setError(messageError(cause)); }
    finally { setCreating(false); }
  }
  return <div className="factory-workspace">
    <aside className="factory-channels" aria-label="Channels">
      <h2>Channels</h2>
      <nav>{channels.map((channel) => <button key={channel.id} type="button" aria-current={selected?.id === channel.id ? "page" : undefined}
        onClick={() => setSelectedId(channel.id)}><span aria-hidden="true">#</span> {channel.name}</button>)}</nav>
      {loading && <p role="status">Loading channels…</p>}
      {!loading && !channels.length && <p>No channels yet.</p>}
      {canOperate && <form onSubmit={(event) => void createChannel(event)} className="factory-channel-form">
        <label htmlFor="factory-channel-name">New channel</label>
        <input id="factory-channel-name" maxLength={200} value={channelName} onChange={(event) => setChannelName(event.target.value)} placeholder="engineering" required />
        <button type="submit" disabled={creating || !channelName.trim()}>{creating ? "Creating…" : "Create"}</button>
      </form>}
      {error && <p className="factory-error" role="alert">{error}</p>}
    </aside>
    {selected ? <ChannelMessages key={selected.id} prepared={prepared} base={`${base}/channels/${encodeURIComponent(selected.id)}/messages`} name={selected.name} canOperate={canOperate} />
      : <div className="factory-empty">{loading ? "Loading…" : canOperate ? "Create a channel to start a conversation." : "No channels in this project."}</div>}
  </div>;
}

function ChannelMessages({ prepared, base, name, canOperate }: { prepared: Prepared; base: string; name: string; canOperate: boolean }) {
  const [history, setHistory] = useState(emptyMessageWindow);
  const historyRef = useRef(history);
  const messages = windowMessages(history);
  const [historyMode, setHistoryMode] = useState(false);
  const historyModeRef = useRef(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const olderRequest = useRef<AbortController | null>(null);
  const initialized = useRef(false);
  const requestEpoch = useRef(0);
  const [catchingUp, setCatchingUp] = useState(false);
  const [sender, setSender] = useLocalStorage("perpeto.messaging.senderRole", "user", Schema.String);
  const [recipient, setRecipient] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const retry = useRef<{ fingerprint: string; key: string } | null>(null);
  const cursor = useRef<string | null>(null);
  const messageEnd = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  useEffect(() => () => olderRequest.current?.abort(), []);
  useEffect(() => {
    if (historyMode) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const epoch = requestEpoch.current;
      try {
        const newestPage = !initialized.current || cursor.current === null;
        const query = new URLSearchParams({ limit: String(MESSAGE_PAGE_SIZE),
          ...(!newestPage && cursor.current ? { after: cursor.current } : { latest: "true" }),
        });
        const page = await messagingRequest<MessagePage>({ prepared, path: `${base}?${query}`, signal: controller.signal });
        if (controller.signal.aborted || historyModeRef.current || epoch !== requestEpoch.current) return;
        if (!("previousCursor" in page)) throw new Error("Update this environment's Perpeto runtime to read bounded message history.");
        if (!newestPage && page.hasMore && page.nextCursor === cursor.current) throw new Error("Message history stopped advancing. Refresh to the latest messages.");
        const next = applyMessageWindow(historyRef.current, page, newestPage ? "latest" : "newer");
        historyRef.current = next; setHistory(next);
        setCatchingUp(!newestPage && page.hasMore);
        cursor.current = page.nextCursor;
        initialized.current = true;
        setPollError(null);
      } catch (cause) { if (!controller.signal.aborted) setPollError(messageError(cause)); }
      finally {
        if (!controller.signal.aborted && !historyModeRef.current) { setLoading(false); timer = setTimeout(() => void poll(), messagingConfig.messagePollIntervalMs); }
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [base, prepared, refresh, historyMode]);
  function latest() {
    requestEpoch.current += 1;
    olderRequest.current?.abort();
    setOlderLoading(false); setHistoryError(null);
    initialized.current = false; cursor.current = null;
    historyModeRef.current = false; setHistoryMode(false);
    stickToBottom.current = true; setLoading(true); setRefresh((value) => value + 1);
  }
  async function loadOlder() {
    const before = historyRef.current.blocks[0]?.previousCursor;
    if (olderLoading || !before) return;
    requestEpoch.current += 1;
    historyModeRef.current = true; setHistoryMode(true); stickToBottom.current = false;
    const controller = new AbortController(); olderRequest.current = controller;
    setOlderLoading(true); setHistoryError(null);
    try {
      const query = new URLSearchParams({ before, limit: String(MESSAGE_PAGE_SIZE) });
      const page = await messagingRequest<MessagePage>({ prepared, path: `${base}?${query}`, signal: controller.signal });
      if (controller.signal.aborted) return;
      const next = applyMessageWindow(historyRef.current, page, "older");
      historyRef.current = next; setHistory(next);
    } catch (cause) { if (!controller.signal.aborted) setHistoryError(messageError(cause)); }
    finally { if (!controller.signal.aborted) setOlderLoading(false); }
  }
  useEffect(() => { if (stickToBottom.current) messageEnd.current?.scrollIntoView({ block: "nearest" }); }, [messages]);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (sending || !body.trim() || !sender.trim()) return;
    const payload = { senderRoleId: sender.trim(), ...(recipient.trim() ? { recipientRoleId: recipient.trim() } : {}), body };
    const fingerprint = JSON.stringify(payload);
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, key: randomUUID() };
    setSending(true); setError(null);
    try {
      await messagingRequest({ prepared, path: base, method: "POST", body: { ...payload, idempotencyKey: retry.current.key } });
      retry.current = null; setBody(""); latest();
    } catch (cause) { setError(messageError(cause)); }
    finally { setSending(false); }
  }
  return <main className="factory-conversation">
    <header className="factory-channel-heading"><h2><span aria-hidden="true">#</span> {name}</h2><span>{messages.length} displayed</span></header>
    <div className="factory-history-controls">
      <button type="button" onClick={() => void loadOlder()} disabled={!history.hasOlder || olderLoading || loading}>{olderLoading ? "Loading…" : "Load older"}</button>
      <span role="status">{historyMode ? "Earlier messages · live updates paused" : catchingUp ? "Catching up" : "Live"}</span>
      <button type="button" onClick={latest} disabled={loading}>Latest</button>
    </div>
    {historyError && <p className="factory-error factory-message-error" role="alert">{historyError}</p>}
    {(pollError || error) && <div className="factory-error factory-message-error" role="alert">{error ?? pollError}<button type="button" onClick={() => { if (historyMode) latest(); else setRefresh((value) => value + 1); }}>Refresh</button></div>}
    <div className="factory-history" role="log" aria-label={`${name} messages`} aria-busy={loading || olderLoading} onScroll={(event) => {
      const node = event.currentTarget; stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
    }}>
      {loading && !messages.length ? <p className="factory-empty">Loading messages…</p>
        : !messages.length ? <p className="factory-empty">No messages yet.</p> : messages.map((message) => <article key={message.id} className="factory-message">
          <div className="factory-message-avatar" aria-hidden="true">{message.senderRoleId.slice(0, 1)}</div>
          <div className="factory-message-content"><header><strong>{message.senderRoleId}</strong>
            {message.recipientRoleId && <span className="factory-recipient">to {message.recipientRoleId}</span>}
            <time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>{new Date(message.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></header>
            <p>{message.body}</p></div>
        </article>)}
      <div ref={messageEnd} />
    </div>
    {canOperate ? <form className="factory-composer" onSubmit={(event) => void send(event)}>
      <div className="factory-addresses"><label>Send as<input aria-label="Sender role" disabled={sending} value={sender} onChange={(event) => setSender(event.target.value)} maxLength={200} required /></label>
        <label>To<input aria-label="Recipient role" disabled={sending} value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="Everyone" maxLength={200} /></label></div>
      <textarea aria-label="Message" disabled={sending} placeholder={`Message #${name}`} value={body} onChange={(event) => setBody(event.target.value)} maxLength={65536} rows={3} required />
      <footer><span>{recipient.trim() ? `Addressed to ${recipient.trim()} · visible to channel` : "Visible to everyone in this channel"}</span><button type="submit" disabled={sending || !body.trim() || !sender.trim()}>{sending ? "Sending…" : "Send"}</button></footer>
    </form> : <p className="factory-readonly">Your environment grant allows reading only.</p>}
  </main>;
}
