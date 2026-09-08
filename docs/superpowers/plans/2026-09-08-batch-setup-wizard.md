# Batch Setup Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/batch-setup` into a guided wizard (Connections → Generate plans → Schedule → Done) that AI-generates plans for actions **and** triggers, auto-creates staggered monthly schedules, and records every run as browsable, persistent history.

**Architecture:** Add two DB tables (`setup_runs`, `setup_run_items`) written through as the existing in-memory batch queue runs. Extend the batch queue/route to enqueue triggers and persist per-target outcomes. A pure `schedule-planner` assigns a distinct day-of-month per piece; a `setup-scheduler` service creates per-piece schedules (skipping pieces that already have one). The React page becomes a stepper with a Recent Setup Runs landing.

**Tech Stack:** Node + Express + better-sqlite3 (`getDb()` adapter), React + TanStack Query, node-cron, Vitest (`pool: forks`, on-disk `data/test.db`, `beforeEach` table wipes).

**Commit style (user preference — overrides per-task commits):** one small, grouped commit at each **Phase** boundary; short messages (e.g. `feat: setup-run persistence`); **no** `Co-Authored-By` trailer; do **not** push or open a PR — leave for the user to test.

---

## Reference: existing shapes this plan builds on

- Batch queue (`server/src/services/plan-jobs.ts`): `BatchQueueItem { pieceName, pieceDisplayName, actionName, actionDisplayName, status, error? }`, `BatchQueue { id, status, items, currentIndex, startedAt, completedAt?, emitter, events, cancelled }`. Singleton `activeBatchQueue`. `createBatchQueue`, `emitBatchEvent`, `completeBatchQueue`, `cancelBatchQueue`, `getBatchQueueStatus`.
- Batch route (`server/src/routes/batch-setup.ts`): `runBatchInBackground(queue)` loop; `POST /start`, `GET /status`, `GET /subscribe` (SSE), `POST /cancel`.
- Action generator: `createTestPlanWithAi(piece, actionName, onLog, previousMemory?, signal?)` from `server/src/services/ai-config-generator.js` → `{ steps, agentMemory }`.
- Trigger generator: `createTriggerTestPlanV2({ pieceMeta, triggerName, previousMemory?, onLog, abortSignal? })` from `server/src/agents/v2/index.js` → `{ steps, agentMemory, note? }`.
- `createTestPlan({ piece_name, target_action, target_type?, steps, status?, agent_memory? })` (upsert), `listTestPlans(pieceName?)` → rows with `target_action`, `target_type`, `status`.
- `createSchedule({ piece_name?, cron_expression, label?, timezone?, schedule_config?, targets? })`, `listSchedules()` → `ScheduleRow`, `reloadScheduler()` from `server/src/services/scheduler.js`.
- DB adapter: `getDb().run(sql, params) → { lastId }`, `.get<T>(sql, params)`, `.all<T>(sql, params)`, `.exec(sql)`, `.transaction(fn)`.
- Client API (`client/src/lib/api.ts`): `startBatchSetup(pieceNames)`, `getBatchStatus()`, `subscribeBatchSetup(cbs)`, `cancelBatchSetup()`, `sweepConnections(pieceNames?)`, `listSchedules()`, `listPieces()`, `listConnections()`, `listTestPlans()`.

---

## Phase 1 — Persistence layer

### Task 1: Create `setup_runs` and `setup_run_items` tables

**Files:**
- Modify: `server/src/db/schema.ts` (add to the main `db.exec(\`…\`)` CREATE-TABLE block, alongside `schedules`/`test_plans`, around line 200)

- [ ] **Step 1: Add the two tables**

In the big `db.exec(\`... CREATE TABLE IF NOT EXISTS ...\`)` block that defines `schedules`/`test_plans`, append:

```sql
    CREATE TABLE IF NOT EXISTS setup_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'running',   -- running | done | cancelled
      cadence TEXT NOT NULL DEFAULT 'none',      -- monthly | 6h | daily | weekly | custom | none
      cron_template TEXT NOT NULL DEFAULT '',
      config TEXT NOT NULL DEFAULT '{}',         -- JSON: { scheduleEnabled, customCron, pieceNames }
      schedule_ids TEXT NOT NULL DEFAULT '[]',   -- JSON array of created schedule ids
      piece_count INTEGER NOT NULL DEFAULT 0,
      target_count INTEGER NOT NULL DEFAULT 0,
      plans_created INTEGER NOT NULL DEFAULT 0,
      plans_skipped INTEGER NOT NULL DEFAULT 0,
      plans_errored INTEGER NOT NULL DEFAULT 0,
      schedules_created INTEGER NOT NULL DEFAULT 0,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS setup_run_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      setup_run_id INTEGER NOT NULL REFERENCES setup_runs(id) ON DELETE CASCADE,
      piece_name TEXT NOT NULL,
      piece_display_name TEXT NOT NULL DEFAULT '',
      target_type TEXT NOT NULL DEFAULT 'action',   -- action | trigger
      target_name TEXT NOT NULL,
      target_display_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',        -- pending | running | done | skipped | error
      plan_id INTEGER,
      error TEXT
    );
```

