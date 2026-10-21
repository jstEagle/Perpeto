/** Five-field UTC cron. Numeric lists, ranges and steps; day-of-month/day-of-week use cron OR semantics. */
const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
function parse(schedule) {
  if (typeof schedule !== 'string' || schedule.length > 200) throw new Error('Expected a five-field UTC cron expression.');
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Expected a five-field UTC cron expression.');
  return fields.map((field, i) => {
    const [min, max] = bounds[i], values = new Set();
    for (const part of field.split(',')) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      if (!match) throw new Error('Invalid cron field.');
      const stride = match[2] === undefined ? 1 : Number(match[2]);
      const range = match[1] === '*' ? [min, max] : match[1].split('-').map(Number);
      const [from, to = match[2] ? max : from] = range;
      if (!Number.isSafeInteger(stride) || stride < 1 || stride > max - min + 1 || from < min || to > max || from > to) throw new Error('Cron field out of range.');
      for (let n = from; n <= to; n += stride) values.add(n);
    }
    return { values, wildcard: field === '*' };
  });
}
export function validSchedule(value) { try { parse(value); return true; } catch { return false; } }
export function scheduleMatches(schedule, at) {
  const fields = parse(schedule), date = new Date(at);
  const values = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()];
  const matches = fields.map((field, i) => field.values.has(values[i]));
  const days = fields[2].wildcard || fields[4].wildcard ? matches[2] && matches[4] : matches[2] || matches[4];
  return matches[0] && matches[1] && matches[3] && days;
}
