# Linear Report Template + Honest Error Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Linear issues filed to the piece team show the real, untruncated error (clean headline + full raw payload in a code block) plus piece version and AP error code/HTTP status, and fix the underlying error extraction once so the Health board benefits too.

**Architecture:** A new pure module `ap-error.ts` exposes `parseApError(raw)` that digs through AP's `{status, errorMessage, output}` wrapper (and the nested `{__apErrorVersion, message, code, status}` JSON) to a `{message, code?, status?, raw}` shape. The Health board's `extractFirstStepError` and the Linear report path both consume it. The report path pulls the untruncated error from the failing run's full `step_results` (via `getPlanRun`) rather than the 100-char board preview, and best-effort fetches the piece version.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node/Express server, better-sqlite3, Vitest. Tests run from repo root with `npx vitest run <path>`.

**Spec:** `docs/superpowers/specs/2026-09-09-linear-report-template-design.md`

---

## File Structure

- **Create** `server/src/services/ap-error.ts` — pure `parseApError` parser + `ParsedApError` type. No I/O.
- **Create** `server/src/services/ap-error.test.ts` — parser unit tests (5 fixtures).
- **Modify** `server/src/db/queries.ts` — add exported `firstFailedStepError(json)`; rewrite `extractFirstStepError` to reuse `parseApError`.
- **Create** `server/src/db/queries.error.test.ts` — tests for the two extractors.
- **Modify** `server/src/services/report-draft.ts` — `FailingTarget.error` becomes `ParsedApError | null`; new template rendering.
- **Modify** `server/src/services/report-draft.test.ts` — update fixtures to new error shape; add layout assertions.
- **Modify** `server/src/routes/reports.ts` — `gatherFinding` becomes async, pulls untruncated error + version; `/report/preview` and `/report` await it.

---

## Task 1: `parseApError` shared parser

**Files:**
- Create: `server/src/services/ap-error.ts`
- Test: `server/src/services/ap-error.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/src/services/ap-error.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseApError } from './ap-error.js';

describe('parseApError', () => {
  it('digs through the AP wrapper + nested errorMessage JSON', () => {
    const inner = JSON.stringify({ __apErrorVersion: 1, message: 'Invalid Request: reaction must be a valid emoji', code: 'BAD_REQUEST', status: 400 });
    const raw = JSON.stringify({ status: 'FAILED', errorMessage: inner, output: null });
    const p = parseApError(raw);
    expect(p.message).toBe('Invalid Request: reaction must be a valid emoji');
    expect(p.code).toBe('BAD_REQUEST');
    expect(p.status).toBe(400);
    expect(p.raw).toContain('"__apErrorVersion": 1');
    expect(p.raw).toContain('"code": "BAD_REQUEST"');
  });

  it('handles a 404 not_found nested error', () => {
    const inner = JSON.stringify({ __apErrorVersion: 1, message: '404 page not found', code: 'NOT_FOUND', status: 404 });
    const raw = JSON.stringify({ status: 'FAILED', errorMessage: inner, output: null });
    const p = parseApError(raw);
    expect(p.message).toBe('404 page not found');
    expect(p.status).toBe(404);
  });

  it('extracts a trigger params.standardError message with no code/status', () => {
    const raw = JSON.stringify({ code: 'TRIGGER_UPDATE_STATUS', params: { standardError: 'Upstream API returned 500' } });
    const p = parseApError(raw);
    expect(p.message).toBe('Upstream API returned 500');
    expect(p.code).toBeUndefined();
    expect(p.status).toBeUndefined();
  });

  it('handles a plain-string errorMessage (no nested JSON)', () => {
    const raw = JSON.stringify({ status: 'FAILED', errorMessage: 'Cannot read properties of undefined', output: null });
    const p = parseApError(raw);
    expect(p.message).toBe('Cannot read properties of undefined');
    expect(p.code).toBeUndefined();
    expect(p.status).toBeUndefined();
  });

  it('falls back to the first line for non-JSON input', () => {
    const p = parseApError('Timed out after 90s\nstack trace line');
    expect(p.message).toBe('Timed out after 90s');
    expect(p.raw).toBe('Timed out after 90s\nstack trace line');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/src/services/ap-error.test.ts`
Expected: FAIL — `Failed to resolve import "./ap-error.js"` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `server/src/services/ap-error.ts`:

```ts
/**
 * Parse a piece's failure into a human message + optional AP error code/HTTP status.
 * Pure — no I/O. Both the Health board and the Linear report path use this so a red is
 * read the same way everywhere.
 *
 * The stored step error is the wrapper built in ai-config-generator.ts:
 *   { status: 'FAILED', errorMessage: <string, often JSON>, output: <step output> }
 * and AP's real error is usually a JSON string two levels deep:
 *   { __apErrorVersion, message, code, status }
 */
export interface ParsedApError {
  message: string;
  code?: string;
  status?: number;
  raw: string; // full detail, pretty-printed when JSON, for a code block
}

const firstLine = (s: string): string => s.split('\n')[0].trim();
const pretty = (o: unknown): string => {
  try { return JSON.stringify(o, null, 2); } catch { return String(o); }
};

export function parseApError(raw: string): ParsedApError {
  let outer: any;
  try { outer = JSON.parse(raw); } catch { return { message: firstLine(raw), raw }; }

  // 1. AP wrapper: dig into errorMessage (parse it as JSON when possible).
  if (outer && outer.errorMessage != null) {
    let nested: any = outer.errorMessage;
    if (typeof nested === 'string') {
      try { nested = JSON.parse(nested); } catch { /* plain string, keep as-is */ }
    }
    if (nested && typeof nested === 'object') {
      const status = typeof nested.status === 'number' ? nested.status
        : typeof nested.statusCode === 'number' ? nested.statusCode : undefined;
      return {
        message: typeof nested.message === 'string' ? nested.message : firstLine(String(outer.errorMessage)),
        code: typeof nested.code === 'string' ? nested.code : undefined,
        status,
        raw: pretty(nested),
      };
    }
    return { message: firstLine(String(outer.errorMessage)), raw: pretty(outer) };
  }

  // 2. Trigger onEnable/onDisable failure: the real error is in params.standardError.
  if (outer?.params?.standardError) {
    return { message: firstLine(String(outer.params.standardError)), raw: pretty(outer) };
  }

  // 3. Fastify validation and similar: top-level message.
  if (typeof outer?.message === 'string') {
    return { message: firstLine(outer.message), raw: pretty(outer) };
  }

  return { message: firstLine(raw), raw: pretty(outer) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/src/services/ap-error.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/ap-error.ts server/src/services/ap-error.test.ts
git commit -m "feat: parseApError shared error parser"
```

---

## Task 2: Reuse the parser in the Health board extractor

**Files:**
- Modify: `server/src/db/queries.ts:721-732` (the `extractFirstStepError` function)
- Test: `server/src/db/queries.error.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/src/db/queries.error.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { firstFailedStepError, extractFirstStepError } from './queries.js';

const wrapper = JSON.stringify({
  status: 'FAILED',
  errorMessage: JSON.stringify({ __apErrorVersion: 1, message: 'Invalid Request: reaction must be a valid emoji', code: 'BAD_REQUEST', status: 400 }),
  output: null,
});
const stepResults = JSON.stringify([{ stepId: 's1', status: 'failed', error: wrapper }]);

describe('firstFailedStepError', () => {
  it('returns the raw error string of the first failed step', () => {
    expect(firstFailedStepError(stepResults)).toBe(wrapper);
  });
  it('returns null when there is no failed step', () => {
    expect(firstFailedStepError(JSON.stringify([{ stepId: 's1', status: 'completed', error: null }]))).toBeNull();
  });
});

describe('extractFirstStepError', () => {
  it('previews the real message, not the raw wrapper', () => {
    expect(extractFirstStepError(stepResults)).toBe('Invalid Request: reaction must be a valid emoji');
  });
  it('caps the preview at 100 chars', () => {
    const long = 'x'.repeat(150);
    const sr = JSON.stringify([{ status: 'failed', error: long }]);
    const out = extractFirstStepError(sr)!;
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(101);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/src/db/queries.error.test.ts`
Expected: FAIL — `firstFailedStepError` is not exported; and `extractFirstStepError` currently returns the raw wrapper (not the real message).

- [ ] **Step 3: Add the parser import**

In `server/src/db/queries.ts`, add near the other service imports at the top of the file (place it with existing imports):

```ts
import { parseApError } from '../services/ap-error.js';
```