- [ ] **Step 2: Verify the schema loads**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors. (Tables are created on first `getDb()`; verified indirectly by Task 2's tests.)

### Task 2: Setup-run queries (TDD)

**Files:**
- Modify: `server/src/db/queries.ts` (append a new `// ── Setup runs ──` section near the end)
- Test: `server/src/db/setup-runs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './schema.js';
import {
  createSetupRun, addSetupRunItems, updateSetupRunItem,
  finalizeSetupRun, getSetupRun, listSetupRunItems, listSetupRuns,
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
    expect(final!.plans_created).toBe(1);   // one 'done'
    expect(final!.plans_skipped).toBe(1);   // one 'skipped'
    expect(final!.plans_errored).toBe(1);   // one 'error'
    expect(final!.piece_count).toBe(2);     // p1, p2
    expect(final!.target_count).toBe(3);
    expect(final!.schedules_created).toBe(2);
    expect(JSON.parse(final!.schedule_ids)).toEqual([7, 8]);
    expect(final!.completed_at).toBeTruthy();

    expect(listSetupRunItems(run.id)).toHaveLength(3);
    expect(listSetupRuns()[0].id).toBe(run.id);
    expect(getSetupRun(run.id)!.status).toBe('done');
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run server/src/db/setup-runs.test.ts`
Expected: FAIL — `createSetupRun is not a function`.

- [ ] **Step 3: Implement the queries**

Append to `server/src/db/queries.ts`:

```ts
// ── Setup runs ──

export interface SetupRunRow {
  id: number;
  status: 'running' | 'done' | 'cancelled';
  cadence: string;
  cron_template: string;
  config: string;
  schedule_ids: string;
  piece_count: number;
  target_count: number;
  plans_created: number;
  plans_skipped: number;
  plans_errored: number;
  schedules_created: number;
  started_at: string;
  completed_at: string | null;
  created_at: string;
}

export interface SetupRunItemRow {
  id: number;
  setup_run_id: number;
  piece_name: string;
  piece_display_name: string;
  target_type: 'action' | 'trigger';
  target_name: string;
  target_display_name: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'error';
  plan_id: number | null;
  error: string | null;
}

export function createSetupRun(p: { cadence: string; cron_template: string; config: string }): SetupRunRow {
  const r = getDb().run(
    `INSERT INTO setup_runs (cadence, cron_template, config) VALUES (?, ?, ?)`,
    [p.cadence, p.cron_template, p.config],
  );
  return getSetupRun(r.lastId)!;
}

export function getSetupRun(id: number): SetupRunRow | undefined {
  return getDb().get<SetupRunRow>('SELECT * FROM setup_runs WHERE id = ?', [id]);
}

export function listSetupRuns(limit = 50): SetupRunRow[] {
  return getDb().all<SetupRunRow>('SELECT * FROM setup_runs ORDER BY id DESC LIMIT ?', [limit]);
}

export function addSetupRunItems(
  setupRunId: number,
  items: Omit<SetupRunItemRow, 'id' | 'setup_run_id' | 'plan_id' | 'error'>[],
): SetupRunItemRow[] {
  const db = getDb();
  return db.transaction(() => {
    const out: SetupRunItemRow[] = [];
    for (const it of items) {
      const r = db.run(
        `INSERT INTO setup_run_items
           (setup_run_id, piece_name, piece_display_name, target_type, target_name, target_display_name, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [setupRunId, it.piece_name, it.piece_display_name, it.target_type, it.target_name, it.target_display_name, it.status],
      );
      out.push(getSetupRunItem(r.lastId)!);
    }
    return out;
  });
}

export function getSetupRunItem(id: number): SetupRunItemRow | undefined {
  return getDb().get<SetupRunItemRow>('SELECT * FROM setup_run_items WHERE id = ?', [id]);
}

export function listSetupRunItems(setupRunId: number): SetupRunItemRow[] {
  return getDb().all<SetupRunItemRow>('SELECT * FROM setup_run_items WHERE setup_run_id = ? ORDER BY id', [setupRunId]);
}

export function updateSetupRunItem(
  id: number,
  patch: { status?: string; plan_id?: number | null; error?: string | null },
): void {
  const cur = getSetupRunItem(id);
  if (!cur) return;
  getDb().run(
    `UPDATE setup_run_items SET status = ?, plan_id = ?, error = ? WHERE id = ?`,
    [
      patch.status ?? cur.status,
      patch.plan_id !== undefined ? patch.plan_id : cur.plan_id,
      patch.error !== undefined ? patch.error : cur.error,
      id,
    ],
  );
}

