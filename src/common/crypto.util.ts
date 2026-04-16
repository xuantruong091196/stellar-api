import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // AES-GCM standard nonce length (96 bits)
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH_BYTES = 32; // AES-256

/**
 * Parse the hex-encoded encryption key and verify it is exactly 32 bytes
 * (the length AES-256 requires). Throws early with a clear message on
 * misconfiguration instead of letting `createCipheriv` fail cryptically.
 */
function parseKey(secret: string): Buffer {
  if (typeof secret !== 'string' || !/^[0-9a-fA-F]+$/.test(secret)) {
    throw new Error('ENCRYPTION_KEY must be a hex string');
  }
  const key = Buffer.from(secret, 'hex');
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must decode to ${KEY_LENGTH_BYTES} bytes (got ${key.length})`,
    );
  }
  return key;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a string in the format: `iv:authTag:ciphertext` (all hex-encoded).
 */
export function encrypt(text: string, secret: string): string {
  const key = parseKey(secret);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt a string encrypted with `encrypt()`.
 * Expects input in the format: `iv:authTag:ciphertext` (all hex-encoded).
 *
 * Throws on malformed input (missing parts, wrong lengths) or on failed
 * authentication (tampered ciphertext or wrong key).
 */
export function decrypt(encrypted: string, secret: string): string {
  if (typeof encrypted !== 'string') {
    throw new Error('Encrypted value must be a string');
  }
  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Encrypted value must have format iv:authTag:ciphertext');
  }
  const [ivHex, authTagHex, ciphertext] = parts;
  const key = parseKey(secret);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  if (iv.length !== IV_LENGTH && iv.length !== 16) {
    // Accept 12-byte (standard) and 16-byte (legacy) IVs for backwards compat.
    throw new Error(`Invalid IV length: ${iv.length}`);
  }
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(`Invalid auth tag length: ${authTag.length}`);
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
