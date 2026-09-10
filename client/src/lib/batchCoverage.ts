import type { TestPlan } from './api';

/** How much of a piece's action+trigger surface already has a test plan. */
export type CoverageState = 'none' | 'partial' | 'done';

/** The Generate-step filter chips. `needs` = any gap (none or partial). */
export type CoverageFilter = 'all' | 'needs' | 'partial' | 'done';

export interface PieceCoverage {
  /** `type:name` keys of targets that already have a plan. */
  plannedKeys: Set<string>;
  /** Planned targets, clamped to `totalTargets` for display. */
  plannedCount: number;
  totalTargets: number;
  state: CoverageState;
}

/** The subset of a `/pieces` summary row that coverage needs. */
export interface PieceSummaryLike {
  name: string;
  actions?: number | Record<string, unknown>;
  triggers?: number | Record<string, unknown>;
}

/** `/pieces` returns counts as numbers; `getPiece` returns maps. Handle both. */
function countTargets(v: number | Record<string, unknown> | undefined): number {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object') return Object.keys(v).length;
  return 0;
}

export function targetKey(type: string | undefined, name: string): string {
  return `${type ?? 'action'}:${name}`;
}

export function plannedKeysForPiece(plans: TestPlan[] | undefined, pieceName: string): Set<string> {
  const keys = new Set<string>();
  for (const p of plans ?? []) {
    if (p.piece_name === pieceName) keys.add(targetKey(p.target_type, p.target_action));
  }
  return keys;
}

export function coverageState(plannedCount: number, totalTargets: number): CoverageState {
  if (plannedCount <= 0) return 'none';
  if (totalTargets > 0 && plannedCount >= totalTargets) return 'done';
  return 'partial';
}

export function pieceCoverage(piece: PieceSummaryLike, plans: TestPlan[] | undefined): PieceCoverage {
  const plannedKeys = plannedKeysForPiece(plans, piece.name);
  const totalTargets = countTargets(piece.actions) + countTargets(piece.triggers);
  const plannedCount = totalTargets > 0 ? Math.min(plannedKeys.size, totalTargets) : 0;
  return { plannedKeys, plannedCount, totalTargets, state: coverageState(plannedCount, totalTargets) };
}

export function matchesFilter(state: CoverageState, filter: CoverageFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'done') return state === 'done';
  if (filter === 'partial') return state === 'partial';
  return state !== 'done'; // 'needs' = none | partial
}

export interface FilterCounts {
  all: number;
  needs: number;
  partial: number;
  done: number;
}

export function filterCounts(states: CoverageState[]): FilterCounts {
  let partial = 0;
  let done = 0;
  for (const s of states) {
    if (s === 'partial') partial++;
    else if (s === 'done') done++;
  }
  return { all: states.length, needs: states.length - done, partial, done };
}

/**
 * "Select all" over a visible list: pick only pieces that still have gaps and
 * seed each with its already-planned targets deselected, so a run defaults to
 * filling gaps only. Done pieces are skipped entirely.
 */
export function gapSelection(
  visible: PieceSummaryLike[],
  plans: TestPlan[] | undefined,
): { selected: string[]; deselected: Record<string, string[]> } {
  const selected: string[] = [];
  const deselected: Record<string, string[]> = {};
  for (const piece of visible) {
    const cov = pieceCoverage(piece, plans);
    if (cov.state === 'done') continue;
    selected.push(piece.name);
    if (cov.plannedKeys.size > 0) deselected[piece.name] = [...cov.plannedKeys];
  }
  return { selected, deselected };
}
