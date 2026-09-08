import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../db/schema.js';
import { getConnectionByPiece, createConnection } from '../db/queries.js';
import { sweepTestConnections } from './connection-sweep.js';
import type { AppConnection, ActivepiecesClient } from './ap-client.js';

function conn(over: Partial<AppConnection>): AppConnection {
  return {
    id: 'id1', pieceName: 'p', displayName: 'd', projectId: 'proj',
    externalId: 'ext1', type: 'OAUTH2', status: 'ACTIVE', ...over,
  };
}

/** Fake AP client exposing only listConnections; counts calls via the returned box. */
function fakeClient(list: AppConnection[]) {
  const box = { calls: 0 };
  const client = {
    listConnections: async () => { box.calls++; return list; },
  } as unknown as ActivepiecesClient;
  return { client, box };
}

describe('sweepTestConnections', () => {
  beforeEach(() => getDb().exec('DELETE FROM piece_connections; DELETE FROM test_plans;'));

  it('links a single clean match and stores {_imported, remote_id: externalId}', async () => {
    const { client, box } = fakeClient([
      conn({ id: 'r1', externalId: 'ext-gmail', displayName: 'gmail-piece-testing' }),
    ]);
    const result = await sweepTestConnections(client, ['@activepieces/piece-gmail']);

    expect(box.calls).toBe(1);
    expect(result.linked.map(r => r.pieceName)).toEqual(['@activepieces/piece-gmail']);
    const row = getConnectionByPiece('@activepieces/piece-gmail')!;
    expect(JSON.parse(row.connection_value)).toEqual({ _imported: true, remote_id: 'ext-gmail' });
  });

  it('skips an already-linked live piece and fetches only once for many pieces', async () => {
    createConnection({
      piece_name: '@activepieces/piece-gmail', display_name: 'x', connection_type: 'IMPORTED',
      connection_value: JSON.stringify({ _imported: true, remote_id: 'ext-gmail' }),
    });
    const { client, box } = fakeClient([
      conn({ id: 'r1', externalId: 'ext-gmail', displayName: 'gmail-piece-testing' }),
      conn({ id: 'r2', externalId: 'ext-slack', displayName: 'slack-piece-testing' }),
    ]);
    const result = await sweepTestConnections(client, [
      '@activepieces/piece-gmail', '@activepieces/piece-slack',
    ]);

    expect(box.calls).toBe(1);
    expect(result.alreadyLinked.map(r => r.pieceName)).toEqual(['@activepieces/piece-gmail']);
    expect(result.linked.map(r => r.pieceName)).toEqual(['@activepieces/piece-slack']);
  });

  it('reports none and ambiguous without linking', async () => {
    const { client } = fakeClient([
      conn({ id: 'a', externalId: 'ea', displayName: 'gmail-piece-testing' }),
      conn({ id: 'b', externalId: 'eb', displayName: 'my-gmail-piece-testing' }),
    ]);
    const result = await sweepTestConnections(client, [
      '@activepieces/piece-gmail', '@activepieces/piece-notion',
    ]);

    expect(result.skippedAmbiguous.map(r => r.pieceName)).toEqual(['@activepieces/piece-gmail']);
    expect(result.skippedAmbiguous[0].candidates).toEqual(['gmail-piece-testing', 'my-gmail-piece-testing']);
    expect(result.skippedNone.map(r => r.pieceName)).toEqual(['@activepieces/piece-notion']);
    expect(getConnectionByPiece('@activepieces/piece-gmail')).toBeUndefined();
  });
});
