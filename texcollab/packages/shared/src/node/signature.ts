import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Request authentication between the app and compile workers.
 *
 * The signature covers the method, path, the canonical query string, a
 * timestamp and the SHA-256 of the body, so neither parameters nor the
 * project archive can be altered, and captured requests cannot be replayed
 * after the time window (and not at all within it, see ReplayGuard).
 */
export const SIGNATURE_HEADER = 'x-texcollab-signature';
export const TIMESTAMP_HEADER = 'x-texcollab-timestamp';
export const BODY_HASH_HEADER = 'x-texcollab-body-sha256';
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!)}`)
    .join('&');
}

export function sign(
  secret: string,
  req: { method: string; path: string; query: Record<string, string>; timestamp: string; bodySha256: string },
): string {
  const payload = [req.method.toUpperCase(), req.path, canonicalQuery(req.query), req.timestamp, req.bodySha256].join(
    '\n',
  );
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifySignature(
  secret: string,
  req: { method: string; path: string; query: Record<string, string>; timestamp: string; bodySha256: string },
  signature: string,
  now = Date.now(),
): boolean {
  const ts = Number(req.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) return false;
  if (!/^[0-9a-f]{64}$/.test(signature) || !/^[0-9a-f]{64}$/.test(req.bodySha256)) return false;
  const expected = Buffer.from(sign(secret, req), 'hex');
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

/** Remembers recently seen signatures so a request cannot be replayed inside the clock-skew window. */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  check(signature: string, now = Date.now()): boolean {
    for (const [sig, t] of this.seen) {
      if (now - t > 2 * MAX_CLOCK_SKEW_MS) this.seen.delete(sig);
      else break; // Map preserves insertion order: the rest are newer.
    }
    if (this.seen.has(signature)) return false;
    this.seen.set(signature, now);
    return true;
  }
}
