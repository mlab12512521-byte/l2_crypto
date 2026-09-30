import { extensionOf, type GitRemoteInfo, type VersionDiff, type VersionInfo } from '@texcollab/shared';
import type { FastifyInstance } from 'fastify';
import yazl from 'yazl';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../http/auth-hooks.js';
import { contentDisposition, USER_CONTENT_HEADERS } from '../../http/content.js';
import { parse } from '../../http/validation.js';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { decodeText } from '../files/service.js';
import { PROVIDERS, providerFor } from './remote.js';

const projectParams = z.object({ id: z.uuid() });
const versionParams = z.object({ id: z.uuid(), vid: z.uuid() });
/** A version id, or "current" for the live project state. */
const refSchema = z.union([z.uuid(), z.literal('current')]);

export async function gitRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/:id/versions', async (req): Promise<{ versions: VersionInfo[]; dirty: boolean }> => {
    const user = requireUser(req);
    const { id } = parse(projectParams, req.params);
    await ctx.access.require(user.id, id, 'viewer');
    return { versions: await ctx.versions.list(id), dirty: await ctx.versions.isDirty(id) };
  });

  /** Save a named version of the current state. */
  app.post('/:id/versions', async (req, reply): Promise<VersionInfo | null> => {
    const user = requireUser(req);
    const { id } = parse(projectParams, req.params);
    const body = parse(z.object({ label: z.string().trim().min(1).max(200) }), req.body);
    await ctx.access.require(user.id, id, 'editor');
    const v = await ctx.versions.createVersion(id, { kind: 'named', label: body.label, userId: user.id });
    reply.code(201);
    return v;
  });

  /** Files changed between two versions ("from" omitted = since the beginning; "current" = live state). */
  app.get('/:id/diff', async (req): Promise<VersionDiff> => {
    const user = requireUser(req);
    const { id } = parse(projectParams, req.params);
    const q = parse(z.object({ from: refSchema.optional(), to: refSchema }), req.query);
    await ctx.access.require(user.id, id, 'viewer');
    const to = await ctx.versions.resolveRef(id, q.to);
    const from = q.from ? await ctx.versions.resolveRef(id, q.from) : null;
    return ctx.versions.diff(id, from, to);
  });

  /** Content of one file at a version (or the live state). */
  app.get('/:id/history/file', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(projectParams, req.params);
    const q = parse(z.object({ ref: refSchema, path: z.string().min(1).max(4096) }), req.query);
    await ctx.access.require(user.id, id, 'viewer');
    const commit = await ctx.versions.resolveRef(id, q.ref);
    const content = await ctx.versions.fileAt(id, commit, q.path);
    if (!content) throw notFound('File not found in this version');
    reply.headers(USER_CONTENT_HEADERS);
    const text = content.length <= 5 * 1024 * 1024 ? decodeText(content) : null;
    if (text !== null) return reply.header('Content-Type', 'text/plain; charset=utf-8').send(text);
    const name = q.path.split('/').pop()!;
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', contentDisposition('attachment', name))
      .header('X-Binary', extensionOf(name) || '1')
      .send(content);
  });

  app.post('/:id/versions/:vid/restore', async (req): Promise<VersionInfo | null> => {
    const user = requireUser(req);
    const { id, vid } = parse(versionParams, req.params);
    await ctx.access.require(user.id, id, 'editor');
    const v = await ctx.versions.restore(id, vid, user.id);
    await audit(ctx.db, {
      actorId: user.id,
      action: 'project.version_restored',
      targetType: 'project',
      targetId: id,
      ip: req.ip,
      details: { versionId: vid },
    });
    return v;
  });

  app.get('/:id/versions/:vid/download.zip', async (req, reply) => {
    const user = requireUser(req);
    const { id, vid } = parse(versionParams, req.params);
    const { project } = await ctx.access.require(user.id, id, 'viewer');
    const v = await ctx.versions.get(id, vid);
    const files = await ctx.versions.filesOf(id, v.commitSha);
    const zip = new yazl.ZipFile();
    for (const f of files) zip.addBuffer(f.content, f.path);
    zip.end();
    return reply
      .header('Content-Type', 'application/zip')
      .header(
        'Content-Disposition',
        contentDisposition('attachment', `${project.name} (${v.createdAt.slice(0, 10)}).zip`),
      )
      .send(zip.outputStream);
  });

  // ---- external remote

  app.get(
    '/:id/git',
    async (
      req,
    ): Promise<{
      remote: GitRemoteInfo | null;
      providers: Array<{ id: string; label: string; tokenHelp: string }>;
    }> => {
      const user = requireUser(req);
      const { id } = parse(projectParams, req.params);
      await ctx.access.require(user.id, id, 'viewer');
      const remote = await ctx.remotes.get(id);
      return {
        remote,
        providers: PROVIDERS.map((p) => ({ id: p.id, label: p.label, tokenHelp: p.tokenHelp })),
        ...(remote ? { provider: providerFor(new URL(remote.url).hostname).id } : {}),
      };
    },
  );

  /** Configure the remote (owner only: it holds credentials). */
  app.put('/:id/git', async (req): Promise<GitRemoteInfo> => {
    const user = requireUser(req);
    const { id } = parse(projectParams, req.params);
    const body = parse(
      z.object({
        url: z.string().min(1).max(2000),
        branch: z.string().trim().min(1).max(100).default('main'),
        username: z.string().trim().max(200).nullish(),
        /** Omit to keep the stored token; null to remove it. */
        token: z.string().max(2000).nullish(),
      }),
      req.body,
    );
    await ctx.access.require(user.id, id, 'owner');
    const info = await ctx.remotes.set(id, user.id, {
      url: body.url,
      branch: body.branch,
      ...(body.username !== undefined ? { username: body.username } : {}),
      ...(body.token !== undefined ? { token: body.token } : {}),
    });
    await audit(ctx.db, {
      actorId: user.id,
      action: 'project.git_remote_set',
      targetType: 'project',
      targetId: id,
      ip: req.ip,
      details: { host: new URL(info.url).hostname },
    });
    return info;
  });

  app.delete('/:id/git', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(projectParams, req.params);
    await ctx.access.require(user.id, id, 'owner');
    await ctx.remotes.remove(id);
    await audit(ctx.db, {
      actorId: user.id,
      action: 'project.git_remote_removed',
      targetType: 'project',
      targetId: id,
      ip: req.ip,
    });
    reply.code(204);
  });

  app.post('/:id/git/push', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(projectParams, req.params);
    await ctx.access.require(user.id, id, 'editor');
    const r = await ctx.remotes.push(id, user.id);
    await audit(ctx.db, {
      actorId: user.id,
      action: 'project.git_push',
      targetType: 'project',
      targetId: id,
      ip: req.ip,
    });
    return r;
  });

  app.post('/:id/git/pull', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(projectParams, req.params);
    await ctx.access.require(user.id, id, 'editor');
    const r = await ctx.remotes.pull(id, user.id);
    await audit(ctx.db, {
      actorId: user.id,
      action: 'project.git_pull',
      targetType: 'project',
      targetId: id,
      ip: req.ip,
      details: { result: r.result },
    });
    return r;
  });
}
