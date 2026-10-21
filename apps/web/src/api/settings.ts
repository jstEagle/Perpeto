import type { HubSettings } from './client';

/**
 * Hub connection settings live in this browser's localStorage, as the task
 * specifies. The owner token is readable by any script on this origin, so
 * serve the app only from an origin you trust.
 */
const KEY = 'perpeto.hub.v1';

export function loadSettings(): HubSettings | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<HubSettings>;
    if (typeof parsed.baseUrl !== 'string' || typeof parsed.token !== 'string' || !parsed.baseUrl || !parsed.token) return null;
    return { baseUrl: parsed.baseUrl, token: parsed.token };
  } catch {
    return null;
  }
}

export function saveSettings(settings: HubSettings | null) {
  if (settings) localStorage.setItem(KEY, JSON.stringify(settings));
  else localStorage.removeItem(KEY);
}

/** Returns an error message, or null when the URL is acceptable. */
export function checkBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Enter a full URL, for example http://localhost:7300.';
  }
  if (!['http:', 'https:'].includes(url.protocol)) return 'Use an http or https URL.';
  if (url.username || url.password) return 'Remove credentials from the URL. Put the token in the token field.';
  if (url.search || url.hash) return 'Remove the query or fragment from the URL.';
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !local) return 'Use HTTPS for a hub that is not on this machine. Plain HTTP would expose the token.';
  return null;
}
