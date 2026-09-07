import { getSettings, updateSettings } from '../db/queries.js';
import { ActivepiecesClient } from './ap-client.js';
import { decryptSecret } from './crypto-vault.js';
import { decodeJwtExp } from './jwt-util.js';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export class JwtRefreshError extends Error {}

export type RefreshDecision = 'use-current' | 'refresh' | 'stale-no-creds';

/** Pure decision: given the current token, whether creds exist, and options, what should we do? */
export function decideRefresh(
  jwtToken: string,
  hasCreds: boolean,
  opts: { now: number; bufferMs: number; force?: boolean },
): RefreshDecision {
  const exp = decodeJwtExp(jwtToken);
  const stale = opts.force || exp === null || exp * 1000 - opts.now < opts.bufferMs;
  if (!stale) return 'use-current';
  return hasCreds ? 'refresh' : 'stale-no-creds';
}

/** Injectable IO surface so ensureFreshJwt is testable without module mocks. */
export interface RefreshDeps {
  getStored: () => { jwtToken: string; email: string; encryptedPassword: string; baseUrl: string };
  decryptPassword: (encrypted: string) => string;
  signIn: (baseUrl: string, email: string, password: string) => Promise<{ token: string }>;
  persist: (updates: { jwt_token?: string; jwt_expiry?: string; jwt_auth_status?: string }) => void;
  now: () => number;
}

const defaultDeps: RefreshDeps = {
  getStored: () => {
    const s = getSettings();
    return { jwtToken: s.jwt_token, email: s.ap_service_email, encryptedPassword: s.ap_service_password, baseUrl: s.base_url };
  },
  decryptPassword: decryptSecret,
  signIn: (baseUrl, email, password) => ActivepiecesClient.signIn(baseUrl, email, password),
  persist: (updates) => { updateSettings(updates); },
  now: () => Date.now(),
};

let inFlight: Promise<string> | null = null;

/**
 * Ensure a usable JWT is stored and return it.
 * - Valid token -> returned as-is (no network).
 * - Expiring + creds -> one silent re-sign-in, persisted (single-flight).
 * - Expiring + no creds -> the stale token is returned unchanged; the caller/UI surfaces "reconnect".
 * Throws JwtRefreshError (and records needs_attention) only when a real sign-in attempt fails.
 */
export async function ensureFreshJwt(opts: { force?: boolean } = {}, deps: RefreshDeps = defaultDeps): Promise<string> {
  const stored = deps.getStored();
  const hasCreds = !!(stored.email && stored.encryptedPassword);
  const decision = decideRefresh(stored.jwtToken, hasCreds, { now: deps.now(), bufferMs: REFRESH_BUFFER_MS, force: opts.force });

  if (decision === 'use-current' || decision === 'stale-no-creds') return stored.jwtToken;

  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const password = deps.decryptPassword(stored.encryptedPassword);
      const { token } = await deps.signIn(stored.baseUrl, stored.email, password);
      const exp = decodeJwtExp(token);
      deps.persist({
        jwt_token: token,
        jwt_expiry: exp ? new Date(exp * 1000).toISOString() : '',
        jwt_auth_status: 'ok',
      });
      return token;
    } catch (err) {
      const reason = ActivepiecesClient.formatError(err);
      deps.persist({ jwt_auth_status: `needs_attention:${reason}` });
      throw new JwtRefreshError(reason);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** True for an Activepieces auth rejection (expired/invalid JWT). */
export function isAuthError(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 401 || status === 403;
}
