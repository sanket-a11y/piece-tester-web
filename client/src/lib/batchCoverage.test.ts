import { describe, it, expect } from 'vitest';
import type { TestPlan } from './api';
import {
  targetKey,
  plannedKeysForPiece,
  coverageState,
  pieceCoverage,
  matchesFilter,
  filterCounts,
  gapSelection,
} from './batchCoverage';

/** Minimal plan fixture — only the fields coverage reads. */
function plan(piece_name: string, target_action: string, target_type?: 'action' | 'trigger'): TestPlan {
  return { piece_name, target_action, target_type } as unknown as TestPlan;
}

describe('targetKey', () => {
  it('defaults a missing target_type to action', () => {
    expect(targetKey(undefined, 'send')).toBe('action:send');
    expect(targetKey('trigger', 'new_row')).toBe('trigger:new_row');
  });
});

describe('plannedKeysForPiece', () => {
  it('collects only the named piece and keys by type:name', () => {
    const plans = [
      plan('slack', 'send', 'action'),
      plan('slack', 'new_message', 'trigger'),
      plan('notion', 'create_page', 'action'),
    ];
    const keys = plannedKeysForPiece(plans, 'slack');
    expect([...keys].sort()).toEqual(['action:send', 'trigger:new_message']);
  });

  it('is empty for an unknown piece and tolerates undefined plans', () => {
    expect(plannedKeysForPiece([], 'x').size).toBe(0);
    expect(plannedKeysForPiece(undefined, 'x').size).toBe(0);
  });
});

describe('coverageState', () => {
  it('none when nothing is planned', () => {
    expect(coverageState(0, 8)).toBe('none');
  });
  it('done when planned meets or exceeds the total', () => {
    expect(coverageState(8, 8)).toBe('done');
    expect(coverageState(9, 8)).toBe('done');
  });
  it('partial in between', () => {
    expect(coverageState(3, 8)).toBe('partial');
  });
  it('none when there are no targets at all', () => {
    expect(coverageState(0, 0)).toBe('none');
  });
});

describe('pieceCoverage', () => {
  it('sums actions + triggers as numeric counts', () => {
    const cov = pieceCoverage({ name: 'slack', actions: 6, triggers: 2 }, [
      plan('slack', 'send', 'action'),
      plan('slack', 'new_message', 'trigger'),
    ]);
    expect(cov.totalTargets).toBe(8);
    expect(cov.plannedCount).toBe(2);
    expect(cov.state).toBe('partial');
  });

  it('reads action/trigger maps when counts arrive as objects', () => {
    const cov = pieceCoverage(
      { name: 'notion', actions: { create_page: {} }, triggers: {} },
      [plan('notion', 'create_page', 'action')],
    );
    expect(cov.totalTargets).toBe(1);
    expect(cov.state).toBe('done');
  });

  it('clamps the planned count to the total for display', () => {
    const cov = pieceCoverage({ name: 'slack', actions: 1, triggers: 0 }, [
      plan('slack', 'send', 'action'),
      plan('slack', 'stale_removed_action', 'action'),
    ]);
    expect(cov.plannedCount).toBe(1);
    expect(cov.state).toBe('done');
  });
});

describe('matchesFilter', () => {
  it('all admits everything', () => {
    for (const s of ['none', 'partial', 'done'] as const) expect(matchesFilter(s, 'all')).toBe(true);
  });
  it('needs is any gap (none or partial)', () => {
    expect(matchesFilter('none', 'needs')).toBe(true);
    expect(matchesFilter('partial', 'needs')).toBe(true);
    expect(matchesFilter('done', 'needs')).toBe(false);
  });
  it('done is complete only', () => {
    expect(matchesFilter('done', 'done')).toBe(true);
    expect(matchesFilter('partial', 'done')).toBe(false);
  });
  it('partial is started-but-not-done only', () => {
    expect(matchesFilter('partial', 'partial')).toBe(true);
    expect(matchesFilter('none', 'partial')).toBe(false);
    expect(matchesFilter('done', 'partial')).toBe(false);
  });
});

describe('filterCounts', () => {
  it('counts each bucket; needs = none + partial', () => {
    const counts = filterCounts(['none', 'partial', 'partial', 'done', 'done']);
    expect(counts).toEqual({ all: 5, needs: 3, partial: 2, done: 2 });
    expect(counts.needs + counts.done).toBe(counts.all); // partial is a subset of needs
  });
});

describe('gapSelection', () => {
  const pieces = [
    { name: 'notion', actions: 5, triggers: 0 },      // none
    { name: 'slack', actions: 6, triggers: 2 },       // partial (2 planned)
    { name: 'stripe', actions: 1, triggers: 0 },      // done
  ];
  const plans = [
    plan('slack', 'send', 'action'),
    plan('slack', 'new_message', 'trigger'),
    plan('stripe', 'charge', 'action'),
  ];

  it('selects only pieces with gaps and seeds planned targets as deselected', () => {
    const { selected, deselected } = gapSelection(pieces, plans);
    expect(selected.sort()).toEqual(['notion', 'slack']);
    expect(deselected).toEqual({ slack: ['action:send', 'trigger:new_message'] });
    expect(deselected.notion).toBeUndefined();
    expect(deselected.stripe).toBeUndefined();
  });

  it('only considers the visible subset it is given', () => {
    const visible = pieces.filter(p => p.name !== 'notion');
    const { selected } = gapSelection(visible, plans);
    expect(selected).toEqual(['slack']);
  });
});
