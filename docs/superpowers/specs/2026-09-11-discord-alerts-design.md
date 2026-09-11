# Discord Alerts — Design Spec

- **Date:** 2026-09-11
- **Status:** Approved for spec review (brainstorm complete)
- **Owner:** sanket
- **One-liner:** A Discord channel becomes the team's pull-me-in surface for *confirmed piece bugs* — so nobody has to open the app daily to find out what broke.

## 1. Problem & goal

Today, finding out a piece broke means opening the app and reading the Health tab. That does not scale to a team juggling pieces one-by-one and in batches. We want the team to be **notified in a shared Discord channel** only when it matters, with a way to **acknowledge** an alert so it stops nagging.

The make-or-break is **not** the Discord transport (trivial) — it's **what earns a ping**. A noisy channel gets muted on day two and the feature is dead. So this design is mostly an anti-noise design: Discord is a *surface for the triage state the app already tracks*, not a bolt-on notifier.

## 2. Non-goals (YAGNI)

- Not a full incident-management tool (no on-call rotations, SLAs, escalation ladders).
- Not per-user DMs or per-piece-owner routing in V1 — one team channel, one webhook.
- Not a real-time in-Discord button framework in V1 (needs a hosted Discord app; deferred to Phase 2).
- Not a replacement for the Health tab, Reports, or Needs-Attention inbox — it links *into* them.
- No Slack/email/other channels in V1.

## 3. Core principle

> Discord shows the state the app already computes. It never invents new truth.

The app already knows how to decide "this red is a real piece bug" (`classifyError` → `errorCategory`, the Needs-Attention lanes, `fail_streak`, assertion oracle). Discord alerts ride on that. The one *new* piece of judgement is **confirm-by-retest** (below), which replaces the old, cadence-coupled `fail_streak ≥ 2` gate.

## 4. Trigger model — eager confirm-by-retest (chosen: option B)

The old idea (`fail_streak ≥ 2` across scheduled fires) couples confirmation latency to schedule cadence: a **monthly** schedule would hide a real bug for up to a month. Rejected.

Instead, confirmation is decoupled from cadence by **re-running the target inline** on first failure. A monthly piece and an hourly piece both resolve within minutes.

Decision tree on the **first** failure of a target in a sweep:

```
Failure category?
 ├─ auth / rate_limit / transient    → env noise, NOT a piece bug
 │                                      → reauth/watching lane, no per-fire piece ping
 └─ piece_error / assert_failed /     → post "⏳ Verifying …" immediately (eager)
    bad_request / not_found              then retest inline up to 2× (short backoff)
        ├─ reproduces  → EDIT message → "🔴 Confirmed (failed 3×)"  → alert persists
        ├─ passes      → EDIT message → "🟢 Recovered on retest (flaky)" → self-retracts
        └─ inconclusive (retest hits    → keep as 🔴 confirmed with "unverified" note
           transient/auth)                (eager posture never swallows a monthly bug)
```

Notes:
- **Eager**: we post `⏳ Verifying` on the *first* failure (fast signal), then **edit the same message** to the outcome. This is why we post directly to a Discord webhook (see §7) — we need the message ID to edit it.
- Assertion failures are deterministic, so **one** retest confirms them cheaply.
- Env-noise categories are never retested and never produce a per-fire piece ping.
- `fail_streak` across fires is no longer the *gate*; it becomes a **label** on the message ("new this sweep" vs "chronic — broken 4 fires running").

## 5. Alert lifecycle & anti-noise engine

Each alert is one row keyed by `(piece_name, target_action, error_signature)`. `error_signature` = `error_category` + a fingerprint of the error (normalized first line / assertion path), so a *genuinely different* failure on the same target is a new alert, but the same failure re-firing is not.

State machine:

```
            first failure
   (none) ─────────────────▶ verifying ──reproduces──▶ confirmed
                                 │                          │
                          passes │                    ack link │ recovers on real sweep
                                 ▼                          ▼        │
                             recovered             acknowledged ─────┤
                          (self-retract)                             ▼
                                                                 recovered
```

Rules that keep the channel alive:

