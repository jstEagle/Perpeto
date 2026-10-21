const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en');

export function tokens(n: number): string {
  return n < 10_000 ? whole.format(n) : compact.format(n);
}

export function count(n: number): string {
  return whole.format(n);
}

export function pct(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—';
  return `${Math.round(ratio * 100)}%`;
}

export function rate(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toFixed(digits).replace(/\.0$/, '');
}

/** Seconds as "45 s", "14 min", "6.4 h", "2.1 d". */
export function duration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return '—';
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86_400) return `${rate(sec / 3600)} h`;
  return `${rate(sec / 86_400)} d`;
}

export function relative(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const diff = (now - new Date(iso).getTime()) / 1000;
  if (Number.isNaN(diff)) return '—';
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < 60) return 'in under a minute';
    return `in ${duration(ahead)}`;
  }
  if (diff < 10) return 'just now';
  if (diff < 60) return `${Math.round(diff)} s ago`;
  return `${duration(diff)} ago`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function day(isoDay: string): string {
  return new Date(`${isoDay}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : '—';
}

export function prNumber(url: string | undefined): string {
  const m = url?.match(/\/pull\/(\d+)/);
  return m ? `#${m[1]}` : url ?? '—';
}

export function repoName(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '');
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}
