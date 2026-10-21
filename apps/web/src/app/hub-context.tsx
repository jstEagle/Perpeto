import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { HttpHub } from '../api/client';
import type { HubSettings } from '../api/client';
import { DemoHub } from '../api/demo';
import type { HubApi, StreamState } from '../api/hub';
import type { HubEvent } from '../api/types';
import { loadSettings, saveSettings } from '../api/settings';

type Listener = (event: HubEvent) => void;

interface HubContextValue {
  api: HubApi;
  settings: HubSettings | null;
  stream: StreamState;
  connect(settings: HubSettings | null): void;
  /** Subscribe to live events. Returns an unsubscribe function. */
  onEvent(listener: Listener): () => void;
}

const HubContext = createContext<HubContextValue | null>(null);

export function HubProvider({ children, initial }: { children: ReactNode; initial?: HubApi }) {
  const [settings, setSettings] = useState<HubSettings | null>(() => (initial ? null : loadSettings()));
  const api = useMemo<HubApi>(() => initial ?? (settings ? new HttpHub(settings) : new DemoHub()), [settings, initial]);
  const [stream, setStream] = useState<StreamState>('connecting');
  const listeners = useRef(new Set<Listener>());

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | null = null;
    // Start from the newest event so screens don't replay history.
    api
      .events(0, 1)
      .catch(() => [])
      .then((latest) => {
        if (cancelled) return;
        const after = latest.at(-1)?.seq ?? 0;
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
  }, []);

  const onEvent = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const value = useMemo(() => ({ api, settings, stream, connect, onEvent }), [api, settings, stream, connect, onEvent]);
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

/**
 * Loads data from the hub and reloads when a matching live event arrives.
 * `refreshOn` receives each event; return true to refetch (debounced).
 */
export function useResource<T>(load: (api: HubApi) => Promise<T>, deps: unknown[], refreshOn?: (event: HubEvent) => boolean): Resource<T> {
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
    const off = onEvent((event) => {
      if (!refreshRef.current?.(event)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setNonce((n) => n + 1), 250);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [onEvent]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}
