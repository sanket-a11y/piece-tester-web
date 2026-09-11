# Discord Alerts — Core (Plan 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shared Discord channel receives one self-editing message per *confirmed* piece bug found by a scheduled sweep — verified by immediate inline retest (not by waiting for the next fire), deduplicated per target, auto-recovered when it goes green, storm-guarded against outages, and acknowledgeable from a link.

**Architecture:** After a scheduled wave finishes each plan run, a wave-level driver inspects the outcome. Piece-implicating failures are retested inline (reusing `executePlan` with `trigger_type='retest'`); the result drives a small state machine (`verifying → confirmed | recovered`) persisted in a new `alerts` table and mirrored to Discord by posting (`POST …?wait=true`) then editing (`PATCH …/messages/{id}`) a single message. Env-noise categories, quarantined targets, and duplicate failures never post. A per-wave circuit breaker collapses mass failures into one outage summary. All Discord I/O and the state machine take injected dependencies so they unit-test without network or DB.

**Tech Stack:** Node/TS server, Express routes, better-sqlite3 (via `DatabaseAdapter`), React/TS client, Vitest (`pool: 'forks'`, shared on-disk `data/test.db`), native `fetch`.

**Spec:** `docs/superpowers/specs/2026-09-11-discord-alerts-design.md`. This plan covers spec §§4–13 for the event-alert path and storm guard; the dead-man's-switch (§5.6) and daily reauth digest (§5.7) and Phase-2 buttons (§8) are **Plan 2**.

**Deferred to Plan 2 (do NOT build here):** the watchdog loop, dead-man's-switch, daily reauth digest, real in-Discord interactive buttons. (The settings for the reauth digest time are added now so there's only one schema migration.)

---

## File Structure

**New files:**
- `server/src/services/notifier.ts` — Discord transport (`postDiscordMessage`, `editDiscordMessage`) + message builders (`alertEmbed`, `stormEmbed`) + `errorSignature`. No DB, no app state; injectable `fetch`.
- `server/src/services/notifier.test.ts` — unit tests for transport (mock fetch) + builders + signature.
- `server/src/services/alert-engine.ts` — the wave-level state-machine driver (`newWaveState`, `processRunAlert`, `finalizeWaveAlerts`) + `retestTarget` + run-outcome analysis; all logic takes an injected `AlertDeps`.
- `server/src/services/alert-engine.test.ts` — drives the state machine with fake deps (no network/DB).
- `server/src/routes/alerts.ts` — `POST /api/alerts/:id/acknowledge`.
- `server/src/db/alerts.queries.test.ts` — DB-backed tests for the alert queries.

**Modified files:**
- `server/src/db/schema.ts` — one migration block: new `settings` columns + the `alerts` table.
- `server/src/db/queries.ts` — `SettingsRow` fields; `updateSettings` UPDATE list; new `AlertRow` type + alert CRUD.
- `server/src/routes/settings-view.ts` — `SettingsForView` fields + `maskedSettings` output.
- `server/src/routes/settings.ts` — PUT whitelist + `POST /test-notification` + `POST /remove-notify-webhook`.
- `server/src/services/test-engine.ts` — `runScheduledTests` awaits each plan run, then drives alerts + finalizes the wave.
- `server/src/index.ts` — mount `/api/alerts`; add top-level `GET /ack/:id` HTML page before the static fallback.
- `client/src/lib/api.ts` — `removeNotifyWebhook`, `testNotification`.
- `client/src/pages/Settings.tsx` — a "Discord alerts" section cloned from the Linear-webhook section.

---

## Milestone 1 — Settings plumbing (configure a webhook, send a test alert)

### Task 1.1: Schema migration — settings columns + `alerts` table

**Files:**
- Modify: `server/src/db/schema.ts` (inside `initTables`, alongside the existing `ALTER TABLE settings ADD COLUMN …` migration blocks near line 41)

- [ ] **Step 1: Add the migration block**

Insert after the existing settings column migrations (the `anthropic_api_key` block around `server/src/db/schema.ts:47-51`), matching the existing `pragma table_info` pattern:

```typescript
// Migration: Discord alert settings
for (const [col, ddl] of [
  ['notify_webhook_url',       `ALTER TABLE settings ADD COLUMN notify_webhook_url TEXT NOT NULL DEFAULT ''`],
  ['notify_enabled',           `ALTER TABLE settings ADD COLUMN notify_enabled INTEGER NOT NULL DEFAULT 0`],
  ['notify_storm_threshold',   `ALTER TABLE settings ADD COLUMN notify_storm_threshold INTEGER NOT NULL DEFAULT 8`],
  ['notify_retest_count',      `ALTER TABLE settings ADD COLUMN notify_retest_count INTEGER NOT NULL DEFAULT 2`],
  ['notify_reauth_digest_time',`ALTER TABLE settings ADD COLUMN notify_reauth_digest_time TEXT NOT NULL DEFAULT '09:00'`],
] as const) {
  const c = db.pragma(`table_info(settings)`) as { name: string }[];
  if (!c.some(x => x.name === col)) db.exec(ddl);
}
```

- [ ] **Step 2: Add the `alerts` table**

Add a `CREATE TABLE IF NOT EXISTS` block inside `initTables` (same style as the other tables, e.g. `quarantined_items` at `server/src/db/schema.ts:310`):

```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    piece_name TEXT NOT NULL,
    target_action TEXT,
    target_type TEXT,
    error_signature TEXT NOT NULL DEFAULT '',
    error_category TEXT,
    error_message TEXT,
    status TEXT NOT NULL DEFAULT 'verifying',
    discord_message_id TEXT,
    first_seen_at TEXT DEFAULT (datetime('now')),
    last_seen_at TEXT DEFAULT (datetime('now')),
    confirmed_at TEXT,
    acknowledged_at TEXT,
    acknowledged_by TEXT,
    recovered_at TEXT,
    fail_count INTEGER NOT NULL DEFAULT 1,
    last_run_id INTEGER,
    last_wave_id TEXT,
    schedule_id INTEGER
  );
`);
```

- [ ] **Step 3: Verify tables build**

Run: `rm -f data/test.db && DB_PATH=./data/test.db node -e "import('./server/src/db/schema.js').then(m=>{m.getDb().all('SELECT name FROM sqlite_master WHERE type=\"table\" AND name=\"alerts\"').length && console.log('alerts OK')}).catch(e=>{console.error(e);process.exit(1)})"`

(If the project runs TS directly, use `npx tsx -e "import('./server/src/db/schema.ts')…"` instead.) Expected: prints `alerts OK` with no error. If your environment can't run this one-liner, defer verification to Task 1.2's test which exercises the columns.

- [ ] **Step 4: Commit**

```bash
git add server/src/db/schema.ts
git commit -m "feat(alerts): add settings columns + alerts table"
```

### Task 1.2: `SettingsRow` fields + `updateSettings` persists them

**Files:**
- Modify: `server/src/db/queries.ts` (`SettingsRow` interface at lines 7-30; `updateSettings` UPDATE at lines 36-83)
- Test: `server/src/db/alerts.queries.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `server/src/db/alerts.queries.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './schema.js';
import { getSettings, updateSettings } from './queries.js';

describe('notify settings', () => {
  beforeEach(() => {
    getDb().run(`UPDATE settings SET notify_webhook_url='', notify_enabled=0, notify_storm_threshold=8, notify_retest_count=2 WHERE id=1`);
  });

  it('round-trips the discord webhook + toggles', () => {
    updateSettings({ notify_webhook_url: 'https://discord.com/api/webhooks/1/abc', notify_enabled: 1, notify_storm_threshold: 5, notify_retest_count: 3 });
    const s = getSettings();
    expect(s.notify_webhook_url).toBe('https://discord.com/api/webhooks/1/abc');
    expect(s.notify_enabled).toBe(1);
    expect(s.notify_storm_threshold).toBe(5);
    expect(s.notify_retest_count).toBe(3);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- server/src/db/alerts.queries.test.ts`
Expected: FAIL — `updateSettings` doesn't write the new columns (values stay default / TS error on unknown fields).

