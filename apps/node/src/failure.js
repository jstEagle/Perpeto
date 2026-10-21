const MAX_REASON = 1000;

/** Only message/code are public, never stack, cause or arbitrary adapter properties. */
export function sanitizeFailure(error, { literals = [], patterns = [] } = {}) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? `${error.code}: ` : '';
  let message = typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : 'Executor threw an unknown error.';
  // Do not truncate a secret before masking it, or retain unbounded adapter output.
  if (message.length > 16000) message = 'Executor error message exceeded the diagnostic limit.';
  message = code + message;
  for (const literal of literals.filter(value => typeof value === 'string' && value).sort((a, b) => b.length - a.length)) {
    message = message.split(literal).join('[REDACTED]');
  }
  for (const pattern of patterns) message = message.replace(new RegExp(pattern, 'g'), '[REDACTED]');
  message = message
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*/gi, '[REDACTED]')
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, '[REDACTED URL]')
    .replace(/\b(?:authorization|cookie|set-cookie)\s*:[^\r\n]*/gi, '[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, '[REDACTED]')
    .replace(/(["']?\b(?:[\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)[\w-]*)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_|pa1_|cka_|pm1_|eyJ)[A-Za-z0-9_.-]+/g, '[REDACTED]')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (message || 'Executor failed.').slice(0, MAX_REASON);
}
