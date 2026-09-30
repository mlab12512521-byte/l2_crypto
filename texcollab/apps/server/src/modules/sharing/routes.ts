import type { MembersResponse, PublicUser } from '@texcollab/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../http/auth-hooks.js';
import { parse } from '../../http/validation.js';

const projectParams = z.object({ id: z.uuid() });
const memberParams = z.object({ id: z.uuid(), uid: z.uuid() });
const role = z.enum(['editor', 'viewer']);

const shareSchema = z
  .object({
    userId: z.uuid().optional(),
    /** Username or e-mail address. */
    identifier: z.string().trim().min(1).max(254).optional(),
    role,
  })
  .refine((v) => v.userId || v.identifier, 'Choose a user or enter an e-mail address');

export async function sharingRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/projects/:id/members', async (req): Promise<MembersResponse> => {
    const user = requireUser(req);
    const { id } = parse(projectParams, req.params);
    const { role: myRole } = await ctx.access.require(user.id, id, 'viewer');
    return ctx.sharing.list(id, myRole === 'owner');
  });

  app.post('/projects/:id/members', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(projectParams, req.params);
    const body = parse(shareSchema, req.body);
    await ctx.access.require(user.id, id, 'owner');
    const result = await ctx.sharing.share(
      id,
      user.id,
      { ...(body.userId ? { userId: body.userId } : {}), ...(body.identifier ? { identifier: body.identifier } : {}) },
      body.role,
      req.ip,
    );
    reply.code(201);
    return result;
  });

  app.patch('/projects/:id/members/:uid', async (req) => {
    const user = requireUser(req);
    const { id, uid } = parse(memberParams, req.params);
    const body = parse(z.object({ role }), req.body);
    await ctx.access.require(user.id, id, 'owner');
    await ctx.sharing.changeRole(id, user.id, uid, body.role, req.ip);
    return { ok: true };
  });

  app.delete('/projects/:id/members/:uid', async (req, reply) => {
    const user = requireUser(req);
    const { id, uid } = parse(memberParams, req.params);
    const { role: myRole } = await ctx.access.require(user.id, id, 'viewer');
    await ctx.sharing.remove(id, { id: user.id, role: myRole }, uid, req.ip);
    reply.code(204);
  });

  app.post('/projects/:id/transfer', async (req) => {
    const user = requireUser(req);
    const { id } = parse(projectParams, req.params);
    const body = parse(z.object({ userId: z.uuid() }), req.body);
    await ctx.access.require(user.id, id, 'owner');
    await ctx.sharing.transferOwnership(id, user.id, body.userId, req.ip);
    return { ok: true };
  });

  app.delete('/projects/:id/invitations/:iid', async (req, reply) => {
    const user = requireUser(req);
    const { id, iid } = parse(z.object({ id: z.uuid(), iid: z.uuid() }), req.params);
    await ctx.access.require(user.id, id, 'owner');
    await ctx.sharing.cancelInvitation(id, user.id, iid, req.ip);
    reply.code(204);
  });

  /** Find people to share with. Returns names only, never e-mail addresses. */
  app.get(
    '/users/search',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req): Promise<{ items: PublicUser[] }> => {
      const user = requireUser(req);
      const { q } = parse(z.object({ q: z.string().max(100).default('') }), req.query);
      return { items: await ctx.sharing.searchUsers(q, user.id) };
    },
  );
}
