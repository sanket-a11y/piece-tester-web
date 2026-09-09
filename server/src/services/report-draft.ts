import type { ParsedApError } from './ap-error.js';

const clean = (n: string) => n.replace('@activepieces/piece-', '');

export interface FailingTarget {
  action: string;
  category: string;
  error: ParsedApError | null;
  run_id: number;
  reproduction: string[];   // human-readable plan-step lines
}

export interface ReportFinding {
  piece_name: string;                 // '@activepieces/piece-streak'
  failing_targets: FailingTarget[];
  version?: string | null;
  authors?: string[];                 // upstream context; unset in v1 (see plan note)
}

export interface ReportDraft {
  title: string;
  description: string;   // markdown
  label: string;         // 'piece:<short>'
  priority: number;      // Linear: 1 urgent · 2 high · 3 medium · 4 low
}

/** Linear priority from the dominant error category. */
function priorityFor(category: string): number {
  return category === 'piece_error' ? 2 : 3;
}

/** Deterministic Linear-issue draft from a confirmed-broken piece finding. Pure — no I/O. */
export function buildReportDraft(finding: ReportFinding): ReportDraft {
  const short = clean(finding.piece_name);
  const targets = finding.failing_targets;
  const primary = targets[0]?.category || 'piece_error';

  const title = targets.length === 1
    ? `${short} / ${targets[0].action} failing (${primary})`
    : `${short} failing (${primary})`;

  const lines: string[] = [];
  lines.push(`**Piece:** \`${finding.piece_name}\`${finding.version ? ` (v${finding.version})` : ''}`);
  if (finding.authors?.length) lines.push(`**Upstream authors:** ${finding.authors.map(a => `@${a}`).join(', ')}`);
  lines.push('');
  lines.push(`Reported by Piece Tester — ${targets.length} failing target${targets.length === 1 ? '' : 's'}.`);
  for (const t of targets) {
    lines.push('');
    lines.push(`### \`${t.action}\` — ${t.category}`);
    if (t.error) {
      lines.push('');
      lines.push(`**${t.error.message}**`);
      const codeStatus = [
        t.error.code ? `\`${t.error.code}\`` : null,
        typeof t.error.status === 'number' ? `HTTP ${t.error.status}` : null,
      ].filter(Boolean);
      if (codeStatus.length) { lines.push(''); lines.push(codeStatus.join(' · ')); }
      const isJson = /^[\s]*[[{]/.test(t.error.raw);
      lines.push('');
      lines.push('```' + (isJson ? 'json' : ''));
      lines.push(t.error.raw);
      lines.push('```');
    }
    lines.push('');
    lines.push(`**Run:** #${t.run_id}`);
    if (t.reproduction.length) {
      lines.push('**Reproduction (test plan):**');
      t.reproduction.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
    }
  }

  return { title, description: lines.join('\n'), label: `piece:${short}`, priority: priorityFor(primary) };
}
