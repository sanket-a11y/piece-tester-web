import { describe, it, expect } from 'vitest';
import { pieceSlug, normalize, expectedTestName, classify } from './test-connection-matcher.js';
import type { AppConnection } from './ap-client.js';

function conn(over: Partial<AppConnection>): AppConnection {
  return {
    id: 'id1', pieceName: 'p', displayName: 'd', projectId: 'proj',
    externalId: 'ext1', type: 'OAUTH2', status: 'ACTIVE', ...over,
  };
}

describe('pieceSlug', () => {
  it('strips the @scope/piece- prefix', () => {
    expect(pieceSlug('@activepieces/piece-gmail')).toBe('gmail');
    expect(pieceSlug('@activepieces/piece-google-sheets')).toBe('google-sheets');
  });
  it('falls back to the raw name when there is no piece- segment', () => {
    expect(pieceSlug('gmail')).toBe('gmail');
  });
});

describe('normalize', () => {
  it('collapses case, spaces, underscores and hyphens to one form', () => {
    expect(normalize('Google Sheets - Piece Testing')).toBe('google-sheets-piece-testing');
    expect(normalize('google_sheets_piece_testing')).toBe('google-sheets-piece-testing');
    expect(normalize('  google--sheets  ')).toBe('google-sheets');
  });
});

describe('expectedTestName', () => {
  it('is the normalized slug plus -piece-testing', () => {
    expect(expectedTestName('@activepieces/piece-gmail')).toBe('gmail-piece-testing');
    expect(expectedTestName('@activepieces/piece-google-sheets')).toBe('google-sheets-piece-testing');
  });
});

describe('classify', () => {
  it('matches an exact name regardless of casing/spacing', () => {
    for (const name of ['gmail-piece-testing', 'Gmail-piece-testing', 'Gmail Piece Testing']) {
      const r = classify('@activepieces/piece-gmail', [conn({ displayName: name })]);
      expect(r.status).toBe('matched');
      expect(r.connection?.displayName).toBe(name);
    }
  });
  it('matches a suffix (a prefixed name)', () => {
    const r = classify('@activepieces/piece-gmail', [conn({ displayName: 'Prod gmail-piece-testing' })]);
    expect(r.status).toBe('matched');
  });
  it('does not match without a hyphen boundary before the slug', () => {
    // 'gmail-piece-testing' must not match piece 'mail' — the 'g' fuses the slug, so there is
    // no '-mail-piece-testing' boundary. Guards the suffix rule against false positives.
    const r = classify('@activepieces/piece-mail', [conn({ displayName: 'gmail-piece-testing' })]);
    expect(r.status).toBe('none');
  });
  it('returns none when nothing matches', () => {
    const r = classify('@activepieces/piece-notion', [conn({ displayName: 'gmail-piece-testing' })]);
    expect(r.status).toBe('none');
  });
  it('returns ambiguous with candidates when more than one matches', () => {
    const r = classify('@activepieces/piece-gmail', [
      conn({ id: 'a', displayName: 'gmail-piece-testing' }),
      conn({ id: 'b', displayName: 'my-gmail-piece-testing' }),
    ]);
    expect(r.status).toBe('ambiguous');
    expect(r.candidates?.map(c => c.displayName)).toEqual(['gmail-piece-testing', 'my-gmail-piece-testing']);
  });
});
