import { describe, expect, it } from 'vitest';
import { DEFAULT_SCHEDULE, describeSchedule, fromCron, isCron, offsetLabel, toCron } from './schedule';
import type { ScheduleSpec } from './schedule';

const spec = (s: Partial<ScheduleSpec>): ScheduleSpec => ({ ...DEFAULT_SCHEDULE, ...s });
const BERLIN = 120;
const NEW_YORK = -240;
const DELHI = 330;

describe('schedule picker', () => {
  it('stores local times as UTC cron', () => {
    expect(toCron(spec({ repeat: 'daily', time: '09:00' }), BERLIN)).toBe('0 7 * * *');
    expect(toCron(spec({ repeat: 'weekdays', time: '09:30' }), 0)).toBe('30 9 * * 1-5');
    expect(toCron(spec({ repeat: 'hourly', minute: 15 }), DELHI)).toBe('45 * * * *');
  });

  it('moves the days when the UTC time falls on another day', () => {
    // 01:00 Monday in Berlin is 23:00 Sunday UTC.
    expect(toCron(spec({ repeat: 'weekly', time: '01:00', day: 1 }), BERLIN)).toBe('0 23 * * 0');
    expect(toCron(spec({ repeat: 'weekdays', time: '01:00' }), BERLIN)).toBe('0 23 * * 0-4');
    // 22:00 Friday in New York is 02:00 Saturday UTC.
    expect(toCron(spec({ repeat: 'weekdays', time: '22:00' }), NEW_YORK)).toBe('0 2 * * 2-6');
    expect(toCron(spec({ repeat: 'weekly', time: '22:00', day: 6 }), NEW_YORK)).toBe('0 2 * * 0');
  });

  it('reads its own cron back', () => {
    for (const offset of [0, BERLIN, NEW_YORK, DELHI]) {
      for (const s of [
        spec({ repeat: 'daily', time: '09:00' }),
        spec({ repeat: 'weekdays', time: '00:30' }),
        spec({ repeat: 'weekdays', time: '23:45' }),
        spec({ repeat: 'weekly', time: '06:15', day: 0 }),
        spec({ repeat: 'weekly', time: '21:00', day: 6 }),
        spec({ repeat: 'hourly', minute: 40 }),
      ]) {
        const back = fromCron(toCron(s, offset), offset);
        expect(back.repeat).toBe(s.repeat);
        if (s.repeat === 'hourly') expect(back.minute).toBe(s.minute);
        else expect(back.time).toBe(s.time);
        if (s.repeat === 'weekly') expect(back.day).toBe(s.day);
      }
    }
  });

  it('keeps anything else as custom cron', () => {
    expect(fromCron('*/15 9-17 * * 1-5', 0).repeat).toBe('custom');
    expect(fromCron('0 9 1 * *', 0).repeat).toBe('custom');
    expect(fromCron('0 9 * * 1,3', 0).repeat).toBe('custom');
    expect(describeSchedule('0 */6 * * *', 0)).toBe('Custom schedule 0 */6 * * * (UTC)');
  });

  it('describes schedules in local time', () => {
    expect(describeSchedule('0 7 * * 1-5', BERLIN)).toBe('Weekdays at 09:00');
    expect(describeSchedule('0 23 * * 0', BERLIN)).toBe('Mondays at 01:00');
    expect(describeSchedule('45 * * * *', DELHI)).toBe('Every hour at :15');
    expect(offsetLabel(DELHI)).toBe('UTC+5:30');
    expect(offsetLabel(NEW_YORK)).toBe('UTC−4');
  });

  it('accepts only five numeric cron fields', () => {
    expect(isCron('0 9 * * 1-5')).toBe(true);
    expect(isCron('*/10 * * * *')).toBe(true);
    expect(isCron('0 9 * *')).toBe(false);
    expect(isCron('0 9 * * MON')).toBe(false);
    expect(isCron('@daily')).toBe(false);
  });
});
