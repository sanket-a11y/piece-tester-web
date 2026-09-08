import { describe, it, expect } from 'vitest';
import { itemsForSelection } from './batch-selection.js';

const piece = {
  displayName: 'Slack',
  actions: {
    send_message: { displayName: 'Send Message' },
    update_message: { displayName: 'Update Message' },
  },
  triggers: {
    new_message: { displayName: 'New Message' },
  },
};

// update_message is already planned → should come back as 'skipped'.
const existingTargets = new Set(['action:update_message']);

describe('itemsForSelection', () => {
  it('omitted targets → all actions+triggers, already-planned one skipped', () => {
    const items = itemsForSelection(piece, { pieceName: 'slack' }, existingTargets);
    expect(items).toHaveLength(3);
    const byName = Object.fromEntries(items.map(i => [i.actionName, i]));
    expect(byName.send_message.targetType).toBe('action');
    expect(byName.send_message.status).toBe('pending');
    expect(byName.update_message.status).toBe('skipped');
    expect(byName.new_message.targetType).toBe('trigger');
    expect(byName.new_message.status).toBe('pending');
  });

  it('explicit subset → only those items', () => {
    const items = itemsForSelection(
      piece,
      { pieceName: 'slack', targets: [{ type: 'action', name: 'send_message' }] },
      existingTargets,
    );
    expect(items).toHaveLength(1);
    expect(items[0].actionName).toBe('send_message');
    expect(items[0].targetType).toBe('action');
    expect(items[0].status).toBe('pending');
  });

  it('unknown target name → skipped (not enqueued)', () => {
    const items = itemsForSelection(
      piece,
      { pieceName: 'slack', targets: [{ type: 'action', name: 'does_not_exist' }] },
      existingTargets,
    );
    expect(items).toHaveLength(0);
  });

  it('empty targets [] → returns [] (regression guard)', () => {
    const items = itemsForSelection(piece, { pieceName: 'slack', targets: [] }, existingTargets);
    expect(items).toEqual([]);
  });
});
