import type { ToolDefinition } from '../types.js';
import { simulateTriggerOnAP } from '../../../services/trigger-engine.js';
import { ActivepiecesClient } from '../../../services/ap-client.js';

export const testTriggerSimulationTool: ToolDefinition = {
  name: 'test_trigger_simulation',
  description: `Validate a WEBHOOK/APP_WEBHOOK trigger end-to-end using the user's real connection: arm a SIMULATION listener, run a "generator" action to cause the event, then capture what the trigger receives. Use this to confirm that a given generator action actually fires the trigger BEFORE writing the plan. Returns the captured sample payload(s) and the generator's output. If 0 samples are captured, that generator action does NOT fire this trigger (or the timeout was too short) -- pick a different action.`,
  input_schema: {
    type: 'object' as const,
    properties: {
      description: { type: 'string', description: 'What you are validating and why' },
      trigger_name: { type: 'string', description: 'The trigger (WEBHOOK/APP_WEBHOOK) to arm' },
      trigger_input: { type: 'object' as const, description: 'Trigger input parameters (no auth needed)', additionalProperties: true },
      generator_action_name: { type: 'string', description: 'The action to run that should cause the trigger to fire' },
      generator_input: { type: 'object' as const, description: 'Input for the generator action (no auth needed)', additionalProperties: true },
    },
    required: ['description', 'trigger_name', 'generator_action_name', 'generator_input'],
  },
  async handler(input, ctx) {
    try {
      const result = await simulateTriggerOnAP({
        pieceMeta: ctx.pieceMeta,
        triggerName: input.trigger_name,
        triggerInput: input.trigger_input || {},
        generatorActionName: input.generator_action_name,
        generatorInput: input.generator_input || {},
      });
      const text = JSON.stringify(result, null, 2);
      if (result.sampleCount === 0) {
        return `Captured 0 events. Action "${input.generator_action_name}" did not fire trigger "${input.trigger_name}" within the timeout. Generator output:\n\n${JSON.stringify(result.generatorOutput, null, 2).slice(0, 4000)}`;
      }
      return `Success (${result.sampleCount} captured event(s)):\n\n${text.slice(0, 10000)}`;
    } catch (err: any) {
      return `Failed: ${ActivepiecesClient.formatError(err)}`;
    }
  },
};