- [ ] **Step 4: Replace the `extractFirstStepError` function**

Replace the whole function at `server/src/db/queries.ts:721-732`:

```ts
function extractFirstStepError(stepResultsJson: string): string | null {
  try {
    const steps = JSON.parse(stepResultsJson);
    if (!Array.isArray(steps)) return null;
    const failed = steps.find((s: any) => s && (s.status === 'failed' || s.status === 'assert_failed') && s.error);
    if (!failed) return null;
    let msg = String(failed.error);
    try { const o = JSON.parse(msg); if (o && typeof o.message === 'string') msg = o.message; } catch { /* not JSON */ }
    msg = msg.split('\n')[0].trim();
    return msg.length > 100 ? msg.slice(0, 100) + '…' : msg;
  } catch { return null; }
}
```

with:

```ts
/** Raw (untruncated, uncleaned) error string of the first failed/assert_failed step. */
export function firstFailedStepError(stepResultsJson: string): string | null {
  try {
    const steps = JSON.parse(stepResultsJson);
    if (!Array.isArray(steps)) return null;
    const failed = steps.find((s: any) => s && (s.status === 'failed' || s.status === 'assert_failed') && s.error);
    return failed ? String(failed.error) : null;
  } catch { return null; }
}

/** 100-char cleaned preview of the first failed step's error, for the Health board. */
export function extractFirstStepError(stepResultsJson: string): string | null {
  const raw = firstFailedStepError(stepResultsJson);
  if (raw == null) return null;
  const msg = parseApError(raw).message;
  return msg.length > 100 ? msg.slice(0, 100) + '…' : msg;
}
```

Note: `extractFirstStepError` gains an `export` (was module-private). Its existing caller `getPieceHealth` (`server/src/db/queries.ts:805`) is unchanged.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run server/src/db/queries.error.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the broader queries + health suite to confirm no regression**

