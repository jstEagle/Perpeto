import { useState } from 'react';
import { HttpHub } from '../api/client';
import { checkBaseUrl, defaultHubUrl } from '../api/settings';
import { useHub } from '../app/hub-context';
import { Button, Field, PageHeader, Panel } from '../components/ui';
import { StatusLabel } from '../components/status';
import { IconAlert } from '../components/icons';

export function SettingsPage() {
  const { api, settings, reconnect, connect } = useHub();
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl ?? reconnect ?? defaultHubUrl());
  const [token, setToken] = useState('');
  const [show, setShow] = useState(false);
  const [test, setTest] = useState<{ tone: 'done' | 'failed' | 'waiting'; text: string } | null>(null);
  const [touched, setTouched] = useState(false);

  const urlError = touched ? checkBaseUrl(baseUrl.trim()) : null;
  const tokenError = touched && !token.trim() ? 'Enter the owner token.' : null;
  const tabOnly = settings?.auth.kind === 'bearer';

  async function testConnection() {
    setTouched(true);
    if (checkBaseUrl(baseUrl.trim()) || !token.trim()) return false;
    setTest({ tone: 'waiting', text: 'Checking the hub…' });
    const hub = new HttpHub({ baseUrl: baseUrl.trim(), auth: { kind: 'bearer', token: token.trim() } });
    try {
      const health = await hub.health();
      await hub.overview();
      setTest({ tone: 'done', text: `Connected. Hub version ${health.version}, token accepted.` });
      return true;
    } catch (err) {
      setTest({ tone: 'failed', text: `Could not connect. ${(err as Error).message}` });
      return false;
    }
  }

  /** Prefer an HttpOnly session cookie; keep the token for this tab only if the hub cannot set one. */
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!(await testConnection())) return;
    const url = baseUrl.trim().replace(/\/+$/, '');
    try {
      const cookie = await HttpHub.startSession(url, token.trim());
      connect({ baseUrl: url, auth: cookie ? { kind: 'cookie' } : { kind: 'bearer', token: token.trim() } });
      // The token is no longer needed here; an empty field after connecting is not an error.
      setToken('');
      setTouched(false);
    } catch (err) {
      setTest({ tone: 'failed', text: `Could not start a session. ${(err as Error).message}` });
    }
  }

  async function disconnect() {
    if (api instanceof HttpHub) await api.endSession();
    connect(null);
    setToken('');
    setTest(null);
  }

  return (
    <div className="page settings-page">
      <PageHeader title="Settings" description="Connect this browser to your factory hub." />
      <Panel title="Hub connection" actions={api.mode === 'demo' ? <StatusLabel tone="quiet">Showing demo data</StatusLabel> : <StatusLabel tone="done">Connected</StatusLabel>}>
        <form className="form" onSubmit={save} noValidate>
          <Field label="Hub URL" htmlFor="hub-url" error={urlError} hint="The hub’s address. HTTPS is required unless the hub runs on this machine.">
            <input id="hub-url" className="input mono-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} autoComplete="url" aria-invalid={!!urlError} />
          </Field>
          <Field
            label="Owner token"
            htmlFor="hub-token"
            error={tokenError}
            hint="The hub keeps it in .perpeto/hub/owner.secret. This browser asks the hub for a session cookie and does not store the token. If the hub cannot set one, the token stays in this tab until you close it."
          >
            <div className="input-row">
              <input
                id="hub-token"
                className="input mono-input"
                type={show ? 'text' : 'password'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!tokenError}
              />
              <Button type="button" onClick={() => setShow((s) => !s)} aria-pressed={show}>
                {show ? 'Hide' : 'Show'}
              </Button>
            </div>
          </Field>
          {reconnect && !settings && (
            <p className="note" role="status">
              The session with <span className="mono">{new URL(reconnect).host}</span> ended. Enter the owner token to connect again.
            </p>
          )}
          {tabOnly && (
            <div className="callout" role="note">
              <IconAlert />
              <div className="callout-body">
                <span className="callout-title">The token is kept in this tab only.</span>
                <span>This hub has no session route, so it cannot set a session cookie. The token sits in session storage until the tab closes, and scripts running on this page’s origin can read it. Update the hub, or serve the app only from an origin you trust.</span>
              </div>
            </div>
          )}
          {test && (
            <p role="status">
              <StatusLabel tone={test.tone}>{test.text}</StatusLabel>
            </p>
          )}
          <div className="row form-actions">
            <Button variant="primary" type="submit">
              Save and connect
            </Button>
            <Button type="button" onClick={() => void testConnection()}>
              Test connection
            </Button>
            {settings && (
              <Button type="button" variant="ghost" onClick={() => void disconnect()}>
                Disconnect and use demo data
              </Button>
            )}
          </div>
        </form>
      </Panel>
      <Panel title="About demo data">
        <p className="muted reading">
          Without a hub, Perpeto shows a built-in example factory: three projects, two machines and a running build whose reviewer is the bottleneck. Changes you make in demo mode stay in this tab and reset on reload. Nothing is sent anywhere.
        </p>
      </Panel>
    </div>
  );
}
