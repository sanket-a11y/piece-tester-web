import type { AppConnection } from './ap-client.js';

export const TEST_MARKER = 'piece-testing';

/** "@activepieces/piece-google-sheets" -> "google-sheets". Falls back to the raw name. */
export function pieceSlug(pieceName: string): string {
  const m = pieceName.match(/piece-([^/]+)$/);
  return m ? m[1] : pieceName;
}

/** Lowercase; collapse any run of non-alphanumerics to a single "-"; trim leading/trailing "-". */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The expected normalized display name for a piece's test connection. */
export function expectedTestName(pieceName: string): string {
  return `${normalize(pieceSlug(pieceName))}-${TEST_MARKER}`;
}

export type MatchStatus = 'matched' | 'none' | 'ambiguous';
export interface MatchResult {
  status: MatchStatus;
  connection?: AppConnection;
  candidates?: AppConnection[];
  expected: string;
}

/**
 * Name-only matching. A remote connection matches piece P when its normalized displayName
 * equals P's expected test name, or ends with "-<expected>" (a prefixed name). Exactly one
 * candidate -> matched; zero -> none; more than one -> ambiguous (skip-and-report).
 */
export function classify(pieceName: string, remoteConns: AppConnection[]): MatchResult {
  const expected = expectedTestName(pieceName);
  const candidates = remoteConns.filter(c => {
    const n = normalize(c.displayName || '');
    return n === expected || n.endsWith(`-${expected}`);
  });
  if (candidates.length === 1) return { status: 'matched', connection: candidates[0], expected };
  if (candidates.length === 0) return { status: 'none', expected };
  return { status: 'ambiguous', candidates, expected };
}
