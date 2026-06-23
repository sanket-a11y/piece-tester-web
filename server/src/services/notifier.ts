/**
 * Failure notifier — posts a single aggregated payload to an Activepieces
 * Catch-Webhook flow when a scheduled run produces piece-implicating failures.
 * That AP flow (Catch Webhook trigger → Discord "Send Message" action) is what
 * actually delivers the message to Discord, so this app never holds Discord
 * secrets and the message formatting can be edited in AP without a redeploy.
 *
 * Design rules:
 *  - Fire-and-forget: a notification failure must NEVER break or throw into a run.
 *  - No-op when no webhook URL is configured, or when there are no failures to report.
 *  - Only piece-implicating failures are reported (see isPieceImplicating) — auth,
 *    rate-limit, transient (5xx/timeouts) and bad-request errors are env/credential
 *    noise, not piece bugs, and would just be alarm fatigue.
 */

import axios from 'axios';
import { getSettings } from '../db/queries.js';

/** One failing action/trigger surfaced in a Discord alert. */
export interface ScheduledFailure {
  piece: string;
  action: string;
  /** 'failed' | 'error' | 'assert_failed' | 'timeout' */
  status: string;
  /** Deterministic error category (only piece_error/unknown reach here). */
  category?: string;
  error: string;
}

/** The contract the Activepieces Catch-Webhook flow consumes. */
export interface ScheduledFailurePayload {
  event: 'scheduled_run_failed';
  /** Human label of the schedule that fired (e.g. "Nightly smoke"). */
  schedule: string;
  /** Legacy test_run id (for a link back), or null when only plans ran. */
  runId: number | null;
  trigger: string;
  /** ISO timestamp of when the alert was built. */
  ts: string;
  summary: { total: number; passed: number; failed: number };
  failures: ScheduledFailure[];
}

const PIECE_IMPLICATING_CATEGORIES = new Set(['piece_error', 'unknown']);

/**
 * Should this failure trigger a Discord alert?
 *  - assert_failed: the oracle caught wrong output → a real defect, always report.
 *  - failed/error/timeout: report ONLY when the error category implicates the piece
 *    (piece_error/unknown). auth, rate_limit, transient, bad_request, not_found are
 *    environment/credential noise and are suppressed.
 *  - A missing category is treated as implicating (conservative — don't silently drop).
 */
export function isPieceImplicating(status: string, category?: string): boolean {
  if (status === 'assert_failed') return true;
  if (status === 'failed' || status === 'error' || status === 'timeout') {
    return !category || PIECE_IMPLICATING_CATEGORIES.has(category);
  }
  return false;
}

function errMsg(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    return status ? `HTTP ${status}: ${err.message}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * POST the aggregated failure payload to the configured AP Catch-Webhook URL.
 * Never throws — logs and returns on any error so a flaky webhook can't break a run.
 */
export async function notifyScheduledFailure(payload: ScheduledFailurePayload): Promise<void> {
  const url = getSettings().notify_webhook_url?.trim();
  if (!url) return;                       // not configured → notifications off
  if (payload.failures.length === 0) return; // nothing piece-implicating to report

  try {
    await axios.post(url, payload, {
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });
    console.log(`[notifier] Sent failure alert for "${payload.schedule}" (${payload.failures.length} failure(s))`);
  } catch (err) {
    console.error(`[notifier] Failed to deliver alert for "${payload.schedule}":`, errMsg(err));
  }
}

/**
 * Send a representative sample payload so a user can verify their AP flow +
 * Discord wiring from the Settings page. Returns a structured result instead of
 * swallowing errors, so the UI can show success/failure.
 */
export async function sendTestNotification(): Promise<{ success: boolean; message: string }> {
  const url = getSettings().notify_webhook_url?.trim();
  if (!url) return { success: false, message: 'No notification webhook URL configured.' };

  const payload: ScheduledFailurePayload = {
    event: 'scheduled_run_failed',
    schedule: 'Test notification',
    runId: null,
    trigger: 'manual',
    ts: new Date().toISOString(),
    summary: { total: 1, passed: 0, failed: 1 },
    failures: [
      {
        piece: 'example-piece',
        action: 'example_action',
        status: 'failed',
        category: 'piece_error',
        error: 'This is a test alert from Piece Tester — your Discord wiring works.',
      },
    ],
  };

  try {
    await axios.post(url, payload, { timeout: 10_000, headers: { 'Content-Type': 'application/json' } });
    return { success: true, message: 'Test notification sent. Check your Discord channel.' };
  } catch (err) {
    return { success: false, message: `Failed to send: ${errMsg(err)}` };
  }
}
