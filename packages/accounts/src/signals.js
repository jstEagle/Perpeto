/** Sanitized observations only. Input messages are never returned or retained. */
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const finite = value => typeof value === 'number' && Number.isFinite(value);
const permittedOverage = info => info.overageStatus === 'allowed' || info.overageStatus === 'allowed_warning'
  || info.isUsingOverage === true || info.overageInUse === true;
const iso = value => {
  const ms = typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 && ms < 8.64e15 ? new Date(ms).toISOString() : undefined;
};

function payload(message) {
  const root = object(message);
  return object(root.params ?? root.data ?? root);
}

const KINDS = ['session', 'weekly', 'monthly', 'other'];
/** Window length in minutes when known, from T3 (`windowDurationMins`) or a native field. */
const minutes = value => Number.isSafeInteger(value) && value > 0 && value <= 527040 ? value : undefined;
/** T3's kind, else inferred from the length, else from the provider's stable id (five_hour, seven_day…, primary/secondary). */
export function kindOf(id, kind, windowMins) {
  if (KINDS.includes(kind)) return kind;
  if (windowMins) return windowMins <= 1440 ? 'session' : windowMins <= 11520 ? 'weekly' : 'monthly';
  if (/^(?:five_hour|primary|session)/.test(id)) return 'session';
  if (/^(?:seven_day|secondary|week)/.test(id)) return 'weekly';
  return 'other';
}
/** Display text only; never a credential. Control characters are dropped and the length bounded. */
const label = (value, fallback) => {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '';
  return text || fallback;
};
/** Kind and label appear only when the update states or implies them, so a sparse update keeps earlier ones. */
function window(id, usedPercent, { kind, label: name, resetsAt, windowMins, ...extra } = {}) {
  const length = minutes(windowMins);
  const reset = iso(resetsAt);
  const text = label(name, '');
  return { id, ...(KINDS.includes(kind) || length ? { kind: kindOf(id, kind, length) } : {}), ...(text ? { label: text } : {}),
    usedPercent: Math.min(100, Math.max(0, usedPercent)), ...(reset ? { resetsAt: reset } : {}), ...(length ? { windowMins: length } : {}), ...extra };
}

/**
 * Native notifications and T3 ProviderUsageLimitsUpdate windows (sparse). Each window keeps only its id, kind, label,
 * used percentage, reset time and length.
 */
export function usageWindows(provider, message) {
  const data = payload(message);
  if (Array.isArray(data.windows)) {
    return data.windows.flatMap(item => {
      if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id)
          || !finite(item.usedPercent)) return [];
      return [window(item.id, item.usedPercent, { kind: item.kind, label: item.label, resetsAt: item.resetsAt,
        windowMins: item.windowDurationMins ?? item.windowMins })];
    });
  }
  if (provider === 'codex') {
    const limits = object(data.rateLimits ?? data);
    if (limits.limitId && limits.limitId !== 'codex') return [];
    return ['primary', 'secondary'].flatMap(id => {
      const item = object(limits[id]);
      if (!finite(item.usedPercent)) return [];
      return [window(id, item.usedPercent, { resetsAt: item.resetsAt, windowMins: item.windowDurationMins ?? item.windowMinutes })];
    });
  }
  if (provider === 'claudeAgent') {
    const info = object(data.rate_limit_info);
    if (typeof info.rateLimitType !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(info.rateLimitType)
        || !finite(info.utilization)) return [];
    return [window(info.rateLimitType, info.utilization * 100, { resetsAt: info.resetsAt, overageAllowed: permittedOverage(info) })];
  }
  return [];
}

