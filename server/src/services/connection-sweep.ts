import type { AppConnection, ActivepiecesClient } from './ap-client.js';
import { getConnectionByPiece, createConnection, markPlansStaleByPiece } from '../db/queries.js';
import { classify, expectedTestName } from './test-connection-matcher.js';

export interface SweepPieceResult {
  pieceName: string;
  outcome: 'linked' | 'already_linked' | 'skipped_none' | 'skipped_ambiguous' | 'error';
  displayName?: string;
  candidates?: string[];
  error?: string;
  expected: string;
}
export interface SweepResult {
  linked: SweepPieceResult[];
  alreadyLinked: SweepPieceResult[];
  skippedNone: SweepPieceResult[];
  skippedAmbiguous: SweepPieceResult[];
  errored: SweepPieceResult[];
}

/** True when the piece has an active _imported connection whose remote_id still resolves to a
 *  row upstream (presence only — does not check the remote connection's health/status). */
function isLiveImported(pieceName: string, remoteList: AppConnection[]): boolean {
  const row = getConnectionByPiece(pieceName);
  if (!row) return false;
  let value: any;
  try { value = JSON.parse(row.connection_value); } catch { return false; }
  if (!value?._imported) return false;
  const rid = value.remote_id;
  return remoteList.some(rc => rc.id === rid || rc.externalId === rid);
}

/** Fetch the AP connection list once; per piece, skip if already linked, else link a single match. */
export async function sweepTestConnections(
  client: ActivepiecesClient,
  pieceNames: string[],
): Promise<SweepResult> {
  const remoteList = await client.listConnections();
  const result: SweepResult = { linked: [], alreadyLinked: [], skippedNone: [], skippedAmbiguous: [], errored: [] };

  for (const pieceName of pieceNames) {
    const expected = expectedTestName(pieceName);
    if (isLiveImported(pieceName, remoteList)) {
      result.alreadyLinked.push({ pieceName, outcome: 'already_linked', expected });
      continue;
    }
    const m = classify(pieceName, remoteList);
    if (m.status === 'matched' && m.connection) {
      const c = m.connection;
      try {
        createConnection({
          piece_name: pieceName,
          display_name: c.displayName,
          connection_type: c.type || 'IMPORTED',
          connection_value: JSON.stringify({ _imported: true, remote_id: c.externalId || c.id }),
        });
        markPlansStaleByPiece(pieceName);
        result.linked.push({ pieceName, outcome: 'linked', displayName: c.displayName, expected });
      } catch (err) {
        // A matched connection that failed to persist is an actionable error, not a benign
        // no-match — keep it distinct and carry the message so the report can surface it.
        result.errored.push({
          pieceName, outcome: 'error', expected,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (m.status === 'ambiguous') {
      result.skippedAmbiguous.push({
        pieceName, outcome: 'skipped_ambiguous', expected,
        candidates: (m.candidates || []).map(c => c.displayName),
      });
    } else {
      result.skippedNone.push({ pieceName, outcome: 'skipped_none', expected });
    }
  }
  return result;
}
