import { displayNameSchema, emailSchema, type MeResponse, passwordSchema, usernameSchema } from '@texcollab/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { clearSessionCookie, requireUser, setSessionCookie } from '../../http/auth-hooks.js';
import { parse } from '../../http/validation.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, forbidden } from '../../lib/errors.js';
import { toCurrentUser } from '../users/service.js';
import { verifyPassword } from './password.js';

const loginSchema = z.object({
  // Deliberately lenient: only bounded, so LDAP usernames with other characters still work.
  username: z.string().trim().min(1).max(256),
  password: z.string().min(1).max(256),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().max(256),
  newPassword: passwordSchema,
});

const registerSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  email: emailSchema.optional(),
  password: passwordSchema,
});

function clientMeta(req: FastifyRequest) {
  return { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null };
}

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const authRateLimit = {
    rateLimit: { max: ctx.config.login.rateLimitPerMinute, timeWindow: '1 minute' },
  };

  /** Public: what the login page should offer. */
  app.get('/config', async () => {
    const registration = await ctx.settings.get('registration');
    return { registrationEnabled: registration.enabled };
  });

  app.post('/login', { config: authRateLimit }, async (req, reply): Promise<MeResponse> => {
    const body = parse(loginSchema, req.body);
    // Prevent session fixation: any session presented with the login request is discarded.
    if (req.sessionId) await ctx.sessions.revoke(req.sessionId);
    const result = await ctx.auth.login(body.username, body.password, clientMeta(req));
    setSessionCookie(reply, ctx, result.token, result.expiresAt);
    return { user: toCurrentUser(result.user), csrfToken: result.csrfToken };
  });

  app.post('/logout', { config: { allowPendingPasswordChange: true } }, async (req, reply) => {
    if (req.sessionId) {
      await ctx.sessions.revoke(req.sessionId);
      if (req.user) await audit(ctx.db, { actorId: req.user.id, action: 'auth.logout', ip: req.ip });
    }
    clearSessionCookie(reply, ctx);
    return { ok: true };
  });

  app.get('/me', { config: { allowPendingPasswordChange: true } }, async (req): Promise<MeResponse> => {
    const user = requireUser(req);
    return { user: toCurrentUser(user), csrfToken: req.csrfToken! };
  });

  app.post('/password', { config: { allowPendingPasswordChange: true, ...authRateLimit } }, async (req) => {
    const user = requireUser(req);
    const body = parse(changePasswordSchema, req.body);
    if (user.auth_source !== 'local') {
      throw badRequest('Your password is managed by the organisation directory');
    }
    if (!(await verifyPassword(user.password_hash ?? '', body.currentPassword))) {
      await audit(ctx.db, { actorId: user.id, action: 'auth.password_change_failed', ip: req.ip });
      throw new AppError(400, 'invalid_current_password', 'Current password is incorrect', {
        currentPassword: 'Current password is incorrect',
      });
    }
    if (body.newPassword === body.currentPassword) {
      throw badRequest('The new password must differ from the current one', {
        newPassword: 'Choose a different password',
      });
    }
    if (body.newPassword.toLowerCase().includes(user.username.toLowerCase())) {
      throw badRequest('The password must not contain the username', {
        newPassword: 'The password must not contain the username',
      });
    }
    await ctx.users.setPassword(user.id, body.newPassword, false);
    // Other devices must log in again with the new password.
    await ctx.sessions.revokeAllForUser(user.id, req.sessionId ?? undefined);
    await audit(ctx.db, { actorId: user.id, action: 'auth.password_changed', ip: req.ip });
    return { ok: true };
  });

  app.post('/register', { config: authRateLimit }, async (req, reply): Promise<MeResponse> => {
    const registration = await ctx.settings.get('registration');
    if (!registration.enabled) throw forbidden('Self-registration is disabled');
    const body = parse(registerSchema, req.body);
    if (body.password.toLowerCase().includes(body.username.toLowerCase())) {
      throw badRequest('The password must not contain the username', {
        password: 'The password must not contain the username',
      });
    }
    const user = await ctx.users.createLocalUser({
      username: body.username,
      displayName: body.displayName,
      email: body.email ?? null,
      password: body.password,
    });
    await audit(ctx.db, { actorId: user.id, action: 'auth.registered', ip: req.ip });
    const session = await ctx.sessions.create(user.id, clientMeta(req));
    setSessionCookie(reply, ctx, session.token, session.expiresAt);
    return { user: toCurrentUser(user), csrfToken: session.csrfToken };
  });
}
