/**
 * The friendly schedule picker and the hub's numeric UTC cron. People pick a
 * local time; the hub stores five UTC fields. A schedule this picker cannot
 * express stays as custom cron text.
 */

export type Repeat = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom';

export interface ScheduleSpec {
  repeat: Repeat;
  /** Local `HH:MM`, for daily, weekdays and weekly. */
  time: string;
  /** Minute past each hour, for hourly. */
  minute: number;
  /** Local day of the week, 0 Sunday, for weekly. */
  day: number;
  /** Raw UTC cron, for custom. */
  cron: string;
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Minutes the browser's clock is ahead of UTC right now. */
export const localOffset = () => -new Date().getTimezoneOffset();

export const DEFAULT_SCHEDULE: ScheduleSpec = { repeat: 'weekdays', time: '09:00', minute: 0, day: 1, cron: '0 9 * * 1-5' };

const mod = (n: number, m: number) => ((n % m) + m) % m;
const pad = (n: number) => String(n).padStart(2, '0');
const FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;

/** Five numeric cron fields with lists, ranges and steps; the hub checks the ranges. */
export function isCron(text: string): boolean {
  const fields = text.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => FIELD.test(f));
}

/** Days as cron: a run of consecutive days as a range, otherwise a list. */
function dayField(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const consecutive = sorted.length > 2 && sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  return consecutive ? `${sorted[0]}-${sorted[sorted.length - 1]}` : sorted.join(',');
}

function parseDays(field: string): number[] | null {
  const days: number[] = [];
  for (const part of field.split(',')) {
    const m = /^(\d)(?:-(\d))?$/.exec(part);
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from > 7 || to > 7 || to < from) return null;
    for (let d = from; d <= to; d++) days.push(d % 7);
  }
  return [...new Set(days)];
}

export function toCron(spec: ScheduleSpec, offset = localOffset()): string {
  if (spec.repeat === 'custom') return spec.cron.trim().replace(/\s+/g, ' ');
  if (spec.repeat === 'hourly') return `${mod(spec.minute - offset, 60)} * * * *`;
  const [h, m] = spec.time.split(':').map(Number);
  const utc = h * 60 + m - offset;
  const shift = Math.floor(utc / 1440);
  const at = mod(utc, 1440);
  const head = `${at % 60} ${Math.floor(at / 60)} * *`;
  if (spec.repeat === 'daily') return `${head} *`;
  const local = spec.repeat === 'weekdays' ? [1, 2, 3, 4, 5] : [spec.day];
  return `${head} ${dayField(local.map((d) => mod(d + shift, 7)))}`;
}

/** The picker's reading of a UTC cron; anything else is custom. */
export function fromCron(cron: string | undefined, offset = localOffset()): ScheduleSpec {
  if (!cron) return { ...DEFAULT_SCHEDULE, cron: toCron(DEFAULT_SCHEDULE, offset) };
  const custom: ScheduleSpec = { ...DEFAULT_SCHEDULE, repeat: 'custom', cron };
  const [min, hour, dom, mon, dow] = cron.trim().split(/\s+/);
  if (!isCron(cron) || dom !== '*' || mon !== '*' || !/^\d+$/.test(min) || Number(min) > 59) return custom;
  if (hour === '*') return dow === '*' ? { ...custom, repeat: 'hourly', minute: mod(Number(min) + offset, 60) } : custom;
  if (!/^\d+$/.test(hour) || Number(hour) > 23) return custom;
  const local = Number(hour) * 60 + Number(min) + offset;
  const shift = Math.floor(local / 1440);
  const at = mod(local, 1440);
  const time = `${pad(Math.floor(at / 60))}:${pad(at % 60)}`;
  if (dow === '*') return { ...custom, repeat: 'daily', time };
  const days = parseDays(dow)?.map((d) => mod(d + shift, 7));
  if (!days) return custom;
  if (days.length === 1) return { ...custom, repeat: 'weekly', time, day: days[0] };
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return { ...custom, repeat: 'weekdays', time };
  return custom;
}

/** "Weekdays at 09:00", in local time. */
export function describeSchedule(cron: string | undefined, offset = localOffset()): string {
  if (!cron) return 'No schedule';
  const spec = fromCron(cron, offset);
  switch (spec.repeat) {
    case 'hourly':
      return `Every hour at :${pad(spec.minute)}`;
    case 'daily':
      return `Every day at ${spec.time}`;
    case 'weekdays':
      return `Weekdays at ${spec.time}`;
    case 'weekly':
      return `${DAY_NAMES[spec.day]}s at ${spec.time}`;
    default:
      return `Custom schedule ${cron} (UTC)`;
  }
}

/** "UTC+2", "UTC−5", "UTC+5:30". */
export function offsetLabel(offset = localOffset()): string {
  if (offset === 0) return 'UTC';
  const sign = offset > 0 ? '+' : '−';
  const abs = Math.abs(offset);
  return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${pad(abs % 60)}` : ''}`;
}
