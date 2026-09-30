import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Authenticated encryption for secrets stored in the database (LDAP bind
 * password, Git credentials). The key is derived from APP_SECRET with HKDF
 * and a purpose label, so different uses never share a key.
 *
 * Format: version(1) | iv(12) | tag(16) | ciphertext
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(appSecret: string, purpose: string) {
    this.key = Buffer.from(hkdfSync('sha256', appSecret, 'texcollab', `secretbox:${purpose}`, 32));
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ct]);
  }

  decrypt(box: Buffer): string {
    if (box.length < 29 || box[0] !== 1) throw new Error('Unsupported secret format');
    const iv = box.subarray(1, 13);
    const tag = box.subarray(13, 29);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(box.subarray(29)), decipher.final()]).toString('utf8');
  }
}