- [ ] **Step 3: Add fields to `SettingsRow`**

In the `SettingsRow` interface (`server/src/db/queries.ts:7-30`), add before `updated_at`:

```typescript
  notify_webhook_url: string;
  notify_enabled: number;
  notify_storm_threshold: number;
  notify_retest_count: number;
  notify_reauth_digest_time: string;
```

- [ ] **Step 4: Extend `updateSettings`**

In `updateSettings` (`server/src/db/queries.ts:36-83`), add the five columns to the `UPDATE settings SET …` list and the matching values array (mirroring the `s.x ?? current.x` pattern used for every other field):

```typescript
      notify_webhook_url = ?,
      notify_enabled = ?,
      notify_storm_threshold = ?,
      notify_retest_count = ?,
      notify_reauth_digest_time = ?,
```

and in the values array, before the closing `]);`:

```typescript
    s.notify_webhook_url ?? current.notify_webhook_url,
    s.notify_enabled ?? current.notify_enabled,
    s.notify_storm_threshold ?? current.notify_storm_threshold,
    s.notify_retest_count ?? current.notify_retest_count,
    s.notify_reauth_digest_time ?? current.notify_reauth_digest_time,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -- server/src/db/alerts.queries.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/queries.ts server/src/db/alerts.queries.test.ts
git commit -m "feat(alerts): persist discord notify settings"
```

### Task 1.3: Expose masked notify settings to the client

**Files:**
- Modify: `server/src/routes/settings-view.ts` (`SettingsForView` lines 2-23; `maskedSettings` lines 45-67)
- Test: `server/src/routes/settings-view.test.ts` (extend existing)

- [ ] **Step 1: Add a failing assertion to the existing test**

In `server/src/routes/settings-view.test.ts`, add to the `raw` object: `notify_webhook_url: 'https://discord.com/api/webhooks/1/SECRETHOOK', notify_enabled: 1, notify_storm_threshold: 8, notify_retest_count: 2, notify_reauth_digest_time: '09:00',` and add a test:

```typescript
  it('exposes the discord webhook as presence + mask, never raw', () => {
    const out = maskedSettings(raw) as any;
    expect(out.has_notify_webhook).toBe(true);
    expect(JSON.stringify(out)).not.toContain('SECRETHOOK');
    expect(out.notify_webhook_url).toBeUndefined();
    expect(out.notify_enabled).toBe(1);
    expect(out.notify_storm_threshold).toBe(8);
    expect(out.notify_retest_count).toBe(2);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- server/src/routes/settings-view.test.ts`
Expected: FAIL — `has_notify_webhook` undefined.

- [ ] **Step 3: Add the fields**

In `SettingsForView` (`server/src/routes/settings-view.ts:2-23`) add:

```typescript
  notify_webhook_url: string;
  notify_enabled: number;
  notify_storm_threshold: number;
  notify_retest_count: number;
  notify_reauth_digest_time: string;
```

In `maskedSettings` return (`server/src/routes/settings-view.ts:45-67`), add before the closing brace:

```typescript
    has_notify_webhook: !!s.notify_webhook_url,
    notify_webhook_masked: maskLong(s.notify_webhook_url, 34, 40),
    notify_enabled: s.notify_enabled,
    notify_storm_threshold: s.notify_storm_threshold,
    notify_retest_count: s.notify_retest_count,
    notify_reauth_digest_time: s.notify_reauth_digest_time,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- server/src/routes/settings-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/settings-view.ts server/src/routes/settings-view.test.ts
git commit -m "feat(alerts): expose masked discord notify settings"
```

### Task 1.4: Settings routes — save (PUT), remove, test-notification

**Files:**
- Modify: `server/src/routes/settings.ts` (PUT at 72-88; add two POST handlers near the `remove-linear-webhook` handler at 237-240)

Note: `postDiscordMessage` (Task 2.1) is used by `test-notification`. Implement this task's `test-notification` body after Task 2.1 lands, or stub the import now and fill the call in Step 3. Ordering: do Task 2.1 before wiring the live test button, but the PUT/remove handlers below have no dependency.

- [ ] **Step 1: Extend the PUT whitelist**

In the PUT handler (`server/src/routes/settings.ts:72-88`), add before `res.json(...)`:

```typescript
    if (typeof b.notify_webhook_url === 'string' && b.notify_webhook_url.trim()) updates.notify_webhook_url = b.notify_webhook_url.trim();
    if (b.notify_enabled === 0 || b.notify_enabled === 1) updates.notify_enabled = b.notify_enabled;
    if (typeof b.notify_storm_threshold === 'number' && Number.isFinite(b.notify_storm_threshold)) updates.notify_storm_threshold = Math.max(1, Math.floor(b.notify_storm_threshold));
    if (typeof b.notify_retest_count === 'number' && Number.isFinite(b.notify_retest_count)) updates.notify_retest_count = Math.max(0, Math.min(5, Math.floor(b.notify_retest_count)));
    if (typeof b.notify_reauth_digest_time === 'string' && /^\d{2}:\d{2}$/.test(b.notify_reauth_digest_time)) updates.notify_reauth_digest_time = b.notify_reauth_digest_time;
```

- [ ] **Step 2: Add the remove handler**

After the `remove-linear-webhook` handler (`server/src/routes/settings.ts:237-240`):

```typescript
router.post('/remove-notify-webhook', (_req, res) => {
  updateSettings({ notify_webhook_url: '', notify_enabled: 0 });
  res.json({ success: true });
});
```

- [ ] **Step 3: Add the test-notification handler** (after Task 2.1)

```typescript
router.post('/test-notification', async (_req, res) => {
  const s = getSettings();
  if (!s.notify_webhook_url) return res.status(400).json({ success: false, error: 'No Discord webhook configured' });
  try {
    await postDiscordMessage(s.notify_webhook_url, {
      embeds: [{ title: '✅ Piece Tester connected', color: 0x57F287, description: 'This channel will receive confirmed piece-bug alerts.' }],
    });
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err?.message || 'Failed to reach Discord' });
  }
});
```

Add the import at the top of `settings.ts`: `import { postDiscordMessage } from '../services/notifier.js';`

- [ ] **Step 4: Manual verify (after Task 2.1)**

