import { randomBytes } from 'node:crypto';
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  newSessionToken,
  verifyPassword,
} from '../../src/common/crypto';
import { decodeEncryptionKey } from '../../src/config/configuration';

const key = randomBytes(32);

describe('secret encryption', () => {
  it('round-trips a value', () => {
    const encrypted = encryptSecret('sk-test-value', key);
    expect(decryptSecret(encrypted, key)).toBe('sk-test-value');
  });

  it('does not contain the plaintext', () => {
    const encrypted = encryptSecret('sk-test-value', key);
    expect(encrypted).not.toContain('sk-test-value');
  });

  it('produces a different ciphertext each time', () => {
    // A fresh IV per encryption, so two identical credentials are not
    // recognisable as identical in the table.
    expect(encryptSecret('same', key)).not.toBe(encryptSecret('same', key));
  });

  it('refuses a value encrypted under a different key', () => {
    const encrypted = encryptSecret('sk-test-value', key);
    expect(() => decryptSecret(encrypted, randomBytes(32))).toThrow();
  });

  it('refuses a tampered ciphertext', () => {
    // GCM authenticates, so a flipped byte is detected rather than decrypting
    // to garbage.
    const encrypted = encryptSecret('sk-test-value', key);
    const parts = encrypted.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');

    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
  });

  it('refuses a malformed payload', () => {
    expect(() => decryptSecret('nonsense', key)).toThrow(/Malformed/);
  });
});

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('wrong', hash)).resolves.toBe(false);
  });

  it('salts, so the same password hashes differently', async () => {
    const first = await hashPassword('same');
    const second = await hashPassword('same');
    expect(first).not.toBe(second);
  });

  it('rejects a malformed stored hash without throwing', async () => {
    await expect(verifyPassword('anything', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('anything', '')).resolves.toBe(false);
  });
});

describe('session tokens', () => {
  it('are long and unique', () => {
    const tokens = new Set(
      Array.from({ length: 100 }, () => newSessionToken()),
    );
    expect(tokens.size).toBe(100);
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(60);
  });
});

describe('decodeEncryptionKey', () => {
  it('accepts 64 hex characters', () => {
    expect(decodeEncryptionKey('a'.repeat(64))).toHaveLength(32);
  });

  it('accepts base64', () => {
    expect(decodeEncryptionKey(randomBytes(32).toString('base64'))).toHaveLength(32);
  });

  it('yields the wrong length for a short key, so validation can reject it', () => {
    expect(decodeEncryptionKey('short').length).not.toBe(32);
  });
});