export function finalizeSetupRun(
  id: number,
  patch: { status: 'done' | 'cancelled'; schedule_ids?: number[]; schedules_created?: number },
): SetupRunRow | undefined {
  const db = getDb();
  const agg = db.get<{ total: number; pieces: number; done: number; skipped: number; errored: number }>(
    `SELECT COUNT(*) AS total,
            COUNT(DISTINCT piece_name) AS pieces,
            SUM(status = 'done')    AS done,
            SUM(status = 'skipped') AS skipped,
            SUM(status = 'error')   AS errored
       FROM setup_run_items WHERE setup_run_id = ?`,
    [id],
  )!;
  db.run(
    `UPDATE setup_runs SET
       status = ?, completed_at = datetime('now'),
       target_count = ?, piece_count = ?,
       plans_created = ?, plans_skipped = ?, plans_errored = ?,
       schedule_ids = ?, schedules_created = ?
     WHERE id = ?`,
    [
      patch.status,
      agg.total ?? 0, agg.pieces ?? 0,
      agg.done ?? 0, agg.skipped ?? 0, agg.errored ?? 0,
      JSON.stringify(patch.schedule_ids ?? []),
      patch.schedules_created ?? 0,
      id,
    ],
  );
  return getSetupRun(id);
}
```

> Note: `SUM(status = 'done')` uses SQLite's boolean-as-1/0. `getDb()` is better-sqlite3; results come back as numbers.

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run server/src/db/setup-runs.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit Phase 1**

```bash
git add server/src/db/schema.ts server/src/db/queries.ts server/src/db/setup-runs.test.ts
git commit -m "feat: setup-run persistence"
```

---

## Phase 2 — Schedule planner (pure logic)

### Task 3: Day-of-month assignment + cron building (TDD)

**Files:**
- Create: `server/src/services/schedule-planner.ts`
- Test: `server/src/services/schedule-planner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run server/src/services/schedule-planner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/src/services/schedule-planner.ts
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
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run server/src/services/schedule-planner.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit Phase 2**

```bash
git add server/src/services/schedule-planner.ts server/src/services/schedule-planner.test.ts
git commit -m "feat: schedule planner"
```

---

## Phase 3 — Setup scheduler service

### Task 4: Auto-create per-piece schedules, skipping existing (TDD)

**Files:**
- Create: `server/src/services/setup-scheduler.ts`
- Test: `server/src/services/setup-scheduler.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run server/src/services/setup-scheduler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/src/services/setup-scheduler.ts
import { createSchedule, listSchedules } from '../db/queries.js';
import { reloadScheduler } from './scheduler.js';
import { assignDaysOfMonth, buildCron, buildScheduleConfig, type Cadence } from './schedule-planner.js';

/** Pieces that already have a schedule — by piece_name column or a single-piece targets entry. */
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

/**
 * Create one schedule per eligible piece (has ≥1 approved plan — caller decides `pieceNames`)
 * that isn't already scheduled. Monthly cadence staggers day-of-month across the eligible set.
 * Returns the created schedule ids.
 */
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
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run server/src/services/setup-scheduler.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit Phase 3**

```bash
git add server/src/services/setup-scheduler.ts server/src/services/setup-scheduler.test.ts
git commit -m "feat: auto-create per-piece schedules"
```

---

## Phase 4 — Generate stage: triggers + write-through

### Task 5: Extend the batch queue item type

**Files:**
- Modify: `server/src/services/plan-jobs.ts:23-42` (`BatchQueueItem`, `BatchQueue`)

- [ ] **Step 1: Add `targetType` + persistence linkage**

Change `BatchQueueItem` to:

```ts
export interface BatchQueueItem {
  pieceName: string;
  pieceDisplayName: string;
  actionName: string;            // holds the target name (action OR trigger)
  actionDisplayName: string;     // holds the target displayName
  targetType: 'action' | 'trigger';
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  error?: string;
  setupItemId?: number;          // row id in setup_run_items
}
```

Add `setupRunId?: number;` to the `BatchQueue` interface.

In `getBatchQueueStatus()` include `targetType` in the mapped items:

```ts
    items: q.items.map(i => ({ pieceName: i.pieceName, pieceDisplayName: i.pieceDisplayName, actionName: i.actionName, actionDisplayName: i.actionDisplayName, targetType: i.targetType, status: i.status })),
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: errors ONLY in `server/src/routes/batch-setup.ts` (items built without `targetType`). Fixed in Task 6.

### Task 6: Enqueue triggers, generate them, and write through to `setup_run_items`

**Files:**
- Modify: `server/src/routes/batch-setup.ts` (imports, `POST /start`, `runBatchInBackground`)

- [ ] **Step 1: Add imports**

At the top of `server/src/routes/batch-setup.ts` add:

```ts
import { createTriggerTestPlanV2 } from '../agents/v2/index.js';
import {
  createSetupRun, addSetupRunItems, updateSetupRunItem, finalizeSetupRun,
  listTestPlans,
} from '../db/queries.js';
import { createSchedulesForRun } from '../services/setup-scheduler.js';
import type { Cadence } from '../services/schedule-planner.js';
```

(`listTestPlans` is already imported — keep a single import; remove the duplicate if the editor flags it.)

- [ ] **Step 2: Build action + trigger items and a setup_run in `POST /start`**

Replace the item-building loop and queue creation in `POST /start` with:

```ts
  const { pieceNames, schedule } = req.body as {
    pieceNames: string[];
    schedule?: { enabled?: boolean; cadence?: Cadence; customCron?: string };
  };
  if (!pieceNames || !Array.isArray(pieceNames) || pieceNames.length === 0) {
    return res.status(400).json({ error: 'pieceNames array is required' });
  }

  const existingQueue = getBatchQueue();
  if (existingQueue && existingQueue.status === 'running') {
    return res.status(409).json({ error: 'A batch is already running' });
  }

  try {
    const client = createClient();
    const items: BatchQueueItem[] = [];

    for (const pieceName of pieceNames) {
      const piece = await client.getPieceMetadata(pieceName);
      const existing = new Set(listTestPlans(pieceName).map(p => `${p.target_type}:${p.target_action}`));

      for (const [actionName, meta] of Object.entries(piece.actions || {})) {
        items.push({
          pieceName, pieceDisplayName: piece.displayName,
          actionName, actionDisplayName: (meta as any).displayName || actionName,
          targetType: 'action',
          status: existing.has(`action:${actionName}`) ? 'skipped' : 'pending',
        });
      }
      for (const [triggerName, meta] of Object.entries(piece.triggers || {})) {
        items.push({
          pieceName, pieceDisplayName: piece.displayName,
          actionName: triggerName, actionDisplayName: (meta as any).displayName || triggerName,
          targetType: 'trigger',
          status: existing.has(`trigger:${triggerName}`) ? 'skipped' : 'pending',
        });
      }
    }

    const cadence: Cadence = schedule?.enabled === false ? 'none' : (schedule?.cadence ?? 'monthly');
    const run = createSetupRun({
      cadence,
      cron_template: '',
      config: JSON.stringify({ scheduleEnabled: schedule?.enabled !== false, customCron: schedule?.customCron ?? '', pieceNames }),
    });
    const savedItems = addSetupRunItems(run.id, items.map(i => ({
      piece_name: i.pieceName, piece_display_name: i.pieceDisplayName,
      target_type: i.targetType, target_name: i.actionName, target_display_name: i.actionDisplayName,
      status: i.status,
    })));
    items.forEach((i, idx) => { i.setupItemId = savedItems[idx].id; });

    const queue = createBatchQueue(items);
    queue.setupRunId = run.id;
    runBatchInBackground(queue);

    res.json({
      id: queue.id,
      setupRunId: run.id,
      totalItems: items.length,
      pendingItems: items.filter(i => i.status === 'pending').length,
      skippedItems: items.filter(i => i.status === 'skipped').length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
```

- [ ] **Step 3: Generate triggers + write-through in `runBatchInBackground`**

In `runBatchInBackground`, (a) when an item is `skipped`, persist it; (b) branch on `targetType`; (c) update the setup_run_item on every settle. Concretely:

After `if (item.status === 'skipped') {` … persist before `continue`:

```ts
    if (item.status === 'skipped') {
      if (item.setupItemId) updateSetupRunItem(item.setupItemId, { status: 'skipped' });
      emitBatchEvent(queue, 'item_update', { index: i, ...item });
      continue;
    }
```

Set running state (after `item.status = 'running'`):

```ts
    item.status = 'running';
    if (item.setupItemId) updateSetupRunItem(item.setupItemId, { status: 'running' });
    emitBatchEvent(queue, 'item_update', { index: i, ...item });
```

Replace the action-only generation block with a target-type branch. For **triggers**, generate + save + single auto-test (mirrors `pieces.ts` trigger path, no fixer); for **actions**, keep the existing generate + auto-test + up-to-3 fix loop. Capture the saved `planId` in a `let planId: number | undefined`:

```ts
    try {
      const piece = await client.getPieceMetadata(item.pieceName);
      const targetName = item.actionName;
      let planId: number | undefined;

      const onLog = (log: AgentLogEntry) => {
        emitBatchEvent(queue, 'log', { index: i, pieceName: item.pieceName, actionName: targetName, log });
      };

      if (item.targetType === 'trigger') {
        if (!piece.triggers?.[targetName]) {
          item.status = 'error'; item.error = `Trigger "${targetName}" not found`;
          if (item.setupItemId) updateSetupRunItem(item.setupItemId, { status: 'error', error: item.error });
          emitBatchEvent(queue, 'item_update', { index: i, ...item });
          continue;
        }
        const planResult = await createTriggerTestPlanV2({
          pieceMeta: piece, triggerName: targetName,
          onLog: (l: any) => onLog(l),
        });
        if (queue.cancelled) break;
        const saved = createTestPlan({
          piece_name: item.pieceName, target_action: targetName, target_type: 'trigger',
          steps: JSON.stringify(planResult.steps), status: 'draft', agent_memory: planResult.agentMemory || '',
        });
        planId = saved.id;
        emitBatchEvent(queue, 'plan_created', { index: i, pieceName: item.pieceName, actionName: targetName, planId: saved.id, steps: planResult.steps, status: 'draft' });

        const hasHumanInput = planResult.steps.some((s: any) => s.type === 'human_input');
        if (!hasHumanInput && planResult.steps.length > 0) {
          onLog({ timestamp: Date.now(), type: 'thinking', message: 'Auto-testing trigger plan...' });
          const finalRun = await executePlan(saved.id, () => {}, 'auto_test');
          if (queue.cancelled) break;
          if (finalRun.status === 'completed') {
            onLog({ timestamp: Date.now(), type: 'done', message: 'Auto-test passed!' });
            updateTestPlan(saved.id, { status: 'approved' });
            emitBatchEvent(queue, 'plan_approved', { index: i, pieceName: item.pieceName, actionName: targetName, planId: saved.id });
          } else {
            onLog({ timestamp: Date.now(), type: 'error', message: 'Auto-test did not pass. Left as draft.' });
          }
        }
      } else {
        // ===== existing action path — unchanged, but capture planId =====
        const planResult = await createTestPlanWithAi(piece, targetName, onLog);
        if (queue.cancelled) break;
        const saved = createTestPlan({
          piece_name: item.pieceName, target_action: targetName,
          steps: JSON.stringify(planResult.steps), status: 'draft', agent_memory: planResult.agentMemory || '',
        });
        planId = saved.id;
        emitBatchEvent(queue, 'plan_created', { index: i, pieceName: item.pieceName, actionName: targetName, planId: saved.id, steps: planResult.steps, status: 'draft' });
        // … keep the existing hasHumanInputSteps + MAX_FIX_ATTEMPTS auto-test/fix loop verbatim,
        //    it already updates status to 'approved' and emits 'plan_approved' …
      }

      item.status = 'done';
      if (item.setupItemId) updateSetupRunItem(item.setupItemId, { status: 'done', plan_id: planId ?? null });
      emitBatchEvent(queue, 'item_update', { index: i, ...item });

    } catch (err: any) {
      if (queue.cancelled) break;
      console.error(`[batch-setup] Error for ${item.pieceName}/${item.actionName}:`, err.message);
      item.status = 'error'; item.error = err.message;
      if (item.setupItemId) updateSetupRunItem(item.setupItemId, { status: 'error', error: err.message });
      emitBatchEvent(queue, 'item_update', { index: i, ...item });
    }
```

> Keep the existing action auto-test/fix loop exactly as it is today (the `MAX_FIX_ATTEMPTS` block, `extractAndStoreLessons`, etc.) — only wrap it in the `else` branch and make sure `planId = saved.id` is set. Do not duplicate that code into the trigger branch.

- [ ] **Step 4: Finalize the run + auto-schedule when the batch completes**

Replace the tail of `runBatchInBackground` (currently `completeBatchQueue(...)` + `emitBatchEvent('batch_done')`) with:

```ts
  const finalStatus = queue.cancelled ? 'cancelled' : 'done';

  let scheduleIds: number[] = [];
  if (!queue.cancelled && queue.setupRunId) {
    const cfg = JSON.parse((getSetupRunConfig(queue.setupRunId)) || '{}');
    if (cfg.scheduleEnabled) {
      const selectedPieces: string[] = cfg.pieceNames ?? [];
      const eligible = selectedPieces.filter(p => listTestPlans(p).some(pl => pl.status === 'approved'));
      try {
        scheduleIds = createSchedulesForRun({
          pieceNames: eligible,
          cadence: (getSetupRunCadence(queue.setupRunId) as Cadence),
          customCron: cfg.customCron || undefined,
        });
      } catch (e: any) {
        console.error('[batch-setup] auto-schedule failed:', e.message);
      }
    }
  }

  if (queue.setupRunId) {
    finalizeSetupRun(queue.setupRunId, {
      status: finalStatus,
      schedule_ids: scheduleIds,
      schedules_created: scheduleIds.length,
    });
  }

  completeBatchQueue(queue, finalStatus);
  emitBatchEvent(queue, 'batch_done', { status: queue.status, setupRunId: queue.setupRunId, schedulesCreated: scheduleIds.length });
```