Start the server, `PUT /api/settings` with a real webhook URL, then `POST /api/settings/test-notification`; confirm a green "connected" embed appears in the Discord channel.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/settings.ts
git commit -m "feat(alerts): settings routes for discord webhook (save/remove/test)"
```

### Task 1.5: Client — API methods + Settings "Discord alerts" section

**Files:**
- Modify: `client/src/lib/api.ts` (settings block near lines 998-1012; `removeLinearWebhook` at 1164)
- Modify: `client/src/pages/Settings.tsx` (clone the Linear-webhook section at 599-625; state at 21-30; loader at 72-73)

- [ ] **Step 1: Add API methods**

In `client/src/lib/api.ts`, next to `removeLinearWebhook`:

```typescript
removeNotifyWebhook: () => request<{ success: boolean }>('POST', '/settings/remove-notify-webhook'),
testNotification: () => request<{ success: boolean; error?: string }>('POST', '/settings/test-notification'),
```

- [ ] **Step 2: Add Settings state + loader**

In `Settings.tsx`, mirror the Linear state (lines 21-25) and loader (lines 72-73):

```typescript
const [hasNotifyWebhook, setHasNotifyWebhook] = useState(false);
const [notifyWebhookMasked, setNotifyWebhookMasked] = useState('');
const [notifyWebhookInput, setNotifyWebhookInput] = useState('');
const [notifyEnabled, setNotifyEnabled] = useState(false);
const [stormThreshold, setStormThreshold] = useState(8);
const [retestCount, setRetestCount] = useState(2);
const [savingNotify, setSavingNotify] = useState(false);
const [notifyResult, setNotifyResult] = useState<{ success: boolean; message: string } | null>(null);
```

In the settings loader (`useEffect` around line 72):

```typescript
setHasNotifyWebhook(s.has_notify_webhook || false);
setNotifyWebhookMasked(s.notify_webhook_masked || '');
setNotifyEnabled(!!s.notify_enabled);
setStormThreshold(s.notify_storm_threshold ?? 8);
setRetestCount(s.notify_retest_count ?? 2);
```

- [ ] **Step 3: Add handlers**

```typescript
const handleSaveNotify = async () => {
  setSavingNotify(true); setNotifyResult(null);
  try {
    const payload: any = { notify_enabled: notifyEnabled ? 1 : 0, notify_storm_threshold: stormThreshold, notify_retest_count: retestCount };
    if (notifyWebhookInput.trim()) payload.notify_webhook_url = notifyWebhookInput.trim();
    await api.updateSettings(payload);
    const s = await api.getSettings();
    setHasNotifyWebhook(s.has_notify_webhook || false);
    setNotifyWebhookMasked(s.notify_webhook_masked || '');
    setNotifyWebhookInput('');
    setNotifyResult({ success: true, message: 'Discord alert settings saved.' });
  } catch (e: any) { setNotifyResult({ success: false, message: e?.message || 'Failed to save.' }); }
  finally { setSavingNotify(false); }
};
const handleRemoveNotify = async () => {
  try { await api.removeNotifyWebhook(); setHasNotifyWebhook(false); setNotifyWebhookMasked(''); setNotifyEnabled(false);
    setNotifyResult({ success: true, message: 'Discord webhook removed.' });
  } catch (e: any) { setNotifyResult({ success: false, message: e?.message || 'Failed to remove.' }); }
};
const handleTestNotify = async () => {
  setNotifyResult(null);
  try { await api.testNotification(); setNotifyResult({ success: true, message: 'Test alert sent — check the channel.' }); }
  catch (e: any) { setNotifyResult({ success: false, message: e?.message || 'Failed to send.' }); }
};
```

- [ ] **Step 4: Add the JSX section** (clone of the Linear block at `Settings.tsx:599-625`, placed just after it)

```tsx
{/* Discord alerts */}
<div className="mt-6 rounded-lg border border-gray-800 bg-gray-900 p-4">
  <h3 className="mb-1 text-sm font-semibold text-gray-200">Discord alerts</h3>
  <p className="mb-3 text-[12px] text-gray-500">
    Paste a Discord channel <span className="text-gray-300">Incoming Webhook URL</span>. Confirmed piece bugs from scheduled sweeps post here and self-edit as they verify or recover.
  </p>
  {hasNotifyWebhook ? (
    <div className="mb-2 flex items-center gap-2 text-[12px] text-gray-400">
      <span className="rounded bg-gray-800 px-2 py-1 font-mono">{notifyWebhookMasked}</span>
      <button type="button" onClick={handleRemoveNotify} className="text-red-400 hover:underline">Remove</button>
    </div>
  ) : (
    <p className="mb-2 text-[12px] text-amber-400/80">Not configured — no alerts will be sent.</p>
  )}
  <div className="flex gap-2">
    <input value={notifyWebhookInput} onChange={e => setNotifyWebhookInput(e.target.value)}
      placeholder="https://discord.com/api/webhooks/…"
      className="flex-1 rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-200" />
    <button onClick={handleSaveNotify} disabled={savingNotify}
      className="rounded bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-500 disabled:opacity-50">
      {savingNotify ? 'Saving…' : 'Save'}
    </button>
    <button onClick={handleTestNotify} disabled={!hasNotifyWebhook}
      className="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-50">
      Send test alert
    </button>
  </div>
  <div className="mt-3 flex flex-wrap items-center gap-4 text-[12px] text-gray-400">
    <label className="flex items-center gap-2"><input type="checkbox" checked={notifyEnabled} onChange={e => setNotifyEnabled(e.target.checked)} /> Enabled</label>
    <label className="flex items-center gap-2">Storm threshold <input type="number" min={1} value={stormThreshold} onChange={e => setStormThreshold(Number(e.target.value))} className="w-16 rounded border border-gray-700 bg-gray-950 px-2 py-1" /></label>
    <label className="flex items-center gap-2">Retests <input type="number" min={0} max={5} value={retestCount} onChange={e => setRetestCount(Number(e.target.value))} className="w-16 rounded border border-gray-700 bg-gray-950 px-2 py-1" /></label>
  </div>
  {notifyResult && (
    <p className={`mt-2 text-[12px] ${notifyResult.success ? 'text-green-400' : 'text-red-400'}`}>{notifyResult.message}</p>
  )}
</div>
```

- [ ] **Step 5: Manual verify**

Run `npm run dev`, open Settings, save a webhook, toggle Enabled, click "Send test alert", confirm the embed lands in Discord.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/api.ts client/src/pages/Settings.tsx
git commit -m "feat(alerts): Settings UI for discord alerts"
```

---

## Milestone 2 — Notifier service (Discord transport + message builders)

### Task 2.1: `postDiscordMessage` + `editDiscordMessage`

**Files:**
- Create: `server/src/services/notifier.ts`
- Test: `server/src/services/notifier.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/services/notifier.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { postDiscordMessage, editDiscordMessage, NotifierError } from './notifier.js';

function fakeFetch(responses: Array<{ ok: boolean; status: number; body: string }>) {
  const calls: Array<{ url: string; init: any }> = [];
  let i = 0;
  const impl = async (url: string, init: any) => { calls.push({ url, init }); const r = responses[i++]; return { ok: r.ok, status: r.status, text: async () => r.body }; };
  return { impl, calls };
}

describe('postDiscordMessage', () => {
  it('POSTs with ?wait=true and returns the message id', async () => {
    const { impl, calls } = fakeFetch([{ ok: true, status: 200, body: JSON.stringify({ id: '999' }) }]);
    const out = await postDiscordMessage('https://discord.com/api/webhooks/1/tok', { content: 'hi' }, impl);
    expect(out.id).toBe('999');
    expect(calls[0].url).toBe('https://discord.com/api/webhooks/1/tok?wait=true');
    expect(calls[0].init.method).toBe('POST');
  });

  it('throws NotifierError on non-2xx', async () => {
    const { impl } = fakeFetch([{ ok: false, status: 400, body: 'bad' }]);
    await expect(postDiscordMessage('https://x', {}, impl)).rejects.toBeInstanceOf(NotifierError);
  });
});

describe('editDiscordMessage', () => {
  it('PATCHes /messages/{id}', async () => {
    const { impl, calls } = fakeFetch([{ ok: true, status: 200, body: '{}' }]);
    await editDiscordMessage('https://discord.com/api/webhooks/1/tok', '999', { content: 'x' }, impl);
    expect(calls[0].url).toBe('https://discord.com/api/webhooks/1/tok/messages/999');
    expect(calls[0].init.method).toBe('PATCH');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- server/src/services/notifier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the transport**

Create `server/src/services/notifier.ts`:

```typescript
export interface DiscordEmbed { title?: string; description?: string; color?: number; url?: string; }
export interface DiscordMessage { content?: string; embeds?: DiscordEmbed[]; }

export type FetchLike = (url: string, init: any) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
export class NotifierError extends Error {}

function withWait(url: string): string { return url.includes('?') ? `${url}&wait=true` : `${url}?wait=true`; }

export async function postDiscordMessage(webhookUrl: string, msg: DiscordMessage, fetchImpl: FetchLike = fetch as any): Promise<{ id: string }> {
  if (!webhookUrl) throw new NotifierError('No Discord webhook configured');
  let res;
  try { res = await fetchImpl(withWait(webhookUrl), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) }); }
  catch (e: any) { throw new NotifierError(`Could not reach Discord: ${e?.message || e}`); }
  const body = await res.text();
  if (!res.ok) throw new NotifierError(`Discord POST ${res.status}: ${body.slice(0, 200)}`);
  let data: any; try { data = JSON.parse(body); } catch { throw new NotifierError(`Discord returned non-JSON: ${body.slice(0, 200)}`); }
  if (!data?.id) throw new NotifierError(`Discord response missing message id: ${body.slice(0, 200)}`);
  return { id: String(data.id) };
}

