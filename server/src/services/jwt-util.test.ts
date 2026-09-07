import { describe, it, expect } from 'vitest';
import { decodeJwtExp, jwtExpiringWithin } from './jwt-util.js';

// A JWT is three base64url segments: header.payload.signature. We only read payload.exp.
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

describe('decodeJwtExp', () => {
  it('reads the exp claim in epoch seconds', () => {
    expect(decodeJwtExp(makeJwt({ exp: 1700000000 }))).toBe(1700000000);
  });
  it('returns null when exp is missing', () => {
    expect(decodeJwtExp(makeJwt({ sub: 'u1' }))).toBeNull();
  });
  it('returns null for a non-JWT string', () => {
    expect(decodeJwtExp('not-a-jwt')).toBeNull();
  });
  it('returns null for a malformed payload segment', () => {
    expect(decodeJwtExp('aaa.@@@.ccc')).toBeNull();
  });
});

describe('jwtExpiringWithin', () => {
  it('true when the token expires inside the buffer', () => {
    const soon = Math.floor(Date.now() / 1000) + 60; // 1 min out
    expect(jwtExpiringWithin(makeJwt({ exp: soon }), 5 * 60 * 1000)).toBe(true);
  });
  it('false when the token is comfortably valid', () => {
    const later = Math.floor(Date.now() / 1000) + 60 * 60; // 1 hour out
    expect(jwtExpiringWithin(makeJwt({ exp: later }), 5 * 60 * 1000)).toBe(false);
  });
  it('true (treat as needs-refresh) when exp is unknown', () => {
    expect(jwtExpiringWithin('not-a-jwt', 5 * 60 * 1000)).toBe(true);
  });
});
