import type { ToolDefinition, TestPlanStep } from '../types.js';

/**
 * Terminal tool: when an agent calls this, the runner captures its input
 * as the plan result and stops the loop. The handler itself just returns
 * an acknowledgement -- the runner intercepts the structured input.
 */
export const setPlanTool: ToolDefinition = {
  name: 'set_test_plan',
  description: 'Create the multi-step test plan. Each step will be executed sequentially at test time. Use inputMapping to pipe outputs from earlier steps.',
  input_schema: {
    type: 'object' as const,
    properties: {
      steps: {
        type: 'array' as const,
        description: 'Ordered list of test steps',
        items: {
          type: 'object' as const,
          properties: {
            id: { type: 'string', description: 'Unique step ID, e.g. "step_1"' },
            type: { type: 'string', enum: ['setup', 'test', 'verify', 'cleanup', 'human_input', 'trigger_test'], description: 'setup=create resources, test=the actual action being tested, verify=check result, cleanup=tear down, human_input=ask user for a value, trigger_test=run the piece trigger under test' },
            label: { type: 'string', description: 'Short human-readable label' },
            description: { type: 'string', description: 'Longer explanation of what this step does and why' },
            actionName: { type: 'string', description: 'The Activepieces action name to execute (empty for human_input and trigger_test steps)' },
            kind: { type: 'string', enum: ['action', 'trigger'], description: 'Step kind. Omit or "action" for normal action steps. Use "trigger" for the trigger_test step.' },
            triggerName: { type: 'string', description: 'For kind="trigger": the trigger name to run.' },
            triggerStrategy: { type: 'string', enum: ['TEST_FUNCTION'], description: 'For kind="trigger": how to test it. Use TEST_FUNCTION for POLLING triggers.' },
            input: { type: 'object' as const, description: 'Static input values for this step. Auth is added automatically.', additionalProperties: true },
            inputMapping: {
              type: 'object' as const,
              description: 'Dynamic input references. Maps field names to "${steps.<stepId>.output.<path>}" expressions.',
              additionalProperties: { type: 'string' },
            },
            requiresApproval: { type: 'boolean', description: 'AVOID using this. Plans run unattended on schedules.' },
            humanPrompt: { type: 'string', description: 'Only for human_input type: the question to show the user' },
          },
          required: ['id', 'type', 'label', 'description', 'actionName', 'input'],
        },
      },
      note: { type: 'string', description: 'Summary note for the user about this test plan' },
      agent_memory: { type: 'string', description: 'Compact summary of what you discovered and decided. Saved for future sessions.' },
    },
    required: ['steps', 'note'],
  },
  async handler(input) {
    return 'Test plan created.';
  },
};

/** Parse the raw tool input into a typed TestPlanResult. */
export function parsePlanFromToolInput(input: Record<string, any>): { steps: TestPlanStep[]; note: string; agentMemory?: string } {
  const steps: TestPlanStep[] = (input.steps || []).map((s: any) => {
    // A step is a trigger step if explicitly marked, or if it's a trigger_test type with a triggerName.
    const isTrigger = s.kind === 'trigger' || (s.type === 'trigger_test' && !!s.triggerName);
    return {
      id: s.id || `step_${Math.random().toString(36).slice(2, 6)}`,
      type: s.type || 'test',
      label: s.label || '',
      description: s.description || '',
      actionName: s.actionName || '',
      input: s.input || {},
      inputMapping: s.inputMapping || {},
      requiresApproval: s.requiresApproval || false,
      humanPrompt: s.humanPrompt || undefined,
      ...(isTrigger ? {
        kind: 'trigger' as const,
        triggerName: s.triggerName || s.actionName || '',
        triggerStrategy: (s.triggerStrategy as 'TEST_FUNCTION' | 'SIMULATION') || 'TEST_FUNCTION',
      } : {}),
    };
  });
  return {
    steps,
    note: input.note || '',
    agentMemory: input.agent_memory || undefined,
  };
}
