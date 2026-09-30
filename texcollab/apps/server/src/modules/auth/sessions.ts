import type { Db } from '../../db/index.js';
import type { UserRow } from '../../db/schema.js';
import { randomToken, sha256 } from '../../lib/crypto.js';

/**
 * Server-side sessions. The browser holds a random 256-bit token in an
 * HttpOnly cookie; the database stores only its SHA-256, so a database leak
 * does not yield usable session tokens.
 */

export interface SessionTimeouts {
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
}

export interface ResolvedSession {
  id: Buffer;
  csrfToken: string;
  expiresAt: Date;
  user: UserRow;
}

/** Only refresh last_seen/idle expiry when it is older than this, to limit writes. */
const TOUCH_INTERVAL_MS = 60_000;

export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly timeouts: SessionTimeouts,
  ) {}

  async create(
    userId: string,
    meta: { ip: string | null; userAgent: string | null },
  ): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
    const token = randomToken(32);
    const csrfToken = randomToken(32);
    const now = Date.now();
    const expiresAt = new Date(now + this.timeouts.absoluteTimeoutMs);
    const idleExpiresAt = new Date(Math.min(now + this.timeouts.idleTimeoutMs, expiresAt.getTime()));
    await this.db
      .insertInto('sessions')
      .values({
        id: sha256(token),
        user_id: userId,
        csrf_token: csrfToken,
        expires_at: expiresAt,
        idle_expires_at: idleExpiresAt,
        ip: meta.ip,
        user_agent: meta.userAgent?.slice(0, 512) ?? null,
      })
      .execute();
    return { token, csrfToken, expiresAt };
  }

  /** Resolve a cookie token to a live session of an enabled user, or null. */
  async resolve(token: string): Promise<ResolvedSession | null> {
    if (!token || token.length > 128) return null;
    const id = sha256(token);
    const row = await this.db
      .selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .selectAll('users')
      .select([
        'sessions.id as session_id',
        'sessions.csrf_token',
        'sessions.expires_at',
        'sessions.idle_expires_at',
        'sessions.last_seen_at',
      ])
      .where('sessions.id', '=', id)
      .executeTakeFirst();
    if (!row) return null;
    const now = Date.now();
    if (row.expires_at.getTime() <= now || row.idle_expires_at.getTime() <= now || row.is_disabled) {
      await this.db.deleteFrom('sessions').where('id', '=', id).execute();
      return null;
    }
    if (now - row.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
      const idle = new Date(Math.min(now + this.timeouts.idleTimeoutMs, row.expires_at.getTime()));
      await this.db
        .updateTable('sessions')
        .set({ last_seen_at: new Date(now), idle_expires_at: idle })
        .where('id', '=', id)
        .execute();
    }
    const { session_id, csrf_token, expires_at, idle_expires_at: _i, last_seen_at: _l, ...user } = row;
    return { id: session_id, csrfToken: csrf_token, expiresAt: expires_at, user };
  }

  async revoke(sessionId: Buffer): Promise<void> {
    await this.db.deleteFrom('sessions').where('id', '=', sessionId).execute();
  }

  /** Revoke every session of a user, optionally keeping one (e.g. the caller's). */
  async revokeAllForUser(userId: string, exceptSessionId?: Buffer): Promise<void> {
    let q = this.db.deleteFrom('sessions').where('user_id', '=', userId);
    if (exceptSessionId) q = q.where('id', '!=', exceptSessionId);
    await q.execute();
  }

  async deleteExpired(): Promise<number> {
    const now = new Date();
    const res = await this.db
      .deleteFrom('sessions')
      .where((eb) => eb.or([eb('expires_at', '<=', now), eb('idle_expires_at', '<=', now)]))
      .executeTakeFirst();
    return Number(res.numDeletedRows);
  }

  async countActive(): Promise<number> {
    const r = await this.db
      .selectFrom('sessions')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('idle_expires_at', '>', new Date())
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }
}