Add two tiny helpers near the top of the file (read config/cadence without re-fetching the whole row twice):

```ts
import { getSetupRun } from '../db/queries.js';
function getSetupRunConfig(id: number): string { return getSetupRun(id)?.config ?? '{}'; }
function getSetupRunCadence(id: number): string { return getSetupRun(id)?.cadence ?? 'none'; }
```

- [ ] **Step 5: Verify the whole server compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Run the full server test suite (nothing regressed)**

Run: `npx vitest run server/src`
Expected: all PASS (existing + Phases 1–3 tests).

- [ ] **Step 7: Commit Phase 4**

```bash
git add server/src/services/plan-jobs.ts server/src/routes/batch-setup.ts
git commit -m "feat: batch generates triggers + records setup run"
```

---

## Phase 5 — History endpoints

### Task 7: Expose setup-run history + detail

**Files:**
- Modify: `server/src/routes/batch-setup.ts` (add two routes before `export default router;`)

- [ ] **Step 1: Add the routes**

```ts
import { listSetupRuns, getSetupRun, listSetupRunItems } from '../db/queries.js';

// ── Setup run history ──
router.get('/runs', (_req, res) => {
  res.json(listSetupRuns());
});

router.get('/runs/:id', (req, res) => {
  const run = getSetupRun(parseInt(req.params.id));
  if (!run) return res.status(404).json({ error: 'Setup run not found' });
  res.json({ run, items: listSetupRunItems(run.id) });
});
```

(Merge these imports with the existing `../db/queries.js` import line rather than adding a duplicate.)

- [ ] **Step 2: Verify compile + smoke the endpoints**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

