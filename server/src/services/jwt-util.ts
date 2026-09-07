/** Read the `exp` (epoch seconds) claim from a JWT without verifying its signature.
 *  We only ever read expiry from a token we already hold and trust. */
export function decodeJwtExp(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/** True when the token expires within `bufferMs`, or its expiry is unknown. */
export function jwtExpiringWithin(token: string, bufferMs: number): boolean {
  const exp = decodeJwtExp(token);
  if (exp === null) return true;
  return exp * 1000 - Date.now() < bufferMs;
}
