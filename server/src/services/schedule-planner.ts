export type Cadence = 'monthly' | '6h' | 'daily' | 'weekly' | 'custom' | 'none';

const DEFAULT_HOUR = 3;

/** Assign each piece a distinct day-of-month (1..28, round-robin wrapping), stable by input order. */
export function assignDaysOfMonth(pieceNames: string[]): Map<string, number> {
  const map = new Map<string, number>();
  pieceNames.forEach((name, i) => map.set(name, (i % 28) + 1));
  return map;
}

/** Build a cron expression for a cadence. `day` used only for monthly; `custom` used only for custom. */
export function buildCron(cadence: Cadence, opts: { day?: number; hour?: number; custom?: string } = {}): string {
  const hour = opts.hour ?? DEFAULT_HOUR;
  switch (cadence) {
    case 'monthly': return `0 ${hour} ${opts.day ?? 1} * *`;
    case 'weekly':  return `0 ${hour} * * 1`;
    case 'daily':   return `0 ${hour} * * *`;
    case '6h':      return `0 */6 * * *`;
    case 'custom':  return opts.custom?.trim() || `0 ${hour} * * *`;
    case 'none':    return '';
  }
}

/**
 * schedule_config JSON that the Schedules page editor understands
 * ({ frequency, minute, hour, dayOfWeek, dayOfMonth }). Monthly is exact;
 * other cadences are best-effort for display (the cron_expression is authoritative).
 */
export function buildScheduleConfig(
  cadence: Cadence,
  opts: { day?: number; hour?: number } = {},
): { frequency: string; minute: number; hour: number; dayOfWeek: number; dayOfMonth: number } {
  const hour = opts.hour ?? DEFAULT_HOUR;
  const frequency = cadence === 'monthly' || cadence === 'weekly' || cadence === 'daily' ? cadence : 'daily';
  return { frequency, minute: 0, hour, dayOfWeek: 1, dayOfMonth: opts.day ?? 1 };
}
