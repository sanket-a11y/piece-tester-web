/**
 * Trigger Engine -- executes a single piece trigger against Activepieces and
 * returns its sample data.
 *
 * Triggers do NOT use the action test-step endpoint. AP exposes a dedicated
 * `POST /v1/test-trigger` endpoint (JWT-only) with two strategies keyed off the
 * trigger's TriggerStrategy:
 *
 *  - TEST_FUNCTION (POLLING triggers): synchronously runs the trigger's `test()` hook
 *    and returns captured sample events directly. The clean analog of test-step. (Phase A)
 *  - SIMULATION (WEBHOOK / APP_WEBHOOK): arm a temporary listener, cause a real event
 *    (a paired "generator" action), poll trigger-events, then cancel. (Phase B)
 *
 * SIMULATION is a toggle: the first test-trigger(SIMULATION) call ARMS the listener;
 * cancelTestTrigger (DELETE) disarms it. It needs a flow that stays alive across
 * arm -> generate-event -> capture -> cancel, unlike TEST_FUNCTION / actions which each
 * create a throwaway flow. The plan-executor owns that flow via a TriggerSimContext.
 */

import type { PieceMetadataFull } from './ap-client.js';
import { createClient } from './test-engine.js';
import { executeActionOnAP, resolveConnectionAuthInput } from './ai-config-generator.js';
import type { ActivepiecesClient } from './ap-client.js';

const TRIGGER_STEP_NAME = 'trigger';
const CAPTURE_POLL_INTERVAL_MS = 3_000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 90_000;
/** Buffer after arming, to let an external app's webhook subscription settle before we fire the event. */
const ARM_SETTLE_MS = 2_000;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/** Optional progress logger so callers (the executor) can surface live status to the UI. */
export type TriggerLog = (message: string) => void;

export interface TriggerSampleResult {
  /** Number of sample events the trigger returned/captured. */
  sampleCount: number;
  /** The decoded payloads of the captured sample events (most recent first). */
  samples: unknown[];
}

/**
 * A live SIMULATION test: a flow whose trigger source is armed and waiting for an event.
 * Must be cancelled (cancelTriggerSimulation) to disarm the listener and delete the flow.
 */
export interface TriggerSimContext {
  flowId: string;
  flowVersionId: string;
  triggerName: string;
}

/** Create a flow whose trigger is the given piece trigger (auth + input resolved). */
async function createTriggerFlow(
  apClient: ActivepiecesClient,
  pieceMeta: PieceMetadataFull,
  triggerName: string,
  input: Record<string, unknown>,
): Promise<{ flowId: string; flowVersionId: string }> {
  const { authInput, inputWithoutAuth } = await resolveConnectionAuthInput(apClient, pieceMeta, input);
  const flow = await apClient.createFlow(`[AI Agent] ${pieceMeta.displayName} - ${triggerName} (trigger)`);
  const updatedFlow = await apClient.applyFlowOperation(flow.id, {
    type: 'UPDATE_TRIGGER',
    request: {
      type: 'PIECE_TRIGGER',
      name: TRIGGER_STEP_NAME,
      displayName: `Trigger: ${triggerName}`,
      valid: true,
      settings: {
        pieceName: pieceMeta.name,
        pieceVersion: `~${pieceMeta.version}`,
        triggerName,
        // authInput takes priority -- never let raw input.auth override the formatted connection ref
        input: { ...authInput, ...inputWithoutAuth },
        propertySettings: {},
      },
    },
  });
  return { flowId: flow.id, flowVersionId: updatedFlow.version.id };
}

/**
 * Execute a piece trigger via the TEST_FUNCTION strategy and return its sample data.
 * (POLLING triggers.) Throws if the trigger errors or JWT is missing. Zero samples is
 * NOT an error here -- the caller decides whether an empty result is acceptable.
 */
export async function executeTriggerOnAP(
  pieceMeta: PieceMetadataFull,
  triggerName: string,
  input: Record<string, unknown>,
  strategy: 'TEST_FUNCTION' | 'SIMULATION' = 'TEST_FUNCTION',
  onLog?: TriggerLog,
): Promise<TriggerSampleResult> {
  if (!pieceMeta.triggers[triggerName]) {
    throw new Error(`Trigger "${triggerName}" not found. Available: ${Object.keys(pieceMeta.triggers).join(', ')}`);
  }
  if (strategy !== 'TEST_FUNCTION') {
    throw new Error(`executeTriggerOnAP only handles TEST_FUNCTION. For SIMULATION use armTriggerSimulation + captureTriggerEvents.`);
  }

  const apClient = createClient();
  if (!apClient.hasJwtToken()) throw new Error('JWT token required. Sign in via Settings first.');

  onLog?.(`Setting up a test flow for polling trigger "${triggerName}"…`);
  const { flowId, flowVersionId } = await createTriggerFlow(apClient, pieceMeta, triggerName, input);
  try {
    onLog?.(`Running the trigger's test() against the live connection…`);
    const page = await apClient.testTrigger(flowId, flowVersionId, 'TEST_FUNCTION');
    const samples = (page?.data ?? []).map(e => e.payload);
    onLog?.(samples.length > 0
      ? `✓ Received ${samples.length} sample item(s) from "${triggerName}".`
      : `test() returned 0 sample items (the account may have no matching data yet).`);
    return { sampleCount: samples.length, samples };
  } finally {
    await apClient.deleteFlowSafely(flowId, 5, `ai-agent-trigger:${triggerName}`);
  }
}