export async function editDiscordMessage(webhookUrl: string, messageId: string, msg: DiscordMessage, fetchImpl: FetchLike = fetch as any): Promise<void> {
  let res;
  try { res = await fetchImpl(`${webhookUrl}/messages/${messageId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) }); }
  catch (e: any) { throw new NotifierError(`Could not reach Discord: ${e?.message || e}`); }
  const body = await res.text();
  if (!res.ok) throw new NotifierError(`Discord PATCH ${res.status}: ${body.slice(0, 200)}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- server/src/services/notifier.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/notifier.ts server/src/services/notifier.test.ts
git commit -m "feat(alerts): discord post/edit transport"
```

### Task 2.2: `errorSignature` + `alertEmbed` + `stormEmbed`

**Files:**
- Modify: `server/src/services/notifier.ts`
- Modify: `server/src/services/notifier.test.ts`

- [ ] **Step 1: Write the failing tests** (append)

```typescript
import { errorSignature, alertEmbed, stormEmbed } from './notifier.js';

describe('errorSignature', () => {
  it('is stable across differing ids/numbers but differs by message', () => {
    const a = errorSignature('piece_error', "Cannot read property 'id' of undefined (req 12345)");
    const b = errorSignature('piece_error', "Cannot read property 'id' of undefined (req 67890)");
    const c = errorSignature('piece_error', 'Totally different error');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('piece_error:')).toBe(true);
  });
});

const baseAlert: any = { id: 7, piece_name: '@ap/stripe', target_action: 'create_customer', error_category: 'piece_error', error_message: "Cannot read 'id'", status: 'confirmed', first_seen_at: '2026-09-11T09:00:00.000Z' };

describe('alertEmbed', () => {
  it('confirmed embed is red, names the target, and includes an ack link', () => {
    const m = alertEmbed({ ...baseAlert, status: 'confirmed' }, { appBaseUrl: 'https://app.test', reproduced: 3 });
    const e = m.embeds![0];
    expect(e.color).toBe(0xED4245);
    expect(e.title).toContain('@ap/stripe');
    expect(e.description).toContain('reproduced 3×');
    expect(e.description).toContain('https://app.test/ack/7');
  });
  it('verifying embed is amber with no ack link', () => {
    const e = alertEmbed({ ...baseAlert, status: 'verifying' }, { appBaseUrl: 'https://app.test' }).embeds![0];
    expect(e.color).toBe(0xFEE75C);
    expect(e.description).not.toContain('/ack/');
  });
  it('recovered embed is green', () => {
    const e = alertEmbed({ ...baseAlert, status: 'recovered' }, { appBaseUrl: 'https://app.test', recoveredNote: 'Recovered on retest — looks flaky' }).embeds![0];
    expect(e.color).toBe(0x57F287);
    expect(e.description).toContain('flaky');
  });
});

describe('stormEmbed', () => {
  it('summarizes a mass-failure wave', () => {
    const e = stormEmbed({ failing: 23, suppressed: 15, appBaseUrl: 'https://app.test' }).embeds![0];
    expect(e.title).toContain('23');
    expect(e.description).toContain('platform');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- server/src/services/notifier.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement** (append to `notifier.ts`)

```typescript
export interface AlertLike {
  id: number; piece_name: string; target_action: string | null;
  error_category: string | null; error_message: string | null;
  status: string; acknowledged_by?: string | null; first_seen_at?: string | null;
}
const COLORS = { verifying: 0xFEE75C, confirmed: 0xED4245, acknowledged: 0x5865F2, recovered: 0x57F287, storm: 0xED4245 };

export function errorSignature(category: string, error: string | null): string {
  const norm = (error || '')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\d+/g, '<n>')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${category}:${norm}`;
}

export function alertEmbed(a: AlertLike, opts: { appBaseUrl: string; reproduced?: number; recoveredNote?: string }): DiscordMessage {
  const target = a.target_action ? `${a.piece_name} · ${a.target_action}` : a.piece_name;
  const ackLinks = [`[Acknowledge](${opts.appBaseUrl}/ack/${a.id})`, `[Open in Health](${opts.appBaseUrl}/?piece=${encodeURIComponent(a.piece_name)})`].join('   ');
  let title: string, color: number, lines: string[];
  switch (a.status) {
    case 'verifying':
      title = `⏳ Verifying — ${target}`; color = COLORS.verifying;
      lines = [`Just failed · ${a.error_category}`, a.error_message || '', 'verifying…']; break;
    case 'acknowledged':
      title = `🔴 Piece bug — ${target}`; color = COLORS.acknowledged;
      lines = [`✔ Acknowledged by ${a.acknowledged_by || 'a teammate'} · ${a.error_category}`, a.error_message || '']; break;
    case 'recovered':
      title = `🟢 Recovered — ${target}`; color = COLORS.recovered;
      lines = [opts.recoveredNote || 'Recovered', a.error_message || '']; break;
    case 'confirmed':
    default:
      title = `🔴 Piece bug — ${target}`; color = COLORS.confirmed;
      lines = [opts.reproduced ? `Confirmed · reproduced ${opts.reproduced}× · ${a.error_category}` : `Confirmed (unverified retest) · ${a.error_category}`, a.error_message || '', ackLinks];
  }
  return { embeds: [{ title, color, description: lines.filter(Boolean).join('\n') }] };
}

export function stormEmbed(opts: { failing: number; suppressed: number; appBaseUrl: string }): DiscordMessage {
  return { embeds: [{
    title: `⚠️ ${opts.failing} targets failing this sweep`,
    color: COLORS.storm,
    description: `${opts.suppressed} not individually alerted — this is likely a platform/connection issue, not ${opts.failing} separate piece bugs.\n[Open in Health](${opts.appBaseUrl}/)`,
  }] };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- server/src/services/notifier.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/notifier.ts server/src/services/notifier.test.ts
git commit -m "feat(alerts): error signature + discord embed builders"
```

---

## Milestone 3 — Alert state persistence

### Task 3.1: `AlertRow` type + alert CRUD queries

**Files:**
- Modify: `server/src/db/queries.ts` (add near the quarantine helpers at 846-872)
- Test: `server/src/db/alerts.queries.test.ts` (extend)

- [ ] **Step 1: Write the failing test** (append to `alerts.queries.test.ts`)

```typescript
import { createAlert, getOpenAlert, updateAlert, acknowledgeAlert, recoverAlert, listOpenAlerts } from './queries.js';

describe('alert CRUD', () => {
  beforeEach(() => getDb().exec('DELETE FROM alerts;'));

  it('creates then finds the open alert for a target', () => {
    const a = createAlert({ piece_name: '@ap/stripe', target_action: 'create_customer', error_signature: 'piece_error:x', error_category: 'piece_error', error_message: 'boom', last_run_id: 1, last_wave_id: 'w1', schedule_id: 2 });
    expect(a.status).toBe('verifying');
    const open = getOpenAlert('@ap/stripe', 'create_customer');
    expect(open?.id).toBe(a.id);
  });

  it('recovered alerts are no longer "open"', () => {
    const a = createAlert({ piece_name: '@ap/x', target_action: 'a', error_signature: 's', error_category: 'piece_error', error_message: 'e' });
    recoverAlert(a.id);
    expect(getOpenAlert('@ap/x', 'a')).toBeUndefined();
    expect(listOpenAlerts()).toHaveLength(0);
  });

  it('acknowledge records who + when and keeps it open', () => {
    const a = createAlert({ piece_name: '@ap/y', target_action: 'b', error_signature: 's', error_category: 'piece_error', error_message: 'e' });
    updateAlert(a.id, { status: 'confirmed' });
    const ack = acknowledgeAlert(a.id, 'web session');
    expect(ack?.status).toBe('acknowledged');
    expect(ack?.acknowledged_by).toBe('web session');
    expect(getOpenAlert('@ap/y', 'b')?.status).toBe('acknowledged');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- server/src/db/alerts.queries.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement** (append to `server/src/db/queries.ts`)

```typescript
export interface AlertRow {
  id: number;
  piece_name: string;
  target_action: string | null;
  target_type: string | null;
  error_signature: string;
  error_category: string | null;
  error_message: string | null;
  status: string; // verifying | confirmed | acknowledged | recovered
  discord_message_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  confirmed_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  recovered_at: string | null;
  fail_count: number;
  last_run_id: number | null;
  last_wave_id: string | null;
  schedule_id: number | null;
}

export function getOpenAlert(piece_name: string, target_action: string | null): AlertRow | undefined {
  return getDb().get<AlertRow>(
    `SELECT * FROM alerts WHERE piece_name = ? AND ((target_action = ?) OR (target_action IS NULL AND ? IS NULL)) AND recovered_at IS NULL ORDER BY id DESC`,
    [piece_name, target_action, target_action],
  );
}

export function getAlert(id: number): AlertRow | undefined {
  return getDb().get<AlertRow>('SELECT * FROM alerts WHERE id = ?', [id]);
}

export function listOpenAlerts(): AlertRow[] {
  return getDb().all<AlertRow>('SELECT * FROM alerts WHERE recovered_at IS NULL ORDER BY id DESC');
}

export function createAlert(p: {
  piece_name: string; target_action: string | null; target_type?: string | null;
  error_signature: string; error_category: string | null; error_message: string | null;
  last_run_id?: number | null; last_wave_id?: string | null; schedule_id?: number | null;
}): AlertRow {
  const res = getDb().run(
    `INSERT INTO alerts (piece_name, target_action, target_type, error_signature, error_category, error_message, status, last_run_id, last_wave_id, schedule_id)
     VALUES (?, ?, ?, ?, ?, ?, 'verifying', ?, ?, ?)`,
    [p.piece_name, p.target_action, p.target_type ?? null, p.error_signature, p.error_category, p.error_message, p.last_run_id ?? null, p.last_wave_id ?? null, p.schedule_id ?? null],
  );
  return getAlert(res.lastId)!;
}

export function updateAlert(id: number, u: Partial<Pick<AlertRow,
  'error_signature' | 'error_category' | 'error_message' | 'status' | 'discord_message_id' |
  'last_seen_at' | 'confirmed_at' | 'acknowledged_at' | 'acknowledged_by' | 'recovered_at' |
  'fail_count' | 'last_run_id' | 'last_wave_id' | 'schedule_id'>>): AlertRow | undefined {
  const current = getAlert(id);
  if (!current) return undefined;
  const fields: string[] = []; const values: unknown[] = [];
  for (const [k, v] of Object.entries(u)) { if (v !== undefined) { fields.push(`${k} = ?`); values.push(v); } }
  if (fields.length === 0) return current;
  values.push(id);
  getDb().run(`UPDATE alerts SET ${fields.join(', ')} WHERE id = ?`, values);
  return getAlert(id);
}

export function acknowledgeAlert(id: number, by: string): AlertRow | undefined {
  return updateAlert(id, { status: 'acknowledged', acknowledged_by: by, acknowledged_at: new Date().toISOString() });
}

export function recoverAlert(id: number): AlertRow | undefined {
  return updateAlert(id, { status: 'recovered', recovered_at: new Date().toISOString() });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- server/src/db/alerts.queries.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/queries.ts server/src/db/alerts.queries.test.ts
git commit -m "feat(alerts): alert row type + CRUD queries"
```

---

## Milestone 4 — The alert engine (retest + state machine + storm guard)

### Task 4.1: Run-outcome analysis + `retestTarget`

**Files:**
- Create: `server/src/services/alert-engine.ts`
- Test: `server/src/services/alert-engine.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/services/alert-engine.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { analyzeRun, PIECE_IMPLICATING } from './alert-engine.js';

function run(status: string, steps: any[]): any { return { id: 1, status, step_results: JSON.stringify(steps) }; }

describe('analyzeRun', () => {
  it('reports a thrown piece_error failure', () => {
    const r = analyzeRun(run('failed', [{ status: 'completed' }, { status: 'failed', error: 'boom', errorCategory: 'piece_error' }]));
    expect(r.outcome).toBe('failed');
    expect(r.category).toBe('piece_error');
    expect(r.error).toBe('boom');
  });
  it('reports assert_failed', () => {
    const r = analyzeRun(run('failed', [{ status: 'assert_failed', error: 'expected 200' }]));
    expect(r.category).toBe('assert_failed');
  });
  it('reports a clean pass', () => {
    const r = analyzeRun(run('completed', [{ status: 'completed' }]));
    expect(r.outcome).toBe('passed');
  });
  it('marks auth as env-noise (not piece-implicating)', () => {
    const r = analyzeRun(run('failed', [{ status: 'failed', error: '401', errorCategory: 'auth' }]));
    expect(PIECE_IMPLICATING.has(r.category)).toBe(false);
  });
  it('treats piece_error/assert_failed/bad_request/not_found as piece-implicating', () => {
    for (const c of ['piece_error', 'assert_failed', 'bad_request', 'not_found']) expect(PIECE_IMPLICATING.has(c)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- server/src/services/alert-engine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement analysis + retest**

Create `server/src/services/alert-engine.ts`:

```typescript
import { executePlan } from './plan-executor.js';

export const PIECE_IMPLICATING = new Set(['piece_error', 'assert_failed', 'bad_request', 'not_found', 'unknown']);
const ENV_NOISE = new Set(['auth', 'rate_limit', 'transient']);

export interface RunOutcome { outcome: 'passed' | 'failed'; category: string; error: string | null; }

/** Parse a run's step_results into a single outcome + the piece-implicating category/error. */
export function analyzeRun(run: { status: string; step_results?: string | null }): RunOutcome {
  let steps: any[] = [];
  try { const p = JSON.parse(run.step_results || '[]'); if (Array.isArray(p)) steps = p; } catch { /* ignore */ }
  const thrown = steps.find(s => s && s.status === 'failed');
  if (thrown) return { outcome: 'failed', category: thrown.errorCategory || 'piece_error', error: shorten(thrown.error) };
  const asserted = steps.find(s => s && s.status === 'assert_failed');
  if (asserted) return { outcome: 'failed', category: 'assert_failed', error: shorten(asserted.error) };
  if (run.status === 'completed') return { outcome: 'passed', category: 'none', error: null };
  return { outcome: 'failed', category: 'unknown', error: null };
}

function shorten(e: string | null | undefined): string | null {
  if (!e) return null;
  const first = String(e).split('\n')[0].trim();
  return first.length > 180 ? first.slice(0, 180) + '…' : first;
}

export interface RetestResult { failed: number; passed: number; inconclusive: number; }

/** Re-run a plan `times` times (out of band, trigger_type='retest') and tally outcomes. */
export async function retestTarget(planId: number, times: number, exec = executePlan): Promise<RetestResult> {
  const r: RetestResult = { failed: 0, passed: 0, inconclusive: 0 };
  for (let i = 0; i < times; i++) {
    let run: any;
    try { run = await exec(planId, () => {}, 'retest'); } catch { r.inconclusive++; continue; }
    const a = analyzeRun(run);
    if (a.outcome === 'passed') r.passed++;
    else if (PIECE_IMPLICATING.has(a.category)) r.failed++;
    else r.inconclusive++; // retest itself hit env-noise
  }
  return r;
}

export { ENV_NOISE };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- server/src/services/alert-engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/alert-engine.ts server/src/services/alert-engine.test.ts
git commit -m "feat(alerts): run-outcome analysis + inline retest"
```

### Task 4.2: The state-machine driver (`processRunAlert` + `finalizeWaveAlerts`)

**Files:**
- Modify: `server/src/services/alert-engine.ts`
- Modify: `server/src/services/alert-engine.test.ts`

Design: `processRunAlert` and `finalizeWaveAlerts` take an injected `AlertDeps` bag so tests drive the machine with in-memory fakes (no DB, no network, no real retest). A production factory `realAlertDeps()` wires the actual queries/notifier/retest.

- [ ] **Step 1: Write the failing tests** (append)

```typescript
import { newWaveState, processRunAlert, finalizeWaveAlerts, type AlertDeps } from './alert-engine.js';

function makeDeps(over: Partial<AlertDeps> & { settings?: any } = {}): { deps: AlertDeps; posts: any[]; edits: any[]; store: Map<string, any> } {
  const store = new Map<string, any>();
  const posts: any[] = []; const edits: any[] = [];
  let idSeq = 1;
  const settings = over.settings || { notify_webhook_url: 'https://wh', notify_enabled: 1, notify_storm_threshold: 8, notify_retest_count: 2 };
  const deps: AlertDeps = {
    getSettings: () => settings,
    isQuarantined: () => false,
    getOpenAlert: (p, a) => [...store.values()].find(x => x.piece_name === p && x.target_action === a && !x.recovered_at),
    createAlert: (x) => { const row = { id: idSeq++, status: 'verifying', fail_count: 1, recovered_at: null, first_seen_at: '2026-09-11T09:00:00.000Z', ...x }; store.set(String(row.id), row); return row; },
    updateAlert: (id, u) => { const row = { ...store.get(String(id)), ...u }; store.set(String(id), row); return row; },
    recoverAlert: (id) => { const row = { ...store.get(String(id)), status: 'recovered', recovered_at: 'now' }; store.set(String(id), row); return row; },
    listOpenAlerts: () => [...store.values()].filter(x => !x.recovered_at),
    post: async (_wh, _m) => { posts.push(_m); return { id: 'M' + posts.length }; },
    edit: async (_wh, id, m) => { edits.push({ id, m }); },
    retest: async () => ({ failed: 2, passed: 0, inconclusive: 0 }),
    appBaseUrl: 'https://app.test',
    ...over,
  };
  return { deps, posts, edits, store };
}

function schedRun(status: string, steps: any[]): any { return { id: 42, status, step_results: JSON.stringify(steps) }; }
const stripePlan: any = { id: 5, piece_name: '@ap/stripe', target_action: 'create_customer', target_type: 'action' };
const wave = { wave_id: 'w1', schedule_id: 2 };

describe('processRunAlert', () => {
  it('confirms a reproduced piece bug: posts verifying then edits to confirmed', async () => {
    const { deps, posts, edits, store } = makeDeps();
    const ws = newWaveState();
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'boom', errorCategory: 'piece_error' }]), stripePlan, wave, ws, deps);
    expect(posts).toHaveLength(1);          // verifying posted
    expect(edits).toHaveLength(1);          // edited to confirmed
    const row = [...store.values()][0];
    expect(row.status).toBe('confirmed');
  });

  it('self-retracts a flake: retest passes → recovered, no lasting open alert', async () => {
    const { deps, edits, store } = makeDeps({ retest: async () => ({ failed: 0, passed: 2, inconclusive: 0 }) });
    const ws = newWaveState();
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'blip', errorCategory: 'piece_error' }]), stripePlan, wave, ws, deps);
    expect([...store.values()][0].status).toBe('recovered');
    expect(edits[edits.length - 1].m.embeds[0].color).toBe(0x57F287); // green
  });

  it('never swallows: all-inconclusive retest still confirms', async () => {
    const { deps, store } = makeDeps({ retest: async () => ({ failed: 0, passed: 0, inconclusive: 2 }) });
    const ws = newWaveState();
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'x', errorCategory: 'piece_error' }]), stripePlan, wave, ws, deps);
    expect([...store.values()][0].status).toBe('confirmed');
  });

  it('suppresses env-noise (auth) — no post', async () => {
    const { deps, posts } = makeDeps();
    const ws = newWaveState();
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: '401', errorCategory: 'auth' }]), stripePlan, wave, ws, deps);
    expect(posts).toHaveLength(0);
  });

  it('dedups a same-signature re-fire: no second post, fail_count bumped', async () => {
    const { deps, posts, store } = makeDeps();
    const ws1 = newWaveState();
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'boom', errorCategory: 'piece_error' }]), stripePlan, wave, ws1, deps);
    const ws2 = newWaveState();
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'boom', errorCategory: 'piece_error' }]), stripePlan, wave, ws2, deps);
    expect(posts).toHaveLength(1);
    expect([...store.values()][0].fail_count).toBe(2);
  });

  it('skips quarantined targets', async () => {
    const { deps, posts } = makeDeps({ isQuarantined: () => true });
    const ws = newWaveState();
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'boom', errorCategory: 'piece_error' }]), stripePlan, wave, ws, deps);
    expect(posts).toHaveLength(0);
  });

  it('circuit-breaks past the storm threshold', async () => {
    const { deps, posts } = makeDeps({ settings: { notify_webhook_url: 'https://wh', notify_enabled: 1, notify_storm_threshold: 1, notify_retest_count: 0 } });
    const ws = newWaveState();
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'a', errorCategory: 'piece_error' }]), { ...stripePlan, target_action: 'a' }, wave, ws, deps);
    await processRunAlert(schedRun('failed', [{ status: 'failed', error: 'b', errorCategory: 'piece_error' }]), { ...stripePlan, target_action: 'b' }, wave, ws, deps);
    expect(posts).toHaveLength(1);          // first alerted, second suppressed
    expect(ws.suppressed).toBe(1);
  });
});

