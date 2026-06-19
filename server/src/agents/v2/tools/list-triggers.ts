import type { ToolDefinition } from '../types.js';

const AUTH_PROP_TYPES = ['OAUTH2', 'SECRET_TEXT', 'BASIC_AUTH', 'CUSTOM_AUTH'];
const SKIP_PROP_TYPES = ['MARKDOWN'];

export const listTriggersTool: ToolDefinition = {
  name: 'list_triggers',
  description: 'List all triggers in the piece with their strategy (POLLING/WEBHOOK/APP_WEBHOOK) and property details.',
  input_schema: {
    type: 'object' as const,
    properties: {
      verbose: { type: 'boolean', description: 'If true, include full property details for each trigger.' },
    },
    required: [],
  },
  async handler(input, ctx) {
    const lines: string[] = [];
    const verbose = input.verbose ?? false;
    const triggers = ctx.pieceMeta.triggers || {};

    if (Object.keys(triggers).length === 0) return 'This piece has no triggers.';

    for (const [name, trigger] of Object.entries(triggers)) {
      const trig = trigger as any;
      lines.push(`\n## ${name}: "${trig.displayName}" [${trig.type || 'UNKNOWN'}]`);
      if (trig.description) lines.push(`  ${trig.description}`);

      if (verbose && trig.props) {
        for (const [propName, propDef] of Object.entries(trig.props)) {
          const prop = propDef as any;
          const propType = prop.type ?? 'UNKNOWN';
          if (AUTH_PROP_TYPES.includes(propType) || SKIP_PROP_TYPES.includes(propType)) continue;
          const req = prop.required ? ' [REQUIRED]' : ' [optional]';
          const def = prop.defaultValue !== undefined ? ` (default: ${JSON.stringify(prop.defaultValue)})` : '';
          lines.push(`  - ${propName}: ${propType}${req}${def}`);
          if (prop.description) lines.push(`    ${prop.description}`);
          if (propType === 'STATIC_DROPDOWN' && prop.options?.options) {
            const opts = prop.options.options.slice(0, 10).map((o: any) => `"${o.label}"=${JSON.stringify(o.value)}`).join(', ');
            lines.push(`    Options: ${opts}`);
          }
          if (propType === 'DROPDOWN' || propType === 'MULTI_SELECT_DROPDOWN') {
            lines.push(`    ⚠ DYNAMIC DROPDOWN`);
          }
        }
      }
    }

    return lines.join('\n');
  },
};
