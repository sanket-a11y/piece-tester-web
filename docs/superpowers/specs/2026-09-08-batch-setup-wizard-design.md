# Unified Batch Setup wizard

**Date:** 2026-09-08
**Branch:** `feat/batch-setup-wizard` (off `main`)
**Status:** Design — pending user review

## Goal

Turn today's scattered setup steps into one guided flow: import connections →
AI-generate test plans for whole pieces → put those pieces on a recurring
schedule. Every stage leaves a **persistent, browsable record** of what the AI
produced, so a run can be reviewed days later — not just watched live.

"AFX" in the original ask = **AI-driven** plan generation (the agent layer that
already drafts plans). The new value is the *unified flow* plus *tracking*, not a
new generation engine.

## Language (per CONTEXT.md)

- **Piece** — the unit under test. **Target** — an action or trigger of a piece.
- **Test plan** — the steps that exercise one target. **Plan run** — one execution.
- **Schedule** — a cron rule that fires plan runs. **Connection** — stored creds.
- New term: **Setup run** — one pass of the wizard for a chosen set of pieces;
  the unit the new history rolls up.

## Shape: a guided wizard

Replace the current `/batch-setup` page (`BatchSetup.tsx`) with a wizard.

**Landing view:** a list of **Recent Setup Runs** (history) + a **New Setup Run**
button. Clicking a past run opens its detail (per-target outcomes + created
schedules).

**A run steps through four stages:**

