import type { BatchQueueItem } from './plan-jobs.js';

type PieceMeta = { displayName: string; actions?: Record<string, any>; triggers?: Record<string, any> };
type Selection = { pieceName: string; targets?: { type: 'action' | 'trigger'; name: string }[] };

/** Build queue items for one selection. `targets` present (even empty) = only those that exist on the piece; omitted = all actions+triggers. */
export function itemsForSelection(
  piece: PieceMeta,
  selection: Selection,
  existingTargets: Set<string>,
): BatchQueueItem[] {
  const items: BatchQueueItem[] = [];
  const push = (targetType: 'action' | 'trigger', name: string, meta: any) => {
    items.push({
      pieceName: selection.pieceName,
      pieceDisplayName: piece.displayName,
      actionName: name,
      actionDisplayName: meta?.displayName || name,
      targetType,
      status: existingTargets.has(`${targetType}:${name}`) ? 'skipped' : 'pending',
    });
  };

  if (selection.targets) {
    // present (even []) → only the listed targets that exist on the piece
    for (const t of selection.targets) {
      const map = t.type === 'action' ? piece.actions : piece.triggers;
      const meta = map?.[t.name];
      if (meta) push(t.type, t.name, meta);
    }
  } else {
    for (const [name, meta] of Object.entries(piece.actions || {})) push('action', name, meta);
    for (const [name, meta] of Object.entries(piece.triggers || {})) push('trigger', name, meta);
  }
  return items;
}
