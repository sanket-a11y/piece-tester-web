import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDb } from '../db/schema.js';
import { createSchedule, listSchedules } from '../db/queries.js';

vi.mock('./scheduler.js', () => ({ reloadScheduler: () => {} }));
import { createSchedulesForRun } from './setup-scheduler.js';

describe('createSchedulesForRun', () => {
  beforeEach(() => getDb().exec('DELETE FROM schedules;'));

  it('creates a monthly schedule for each eligible piece with a distinct day, skipping already-scheduled pieces', () => {
    createSchedule({ piece_name: '@ap/piece-b', cron_expression: '0 6 * * *', targets: '[{"piece_name":"@ap/piece-b"}]' });

    const ids = createSchedulesForRun({
      pieceNames: ['@ap/piece-a', '@ap/piece-b', '@ap/piece-c'],
      cadence: 'monthly',
    });

    expect(ids).toHaveLength(2);   // b skipped (already scheduled)
    const all = listSchedules();
    const created = all.filter(s => ids.includes(s.id));
    const days = created.map(s => s.cron_expression.split(' ')[2]).sort();
    expect(days).toEqual(['1', '2']);   // a=day1, c=day2 (round-robin over the eligible set)
    expect(created.every(s => s.piece_name && s.label.startsWith('Auto:'))).toBe(true);
  });

  it('returns [] when cadence is none', () => {
    expect(createSchedulesForRun({ pieceNames: ['@ap/piece-a'], cadence: 'none' })).toEqual([]);
  });
});
