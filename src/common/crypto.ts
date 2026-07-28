import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const IV_BYTES = 12;

/**
 * AES-256-GCM for secrets the service must be able to read back — model
 * provider credentials, specifically.
 *
 * Format: `v1.<iv>.<tag>.<ciphertext>`, all base64url. Versioned so the scheme
 * can change without a flag day.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(encoded: string, key: Buffer): string {
  const [version, ivPart, tagPart, dataPart] = encoded.split('.');

  if (version !== 'v1' || !ivPart || !tagPart || !dataPart) {
    throw new Error('Malformed encrypted secret');
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Password hashing for dashboard accounts.
 *
 * scrypt from node's own crypto rather than bcrypt or argon2: both of those are
 * native modules, and a service that otherwise installs cleanly on any Node 22
 * runtime is worth more here than the marginal difference in hash strength.
 * Parameters follow the OWASP scrypt guidance.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, saltPart, hashPart] = stored.split('$');
  if (scheme !== 'scrypt' || !saltPart || !hashPart) return false;

  const expected = Buffer.from(hashPart, 'base64url');
  const derived = await scrypt(password, Buffer.from(saltPart, 'base64url'), expected.length);

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Opaque session token. Stored hashed; the raw value only lives in a cookie. */
export function newSessionToken(): string {
  return `${randomUUID().replace(/-/g, '')}${randomBytes(16).toString('hex')}`;
}
