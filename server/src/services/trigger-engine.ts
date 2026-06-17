/**
 * Trigger Engine -- executes a single piece trigger against Activepieces and
 * returns its sample data.
 *
 * Triggers do NOT use the action test-step endpoint. AP exposes a dedicated
 * `POST /v1/test-trigger` endpoint (JWT-only) with two strategies keyed off the
 * trigger's TriggerStrategy:
 *
 *  - TEST_FUNCTION (POLLING triggers): synchronously runs the trigger's `test()` hook
 *    and returns captured sample events directly. This is the clean analog of test-step
 *    and is what Phase A implements.
 *  - SIMULATION (WEBHOOK / APP_WEBHOOK): arm a temporary listener, cause a real event,
 *    poll trigger-events, then cancel. (Phase B.)
 */

import type { PieceMetadataFull } from './ap-client.js';
import { createClient } from './test-engine.js';
import { resolveConnectionAuthInput } from './ai-config-generator.js';

const TRIGGER_STEP_NAME = 'trigger';

export interface TriggerSampleResult {
  /** Number of sample events the trigger returned. */
  sampleCount: number;
  /** The decoded payloads of the captured sample events (most recent first). */
  samples: unknown[];
}

/**
 * Execute a piece trigger via the TEST_FUNCTION strategy and return its sample data.
 *
 * Flow: create flow -> UPDATE_TRIGGER (piece trigger + auth + input) -> test-trigger
 * (TEST_FUNCTION) -> read returned events -> delete flow.
 *
 * Throws if the trigger errors (AP returns TEST_TRIGGER_FAILED) or JWT is missing.
 * A successful run with zero sample items is NOT an error here -- the caller decides
 * whether an empty result is acceptable.
 */
export async function executeTriggerOnAP(
  pieceMeta: PieceMetadataFull,
  triggerName: string,
  input: Record<string, unknown>,
  strategy: 'TEST_FUNCTION' | 'SIMULATION' = 'TEST_FUNCTION',
): Promise<TriggerSampleResult> {
  if (!pieceMeta.triggers[triggerName]) {
    throw new Error(`Trigger "${triggerName}" not found. Available: ${Object.keys(pieceMeta.triggers).join(', ')}`);
  }
  if (strategy !== 'TEST_FUNCTION') {
    throw new Error(`Trigger strategy "${strategy}" is not supported yet (Phase A handles polling/TEST_FUNCTION only).`);
  }

  const apClient = createClient();
  if (!apClient.hasJwtToken()) throw new Error('JWT token required. Sign in via Settings first.');

  const { authInput, inputWithoutAuth } = await resolveConnectionAuthInput(apClient, pieceMeta, input);

  const flow = await apClient.createFlow(`[AI Agent] ${pieceMeta.displayName} - ${triggerName} (trigger)`);
  try {
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

    const page = await apClient.testTrigger(flow.id, updatedFlow.version.id, 'TEST_FUNCTION');
    const samples = (page?.data ?? []).map(e => e.payload);
    return { sampleCount: samples.length, samples };
  } finally {
    await apClient.deleteFlowSafely(flow.id, 5, `ai-agent-trigger:${triggerName}`);
  }
}
