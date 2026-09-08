import { createSchedule, listSchedules } from '../db/queries.js';
import { reloadScheduler } from './scheduler.js';
import { assignDaysOfMonth, buildCron, buildScheduleConfig, type Cadence } from './schedule-planner.js';

function alreadyScheduledPieces(): Set<string> {
  const set = new Set<string>();
  for (const s of listSchedules()) {
    if (s.piece_name) set.add(s.piece_name);
    try {
      for (const t of JSON.parse(s.targets || '[]') as { piece_name?: string }[]) {
        if (t.piece_name) set.add(t.piece_name);
      }
    } catch { /* ignore malformed targets */ }
  }
  return set;
}

export function createSchedulesForRun(params: {
  pieceNames: string[];
  cadence: Cadence;
  customCron?: string;
}): number[] {
  if (params.cadence === 'none') return [];

  const existing = alreadyScheduledPieces();
  const eligible = params.pieceNames.filter(p => !existing.has(p));
  const days = assignDaysOfMonth(eligible);

  const ids: number[] = [];
  for (const piece of eligible) {
    const day = days.get(piece);
    const cron = buildCron(params.cadence, { day, custom: params.customCron });
    if (!cron) continue;
    const cfg = buildScheduleConfig(params.cadence, { day });
    const s = createSchedule({
      piece_name: piece,
      cron_expression: cron,
      label: `Auto: ${piece}`,
      schedule_config: JSON.stringify(cfg),
      targets: JSON.stringify([{ piece_name: piece }]),
    });
    ids.push(s.id);
  }

  if (ids.length) reloadScheduler();
  return ids;
}