/** @returns {{kind:'auth-failure'}|{kind:'rate-limit', cooldownUntil?:string}|null} */
export function detectProviderSignal(provider, message, { now = Date.now(), windows, defaultCooldownMs = 300_000 } = {}) {
  if (!['claudeAgent', 'codex'].includes(provider)) return null;
  const data = payload(message);
  const failure = object(data.failure ?? data.turn?.error ?? data.error ?? data);
  const codexInfo = failure.codexErrorInfo;
  const nativeCode = typeof codexInfo === 'string' ? codexInfo : Object.keys(object(codexInfo))[0];
  const code = nativeCode ?? failure.code ?? data.code ?? data.error;
  const status = failure.status ?? data.api_error_status ?? data.error_status ?? data.status;
  const text = typeof message === 'string' ? message
    : typeof failure.message === 'string' ? failure.message : typeof data.message === 'string' ? data.message : '';
  if (status === 403 || code === 'api_error_403' || failure.class === 'permission_error') return null;
  if (status === 401 || ['authentication_failed', 'api_error_401', 'invalid_grant', 'unauthorized', 'auth_required'].includes(code)
      || /^(?:Claude could not authenticate|Not logged in|Your authentication token has been invalidated)\b/i.test(text)) {
    return { kind: 'auth-failure' };
  }
  const info = object(data.rate_limit_info);
  const overage = permittedOverage(info);
  // A Claude warning or permitted overage must never trigger rotation.
  if (data.type === 'rate_limit_event' && (overage || info.status !== 'rejected')) return null;
  const limits = object(data.rateLimits ?? data);
  if (provider === 'codex' && limits.limitId && limits.limitId !== 'codex') return null;
  const exhausted = (windows ?? usageWindows(provider, message)).filter(window =>
    !window.overageAllowed && window.usedPercent >= 100 && (!window.resetsAt || Date.parse(window.resetsAt) > now));
  const limited = failure.class === 'usage_limit' || status === 429
    || ['rate_limit', 'rate_limit_error', 'api_error_429', 'usageLimitExceeded', 'rateLimitExceeded'].includes(code)
    || (provider === 'claudeAgent' && (info.status === 'rejected' && !overage || data.terminal_reason === 'blocking_limit'))
    || exhausted.length > 0
    || /^(?:Claude API rate limit reached|Codex usage limit reached|You(?:'ve| have) (?:hit|reached) your usage limit)\b/i.test(text)
    || /\brate_limit_error\b/.test(text);
  if (!limited) return null;
  const candidates = [iso(failure.resetAt ?? data.resetAt), iso(info.resetsAt),
    ...exhausted.map(window => window.resetsAt)].filter(value => value && Date.parse(value) > now);
  const retryAfter = failure.retryAfterSeconds ?? data.retry_after;
  if (finite(retryAfter) && retryAfter > 0 && now + retryAfter * 1000 < 8.64e15) candidates.push(new Date(now + retryAfter * 1000).toISOString());
  // Claude's observed nested proxy format: (reset after 1h 2m 3s).
  const duration = /\(reset after (?:(\d+)h ?)?(?:(\d+)m ?)?(?:(\d+)s)?\)/.exec(text);
  if (duration) {
    const ms = ((Number(duration[1] ?? 0) * 60 + Number(duration[2] ?? 0)) * 60 + Number(duration[3] ?? 0)) * 1000;
    if (ms > 0 && now + ms < 8.64e15) candidates.push(new Date(now + ms).toISOString());
  }
  // A known short window must not hide another exhausted window without a reset.
  if (candidates.length && exhausted.some(window => !window.resetsAt)
      && finite(defaultCooldownMs) && defaultCooldownMs > 0 && now + defaultCooldownMs < 8.64e15) {
    candidates.push(new Date(now + defaultCooldownMs).toISOString());
  }
  const cooldownUntil = candidates.length ? candidates.sort().at(-1) : undefined;
  return { kind: 'rate-limit', ...(cooldownUntil ? { cooldownUntil } : {}) };
}

export const detectClaudeSignal = (message, options) => detectProviderSignal('claudeAgent', message, options);
export const detectCodexSignal = (message, options) => detectProviderSignal('codex', message, options);