Manual smoke (server running via `npm run dev`): `curl localhost:3000/api/batch-setup/runs` returns `[]` or prior runs. (Port/prefix per this repo's server setup.)

- [ ] **Step 3: Commit Phase 5**

```bash
git add server/src/routes/batch-setup.ts
git commit -m "feat: setup-run history endpoints"
```

---

## Phase 6 — Client API surface

### Task 8: Types + methods for schedule config and history

**Files:**
- Modify: `client/src/lib/api.ts`

- [ ] **Step 1: Extend `BatchStatus` items with `targetType` and add setup-run types**

Find the `BatchStatus` interface (~line 901); add `targetType: 'action' | 'trigger'` to its item shape (and to `BatchQueueItemStatus` if that's the exported item type used by `BatchSetup.tsx`). Then add:

```ts
export interface SetupRunSummary {
  id: number;
  status: 'running' | 'done' | 'cancelled';
  cadence: string;
  piece_count: number;
  target_count: number;
  plans_created: number;
  plans_skipped: number;
  plans_errored: number;
  schedules_created: number;
  started_at: string;
  completed_at: string | null;
}

export interface SetupRunItem {
  id: number;
  piece_name: string;
  piece_display_name: string;
  target_type: 'action' | 'trigger';
  target_name: string;
  target_display_name: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'error';
  plan_id: number | null;
  error: string | null;
}

export interface ScheduleConfigInput {
  enabled: boolean;
  cadence: 'monthly' | '6h' | 'daily' | 'weekly' | 'custom' | 'none';
  customCron?: string;
}
```

- [ ] **Step 2: Update `startBatchSetup` signature and add history getters**

Change the existing `startBatchSetup` to accept optional schedule config, and add getters (place beside the other `batchSetup` methods, ~line 1178):

```ts
  startBatchSetup: (pieceNames: string[], schedule?: ScheduleConfigInput) =>
    request<{ id: string; setupRunId: number; totalItems: number; pendingItems: number; skippedItems: number }>(
      'POST', '/batch-setup/start', { pieceNames, schedule },
    ),
  getSetupRuns: () => request<SetupRunSummary[]>('GET', '/batch-setup/runs'),
  getSetupRunDetail: (id: number) =>
    request<{ run: SetupRunSummary; items: SetupRunItem[] }>('GET', `/batch-setup/runs/${id}`),
```

- [ ] **Step 3: Verify the client compiles**

Run: `npx tsc --noEmit -p client/tsconfig.json` (or the repo's client typecheck script — check `package.json`).
Expected: errors only where `BatchSetup.tsx` must adopt the new shapes — fixed in Phase 7.

- [ ] **Step 4: Commit Phase 6**

```bash
git add client/src/lib/api.ts
git commit -m "feat: client api for setup runs"
```

---

## Phase 7 — Wizard UI

The current `BatchSetup.tsx` already renders piece selection and grouped live progress. Reshape it into: **landing (history + New Setup Run)** → **stepper**: ① Connections → ② Generate → ③ Schedule → ④ Done. Reuse the existing selection list and the grouped-progress renderer as much as possible.

### Task 9: Setup-run history landing

**Files:**
- Create: `client/src/components/SetupRunHistory.tsx`
- Test: `client/src/components/SetupRunHistory.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SetupRunHistory } from './SetupRunHistory';

const runs = [{
  id: 1, status: 'done' as const, cadence: 'monthly',
  piece_count: 3, target_count: 12, plans_created: 10, plans_skipped: 1, plans_errored: 1,
  schedules_created: 3, started_at: '2026-09-08 10:00:00', completed_at: '2026-09-08 10:30:00',
}];

describe('SetupRunHistory', () => {
  it('renders a row per run with rollup counts', () => {
    render(<SetupRunHistory runs={runs} onOpen={() => {}} />);
    expect(screen.getByText(/3 pieces/i)).toBeInTheDocument();
    expect(screen.getByText(/10 plans/i)).toBeInTheDocument();
  });

  it('shows an empty state when there are no runs', () => {
    render(<SetupRunHistory runs={[]} onOpen={() => {}} />);
    expect(screen.getByText(/no setup runs yet/i)).toBeInTheDocument();
  });
});
```

> If the repo has no React test tooling yet, check `vitest.config.ts` `environment`. Client tests need `environment: 'jsdom'` and `@testing-library/react`. If absent, add a `// @vitest-environment jsdom` docblock at the top of this test file and install `@testing-library/react @testing-library/jest-dom jsdom` as devDeps (note it in the commit). Keep the component itself framework-plain so this stays optional.

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run client/src/components/SetupRunHistory.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

```tsx
// client/src/components/SetupRunHistory.tsx
import { History, ChevronRight } from 'lucide-react';
import type { SetupRunSummary } from '../lib/api';

export function SetupRunHistory({ runs, onOpen }: { runs: SetupRunSummary[]; onOpen: (id: number) => void }) {
  if (runs.length === 0) {
    return <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 text-center text-gray-500 text-sm">No setup runs yet.</div>;
  }
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
      {runs.map(r => (
        <button key={r.id} onClick={() => onOpen(r.id)} className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/50 text-left">
          <div className="flex items-center gap-3">
            <History size={16} className="text-primary-400" />
            <div>
              <div className="text-sm">{new Date(r.started_at.replace(' ', 'T') + 'Z').toLocaleString()}</div>
              <div className="text-xs text-gray-500">
                {r.piece_count} pieces · {r.plans_created} plans · {r.plans_errored} err · {r.schedules_created} schedules
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span className={r.status === 'done' ? 'text-green-400' : r.status === 'running' ? 'text-blue-400' : 'text-yellow-400'}>{r.status}</span>
            <ChevronRight size={14} />
          </div>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run client/src/components/SetupRunHistory.test.tsx`
Expected: PASS (2 tests).

### Task 10: Schedule step control

**Files:**
- Create: `client/src/components/ScheduleStep.tsx`

- [ ] **Step 1: Implement (no test — presentational; validated in the wizard)**

```tsx
// client/src/components/ScheduleStep.tsx
import type { ScheduleConfigInput } from '../lib/api';

const CADENCES: { key: ScheduleConfigInput['cadence']; label: string; hint: string }[] = [
  { key: 'monthly', label: 'Monthly (staggered)', hint: 'Each piece runs on a different day of the month' },
  { key: '6h', label: 'Every 6 hours', hint: 'Fast regression signal, heavier load' },
  { key: 'daily', label: 'Daily', hint: 'One run per piece per day' },
  { key: 'weekly', label: 'Weekly', hint: 'Light touch' },
  { key: 'custom', label: 'Custom cron', hint: 'Applied to every piece in the batch' },
];

export function ScheduleStep({ value, onChange }: { value: ScheduleConfigInput; onChange: (v: ScheduleConfigInput) => void }) {
  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value.enabled} onChange={e => onChange({ ...value, enabled: e.target.checked })} />
        Auto-schedule the pieces that got approved plans (pieces already on a schedule are left alone)
      </label>
      {value.enabled && (
        <div className="space-y-2">
          {CADENCES.map(c => (
            <label key={c.key} className={`flex items-start gap-3 px-3 py-2 rounded-lg border cursor-pointer ${value.cadence === c.key ? 'border-primary-600 bg-primary-600/10' : 'border-gray-800'}`}>
              <input type="radio" name="cadence" checked={value.cadence === c.key} onChange={() => onChange({ ...value, cadence: c.key })} className="mt-1" />
              <div>
                <div className="text-sm">{c.label}</div>
                <div className="text-xs text-gray-500">{c.hint}</div>
              </div>
            </label>
          ))}
          {value.cadence === 'custom' && (
            <input
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm font-mono"
              placeholder="0 3 * * *"
              value={value.customCron ?? ''}
              onChange={e => onChange({ ...value, customCron: e.target.value })}
            />
          )}
        </div>
      )}
    </div>
  );
}
```

### Task 11: Reshape `BatchSetup.tsx` into the wizard

**Files:**
- Modify: `client/src/pages/BatchSetup.tsx`

- [ ] **Step 1: Add wizard state + history/detail queries**

At the top of the component add step state, schedule config, and the history query. Default schedule = monthly, enabled:

```tsx
type Step = 'connections' | 'generate' | 'schedule' | 'done';
const [step, setStep] = useState<Step>('connections');
const [schedule, setSchedule] = useState<ScheduleConfigInput>({ enabled: true, cadence: 'monthly' });
const [openRunId, setOpenRunId] = useState<number | null>(null);
const { data: setupRuns, refetch: refetchRuns } = useQuery({ queryKey: ['setupRuns'], queryFn: api.getSetupRuns });
```

- [ ] **Step 2: Render the stepper + landing**

When there's no active `batchStatus` and no in-flight wizard, the landing shows **New Setup Run** + `<SetupRunHistory runs={setupRuns ?? []} onOpen={setOpenRunId} />`. A "New Setup Run" button sets `step = 'connections'` and reveals the stepper. Add a thin stepper header (reuse the badge styles already in the file) reflecting `step`.

- Step **connections**: a "Sweep connections" button calling `api.sweepConnections()` then `queryClient.invalidateQueries(['connections'])`; show `getConnectedPieces().length` connected; **Next** → `generate`.
- Step **generate**: the existing selection list + Start button, but call `api.startBatchSetup(Array.from(selected), schedule)`. While running/after, render the existing grouped-progress view (unchanged). **Next** enabled once `batchStatus.status !== 'running'` → `schedule`.
- Step **schedule**: `<ScheduleStep value={schedule} onChange={setSchedule} />`. (Schedules are created server-side when the batch completes, using the config passed at Start; this step is where the user sets it *before* starting — so render `ScheduleStep` on the **generate** step's config panel too, or gate Start until schedule is chosen. Simplest: show `ScheduleStep` collapsed above the Start button on the generate step, and make the explicit **schedule** step a read-only confirmation of what will be/was created.)
- Step **done**: summary counts from `batchStatus` stats + "schedules created" from the `batch_done` event payload; a **View history** button that calls `refetchRuns()` and returns to landing.

> Implementation note: because auto-scheduling happens at batch completion using the config sent to `/start`, the cleanest flow is **Connections → (config: pick pieces + cadence) Generate → Done**. Keep the four-badge stepper for orientation but collect the cadence on the generate step before Start. Do not add a second server round-trip for scheduling.

- [ ] **Step 3: Run detail drawer**

When `openRunId != null`, fetch `api.getSetupRunDetail(openRunId)` and render items grouped by piece (reuse the grouped-by-piece pattern already in the file), showing each target's `status`, `target_type`, and a **View plan** link when `plan_id` is set. A close button clears `openRunId`.

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit -p client/tsconfig.json` then the repo's client build (`npm run build` or the client build script).
Expected: no errors; build succeeds.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all PASS (server + client).

- [ ] **Step 6: Commit Phase 7**

```bash
git add client/src/pages/BatchSetup.tsx client/src/components/SetupRunHistory.tsx client/src/components/SetupRunHistory.test.tsx client/src/components/ScheduleStep.tsx
git commit -m "feat: batch setup wizard UI"
```

---

## Final verification (before handing back for user test)

- [ ] `npx tsc --noEmit -p tsconfig.json` (server) — clean
- [ ] client typecheck + build — clean
- [ ] `npx vitest run` — all green
- [ ] Manual smoke via `npm run dev` (see [[ui-check-headless-browser]] memory for driving the app in this WSL box):
  1. `/batch-setup` landing shows history (empty first time) + New Setup Run.
  2. Connections step: sweep → connected count updates.
  3. Generate step: select 1–2 pieces, cadence = monthly, Start → actions **and** triggers appear, progress runs, plans created.
  4. Completion: monthly schedules created for pieces with an approved plan, each on a distinct day (`0 3 <day> * *`); a piece already scheduled is untouched.
  5. History: the run appears with correct rollups; opening it shows per-target detail with plan links.
- [ ] Do **not** push or open a PR — leave for the user to test (per project convention).

## Self-review notes (coverage)

- Spec §"Persistence" → Tasks 1–2. §"Generate stage" (triggers + write-through) → Tasks 5–6. §"Schedule stage" (monthly staggered, skip existing, skippable) → Tasks 3–4, 6, 10. §"History view" → Tasks 7, 9, 11. §"Shape: wizard" → Task 11. Dependency on sweep → reused in Task 11 (already on `main`).
- Types are consistent across tasks: `Cadence`, `SetupRunRow`/`SetupRunItemRow` (server), `SetupRunSummary`/`SetupRunItem`/`ScheduleConfigInput` (client), `BatchQueueItem.targetType`.
