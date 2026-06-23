import type { ToolDefinition } from '../types.js';
import { executeTriggerOnAP } from '../../../services/trigger-engine.js';
import { ActivepiecesClient } from '../../../services/ap-client.js';

export const testTriggerTool: ToolDefinition = {
  name: 'test_trigger',
  description: `Run a POLLING trigger via the test-trigger (TEST_FUNCTION) endpoint using the user's real connection, and return its sample data. Use this to confirm the trigger returns data and to learn the shape of the emitted payload. If it returns zero samples, you likely need a setup step that first creates the data the trigger watches for.`,
  input_schema: {
    type: 'object' as const,
    properties: {
      description: { type: 'string', description: 'What you are testing and why' },
      trigger_name: { type: 'string', description: 'The trigger name to test' },
      input: { type: 'object' as const, description: 'Trigger input parameters (no auth needed)', additionalProperties: true },
    },
    required: ['description', 'trigger_name', 'input'],
  },
  async handler(input, ctx) {
    try {
      const result = await executeTriggerOnAP(ctx.pieceMeta, input.trigger_name, input.input || {}, 'TEST_FUNCTION');
      const text = JSON.stringify(result, null, 2);
      return `Success (${result.sampleCount} sample event(s)):\n\n${text.slice(0, 10000)}`;
    } catch (err: any) {
      return `Failed: ${ActivepiecesClient.formatError(err)}`;
    }
  },
};
