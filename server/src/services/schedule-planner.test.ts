import { describe, it, expect } from 'vitest';
import { assignDaysOfMonth, buildCron, buildScheduleConfig } from './schedule-planner.js';

describe('schedule-planner', () => {
  it('assigns a distinct day-of-month per piece, wrapping after 28', () => {
    const days = assignDaysOfMonth(['a', 'b', 'c']);
    expect([days.get('a'), days.get('b'), days.get('c')]).toEqual([1, 2, 3]);
  });

  it('wraps past 28 pieces back to day 1', () => {
    const names = Array.from({ length: 30 }, (_, i) => `p${i}`);
    const days = assignDaysOfMonth(names);
    expect(days.get('p0')).toBe(1);
    expect(days.get('p27')).toBe(28);
    expect(days.get('p28')).toBe(1);   // wrap
    expect(days.get('p29')).toBe(2);
  });

  it('builds a monthly cron for a given day at the default hour', () => {
    expect(buildCron('monthly', { day: 5 })).toBe('0 3 5 * *');
  });

  it('builds crons for other cadences', () => {
    expect(buildCron('daily')).toBe('0 3 * * *');
    expect(buildCron('weekly')).toBe('0 3 * * 1');
    expect(buildCron('6h')).toBe('0 */6 * * *');
    expect(buildCron('custom', { custom: '15 2 * * 0' })).toBe('15 2 * * 0');
    expect(buildCron('none')).toBe('');
  });

  it('builds a Schedules-page config object for monthly', () => {
    expect(buildScheduleConfig('monthly', { day: 5 })).toEqual({
      frequency: 'monthly', minute: 0, hour: 3, dayOfWeek: 1, dayOfMonth: 5,
    });
  });
});
