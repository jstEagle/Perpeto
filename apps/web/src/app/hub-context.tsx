import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { HttpHub } from '../api/client';
import type { HubSettings } from '../api/client';
import { DemoHub } from '../api/demo';
import type { DemoScenario } from '../api/demo';
import type { HubApi, StreamState } from '../api/hub';
import type { HubEvent } from '../api/types';
import { loadDemoScenario, loadSettings, saveDemoScenario, saveSettings } from '../api/settings';

type Listener = (event: HubEvent) => void;

interface HubContextValue {
  api: HubApi;
  settings: HubSettings | null;
  /** A hub whose tab-only token or cookie session ended; Settings asks for the token again. */
  reconnect?: string;
  stream: StreamState;
  connect(settings: HubSettings | null): void;
  /** Which demo factory shows while no hub is connected. */
  demo: DemoScenario;
  setDemo(scenario: DemoScenario): void;
  /** Subscribe to live events. Returns an unsubscribe function. */
  onEvent(listener: Listener): () => void;
}

const HubContext = createContext<HubContextValue | null>(null);

export function HubProvider({ children, initial }: { children: ReactNode; initial?: HubApi }) {
  const [loaded] = useState(() => (initial ? { settings: null } : loadSettings()));
  const [settings, setSettings] = useState<HubSettings | null>(loaded.settings);
  const [reconnect, setReconnect] = useState<string | undefined>(loaded.reconnect);
  const [demo, setDemoState] = useState<DemoScenario>(() => loadDemoScenario());
  const api = useMemo<HubApi>(() => initial ?? (settings ? new HttpHub(settings) : new DemoHub(Date.now(), demo)), [settings, initial, demo]);
  const setDemo = useCallback((scenario: DemoScenario) => {
    saveDemoScenario(scenario);
    setDemoState(scenario);
  }, []);

  // A cookie session can expire while nothing is stored here; check it once.
  useEffect(() => {
    if (!(api instanceof HttpHub) || settings?.auth.kind !== 'cookie') return;
    let cancelled = false;
    void api
      .hasSession()
      .then((ok) => {
        if (ok || cancelled) return;
        saveSettings(null);
        setReconnect(settings.baseUrl);
        setSettings(null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, settings]);
  const [stream, setStream] = useState<StreamState>('connecting');
  const listeners = useRef(new Set<Listener>());

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | null = null;
    // Start from the newest event so screens don't replay history.
    api
      .latestSeq()
      .catch(() => 0)
      .then((after) => {
        if (cancelled) return;
        stop = api.subscribe(
          after,
          (event) => listeners.current.forEach((l) => l(event)),
          (state) => !cancelled && setStream(state),
        );
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [api]);

  const connect = useCallback((next: HubSettings | null) => {
    saveSettings(next);
    setSettings(next);
    setReconnect(undefined);
  }, []);

  const onEvent = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const value = useMemo(() => ({ api, settings, reconnect, stream, connect, onEvent, demo, setDemo }), [api, settings, reconnect, stream, connect, onEvent, demo, setDemo]);
  return <HubContext.Provider value={value}>{children}</HubContext.Provider>;
}

export function useHub(): HubContextValue {
  const value = useContext(HubContext);
  if (!value) throw new Error('useHub must be used inside HubProvider');
  return value;
}

export interface Resource<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload(): void;
}

export interface Refresh {
  /** Quiet time after the last matching event before refetching. */
  debounceMs?: number;
  /** Refetch at least this often while matching events keep arriving. */
  maxWaitMs?: number;
}

/**
 * Loads data from the hub and reloads when a matching live event arrives.
 * `refreshOn` receives each event; return true to refetch. Bursts are
 * debounced, with a ceiling so a busy stream still refreshes. Data stays on
 * screen while a refetch runs.
 */
export function useResource<T>(load: (api: HubApi) => Promise<T>, deps: unknown[], refreshOn?: (event: HubEvent) => boolean, refresh: Refresh = {}): Resource<T> {
  const { debounceMs = 250, maxWaitMs = 2000 } = refresh;
  const { api, onEvent } = useHub();
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const refreshRef = useRef(refreshOn);
  refreshRef.current = refreshOn;

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    loadRef
      .current(api)
      .then((data) => !cancelled && setState({ data, loading: false }))
      .catch((error: Error) => !cancelled && setState((s) => ({ data: s.data, error, loading: false })));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, nonce, ...deps]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let first = 0;
    const fire = () => {
      timer = null;
      first = 0;
      setNonce((n) => n + 1);
    };
    const off = onEvent((event) => {
      if (!refreshRef.current?.(event)) return;
      const now = Date.now();
      first ||= now;
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, Math.max(0, Math.min(debounceMs, first + maxWaitMs - now)));
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [onEvent, debounceMs, maxWaitMs]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}