describe('finalizeWaveAlerts', () => {
  it('recovers an open alert whose target passed this wave', async () => {
    const { deps, edits, store } = makeDeps();
    store.set('1', { id: 1, piece_name: '@ap/stripe', target_action: 'create_customer', status: 'confirmed', recovered_at: null, first_seen_at: '2026-09-10T09:00:00.000Z', discord_message_id: 'M1' });
    const ws = newWaveState();
    ws.passedTargets.push({ piece: '@ap/stripe', action: 'create_customer' });
    await finalizeWaveAlerts(wave, ws, deps);
    expect(store.get('1').status).toBe('recovered');
    expect(edits[edits.length - 1].m.embeds[0].color).toBe(0x57F287);
  });

  it('posts one storm summary when failures were suppressed', async () => {
    const { deps, posts } = makeDeps();
    const ws = newWaveState(); ws.failures = 9; ws.suppressed = 15;
    await finalizeWaveAlerts(wave, ws, deps);
    expect(posts).toHaveLength(1);
    expect(posts[0].embeds[0].title).toContain('9');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- server/src/services/alert-engine.test.ts`
Expected: FAIL — `newWaveState`/`processRunAlert`/`finalizeWaveAlerts` not exported.

- [ ] **Step 3: Implement the driver** (append to `alert-engine.ts`)

```typescript
import { alertEmbed, stormEmbed, errorSignature, type DiscordMessage } from './notifier.js';
import type { AlertRow } from '../db/queries.js';

export interface AlertDeps {
  getSettings: () => { notify_webhook_url: string; notify_enabled: number; notify_storm_threshold: number; notify_retest_count: number };
  isQuarantined: (piece: string, action: string | null) => boolean;
  getOpenAlert: (piece: string, action: string | null) => AlertRow | undefined;
  createAlert: (p: { piece_name: string; target_action: string | null; target_type?: string | null; error_signature: string; error_category: string | null; error_message: string | null; last_run_id?: number | null; last_wave_id?: string | null; schedule_id?: number | null }) => AlertRow;
  updateAlert: (id: number, u: Partial<AlertRow>) => AlertRow | undefined;
  recoverAlert: (id: number) => AlertRow | undefined;
  listOpenAlerts: () => AlertRow[];
  post: (webhook: string, msg: DiscordMessage) => Promise<{ id: string }>;
  edit: (webhook: string, messageId: string, msg: DiscordMessage) => Promise<void>;
  retest: (planId: number, times: number) => Promise<RetestResult>;
  appBaseUrl: string;
}

export interface WaveState {
  failures: number;
  suppressed: number;
  passedTargets: Array<{ piece: string; action: string | null }>;
}
export function newWaveState(): WaveState { return { failures: 0, suppressed: 0, passedTargets: [] }; }

export async function processRunAlert(
  run: { id: number; status: string; step_results?: string | null },
  plan: { id: number; piece_name: string; target_action: string | null; target_type?: string | null },
  wave: { wave_id?: string; schedule_id?: number },
  ws: WaveState,
  deps: AlertDeps,
): Promise<void> {
  const s = deps.getSettings();
  if (!s.notify_enabled || !s.notify_webhook_url) return;

  const a = analyzeRun(run);
  if (a.outcome === 'passed') { ws.passedTargets.push({ piece: plan.piece_name, action: plan.target_action }); return; }
  if (ENV_NOISE.has(a.category)) return;                 // connection/env noise → no piece ping
  if (!PIECE_IMPLICATING.has(a.category)) return;
  if (deps.isQuarantined(plan.piece_name, plan.target_action)) return;

  ws.failures++;
  if (ws.failures > s.notify_storm_threshold) { ws.suppressed++; return; }  // circuit breaker

  const sig = errorSignature(a.category, a.error);
  const existing = deps.getOpenAlert(plan.piece_name, plan.target_action);

  if (existing && existing.error_signature === sig) {
    deps.updateAlert(existing.id, { fail_count: (existing.fail_count || 1) + 1, last_seen_at: new Date().toISOString(), last_run_id: run.id, last_wave_id: wave.wave_id ?? null, error_message: a.error });
    return; // dedup — already alerted for this exact failure
  }

  // New target failure, or the error changed on an open alert → raise a fresh alert.
  let alert: AlertRow;
  if (existing) {
    alert = deps.updateAlert(existing.id, { status: 'verifying', error_signature: sig, error_category: a.category, error_message: a.error, discord_message_id: null, acknowledged_at: null, acknowledged_by: null, last_run_id: run.id, last_wave_id: wave.wave_id ?? null })!;
  } else {
    alert = deps.createAlert({ piece_name: plan.piece_name, target_action: plan.target_action, target_type: plan.target_type ?? null, error_signature: sig, error_category: a.category, error_message: a.error, last_run_id: run.id, last_wave_id: wave.wave_id ?? null, schedule_id: wave.schedule_id ?? null });
  }

  // Post the eager "verifying" message.
  const posted = await deps.post(s.notify_webhook_url, alertEmbed({ ...alert, status: 'verifying' }, { appBaseUrl: deps.appBaseUrl }));
  alert = deps.updateAlert(alert.id, { discord_message_id: posted.id })!;

  // Retest inline (cadence-independent) and self-edit.
  const rt = await deps.retest(plan.id, s.notify_retest_count);
  if (rt.failed === 0 && rt.passed > 0) {
    const recovered = deps.recoverAlert(alert.id)!;
    await deps.edit(s.notify_webhook_url, posted.id, alertEmbed({ ...recovered, status: 'recovered' }, { appBaseUrl: deps.appBaseUrl, recoveredNote: 'Recovered on retest — looks flaky' }));
  } else {
    const reproduced = rt.failed > 0 ? 1 + rt.failed : undefined; // undefined ⇒ "unverified retest" wording
    const confirmed = deps.updateAlert(alert.id, { status: 'confirmed', confirmed_at: new Date().toISOString() })!;
    await deps.edit(s.notify_webhook_url, posted.id, alertEmbed({ ...confirmed, status: 'confirmed' }, { appBaseUrl: deps.appBaseUrl, reproduced }));
  }
}

export async function finalizeWaveAlerts(wave: { wave_id?: string; schedule_id?: number }, ws: WaveState, deps: AlertDeps): Promise<void> {
  const s = deps.getSettings();
  if (!s.notify_enabled || !s.notify_webhook_url) return;

  // Recovery: any open alert whose target passed this wave → recover + edit green.
  const passed = new Set(ws.passedTargets.map(t => `${t.piece}::${t.action ?? ''}`));
  for (const alert of deps.listOpenAlerts()) {
    if (!passed.has(`${alert.piece_name}::${alert.target_action ?? ''}`)) continue;
    const recovered = deps.recoverAlert(alert.id)!;
    if (alert.discord_message_id) {
      const days = daysSince(alert.first_seen_at);
      await deps.edit(s.notify_webhook_url, alert.discord_message_id, alertEmbed({ ...recovered, status: 'recovered' }, { appBaseUrl: deps.appBaseUrl, recoveredNote: `Recovered${days != null ? ` after ${days} day${days === 1 ? '' : 's'}` : ''}` }));
    }
  }

  // Storm: if failures were suppressed, post one outage summary.
  if (ws.suppressed > 0) {
    await deps.post(s.notify_webhook_url, stormEmbed({ failing: ws.failures + ws.suppressed, suppressed: ws.suppressed, appBaseUrl: deps.appBaseUrl }));
  }
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const then = Date.parse(iso); if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 86400000));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- server/src/services/alert-engine.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/alert-engine.ts server/src/services/alert-engine.test.ts
git commit -m "feat(alerts): wave-level state machine, dedup, recovery, storm guard"
```

### Task 4.3: Production deps factory + wire into `runScheduledTests`

**Files:**
- Modify: `server/src/services/alert-engine.ts` (add `realAlertDeps`)
- Modify: `server/src/services/test-engine.ts` (`runScheduledTests`, lines 23-62)

- [ ] **Step 1: Add `realAlertDeps`** (append to `alert-engine.ts`)

```typescript
import { getSettings, listQuarantine, getOpenAlert, createAlert, updateAlert, recoverAlert, listOpenAlerts } from '../db/queries.js';
import { postDiscordMessage, editDiscordMessage } from './notifier.js';

export function realAlertDeps(): AlertDeps {
  return {
    getSettings: () => { const s = getSettings(); return { notify_webhook_url: s.notify_webhook_url, notify_enabled: s.notify_enabled, notify_storm_threshold: s.notify_storm_threshold, notify_retest_count: s.notify_retest_count }; },
    isQuarantined: (piece, action) => listQuarantine().some(q => q.piece_name === piece && (q.action_name == null || q.action_name === action)),
    getOpenAlert, createAlert, updateAlert, recoverAlert, listOpenAlerts,
    post: (wh, m) => postDiscordMessage(wh, m),
    edit: (wh, id, m) => editDiscordMessage(wh, id, m),
    retest: (planId, times) => retestTarget(planId, times),
    appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:5173',
  };
}
```

Note the exact `getSettings`/`listQuarantine`/`updateAlert` signatures used here were defined in Tasks 1.2 and 3.1; `updateAlert` accepts `Partial<AlertRow>`, which matches the `AlertDeps.updateAlert` shape.

- [ ] **Step 2: Rewrite `runScheduledTests`** (`server/src/services/test-engine.ts:23-62`)

Replace the fire-and-forget IIFE with an awaited loop that drives alerts (only when a wave is present, i.e. scheduled). Keep the existing filtering of `validPlans` unchanged; replace only the execution block:

```typescript
  if (validPlans.length > 0) {
    console.log(`[scheduler] Running ${validPlans.length} test plan(s)...`);
    const ws = newWaveState();
    const deps = realAlertDeps();
    for (const plan of validPlans) {
      let run;
      try {
        run = await executePlan(plan.id, () => {}, 'scheduled', undefined, wave);
      } catch (err) {
        console.error(`[scheduler] Plan #${plan.id} (${plan.target_action}) failed:`, err);
        continue;
      }
      if (wave?.wave_id) {
        try { await processRunAlert(run, plan, wave, ws, deps); }
        catch (err) { console.error(`[alerts] processRunAlert failed for plan #${plan.id}:`, err); }
      }
    }
    if (wave?.wave_id) {
      try { await finalizeWaveAlerts(wave, ws, deps); }
      catch (err) { console.error('[alerts] finalizeWaveAlerts failed:', err); }
    }
  }
```

Add imports at the top of `test-engine.ts`:

```typescript
import { newWaveState, processRunAlert, finalizeWaveAlerts, realAlertDeps } from './alert-engine.js';
```

- [ ] **Step 3: Type-check + run the whole suite**

Run: `npm run test`
Expected: PASS (existing suite unaffected; alert tests green). If a type error surfaces at the `run` variable, ensure `executePlan`'s return (`TestPlanRunRow`) has `id`, `status`, `step_results` — it does (see `updatePlanRun`).

- [ ] **Step 4: Commit**

```bash
git add server/src/services/alert-engine.ts server/src/services/test-engine.ts
git commit -m "feat(alerts): drive alerts from scheduled waves"
```

---

## Milestone 5 — Acknowledge

### Task 5.1: Acknowledge endpoint

**Files:**
- Create: `server/src/routes/alerts.ts`
- Modify: `server/src/index.ts` (mount router near lines 40-48)

- [ ] **Step 1: Implement the router**

Create `server/src/routes/alerts.ts`:

```typescript
import { Router } from 'express';
import { getAlert, acknowledgeAlert, getSettings } from '../db/queries.js';
import { alertEmbed, editDiscordMessage } from '../services/notifier.js';

const router = Router();

router.post('/:id/acknowledge', async (req, res) => {
  const id = Number(req.params.id);
  const alert = getAlert(id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  if (alert.recovered_at) return res.json({ success: true, alreadyResolved: true });

  const by = 'web session';
  const acked = acknowledgeAlert(id, by)!;

  const s = getSettings();
  if (s.notify_webhook_url && acked.discord_message_id) {
    const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    try { await editDiscordMessage(s.notify_webhook_url, acked.discord_message_id, alertEmbed({ ...acked, status: 'acknowledged' }, { appBaseUrl: base })); }
    catch (err) { console.error('[alerts] failed to edit ack message:', err); }
  }
  res.json({ success: true, acknowledged_by: by });
});

export default router;
```

- [ ] **Step 2: Mount the router** (`server/src/index.ts`, with the other `app.use('/api/…')` lines at 40-48)

```typescript
import alertsRoutes from './routes/alerts.js';
// …
app.use('/api/alerts', alertsRoutes);
```

- [ ] **Step 3: Manual verify**

Start the server; create a confirmed alert (via a scheduled failing run, or insert a row + set `discord_message_id`), then `POST /api/alerts/:id/acknowledge`; confirm the row flips to `acknowledged` and (if a webhook is set) the Discord embed turns to the acknowledged (blurple) state.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/alerts.ts server/src/index.ts
git commit -m "feat(alerts): acknowledge endpoint"
```

### Task 5.2: `GET /ack/:id` landing page (the Discord hyperlink target)

**Files:**
- Modify: `server/src/index.ts` (add a top-level GET **before** the `app.get('*', …)` static fallback at lines 52-55)

The `Acknowledge` link in every embed points at `${appBaseUrl}/ack/:id`. This page fires the protected POST from the browser (so it runs with the operator's session cookie), shows the result, and links into Health.

- [ ] **Step 1: Add the route** (immediately before `app.get('*', …)`)

```typescript
app.get('/ack/:id', (req, res) => {
  const id = Number(req.params.id);
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Acknowledge alert</title>
<style>body{font-family:system-ui;background:#0b0f19;color:#e5e7eb;display:grid;place-items:center;height:100vh;margin:0}.card{max-width:420px;padding:24px;border:1px solid #1f2937;border-radius:12px;text-align:center}a{color:#818cf8}</style>
</head><body><div class="card"><h2 id="s">Acknowledging…</h2><p id="m"></p><p><a href="/">Open Piece Tester →</a></p></div>
<script>
fetch('/api/alerts/${id}/acknowledge',{method:'POST',credentials:'same-origin'})
 .then(r=>r.json().then(d=>({ok:r.ok,d})))
 .then(({ok,d})=>{document.getElementById('s').textContent = ok ? '✔ Acknowledged' : 'Could not acknowledge';
   document.getElementById('m').textContent = ok ? (d.alreadyResolved?'This alert was already resolved.':'Re-alerts are now silenced until it recovers or the error changes.') : (d.error||'You may need to sign in first.');})
 .catch(()=>{document.getElementById('s').textContent='Could not acknowledge';document.getElementById('m').textContent='You may need to sign in first.';});
</script></body></html>`);
});
```

- [ ] **Step 2: Manual verify**

With the server running and a signed-in session, open `/ack/<id>` for a confirmed alert in the browser; confirm the page shows "✔ Acknowledged" and the alert row + Discord embed update. Open it while signed out; confirm it reports needing sign-in and does not change state (the POST 401s under the existing `/api` auth).

- [ ] **Step 3: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(alerts): /ack landing page for the discord link"
```

---

## Self-Review

**Spec coverage (event-alert scope of the spec):**
- §4 eager confirm-by-retest → Tasks 4.1–4.3 (verifying→confirmed/recovered; never-swallow on inconclusive). ✅
- §5.1 one-alert-per-target dedup → 4.2 (same-signature bump, silent). ✅
- §5.2 acknowledged→silent → 3.1 (`acknowledged` keeps it open) + 4.2 (dedup covers acked same-sig re-fires; a *different* signature deliberately re-alerts, matching §5.3). ✅
- §5.3 re-ping on error-signature change → 4.2 (the `existing && sig !== existing.error_signature` branch). ✅
- §5.4 recovery closes the loop → 4.2 flake path + 4.2 `finalizeWaveAlerts`. ✅
- §5.5 storm guard → 4.2 circuit breaker + `stormEmbed`. ✅
- §6 message anatomy → 2.2 embeds (verifying/confirmed/acknowledged/recovered/storm). ✅
- §7 direct webhook post/edit → 2.1. ✅
- §8 hyperlink acknowledge → 5.1 + 5.2; `acknowledged_by='web session'` (shared-password session; Phase 2 captures the Discord user). ✅
- §9 data model → 1.1 + 3.1. ✅
- §10 components/reuse → files map (reuses `classifyError` via `errorCategory` on steps, `quarantined_items`, `report-transport` pattern). ✅
- §11 scenarios: new bug ✅, flake ✅, monthly first-fail (retest is cadence-independent) ✅, assert_failed (piece-implicating) ✅, env-noise suppressed ✅, known-broken dedup ✅, recovered ✅, chronic (`fail_count`) ✅, new-different-error ✅, storm ✅, ack ✅, quarantined ✅, Discord unreachable (each `post`/`edit` wrapped in try/catch in `test-engine` + route; never blocks a run) ✅. **Deferred (Plan 2):** "sweep didn't run" (dead-man's-switch) and "connection broken → daily reauth nudge" — explicitly out of scope here.
- §13 testing strategy → unit tests in Tasks 2.1, 2.2, 3.1, 4.1, 4.2; manual verifies in 1.4, 1.5, 5.1, 5.2. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. The only cross-task ordering note (test-notification depends on notifier) is called out in Task 1.4. ✅

**Type consistency:** `AlertRow` (3.1) is the single source; `AlertDeps` (4.2) references it; `realAlertDeps` (4.3) supplies functions whose signatures match Tasks 1.2/3.1. `alertEmbed`/`stormEmbed`/`errorSignature` names identical across 2.2, 4.2, 5.1. `retestTarget`/`RetestResult` identical across 4.1/4.2/4.3. `processRunAlert`/`finalizeWaveAlerts`/`newWaveState` identical across 4.2/4.3 and `test-engine`. ✅

---

## Plan 2 (next document — not built here)

To be written after Plan 1 is validated in a live channel:
1. **Watchdog loop** (`server/src/services/alert-watchdog.ts`, started in `index.ts`) using `cron-parser` to compute each enabled schedule's expected previous fire.
2. **Dead-man's-switch** — overdue schedule (past expected fire + grace) → one `🟠 tester may be down` post; reset once it fires.
3. **Daily reauth digest** — at `notify_reauth_digest_time`, if `getAttentionItems()` has `reauth`-lane items, post one batched `🔌 N connections need reauth` message; persist last-sent date to avoid repeats.
4. **Phase 2 real Discord buttons** — a registered Discord app + interactions endpoint (Ed25519 verify) so Acknowledge/Quarantine work in-channel and capture the Discord user; reuses the alert table + `acknowledgeAlert`.
