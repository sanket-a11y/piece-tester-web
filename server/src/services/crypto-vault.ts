import crypto from 'crypto';

const VERSION = 'v1';

/** Derive a 32-byte key from the configured secret, or null when none is set. */
function getKey(): Buffer | null {
  const secret = process.env.PIECE_TESTER_CRED_KEY || process.env.SESSION_SECRET;
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret).digest();
}

export function hasEncryptionKey(): boolean {
  return getKey() !== null;
}

/** AES-256-GCM encrypt. Output: `v1:<iv b64>:<tag b64>:<ciphertext b64>`. */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  if (!key) throw new Error('No encryption key configured (set PIECE_TESTER_CRED_KEY or SESSION_SECRET)');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

/** Reverse of encryptSecret. Throws on a missing key, bad version, or tampered payload. */
export function decryptSecret(payload: string): string {
  const key = getKey();
  if (!key) throw new Error('No encryption key configured (set PIECE_TESTER_CRED_KEY or SESSION_SECRET)');
  const [version, ivB64, tagB64, dataB64] = payload.split(':');
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) throw new Error('Unrecognized ciphertext format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
