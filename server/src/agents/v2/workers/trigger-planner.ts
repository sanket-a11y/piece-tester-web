import type { PieceMetadataFull } from '../../../services/ap-client.js';
import type { OnLogCallback, TestPlanResult, ToolContext } from '../types.js';
import { runAgentLoop } from '../agent-runner.js';
import { createToolRegistry, TRIGGER_PLANNER_TOOLS } from '../tools/index.js';
import { TRIGGER_PLANNER_SYSTEM_PROMPT, buildTriggerPlannerUserPrompt } from '../prompts/trigger-planner.js';
import { parsePlanFromToolInput } from '../tools/set-plan.js';
import type { CostTracker } from '../cost-tracker.js';

/**
 * Run the trigger planner worker.
 *
 * Phase A: a single agent researches the trigger inline (source + live test_trigger)
 * and emits a plan with one trigger_test step (plus setup steps if the live test shows
 * the account has no matching data). Returns a TestPlanResult.
 */
export async function runTriggerPlannerWorker(params: {
  pieceMeta: PieceMetadataFull;
  triggerName: string;
  previousMemory?: string;
  onLog: OnLogCallback;
  abortSignal?: AbortSignal;
  costTracker?: CostTracker;
}): Promise<TestPlanResult> {
  const { pieceMeta, triggerName, previousMemory, onLog, abortSignal, costTracker } = params;
  const registry = createToolRegistry();

  const toolCtx: ToolContext = {
    pieceMeta,
    actionName: triggerName,
    targetKind: 'trigger',
    triggerName,
    abortSignal,
  };

  const result = await runAgentLoop(registry, {
    role: 'planner',
    model: '',
    systemPrompt: TRIGGER_PLANNER_SYSTEM_PROMPT,
    initialMessages: [
      { role: 'user', content: buildTriggerPlannerUserPrompt(pieceMeta, triggerName, previousMemory) },
    ],
    maxIterations: 12,
    toolNames: [...TRIGGER_PLANNER_TOOLS],
    abortSignal,
    onLog,
  }, toolCtx, costTracker);

  if (result.terminatedByTool && result.output) {
    return parsePlanFromToolInput(result.output as Record<string, any>);
  }

  onLog({ timestamp: Date.now(), type: 'error', role: 'planner', message: 'Trigger planner did not call set_test_plan. Returning empty plan.' });
  return { steps: [], note: 'Trigger planner agent failed to produce a plan. Try again.', agentMemory: undefined };
}
