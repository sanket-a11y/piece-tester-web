import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './schema.js';
import {
  createSetupRun, addSetupRunItems, updateSetupRunItem,
  finalizeSetupRun, getSetupRun, getSetupRunItem, listSetupRunItems, listSetupRuns,
} from './queries.js';

describe('setup-run queries', () => {
  beforeEach(() => getDb().exec('DELETE FROM setup_run_items; DELETE FROM setup_runs;'));

  it('creates a running run, adds items, updates them, and finalizes rollups', () => {
    const run = createSetupRun({ cadence: 'monthly', cron_template: '0 3 * * *', config: '{"scheduleEnabled":true}' });
    expect(run.status).toBe('running');

    const items = addSetupRunItems(run.id, [
      { piece_name: 'p1', piece_display_name: 'P1', target_type: 'action', target_name: 'a1', target_display_name: 'A1', status: 'pending' },
      { piece_name: 'p1', piece_display_name: 'P1', target_type: 'trigger', target_name: 't1', target_display_name: 'T1', status: 'pending' },
      { piece_name: 'p2', piece_display_name: 'P2', target_type: 'action', target_name: 'a2', target_display_name: 'A2', status: 'skipped' },
    ]);
    expect(items).toHaveLength(3);
    expect(items[0].id).toBeGreaterThan(0);

    updateSetupRunItem(items[0].id, { status: 'done', plan_id: 42 });
    updateSetupRunItem(items[1].id, { status: 'error', error: 'boom' });

    const final = finalizeSetupRun(run.id, { status: 'done', schedule_ids: [7, 8], schedules_created: 2 });
    expect(final!.status).toBe('done');
    expect(final!.plans_created).toBe(1);
    expect(final!.plans_skipped).toBe(1);
    expect(final!.plans_errored).toBe(1);
    expect(final!.piece_count).toBe(2);
    expect(final!.target_count).toBe(3);
    expect(final!.schedules_created).toBe(2);
    expect(JSON.parse(final!.schedule_ids)).toEqual([7, 8]);
    expect(final!.completed_at).toBeTruthy();

    expect(listSetupRunItems(run.id)).toHaveLength(3);
    expect(listSetupRuns()[0].id).toBe(run.id);
    expect(getSetupRun(run.id)!.status).toBe('done');
  });

  it('finalize(cancelled) closes still-open items and counts them as errored', () => {
    const run = createSetupRun({ cadence: 'monthly', cron_template: '', config: '{}' });
    const [running, pending, done] = addSetupRunItems(run.id, [
      { piece_name: 'p1', piece_display_name: 'P1', target_type: 'action', target_name: 'a1', target_display_name: 'A1', status: 'running' },
      { piece_name: 'p1', piece_display_name: 'P1', target_type: 'trigger', target_name: 't1', target_display_name: 'T1', status: 'pending' },
      { piece_name: 'p2', piece_display_name: 'P2', target_type: 'action', target_name: 'a2', target_display_name: 'A2', status: 'done' },
    ]);

    const final = finalizeSetupRun(run.id, { status: 'cancelled' });
    expect(final!.status).toBe('cancelled');
    expect(final!.plans_errored).toBe(2);

    const runningAfter = getSetupRunItem(running.id)!;
    const pendingAfter = getSetupRunItem(pending.id)!;
    expect(runningAfter.status).toBe('error');
    expect(runningAfter.error).toBe('Cancelled');
    expect(pendingAfter.status).toBe('error');
    expect(pendingAfter.error).toBe('Cancelled');
    // A finished item is left untouched.
    expect(getSetupRunItem(done.id)!.status).toBe('done');
  });

  it('updateSetupRunItem partial-patch preserves fields not in the patch', () => {
    const run = createSetupRun({ cadence: 'weekly', cron_template: '0 0 * * 1', config: '{}' });
    const [item] = addSetupRunItems(run.id, [
      { piece_name: 'px', piece_display_name: 'PX', target_type: 'action', target_name: 'ax', target_display_name: 'AX', status: 'pending' },
    ]);

    updateSetupRunItem(item.id, { plan_id: 9 });
    updateSetupRunItem(item.id, { status: 'done' });

    const final = getSetupRunItem(item.id)!;
    expect(final.plan_id).toBe(9);
    expect(final.status).toBe('done');
  });
});
