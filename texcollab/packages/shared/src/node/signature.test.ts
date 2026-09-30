import { describe, expect, it } from 'vitest';
import { ReplayGuard, sign, verifySignature } from './signature.js';

const secret = 's'.repeat(40);
const base = {
  method: 'POST',
  path: '/compile',
  query: { engine: 'pdflatex', main: 'main.tex' },
  timestamp: String(Date.now()),
  bodySha256: 'a'.repeat(64),
};

describe('request signatures', () => {
  it('verifies a valid signature', () => {
    expect(verifySignature(secret, base, sign(secret, base))).toBe(true);
  });

  it('rejects any tampering', () => {
    const sig = sign(secret, base);
    expect(verifySignature(secret, { ...base, query: { ...base.query, engine: 'lualatex' } }, sig)).toBe(false);
    expect(verifySignature(secret, { ...base, bodySha256: 'b'.repeat(64) }, sig)).toBe(false);
    expect(verifySignature(secret, { ...base, path: '/other' }, sig)).toBe(false);
    expect(verifySignature('x'.repeat(40), base, sig)).toBe(false);
    expect(verifySignature(secret, base, 'zz')).toBe(false);
  });

  it('rejects stale timestamps', () => {
    const old = { ...base, timestamp: String(Date.now() - 10 * 60_000) };
    expect(verifySignature(secret, old, sign(secret, old))).toBe(false);
  });

  it('is independent of query parameter order', () => {
    const a = sign(secret, { ...base, query: { a: '1', b: '2' } });
    const b = sign(secret, { ...base, query: { b: '2', a: '1' } });
    expect(a).toBe(b);
  });

  it('detects replays', () => {
    const g = new ReplayGuard();
    expect(g.check('abc')).toBe(true);
    expect(g.check('abc')).toBe(false);
    expect(g.check('def')).toBe(true);
  });
});