1. **Connections** — reuse the existing naming-convention **sweep**
   (`POST /connections/sweep`, `connection-sweep.ts`, merged to `main` via #32).
   Shows "N pieces connected." The candidate set for the run = connected pieces.
2. **Generate plans** — select connected pieces (Select-all supported). AI
   generates plans for **actions + triggers**. Runs server-side, survives
   navigation/reload, live per-piece progress.
3. **Schedule** — auto-create per-piece schedules for pieces that got approved
   plans (see below).
4. **Done** — a summary; the setup run is already persisted, this just closes it out.

The wizard is linear but resumable: a run in progress can be re-entered from the
landing view.

## Persistence / tracking (core new work)

Two new tables (`server/src/db/schema.ts`):

```
setup_runs
  id INTEGER PK
  status TEXT            -- running | done | cancelled
  cadence TEXT           -- monthly | 6h | daily | weekly | custom | none
  cron_template TEXT     -- resolved cron for non-per-piece parts / custom
  config TEXT            -- JSON: { scheduleEnabled, pieceNames, ... }
  piece_count INTEGER
  target_count INTEGER
  plans_created INTEGER
  plans_skipped INTEGER
  plans_errored INTEGER
  schedules_created INTEGER
  started_at TEXT
  completed_at TEXT
  created_at TEXT DEFAULT (datetime('now'))

setup_run_items
  id INTEGER PK
  setup_run_id INTEGER REFERENCES setup_runs(id) ON DELETE CASCADE
  piece_name TEXT
  target_type TEXT       -- action | trigger
  target_name TEXT
  status TEXT            -- pending | running | done | skipped | error
  plan_id INTEGER        -- nullable, links to the generated plan
  error TEXT             -- nullable
```

Created schedule ids are recorded on the run in a `schedule_ids TEXT` (JSON array)
column on `setup_runs` — lighter than a join table and matches the codebase's
existing "JSON-in-a-column" pattern.

**Write model:** insert the `setup_runs` row + all `setup_run_items` (pending) at
run start; update each item as the batch processes it; finalize rollup counts +
`completed_at` at the end. This makes history durable and lets the live view and
reload-resume both read from the DB (stronger than today's in-memory queue).

## Generate stage

Reuse the existing server-side batch machinery (`plan-jobs.ts` BatchQueue +
`routes/batch-setup.ts`), with two changes:

1. **Include triggers.** Today the queue only iterates `piece.actions`. Also
   enqueue `piece.triggers` as items with `target_type='trigger'`, generated via
   the trigger plan generator the per-piece runner already uses
   (`streamTriggerPlanV2` / the v2 trigger path). Actions keep their current path.
2. **Persist outcomes** into `setup_run_items` as each item settles
   (done/skipped/error + `plan_id`).

Unchanged: sequential processing (one target at a time, API-limit friendly);
already-planned targets marked `skipped`; auto-test + up-to-3 AI-fix loop that
promotes a plan to `approved`.

### Addendum (2026-09-08): per-target selection

The Generate step selects at the **target** level, defaulting to all. Each piece
row expands (lazy `GET /pieces/:name`) to a checklist of its actions + triggers,
all checked by default; deselecting some makes the piece checkbox indeterminate,
deselecting all drops the piece.

- **Contract:** the `/start` payload is `selections: { pieceName; targets? }[]`
  where a selection's `targets` (array of `{type:'action'|'trigger', name}`) is
  **omitted = all**, **present (even `[]`) = exactly those**. Legacy `pieceNames`
  is still accepted (mapped to all-targets) so other callers (e.g. CoverageCockpit)
  keep working.
- **Server:** a pure `itemsForSelection(pieceMeta, selection, existingTargets)`
  (`services/batch-selection.ts`, unit-tested) builds the queue items — keying on
  `targets` *presence*, not length, so an empty array enqueues nothing (never
  "all"). `config.pieceNames` = distinct piece names for schedule eligibility.
- **Client:** the payload is built from a captured `pieceTargetKeys` map (recorded
  when a target is toggled), not the transient React-Query cache — so a piece
  filtered out of view can never emit a truncated/empty target list.

## Schedule stage

For each piece that got **≥1 approved plan** in this run **and has no existing
schedule** (existing schedules are left untouched):

- Create a schedule via the existing `createSchedule` path
  (`db.createSchedule` + `reloadScheduler()`).
- **Default cadence: monthly, staggered per piece.** Each piece gets a distinct
  day-of-month so the batch's runs spread across the month:
  cron `0 <hour> <day> * *`, `day` assigned round-robin over `1..28` across the
  batch's pieces (wrap if >28). Hour is fixed at a single default (`03` UTC) since
  the day already spreads the load.
- The cadence selector also offers **6h / daily / weekly / custom cron**; monthly
  is the default. For non-monthly cadences the per-piece-day rule doesn't apply —
  all pieces share the chosen cron (no staggering); a follow-up can add hour
  staggering if load becomes an issue.
- A **"Skip scheduling"** toggle; scheduling defaults **ON**.
- Record created schedule ids on the setup run; count into `schedules_created`.

Note (planning): schedules are keyed by `piece_name` only, so per-piece = one
schedule row per piece covering all its targets — consistent with existing
whole-piece schedules.

## Out of scope

- No new AI generation engine; reuse the agent layer as-is.
- No change to how plans run or how the scheduler fires (only new schedule rows).
- Per-target scheduling, per-piece cadence overrides — not now (one cadence per run).
- The per-piece "Set up All with AI" button stays; this wizard is the multi-piece surface.

## Dependencies & sequencing

- **Sweep** (`connection-sweep.ts`, `POST /connections/sweep`) — already on `main`.
- Build order (phased, each independently testable):
  1. Persistence layer (`setup_runs` / `setup_run_items` schema + queries + rollups).
  2. Generate stage: triggers in the batch queue + write-through to `setup_run_items`.
  3. Schedule stage: day-of-month assignment + auto-create + skip-existing.
  4. Wizard UI (4 steps) + Recent Setup Runs history + run detail.

## Testing

TDD for pure logic: day-of-month assignment (round-robin, wrap, stagger),
rollup counting, item state transitions, skip-existing-schedule rule. Vitest as
usual; server + client suites must stay green, `tsc --noEmit` clean, client build ok.

## Commit style

Small, grouped commits (one logical group each; short messages). Do not commit
feature code until the user has tested it.
