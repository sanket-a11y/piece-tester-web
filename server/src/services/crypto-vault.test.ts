import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encryptSecret, decryptSecret, hasEncryptionKey } from './crypto-vault.js';

const SAVED = { cred: process.env.PIECE_TESTER_CRED_KEY, sess: process.env.SESSION_SECRET };

describe('crypto-vault', () => {
  beforeEach(() => {
    process.env.PIECE_TESTER_CRED_KEY = 'unit-test-key';
    delete process.env.SESSION_SECRET;
  });
  afterEach(() => {
    if (SAVED.cred === undefined) delete process.env.PIECE_TESTER_CRED_KEY;
    else process.env.PIECE_TESTER_CRED_KEY = SAVED.cred;
    if (SAVED.sess === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = SAVED.sess;
  });

  it('round-trips a secret', () => {
    const enc = encryptSecret('hunter2');
    expect(enc).not.toContain('hunter2');
    expect(decryptSecret(enc)).toBe('hunter2');
  });

  it('produces a versioned, 4-part payload', () => {
    expect(encryptSecret('x').split(':')).toHaveLength(4);
    expect(encryptSecret('x').startsWith('v1:')).toBe(true);
  });

  it('rejects a tampered ciphertext', () => {
    const enc = encryptSecret('secret');
    const parts = enc.split(':');
    parts[3] = Buffer.from('tampered').toString('base64'); // swap the data segment
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });

  it('hasEncryptionKey reflects env presence', () => {
    expect(hasEncryptionKey()).toBe(true);
    delete process.env.PIECE_TESTER_CRED_KEY;
    expect(hasEncryptionKey()).toBe(false);
  });

  it('encryptSecret throws when no key is configured', () => {
    delete process.env.PIECE_TESTER_CRED_KEY;
    expect(() => encryptSecret('x')).toThrow(/encryption key/i);
  });
});
