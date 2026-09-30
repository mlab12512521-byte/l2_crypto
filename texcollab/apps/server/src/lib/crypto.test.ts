import { describe, expect, it } from 'vitest';
import { randomToken, SecretBox, safeEqual } from './crypto.js';

describe('SecretBox', () => {
  const secret = 'a'.repeat(40);

  it('round-trips and uses a fresh IV each time', () => {
    const box = new SecretBox(secret, 'ldap');
    const a = box.encrypt('bind-password');
    const b = box.encrypt('bind-password');
    expect(a.equals(b)).toBe(false);
    expect(box.decrypt(a)).toBe('bind-password');
    expect(a.toString('utf8')).not.toContain('bind-password');
  });

  it('detects tampering', () => {
    const box = new SecretBox(secret, 'ldap');
    const ct = box.encrypt('value');
    ct[ct.length - 1]! ^= 1;
    expect(() => box.decrypt(ct)).toThrow();
  });

  it('separates keys by purpose and by app secret', () => {
    const ct = new SecretBox(secret, 'ldap').encrypt('value');
    expect(() => new SecretBox(secret, 'git').decrypt(ct)).toThrow();
    expect(() => new SecretBox('b'.repeat(40), 'ldap').decrypt(ct)).toThrow();
  });
});

describe('helpers', () => {
  it('randomToken has the requested entropy and is url-safe', () => {
    const t = randomToken(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(32)).not.toBe(t);
  });

  it('safeEqual compares correctly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
