import axios from 'axios';
import type { ToolDefinition } from '../types.js';

/** Fetch a single trigger's source file from the Activepieces GitHub repo. */
export async function fetchTriggerSourceFromGitHub(pieceName: string, triggerName: string): Promise<string | null> {
  const shortName = pieceName.replace('@activepieces/piece-', '');
  const baseUrl = `https://raw.githubusercontent.com/activepieces/activepieces/main/packages/pieces/community/${shortName}`;
  const dashName = triggerName.replace(/_/g, '-');
  const underName = triggerName.replace(/-/g, '_');
  const patterns = [
    `src/lib/triggers/${dashName}.ts`, `src/lib/triggers/${underName}.ts`,
    `src/lib/triggers/${dashName}-trigger.ts`, `src/lib/triggers/${underName}-trigger.ts`,
    `src/lib/triggers/${dashName}.trigger.ts`, `src/lib/triggers/${underName}.trigger.ts`,
    `src/lib/triggers/${dashName}/index.ts`, `src/lib/triggers/${underName}/index.ts`,
  ];
  for (const pattern of patterns) {
    try {
      const resp = await axios.get(`${baseUrl}/${pattern}`, { timeout: 8000 });
      if (resp.status === 200) return resp.data;
    } catch { /* try next */ }
  }
  return null;
}

export const fetchTriggerSourceTool: ToolDefinition = {
  name: 'fetch_trigger_source',
  description: 'Fetch the source code for a specific trigger file from GitHub. Use it to understand the trigger strategy (POLLING/WEBHOOK), its props, and the shape of the data it emits.',
  input_schema: {
    type: 'object' as const,
    properties: {
      trigger_name: { type: 'string', description: 'The trigger name key' },
      reason: { type: 'string', description: 'Why you need this trigger source' },
    },
    required: ['trigger_name', 'reason'],
  },
  async handler(input, ctx) {
    const source = await fetchTriggerSourceFromGitHub(ctx.pieceMeta.name, input.trigger_name);
    if (!source) return `Not found for "${input.trigger_name}". Use fetch_piece_source for all files.`;
    return `Trigger source:\n\n${source.slice(0, 15000)}`;
  },
};
