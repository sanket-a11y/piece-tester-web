# Linear report template + honest error extraction

**Date:** 2026-09-09
**Status:** Approved

## Problem

Linear issues filed to the piece team (via the "Report to Pieces team" flow) show a
truncated raw JSON blob instead of the real error, e.g.:

```
Error: {"status":"FAILED","errorMessage":"{"__apErrorVersion":1,"message":"Invalid Request: reaction m...
```

Two independent bugs cause this:

1. **Bad extraction.** `extractFirstStepError` (`server/src/db/queries.ts`) digs one JSON
   level for `.message`, but AP wraps the real message two levels deep:
   `{status:"FAILED", errorMessage:"{__apErrorVersion, message, code, status}", output}`.
   It never reaches `message`, so it keeps the raw wrapper and hard-truncates at 100 chars.
   The wrapper is built in `ai-config-generator.ts:610`
   (`throw new Error(JSON.stringify({ status, errorMessage, output }))`) and stored verbatim
   as the step's `error` by `plan-executor.ts:679`.
2. **Inline rendering.** `buildReportDraft` (`server/src/services/report-draft.ts`) renders
   the blob as a single `**Error:** …` line, which Linear visually clips.

## Goals

- The piece team sees the real, untruncated error: a clean one-line headline plus the full
  raw payload in a code block.
- Add piece **version** and the AP **error code / HTTP status** when available.
- Fix the extraction once, shared between the Linear report and the Health board.

Non-goals: deep-linking the failing run into the AP instance (deferred); changing the
`PieceHealthRow` shape; any LLM involvement in extraction.

## Component 1 — shared parser `server/src/services/ap-error.ts`

One pure function, the single correct parser both surfaces use:

```ts
export interface ParsedApError { message: string; code?: string; status?: number; raw: string; }
export function parseApError(raw: string): ParsedApError;
```

Extraction order (deterministic, no LLM, no fabrication):

- Parse outer JSON. Pull the human message, in priority:
  1. nested `errorMessage` — if JSON-parseable use its `.message`, else the string itself;
  2. `params.standardError` (trigger `onEnable`/`onDisable` case, per the AP-error-surfacing note);
  3. top-level `.message` (Fastify validation).
- `code` / `status`: only from the nested AP error's `code` and `status`/`statusCode` when
  present — **omitted when absent**. The outer `status:"FAILED"` is a run status, not HTTP,
  and is ignored.
- `raw`: the full original, pretty-printed (`JSON.stringify(parsed, null, 2)`) when it's JSON,
  so the code block is readable and untruncated; otherwise the raw string.
- Non-JSON input → `{ message: firstLine(raw), raw }`.

## Component 2 — report wiring (`server/src/routes/reports.ts`, `report-draft.ts`)

- `FailingTarget.error` changes type `string | null` → `ParsedApError | null`.
- `gatherFinding` stops reusing the Health board's truncated preview. For each failing action
  it loads the full run via `getPlanRun(fa.run_id)`, takes `step_results`, finds the first
  `failed`/`assert_failed` step's raw `error`, and runs `parseApError` on it (untruncated).
  Falls back to wrapping the existing `fa.error` string as `{ message, raw }` if the run row
  is gone.
- Version: best-effort `getPieceMetadata(piece_name).version`; omit on any failure. This makes
  `/report/preview` async (trivial — the router is already async-capable).

### Template layout (`buildReportDraft`)

Per failing target:

```
### `create_message_reaction` — bad_request

**Invalid Request: reaction must be a valid emoji**

`BAD_REQUEST` · HTTP 400

```json
{ ... pretty-printed raw ... }
```

**Run:** #3684

**Reproduction (test plan):**
1. …
```

Layout rules:

| Element | Behavior |
|---|---|
| `**Piece:**` line | Appends `(v…)` only when a version was fetched; omitted otherwise. |
| Bold headline | `parseApError().message`, never truncated. |
| `` `CODE` · HTTP nnn `` line | Rendered only when `code` and/or `status` present; dropped entirely if neither. |
| ` ```json ` block | Pretty raw error. Non-JSON raw → plain ` ``` ` block. |
| `**Run:**` | Plain `#3684` text (no deep link). |
| Reproduction | Unchanged. |

Titles unchanged: single-target `clickup / <action> failing (<category>)`; multi-target
`clickup failing (<category>)`.

## Component 3 — Health board reuse (`server/src/db/queries.ts`)

`extractFirstStepError` becomes a thin wrapper: `parseApError(raw).message`, then the existing
`.slice(0, 100) + '…'` cap. Board previews start showing real messages, capped as before. No
shape change to `PieceHealthRow`.

## Testing

- **`ap-error.test.ts`** — parser against 5 real fixtures: clickup `bad_request`,
  `not_found` 404, trigger `standardError`, plain-string error, non-JSON garbage. Assert
  `message`/`code`/`status`, and that `code`/`status` are `undefined` when absent.
- **`report-draft.test.ts`** — extend: headline uses `message`; `code · HTTP` line
  present-when-present / absent-when-absent; ` ```json ` block contains the pretty raw;
  version suffix only when set. Existing title/label/priority tests updated for the new
  `error` shape.
- **queries health test** — one case asserting the nested-wrapper input previews the real
  message, not the raw blob.

No new dependencies. All changes are server-side; the modal renders the returned markdown
unchanged.
