import { CSRF_HEADER } from '@texcollab/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import type { UserRow } from '../db/schema.js';
import { safeEqual } from '../lib/crypto.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Authenticated user, if the request carries a valid session cookie. */
    user: UserRow | null;
    sessionId: Buffer | null;
    csrfToken: string | null;
  }
  interface FastifyContextConfig {
    /** Allow this route while the user must still change their password. */
    allowPendingPasswordChange?: boolean;
    /** Skip CSRF verification (only for routes that cannot be abused cross-site). */
    skipCsrf?: boolean;
  }
}

export function sessionCookieName(secure: boolean): string {
  // The __Host- prefix forces Secure, Path=/ and no Domain attribute in browsers.
  return secure ? '__Host-texcollab_session' : 'texcollab_session';
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Resolves the session on every request and enforces CSRF protection on
 * state-changing requests:
 *  1. If an Origin header is present it must equal PUBLIC_URL's origin.
 *  2. `Sec-Fetch-Site: cross-site` is rejected.
 *  3. The X-CSRF-Token header must be present; with a session it must match
 *     the session's token. (Custom headers cannot be sent cross-origin without
 *     a CORS preflight, which this server never grants.)
 */
export function registerAuthHooks(app: FastifyInstance, ctx: AppContext): void {
  const cookieName = sessionCookieName(ctx.config.secureCookies);

  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('csrfToken', null);

  app.addHook('onRequest', async (req) => {
    // Static SPA assets need no session lookup.
    if (!req.url.startsWith('/api/') && !req.url.startsWith('/collab')) return;
    const token = req.cookies[cookieName];
    if (!token) return;
    const session = await ctx.sessions.resolve(token);
    if (!session) return;
    req.user = session.user;
    req.sessionId = session.id;
    req.csrfToken = session.csrfToken;
  });

  app.addHook('preHandler', async (req) => {
    if (SAFE_METHODS.has(req.method) || req.routeOptions.config.skipCsrf) return;
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== ctx.config.publicOrigin) {
      // Usually a PUBLIC_URL that does not match the address in the browser (scheme, host or port).
      req.log.warn(
        { origin: origin.slice(0, 200), expected: ctx.config.publicOrigin },
        'request Origin does not match PUBLIC_URL',
      );
      throw new AppError(
        403,
        'csrf_failed',
        `Cross-origin request rejected. This site is configured for ${ctx.config.publicOrigin}; open it at that address (or fix PUBLIC_URL).`,
      );
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw new AppError(403, 'csrf_failed', 'Cross-site request rejected');
    }
    const header = req.headers[CSRF_HEADER];
    if (typeof header !== 'string' || header.length === 0) {
      throw new AppError(403, 'csrf_failed', 'Missing CSRF token');
    }
    if (req.csrfToken !== null && !safeEqual(header, req.csrfToken)) {
      throw new AppError(403, 'csrf_failed', 'Invalid CSRF token');
    }
  });
}

export function setSessionCookie(reply: FastifyReply, ctx: AppContext, token: string, expiresAt: Date): void {
  reply.setCookie(sessionCookieName(ctx.config.secureCookies), token, {
    httpOnly: true,
    secure: ctx.config.secureCookies,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, ctx: AppContext): void {
  reply.clearCookie(sessionCookieName(ctx.config.secureCookies), {
    httpOnly: true,
    secure: ctx.config.secureCookies,
    sameSite: 'lax',
    path: '/',
  });
}

/** Guard: authenticated, enabled user who has completed any forced password change. */
export function requireUser(req: FastifyRequest): UserRow {
  const user = req.user;
  if (!user) throw unauthorized();
  if (user.must_change_password && !req.routeOptions.config.allowPendingPasswordChange) {
    throw new AppError(403, 'password_change_required', 'You must change your password before continuing');
  }
  return user;
}

export function requireAdmin(req: FastifyRequest): UserRow {
  const user = requireUser(req);
  if (!user.is_admin) throw forbidden('Administrator access required');
  return user;
}
