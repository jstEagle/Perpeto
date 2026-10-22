import type { HubSettings } from './client';

/**
 * Where the hub connection lives in this browser.
 *
 * The owner token is never written to localStorage. Preferred: the hub sets
 * an HttpOnly session cookie (POST /api/v1/session), so scripts on this
 * origin cannot read any credential and only `{ baseUrl, auth: 'cookie' }`
 * is remembered. Only a hub without that route gets the fallback: the token
 * in sessionStorage, gone when the tab closes but readable by any script on
 * this origin while it is open. A hub with the route never falls back.
 */
const CONFIG_KEY = 'perpeto.hub.v2';
const TOKEN_KEY = 'perpeto.hub.token';
/** Earlier builds kept the token here. Moved to session storage on first load. */
const LEGACY_KEY = 'perpeto.hub.v1';

interface StoredConfig {
  baseUrl: string;
  auth: 'cookie' | 'session';
}

export interface LoadedSettings {
  settings: HubSettings | null;
  /** A hub this browser used before whose token or session is gone; ask for the token again. */
  reconnect?: string;
}

function readConfig(): StoredConfig | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? 'null') as Partial<StoredConfig> | null;
    if (!parsed || typeof parsed.baseUrl !== 'string' || !parsed.baseUrl || (parsed.auth !== 'cookie' && parsed.auth !== 'session')) return null;
    return { baseUrl: parsed.baseUrl, auth: parsed.auth };
  } catch {
    return null;
  }
}

function migrateLegacy() {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    localStorage.removeItem(LEGACY_KEY);
    const parsed = JSON.parse(raw) as { baseUrl?: unknown; token?: unknown };
    if (typeof parsed.baseUrl !== 'string' || !parsed.baseUrl) return;
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ baseUrl: parsed.baseUrl, auth: 'session' } satisfies StoredConfig));
    if (typeof parsed.token === 'string' && parsed.token) sessionStorage.setItem(TOKEN_KEY, parsed.token);
  } catch {
    /* storage unavailable */
  }
}

export function loadSettings(): LoadedSettings {
  migrateLegacy();
  const config = readConfig();
  if (!config) return { settings: null };
  if (config.auth === 'cookie') return { settings: { baseUrl: config.baseUrl, auth: { kind: 'cookie' } } };
  const token = sessionStorage.getItem(TOKEN_KEY);
  return token ? { settings: { baseUrl: config.baseUrl, auth: { kind: 'bearer', token } } } : { settings: null, reconnect: config.baseUrl };
}

export function saveSettings(settings: HubSettings | null) {
  sessionStorage.removeItem(TOKEN_KEY);
  if (!settings) {
    localStorage.removeItem(CONFIG_KEY);
    return;
  }
  const config: StoredConfig = { baseUrl: settings.baseUrl, auth: settings.auth.kind === 'cookie' ? 'cookie' : 'session' };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  if (settings.auth.kind === 'bearer') sessionStorage.setItem(TOKEN_KEY, settings.auth.token);
}

/**
 * The local hub at the default port, on the same loopback name as this
 * page: the hub's SameSite=Strict cookie treats `localhost` and
 * `127.0.0.1` as different sites.
 */
export function defaultHubUrl(host = typeof location === 'undefined' ? 'localhost' : location.hostname): string {
  return `http://${host === '127.0.0.1' ? '127.0.0.1' : 'localhost'}:4320`;
}

/** Returns an error message, or null when the URL is acceptable. */
export function checkBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Enter a full URL, for example http://127.0.0.1:4320.';
  }
  if (!['http:', 'https:'].includes(url.protocol)) return 'Use an http or https URL.';
  if (url.username || url.password) return 'Remove credentials from the URL. Put the token in the token field.';
  if (url.search || url.hash) return 'Remove the query or fragment from the URL.';
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !local) return 'Use HTTPS for a hub that is not on this machine. Plain HTTP would expose the token.';
  return null;
}

/** Which demo factory to show without a hub: the full one or observe only. */
const DEMO_KEY = 'perpeto.demo';
export type StoredDemoScenario = 'full' | 'observe';

/** `?demo=observe` or `?demo=full` in the address switches and remembers it. */
export function loadDemoScenario(search = typeof location === 'undefined' ? '' : location.search): StoredDemoScenario {
  const fromUrl = new URLSearchParams(search).get('demo');
  if (fromUrl === 'observe' || fromUrl === 'full') {
    saveDemoScenario(fromUrl);
    return fromUrl;
  }
  try {
    return localStorage.getItem(DEMO_KEY) === 'observe' ? 'observe' : 'full';
  } catch {
    return 'full';
  }
}

export function saveDemoScenario(scenario: StoredDemoScenario) {
  try {
    localStorage.setItem(DEMO_KEY, scenario);
  } catch {
    /* storage unavailable */
  }
}
