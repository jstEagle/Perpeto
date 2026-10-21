import { useState } from 'react';
import { HttpHub } from '../api/client';
import { checkBaseUrl } from '../api/settings';
import { useHub } from '../app/hub-context';
import { Button, Field, PageHeader, Panel } from '../components/ui';
import { StatusLabel } from '../components/status';

export function SettingsPage() {
  const { api, settings, connect } = useHub();
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl ?? 'http://localhost:7300');
  const [token, setToken] = useState(settings?.token ?? '');
  const [show, setShow] = useState(false);
  const [test, setTest] = useState<{ tone: 'success' | 'error' | 'accent'; text: string } | null>(null);
  const [touched, setTouched] = useState(false);

  const urlError = touched ? checkBaseUrl(baseUrl.trim()) : null;
  const tokenError = touched && !token.trim() ? 'Enter the owner token.' : null;

  async function testConnection() {
    setTouched(true);
    if (checkBaseUrl(baseUrl.trim()) || !token.trim()) return false;
    setTest({ tone: 'accent', text: 'Checking the hub…' });
    const hub = new HttpHub({ baseUrl: baseUrl.trim(), token: token.trim() });
    try {
      const health = await hub.health();
      await hub.overview();
      setTest({ tone: 'success', text: `Connected. Hub version ${health.version}, token accepted.` });
      return true;
    } catch (err) {
      setTest({ tone: 'error', text: `Could not connect. ${(err as Error).message}` });
      return false;
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (await testConnection()) connect({ baseUrl: baseUrl.trim().replace(/\/+$/, ''), token: token.trim() });
  }

  return (
    <div className="page settings-page">
      <PageHeader title="Settings" description="Connect this browser to your factory hub." />
      <Panel title="Hub connection" actions={api.mode === 'demo' ? <StatusLabel tone="neutral">Showing demo data</StatusLabel> : <StatusLabel tone="success">Connected</StatusLabel>}>
        <form className="form" onSubmit={save} noValidate>
          <Field label="Hub URL" htmlFor="hub-url" error={urlError} hint="The hub’s address. HTTPS is required unless the hub runs on this machine.">
            <input id="hub-url" className="input mono-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} autoComplete="url" aria-invalid={!!urlError} />
          </Field>
          <Field label="Owner token" htmlFor="hub-token" error={tokenError} hint="Stored in this browser’s local storage so you stay connected. Anyone with access to this browser profile can read it.">
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
          {test && (
            <p role="status">
              <StatusLabel tone={test.tone}>{test.text}</StatusLabel>
            </p>
          )}
          <div className="row">
            <Button variant="primary" type="submit">
              Save and connect
            </Button>
            <Button type="button" onClick={() => void testConnection()}>
              Test connection
            </Button>
            {settings && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  connect(null);
                  setToken('');
                  setTest(null);
                }}
              >
                Disconnect and use demo data
              </Button>
            )}
          </div>
        </form>
      </Panel>
      <Panel title="About demo data">
        <p className="muted">
          Without a hub, Perpeto shows a built-in example factory: three projects, two machines and a running build whose reviewer is the bottleneck. Changes you make in demo mode stay in this tab and reset on reload. Nothing is sent anywhere.
        </p>
      </Panel>
    </div>
  );
}
