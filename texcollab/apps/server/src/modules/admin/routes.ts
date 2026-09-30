import {
  type AdminUser,
  displayNameSchema,
  emailSchema,
  type Paginated,
  passwordSchema,
  usernameSchema,
} from '@texcollab/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireAdmin } from '../../http/auth-hooks.js';
import { parse } from '../../http/validation.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { isSettingKey, settingSchemas } from '../settings/service.js';
import { toAdminUser } from '../users/service.js';

const idParams = z.object({ id: z.uuid() });

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const createUserSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  email: emailSchema.nullish(),
  password: passwordSchema,
  isAdmin: z.boolean().default(false),
  mustChangePassword: z.boolean().default(true),
});

const updateUserSchema = z
  .object({
    displayName: displayNameSchema,
    email: emailSchema.nullable(),
    isAdmin: z.boolean(),
    isDisabled: z.boolean(),
  })
  .partial()
  .strict();

const setPasswordSchema = z.object({
  password: passwordSchema,
  mustChangePassword: z.boolean().default(true),
});

const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  action: z.string().max(64).optional(),
});

const logsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 } as const;

export async function adminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Every route in this module requires an administrator.
  app.addHook('preHandler', async (req) => {
    requireAdmin(req);
  });

  app.get('/users', async (req): Promise<Paginated<AdminUser>> => {
    const q = parse(listQuery, req.query);
    const { items, total } = await ctx.users.list({
      limit: q.limit,
      offset: q.offset,
      ...(q.q ? { q: q.q } : {}),
    });
    return { items: items.map(toAdminUser), total };
  });

  app.post('/users', async (req, reply): Promise<AdminUser> => {
    const admin = req.user!;
    const body = parse(createUserSchema, req.body);
    const user = await ctx.users.createLocalUser({
      username: body.username,
      displayName: body.displayName,
      email: body.email ?? null,
      password: body.password,
      isAdmin: body.isAdmin,
      mustChangePassword: body.mustChangePassword,
    });
    await audit(ctx.db, {
      actorId: admin.id,
      action: 'admin.user_created',
      targetType: 'user',
      targetId: user.id,
      ip: req.ip,
      details: { username: user.username, isAdmin: user.is_admin },
    });
    reply.code(201);
    return toAdminUser(user);
  });

  app.get('/users/:id', async (req): Promise<AdminUser> => {
    const { id } = parse(idParams, req.params);
    const user = await ctx.users.findById(id);
    if (!user) throw notFound('User not found');
    return toAdminUser(user);
  });

  app.patch('/users/:id', async (req): Promise<AdminUser> => {
    const admin = req.user!;
    const { id } = parse(idParams, req.params);
    const body = parse(updateUserSchema, req.body);
    const user = await ctx.users.update(id, body);
    if (body.isDisabled === true) {
      // Disabling takes effect immediately on all devices, including live editing sessions.
      await ctx.sessions.revokeAllForUser(id);
      ctx.collab.disconnectUser(id);
    }
    await audit(ctx.db, {
      actorId: admin.id,
      action: 'admin.user_updated',
      targetType: 'user',
      targetId: id,
      ip: req.ip,
      details: { changes: Object.keys(body), isAdmin: body.isAdmin, isDisabled: body.isDisabled },
    });
    return toAdminUser(user);
  });

  app.post('/users/:id/password', async (req) => {
    const admin = req.user!;
    const { id } = parse(idParams, req.params);
    const body = parse(setPasswordSchema, req.body);
    await ctx.users.setPassword(id, body.password, body.mustChangePassword);
    await ctx.sessions.revokeAllForUser(id, id === admin.id ? (req.sessionId ?? undefined) : undefined);
    if (id !== admin.id) ctx.collab.disconnectUser(id);
    await audit(ctx.db, {
      actorId: admin.id,
      action: 'admin.password_reset',
      targetType: 'user',
      targetId: id,
      ip: req.ip,
    });
    return { ok: true };
  });

  app.post('/users/:id/unlock', async (req) => {
    const { id } = parse(idParams, req.params);
    await ctx.users.unlock(id);
    await audit(ctx.db, {
      actorId: req.user!.id,
      action: 'admin.user_unlocked',
      targetType: 'user',
      targetId: id,
      ip: req.ip,
    });
    return { ok: true };
  });

  app.delete('/users/:id', async (req, reply) => {
    const admin = req.user!;
    const { id } = parse(idParams, req.params);
    if (id === admin.id) throw conflict('You cannot delete your own account');
    const { deleteOwnedProjects } = parse(
      z.object({ deleteOwnedProjects: z.enum(['true', 'false']).default('false') }),
      req.query,
    );
    const owned = await ctx.projects.ownedBy(id);
    if (owned.length > 0 && deleteOwnedProjects !== 'true') {
      throw conflict(
        `The user owns ${owned.length} project(s). Transfer or delete them first, or confirm deleting them together with the user.`,
      );
    }
    for (const projectId of owned) await ctx.projects.delete(projectId);
    await ctx.users.delete(id);
    await audit(ctx.db, {
      actorId: admin.id,
      action: 'admin.user_deleted',
      targetType: 'user',
      targetId: id,
      ip: req.ip,
      details: { deletedProjects: owned.length },
    });
    reply.code(204);
  });

  app.get('/settings/:key', async (req) => {
    const { key } = parse(z.object({ key: z.string().max(64) }), req.params);
    if (!isSettingKey(key)) throw notFound('Unknown setting');
    return ctx.settings.get(key);
  });

  app.put('/settings/:key', async (req) => {
    const { key } = parse(z.object({ key: z.string().max(64) }), req.params);
    if (!isSettingKey(key)) throw notFound('Unknown setting');
    const value = parse(settingSchemas[key], req.body);
    const saved = await ctx.settings.set(key, value, req.user!.id);
    await audit(ctx.db, {
      actorId: req.user!.id,
      action: 'admin.setting_changed',
      targetType: 'setting',
      targetId: key,
      ip: req.ip,
    });
    return saved;
  });

  app.get('/audit', async (req) => {
    const q = parse(auditQuery, req.query);
    let query = ctx.db
      .selectFrom('audit_log')
      .leftJoin('users', 'users.id', 'audit_log.actor_id')
      .select([
        'audit_log.id',
        'audit_log.at',
        'audit_log.action',
        'audit_log.target_type',
        'audit_log.target_id',
        'audit_log.ip',
        'audit_log.details',
        'users.username as actor_username',
      ]);
    if (q.action) query = query.where('audit_log.action', 'like', `${q.action}%`);
    const rows = await query.orderBy('audit_log.id', 'desc').limit(q.limit).offset(q.offset).execute();
    return {
      items: rows.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        ip: r.ip,
        actor: r.actor_username,
        details: r.details,
      })),
    };
  });

  app.get('/logs', async (req) => {
    const q = parse(logsQuery, req.query);
    return { items: ctx.logRing?.recent(q.limit, LEVELS[q.level]) ?? [] };
  });

  app.get('/workers', async () => ({
    configured: ctx.workers.configured,
    workers: await ctx.workers.health(),
  }));

  app.get('/status', async () => {
    const started = Date.now();
    const dbVersion = await sql<{ version: string }>`SHOW server_version`.execute(ctx.db);
    const dbLatencyMs = Date.now() - started;
    const mem = process.memoryUsage();
    return {
      version: process.env.npm_package_version ?? '0.1.0',
      nodeVersion: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      memory: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed },
      database: { ok: true, version: dbVersion.rows[0]?.version ?? 'unknown', latencyMs: dbLatencyMs },
      users: { total: await ctx.users.count() },
      activeSessions: await ctx.sessions.countActive(),
      collaboration: ctx.collab.stats(),
    };
  });
}