/**
 * Arm a SIMULATION listener for a WEBHOOK / APP_WEBHOOK trigger.
 * Creates a flow with the trigger, then calls test-trigger(SIMULATION) which subscribes
 * the temporary listener with the external app. Returns a context the caller MUST later
 * pass to cancelTriggerSimulation (even on error) to disarm + delete the flow.
 */
export async function armTriggerSimulation(
  pieceMeta: PieceMetadataFull,
  triggerName: string,
  input: Record<string, unknown>,
  onLog?: TriggerLog,
): Promise<TriggerSimContext> {
  if (!pieceMeta.triggers[triggerName]) {
    throw new Error(`Trigger "${triggerName}" not found. Available: ${Object.keys(pieceMeta.triggers).join(', ')}`);
  }
  const apClient = createClient();
  if (!apClient.hasJwtToken()) throw new Error('JWT token required. Sign in via Settings first.');

  onLog?.(`Setting up a test flow with trigger "${triggerName}"…`);
  const { flowId, flowVersionId } = await createTriggerFlow(apClient, pieceMeta, triggerName, input);
  const ctx: TriggerSimContext = { flowId, flowVersionId, triggerName };
  try {
    onLog?.(`Subscribing to the webhook (arming simulation listener)…`);
    // First SIMULATION call arms the listener (AP awaits the trigger's onEnable/subscribe).
    await apClient.testTrigger(flowId, flowVersionId, 'SIMULATION');
    // Brief settle so an external webhook subscription is live before the generator fires.
    await sleep(ARM_SETTLE_MS);
    onLog?.(`✓ Webhook subscribed. Listening for "${triggerName}" events.`);
    return ctx;
  } catch (err) {
    // Clean up the flow if arming failed, then rethrow.
    await cancelTriggerSimulation(ctx).catch(() => {});
    throw err;
  }
}

/**
 * Poll captured trigger-events for an armed SIMULATION flow until at least one event
 * arrives or the timeout elapses. Returns the captured payloads (does NOT throw on
 * timeout -- returns sampleCount 0 so the caller can decide).
 */
export async function captureTriggerEvents(
  ctx: TriggerSimContext,
  timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
  onLog?: TriggerLog,
): Promise<TriggerSampleResult> {
  const apClient = createClient();
  const start = Date.now();
  const deadline = start + timeoutMs;
  onLog?.(`Waiting for the webhook to deliver an event (up to ${Math.round(timeoutMs / 1000)}s)…`);
  let polls = 0;
  while (Date.now() < deadline) {
    try {
      const page = await apClient.listTriggerEvents(ctx.flowId, 10);
      const data = page?.data ?? [];
      if (data.length > 0) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        onLog?.(`✓ Received ${data.length} event(s) from "${ctx.triggerName}" after ${elapsed}s.`);
        return { sampleCount: data.length, samples: data.map(e => e.payload) };
      }
    } catch {
      // events endpoint may briefly 404 right after arming -- keep polling
    }
    polls++;
    if (polls % 3 === 0) {
      onLog?.(`…still waiting for an event (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
    }
    await sleep(CAPTURE_POLL_INTERVAL_MS);
  }
  onLog?.(`No event received within ${Math.round(timeoutMs / 1000)}s.`);
  return { sampleCount: 0, samples: [] };
}

/** Disarm a SIMULATION listener and delete its flow. Safe to call more than once. */
export async function cancelTriggerSimulation(ctx: TriggerSimContext, onLog?: TriggerLog): Promise<void> {
  const apClient = createClient();
  try {
    onLog?.(`Unsubscribing the webhook (disarming listener)…`);
    await apClient.cancelTestTrigger(ctx.flowId);
  } catch {
    // Listener may already be disabled / flow gone -- proceed to delete.
  }
  await apClient.deleteFlowSafely(ctx.flowId, 5, `ai-agent-trigger-sim:${ctx.triggerName}`);
}

/**
 * One-shot SIMULATION test for use by the planner's research tool: arm the trigger, run a
 * generator action to cause the event, capture, then cancel. Returns the captured samples.
 * Mirrors what the plan-executor does across separate steps, but composed for a single call.
 */
export async function simulateTriggerOnAP(params: {
  pieceMeta: PieceMetadataFull;
  triggerName: string;
  triggerInput?: Record<string, unknown>;
  generatorActionName: string;
  generatorInput?: Record<string, unknown>;
  captureTimeoutMs?: number;
  onLog?: TriggerLog;
}): Promise<TriggerSampleResult & { generatorOutput: unknown }> {
  const { pieceMeta, triggerName, triggerInput = {}, generatorActionName, generatorInput = {}, captureTimeoutMs, onLog } = params;
  const ctx = await armTriggerSimulation(pieceMeta, triggerName, triggerInput, onLog);
  try {
    onLog?.(`Running generator action "${generatorActionName}" to fire the trigger…`);
    const generatorOutput = await executeActionOnAP(pieceMeta, generatorActionName, generatorInput);
    const captured = await captureTriggerEvents(ctx, captureTimeoutMs, onLog);
    return { ...captured, generatorOutput };
  } finally {
    await cancelTriggerSimulation(ctx, onLog).catch(() => {});
  }
}