1. **One alert per broken target, not per fire.** A target broken across 5 monthly fires = one message, relabeled "chronic," never re-pinged.
2. **Acknowledged → silent** while it stays broken. The app records `acknowledged_by` + `acknowledged_at`.
3. **Re-ping only on a real state change:** the target *recovers then re-breaks*, or its `error_signature` changes (a new distinct failure).
4. **Recovery closes the loop.** When a broken target goes green on a real scheduled sweep, its message is edited to 🟢 with a "recovered after N days" note. The channel always reflects current truth.
5. **Storm guard.** If a single wave breaks more than `STORM_THRESHOLD` targets (default 8), that is almost certainly a platform/connection outage, not N independent piece bugs — collapse into **one** `⚠️ 23 targets failing this sweep — likely platform/connection issue` message with a link to the wave, and suppress the individual pings for that wave.
6. **Dead-man's-switch.** A testing tool that silently stops testing is worse than none (green-by-absence looks healthy). A watchdog compares each enabled schedule's expected fire (from its cron) against `schedules.last_run_at`; if overdue past a grace window, post one `🟠 Tester may be down — <schedule> hasn't fired since <time>` and don't repeat until it fires again.
7. **Reauth nudge (the one digest-style message).** Once daily (default 09:00, configurable), if any connections are broken/needing reauth — which silently *skips* their targets rather than failing them — post one batched `🔌 3 connections need reauth (skipping 41 targets)` message. Distinct low-priority styling from the event alerts.

## 6. Message anatomy

Confirmed (the common case):

```
🔴 Piece bug — Stripe · Create Customer
Confirmed · reproduced 3× · piece_error
"Cannot read property 'id' of undefined"
Broke this 09:00 sweep (was green last fire) · monthly schedule
Plan v4 · run #48213
→ Acknowledge   → Open in Health   → Quarantine
```

- **Verifying:** amber `⏳`, same card, "verifying…" instead of the reproduced count.
- **Recovered:** green `🟢`, "recovered after 6 days" / "recovered on retest (flaky)".
- **Storm / dead-man / reauth:** single-line summaries with a link into the relevant view; no per-target detail.

The three links are ordinary markdown hyperlinks (works via a plain webhook). `Open in Health` and `Quarantine` are deep-links; `Acknowledge` hits the ack endpoint (§8).

## 7. Delivery mechanism

- Post directly to a **Discord incoming webhook URL** stored in Settings (`notify_webhook_url`; empty = feature off).
- `POST <webhook>?wait=true` → returns the created message (we store `discord_message_id`).
- `PATCH <webhook>/messages/<id>` → edits it (verifying → confirmed/recovered).
- Reuses the HTTP-POST pattern already in `server/src/services/report-transport.ts` (the Linear webhook). No Discord bot, no secrets beyond the webhook URL.
- Failures to reach Discord are logged and retried best-effort; a delivery failure never blocks or fails a test run.

## 8. Acknowledge design

**V1 — hyperlink (chosen).** The `Acknowledge` link points at `GET /ack/<alertId>?t=<nonce>`. Because the app already has session auth, the page requires login; on success it flips the alert to `acknowledged` (records the session user + time), silences re-alerts, edits the Discord message to show "✔ acknowledged by <user>", then redirects into the Health detail for that target.

**Phase 2 — real Discord buttons.** A registered Discord application with a hosted interactions endpoint (Ed25519 signature verify) lets Acknowledge / Quarantine be clicked *in the channel*, capturing the Discord user. The V1 data model (alerts table + ack endpoint) is built so this is additive — no rework.

- **Acknowledge** = "a human owns this" → stop re-alerting until it recovers or the error signature changes.
- **Quarantine** = "stop testing/alerting this entirely" → writes the existing `quarantined_items` table; quarantined targets never alert.
- These are distinct from `resolved_issues` (which tracks findings inside an AI report analysis); the alert's own state table is the source of truth for dedup + message editing.

## 9. Data model

New table:

```sql
CREATE TABLE alerts (
  id                  INTEGER PRIMARY KEY,
  piece_name          TEXT NOT NULL,
  target_action       TEXT,
  target_type         TEXT,           -- 'action' | 'trigger'
  error_signature     TEXT NOT NULL,  -- category + fingerprint (dedup key)
  error_category      TEXT,
  error_message       TEXT,
  status              TEXT NOT NULL,  -- verifying|confirmed|acknowledged|recovered
  discord_message_id  TEXT,
  first_seen_at       TEXT,
  last_seen_at        TEXT,
  confirmed_at        TEXT,
  acknowledged_at     TEXT,
  acknowledged_by     TEXT,
  recovered_at        TEXT,
  fail_count          INTEGER DEFAULT 1,  -- fires broken while open → chronic label
  last_run_id         INTEGER,
  last_wave_id        TEXT,
  schedule_id         INTEGER
);
-- At most one OPEN (non-recovered) alert per (piece_name, target_action, error_signature).
```

Reuse: `quarantined_items` (mute), `classifyError`/`errorCategory`, wave/schedule columns on `test_plan_runs`.

Settings additions (in the `settings` table, mirroring `linear_report_webhook_url`):
`notify_webhook_url`, `notify_enabled`, `notify_storm_threshold` (default 8), `notify_reauth_digest_time` (default `09:00`), `notify_retest_count` (default 2).

