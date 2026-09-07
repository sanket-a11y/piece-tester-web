import { describe, it, expect, vi } from 'vitest';
import { decideRefresh, ensureFreshJwt, type RefreshDeps } from './auth-refresh.js';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const BUFFER = 5 * 60 * 1000;

// A token that is valid until `expMs`.
function tokenValidUntil(expMs: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(expMs / 1000) })}.sig`;
}

describe('decideRefresh', () => {
  const valid = tokenValidUntil(NOW + HOUR);
  const expiring = tokenValidUntil(NOW + 60 * 1000);

  it('use-current when the token is valid and not forced', () => {
    expect(decideRefresh(valid, true, { now: NOW, bufferMs: BUFFER })).toBe('use-current');
  });
  it('refresh when the token is expiring and creds exist', () => {
    expect(decideRefresh(expiring, true, { now: NOW, bufferMs: BUFFER })).toBe('refresh');
  });
  it('refresh when forced even if valid', () => {
    expect(decideRefresh(valid, true, { now: NOW, bufferMs: BUFFER, force: true })).toBe('refresh');
  });
  it('stale-no-creds when expiring but no creds', () => {
    expect(decideRefresh(expiring, false, { now: NOW, bufferMs: BUFFER })).toBe('stale-no-creds');
  });
  it('stale-no-creds when forced but no creds', () => {
    expect(decideRefresh(valid, false, { now: NOW, bufferMs: BUFFER, force: true })).toBe('stale-no-creds');
  });
});

// Build a fake deps object backed by an in-memory settings row.
function fakeDeps(over: Partial<{ jwt: string; email: string; enc: string; signInImpl: () => Promise<{ token: string }> }> = {}): {
  deps: RefreshDeps; persisted: Record<string, string>; signIn: ReturnType<typeof vi.fn>;
} {
  const row = { jwt_token: over.jwt ?? '', ap_service_email: over.email ?? '', ap_service_password: over.enc ?? '' };
  const persisted: Record<string, string> = {};
  const signIn = vi.fn(
    (over.signInImpl ?? (async () => ({ token: tokenValidUntil(NOW + HOUR) }))) as (baseUrl: string, email: string, password: string) => Promise<{ token: string }>,
  );
  const deps: RefreshDeps = {
    getStored: () => ({ jwtToken: row.jwt_token, email: row.ap_service_email, encryptedPassword: row.ap_service_password, baseUrl: 'https://cloud.activepieces.com/api' }),
    decryptPassword: (enc: string) => `decrypted(${enc})`,
    signIn: (baseUrl, email, password) => signIn(baseUrl, email, password),
    persist: (u) => Object.assign(persisted, u),
    now: () => NOW,
  };
  return { deps, persisted, signIn };
}

describe('ensureFreshJwt', () => {
  it('returns the stored token without signing in when it is valid', async () => {
    const { deps, signIn } = fakeDeps({ jwt: tokenValidUntil(NOW + HOUR), email: 'bot@x.io', enc: 'ENC' });
    const token = await ensureFreshJwt({}, deps);
    expect(token).toBe(tokenValidUntil(NOW + HOUR));
    expect(signIn).not.toHaveBeenCalled();
  });

  it('signs in and persists a fresh token + expiry + ok status when expiring', async () => {
    const fresh = tokenValidUntil(NOW + HOUR);
    const { deps, persisted, signIn } = fakeDeps({ jwt: tokenValidUntil(NOW + 1000), email: 'bot@x.io', enc: 'ENC', signInImpl: async () => ({ token: fresh }) });
    const token = await ensureFreshJwt({}, deps);
    expect(token).toBe(fresh);
    expect(signIn).toHaveBeenCalledWith('https://cloud.activepieces.com/api', 'bot@x.io', 'decrypted(ENC)');
    expect(persisted.jwt_token).toBe(fresh);
    expect(persisted.jwt_auth_status).toBe('ok');
    expect(persisted.jwt_expiry).toBe(new Date(NOW + HOUR).toISOString());
  });

  it('returns the stale token (no throw) when expiring but no creds', async () => {
    const stale = tokenValidUntil(NOW + 1000);
    const { deps, signIn } = fakeDeps({ jwt: stale, email: '', enc: '' });
    expect(await ensureFreshJwt({}, deps)).toBe(stale);
    expect(signIn).not.toHaveBeenCalled();
  });

  it('collapses concurrent callers into one sign-in (single-flight)', async () => {
    let resolve!: (v: { token: string }) => void;
    const gate = new Promise<{ token: string }>((r) => { resolve = r; });
    const { deps, signIn } = fakeDeps({ jwt: tokenValidUntil(NOW + 1000), email: 'bot@x.io', enc: 'ENC', signInImpl: () => gate });
    const a = ensureFreshJwt({}, deps);
    const b = ensureFreshJwt({}, deps);
    resolve({ token: tokenValidUntil(NOW + HOUR) });
    await Promise.all([a, b]);
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it('throws JwtRefreshError and records needs_attention when sign-in fails', async () => {
    const { deps, persisted } = fakeDeps({ jwt: tokenValidUntil(NOW + 1000), email: 'bot@x.io', enc: 'ENC', signInImpl: async () => { throw new Error('bad password'); } });
    await expect(ensureFreshJwt({}, deps)).rejects.toThrow(/bad password/);
    expect(persisted.jwt_auth_status).toContain('needs_attention:');
  });
});