Run: `npx vitest run server/src/db/`
Expected: PASS (all existing db tests, including `queries.health.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add server/src/db/queries.ts server/src/db/queries.error.test.ts
git commit -m "feat: Health board reuses parseApError for honest previews"
```

---

## Task 3: New report-draft template + typed error

**Files:**
- Modify: `server/src/services/report-draft.ts`
- Test: `server/src/services/report-draft.test.ts`

- [ ] **Step 1: Update the existing tests to the new error shape and add layout assertions**

Replace the whole contents of `server/src/services/report-draft.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildReportDraft } from './report-draft.js';

const base = {
  piece_name: '@activepieces/piece-streak',
  failing_targets: [
    {
      action: 'create-box',
      category: 'piece_error',
      error: { message: "Cannot read 'id'", raw: "Cannot read 'id'" },
      run_id: 42,
      reproduction: ['Create box {name:"x"}', 'Expect 200'],
    },
  ],
};

describe('buildReportDraft', () => {
  it('names the single failing target in the title', () => {
    expect(buildReportDraft(base).title).toBe('streak / create-box failing (piece_error)');
  });

  it('uses a piece-level title for multiple targets', () => {
    const d = buildReportDraft({ ...base, failing_targets: [
      base.failing_targets[0],
      { action: 'get-box', category: 'piece_error', error: null, run_id: 43, reproduction: [] },
    ] });
    expect(d.title).toBe('streak failing (piece_error)');
  });

  it('derives the piece label', () => {
    expect(buildReportDraft(base).label).toBe('piece:streak');
  });

  it('maps piece_error to Linear High priority (2)', () => {
    expect(buildReportDraft(base).priority).toBe(2);
  });

  it('maps a non-piece_error category to Medium priority (3)', () => {
    const d = buildReportDraft({ ...base, failing_targets: [{ ...base.failing_targets[0], category: 'assert_failed' }] });
    expect(d.priority).toBe(3);
  });

  it('renders the clean headline, run ref, and reproduction', () => {
    const d = buildReportDraft(base);
    expect(d.description).toContain("**Cannot read 'id'**");
    expect(d.description).toContain('#42');
    expect(d.description).toContain('1. Create box');
  });

  it('renders code + HTTP status line only when present', () => {
    const withCode = buildReportDraft({ ...base, failing_targets: [{
      ...base.failing_targets[0],
      error: { message: 'Invalid Request', code: 'BAD_REQUEST', status: 400, raw: '{\n  "code": "BAD_REQUEST"\n}' },
    }] });
    expect(withCode.description).toContain('`BAD_REQUEST` · HTTP 400');
    expect(withCode.description).toContain('```json');
    // The plain-error base has no code/status → no code line.
    expect(buildReportDraft(base).description).not.toContain('HTTP');
  });

  it('uses a plain code fence when the raw error is not JSON', () => {
    const d = buildReportDraft(base);
    expect(d.description).toContain('```\n');
    expect(d.description).not.toContain('```json');
  });

  it('appends the piece version only when provided', () => {
    expect(buildReportDraft({ ...base, version: '0.4.2' }).description).toContain('(v0.4.2)');
    expect(buildReportDraft(base).description).not.toContain('(v');
  });

  it('renders upstream authors when provided', () => {
    expect(buildReportDraft({ ...base, authors: ['sanket-a11y'] }).description).toContain('@sanket-a11y');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/src/services/report-draft.test.ts`
Expected: FAIL — headline/code-line/fence assertions fail against the current inline `**Error:** …` rendering; TypeScript-shaped `error` object no longer matches the old `string` field.

- [ ] **Step 3: Update the `FailingTarget` type and the renderer**

In `server/src/services/report-draft.ts`, add the import at the top:

```ts
import type { ParsedApError } from './ap-error.js';
```

Change the `FailingTarget` interface `error` field:

```ts
export interface FailingTarget {
  action: string;
  category: string;
  error: ParsedApError | null;
  run_id: number;
  reproduction: string[];   // human-readable plan-step lines
}
```

Replace the per-target rendering loop (the `for (const t of targets) { … }` block) with:

```ts
  for (const t of targets) {
    lines.push('');
    lines.push(`### \`${t.action}\` — ${t.category}`);
    if (t.error) {
      lines.push('');
      lines.push(`**${t.error.message}**`);
      const codeStatus = [
        t.error.code ? `\`${t.error.code}\`` : null,
        typeof t.error.status === 'number' ? `HTTP ${t.error.status}` : null,
      ].filter(Boolean);
      if (codeStatus.length) { lines.push(''); lines.push(codeStatus.join(' · ')); }
      const isJson = /^[\s]*[[{]/.test(t.error.raw);
      lines.push('');
      lines.push('```' + (isJson ? 'json' : ''));
      lines.push(t.error.raw);
      lines.push('```');
    }
    lines.push('');
    lines.push(`**Run:** #${t.run_id}`);
    if (t.reproduction.length) {
      lines.push('**Reproduction (test plan):**');
      t.reproduction.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
    }
  }
```

The `**Piece:**` line already appends `(v${finding.version})` when `finding.version` is set — no change needed there.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/src/services/report-draft.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/report-draft.ts server/src/services/report-draft.test.ts
git commit -m "feat: richer Linear report template with clean error + code block"
```

---

## Task 4: Wire the untruncated error + version into the report path

**Files:**
- Modify: `server/src/routes/reports.ts` (import block `2-28`; `gatherFinding` `337-349`; `/report/preview` `352-367`; `/report` line `380`)

- [ ] **Step 1: Add the new imports**

In `server/src/routes/reports.ts`, add `firstFailedStepError` to the existing `../db/queries.js` import block (alongside `getPlanRun`, `getTestPlan`):

```ts
  getPlanRun,
  getTestPlan,
  firstFailedStepError,
```

Then add two new import lines after the `report-transport.js` import (line 32):

```ts
import { parseApError } from '../services/ap-error.js';
import { createClient } from '../services/test-engine.js';
```

- [ ] **Step 2: Make `gatherFinding` async, untruncated, and version-aware**

Replace `gatherFinding` (`server/src/routes/reports.ts:337-349`) with:

```ts
/** Assemble a ReportFinding for a piece from its current health + test-plan steps. */
async function gatherFinding(pieceName: string): Promise<ReportFinding | null> {
  const piece = getPieceHealth().find(p => p.piece_name === pieceName);
  if (!piece || piece.failing_actions.length === 0) return null;
  const failing_targets = piece.failing_actions.map(fa => {
    let reproduction: string[] = [];
    try {
      const steps = JSON.parse(getTestPlan(fa.plan_id)?.steps || '[]');
      if (Array.isArray(steps)) reproduction = steps.map((s: any) => String(s.label || s.actionName || s.id || 'step'));
    } catch { /* ignore malformed steps */ }
    // Prefer the full run's step_results (untruncated); fall back to the board preview.
    const raw = firstFailedStepError(getPlanRun(fa.run_id)?.step_results || '') ?? fa.error;
    const error = raw ? parseApError(raw) : null;
    return { action: fa.action, category: fa.category, error, run_id: fa.run_id, reproduction };
  });
  // Best-effort current piece version; omit if the AP client is unconfigured/unreachable.
  let version: string | null = null;
  try { version = (await createClient().getPieceMetadata(pieceName)).version ?? null; } catch { /* omit */ }
  return { piece_name: pieceName, failing_targets, version };
}
```

- [ ] **Step 3: Await `gatherFinding` in `/report/preview`**

In `server/src/routes/reports.ts`, change the `/report/preview` handler (`352`) to `async` and await the call:

```ts
router.post('/report/preview', async (req, res) => {
  try {
    const { piece_name } = req.body;
    if (!piece_name) { res.status(400).json({ error: 'piece_name is required' }); return; }
    const finding = await gatherFinding(piece_name);
    if (!finding) { res.status(404).json({ error: 'No failing actions for this piece' }); return; }
    const existing = getOpenReportForPiece(piece_name);
    res.json({
      draft: buildReportDraft(finding),
      mode: existing ? 'comment' : 'create',
      existing: existing ? { linear_url: existing.linear_url, linear_issue_id: existing.linear_issue_id } : null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Await `gatherFinding` in `/report`**

In `server/src/routes/reports.ts:380`, change:

```ts
    const category = gatherFinding(piece_name)?.failing_targets[0]?.category || existing?.error_category || 'piece_error';
```

to:

```ts
    const category = (await gatherFinding(piece_name))?.failing_targets[0]?.category || existing?.error_category || 'piece_error';
```

- [ ] **Step 5: Run the full test suite to confirm nothing regressed**

Run: `npx vitest run`
Expected: PASS — all pre-existing tests plus the new `ap-error`, `queries.error`, and updated `report-draft` tests.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/reports.ts
git commit -m "feat: report path pulls untruncated error + piece version"
```

---

## Task 5: Manual smoke test (user-driven)

**No commit.** The pure/unit layers are covered by Tasks 1–4; this task confirms the end-to-end render against a real failing piece.

- [ ] **Step 1: Start the app**

Run: `npm start` (see the `ui-check-headless-browser` memory for driving the UI in this WSL box).

- [ ] **Step 2: Trigger a report preview**

On the Health tab, open a piece that has a failing action (e.g. a clickup `bad_request`) and click "Report to Pieces team". In the modal, confirm:
- the error shows a bold one-line headline (e.g. **Invalid Request: reaction must be a valid emoji**), not a truncated `{"status":"FAILED"…` blob;
- a `` `BAD_REQUEST` · HTTP 400 `` line appears when the AP error carries a code/status;
- the full raw error is inside a ` ```json ` block;
- the `**Piece:**` line shows `(v…)` when the version fetch succeeds.

- [ ] **Step 3: Report the result**

If it renders correctly, the feature is done — hold the branch for the user to file a real test issue before pushing/merging (per the "commit-after-testing" convention, nothing is pushed until the user confirms).

---

## Self-Review Notes

- **Spec coverage:** Component 1 → Task 1; Component 3 (Health board) → Task 2; Component 2 template → Task 3; Component 2 wiring (untruncated error + version + async routes) → Task 4; testing section → Tasks 1–4 + Task 5 smoke. All covered.
- **Type consistency:** `ParsedApError` defined in Task 1 and imported as a type in Tasks 3–4; `firstFailedStepError`/`extractFirstStepError` signatures in Task 2 match their use in Tasks 2 & 4; `FailingTarget.error: ParsedApError | null` in Task 3 matches the object built in Task 4's `gatherFinding`.
- **Fallback path:** Task 4's `firstFailedStepError(...) ?? fa.error` relies on `fa.error` being `string | null` on `PieceHealthRow` (unchanged by this plan — the type change is only on `report-draft.ts`'s `FailingTarget`). Confirmed consistent.