## 10. Architecture & components

- **`server/src/services/notifier.ts`** (new): `postAlert`, `editAlert`, `postStormSummary`, `postReauthDigest`, `postHeartbeatWarning`. Owns webhook POST/PATCH + message formatting + storm-collapse. Pure-ish; takes the alert state and returns/records message IDs.
- **`server/src/services/plan-executor.ts`** (hook): after a scheduled run finishes failing with a piece-implicating category, run the inline retest (the "Phase 2 flaky detection" scoped but never built) and drive the alert state machine. Gated to `trigger_type='scheduled'`.
- **`server/src/db/queries.ts`** (new): alert CRUD + dedup (`upsertAlert`, `getOpenAlert`, `acknowledgeAlert`, `recoverAlert`, `countWaveFailures`).
- **`server/src/routes/alerts.ts`** (new): `GET /ack/<id>` landing page + `POST /alerts/:id/acknowledge`.
- **`server/src/routes/settings.ts`** (extend): read/write the `notify_*` settings + `POST /test-notification` ("Send test alert").
- **Watchdog**: a lightweight periodic check (reuse the scheduler's cron parsing) for the dead-man's-switch + the daily reauth digest.
- **`client/src/pages/Settings.tsx`** (extend): a "Discord alerts" section cloned from the Linear-webhook section — webhook URL, enable toggle, "Send test alert," storm threshold, reauth-digest time.

## 11. Scenarios (complete)

| Scenario | Behavior |
|---|---|
| New piece bug, reproduces | 🔴 confirmed alert, minutes after fire |
| Flake (passes on retest) | posts ⏳, self-retracts to 🟢, no lasting alert |
| Monthly piece, first-ever failure | alerted immediately — the whole point |
| Assertion failure (output mismatch) | deterministic → 1 retest confirms → 🔴 |
| Auth / rate-limit / transient | no per-fire piece ping; feeds the daily reauth nudge if connection-level |
| Already-known-broken re-fires | no re-ping (deduped); `fail_count`/chronic label updated |
| Broken → recovers on real sweep | message edited 🟢, loop closed |
| Chronic (broken N fires) | one message, labeled "chronic" |
| New *different* error on same target | new alert (error_signature changed) |
| > STORM_THRESHOLD targets fail one sweep | storm guard → single outage summary, per-target pings suppressed |
| Human clicks Acknowledge | silenced until recover / error-change; who+when recorded; message shows ✔ |
| Quarantined target | excluded entirely, no alerts |
| Sweep didn't run (scheduler/AP down) | dead-man's-switch → one "tester may be down" ping |
| Connection broken (targets skipped) | daily reauth nudge, not per-fire |
| Discord unreachable | logged + best-effort retry; never blocks a run |

## 12. Config & defaults

- `notify_retest_count` = 2 (failure + 2 = "reproduced 3×"), short backoff.
- `STORM_THRESHOLD` = 8 failing targets in one wave.
- Dead-man's-switch grace = one cron interval + a small buffer.
- Reauth digest = once daily, default 09:00 local, only if connections need reauth.
- No re-ping while a confirmed alert stays open & unacknowledged (recovery / error-change / ack are the only transitions). An optional weekly "still-open" reminder is Phase 2.

## 13. Testing strategy

- **Unit:** `error_signature` fingerprinting; alert dedup/upsert; storm-collapse threshold; state-machine transitions (verifying→confirmed/recovered, ack, re-break); reauth-digest batching.
- **Notifier:** message formatting per state; POST-then-PATCH message-edit flow against a mocked Discord endpoint; delivery-failure isolation (never throws into the run).
- **Integration:** a scheduled failing run drives verifying→confirmed and writes an alert row; a subsequent green sweep flips it to recovered; ack endpoint silences re-alerts.
- **Manual:** paste a real Discord webhook in Settings, "Send test alert," force a piece failure, watch the message self-edit; click Acknowledge.

## 14. Phasing

- **V1:** direct-webhook post/edit; confirm-by-retest; alert state table + dedup/lifecycle; storm guard; dead-man's-switch; daily reauth nudge; hyperlink Acknowledge; Settings section + test button.
- **Phase 2:** real in-Discord interactive buttons (Discord app + interactions endpoint); weekly still-open reminder; per-piece-owner routing / mentions; other channels (Slack/email).

## 15. Open questions

None blocking. Revisit after V1 usage: whether "unverified/inconclusive" confirmations produce too many self-retracting messages (tune retest count), and whether the reauth nudge should also cover targets skipped for non-connection reasons.
