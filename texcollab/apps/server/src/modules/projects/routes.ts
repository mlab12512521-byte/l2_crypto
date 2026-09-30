import { COMPILERS, type ProjectDetails, type ProjectSummary, projectNameSchema } from '@texcollab/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../http/auth-hooks.js';
import { contentDisposition, rawBody } from '../../http/content.js';
import { parse } from '../../http/validation.js';
import { audit } from '../../lib/audit.js';
import { snapshotProject } from '../files/snapshot.js';
import { detectMainFile, stripCommonRoot, unpackZip, zipSnapshot } from '../files/zip.js';
import { limitsInBytes } from '../settings/service.js';

const idParams = z.object({ id: z.uuid() });

const listQuery = z.object({
  filter: z.enum(['all', 'owned', 'shared']).default('all'),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(['lastModified', 'lastOpened', 'name', 'created']).default('lastModified'),
});

const createSchema = z.object({
  name: projectNameSchema,
  template: z.enum(['article', 'blank']).default('article'),
});

const patchSchema = z
  .object({
    name: projectNameSchema,
    compiler: z.enum(COMPILERS),
    mainFileId: z.uuid().nullable(),
  })
  .partial()
  .strict();

export async function projectRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/', async (req): Promise<{ items: ProjectSummary[] }> => {
    const user = requireUser(req);
    const q = parse(listQuery, req.query);
    return { items: await ctx.projects.list(user.id, { filter: q.filter, sort: q.sort, ...(q.q ? { q: q.q } : {}) }) };
  });

  app.post('/', async (req, reply): Promise<ProjectDetails> => {
    const user = requireUser(req);
    const body = parse(createSchema, req.body);
    const id = await ctx.projects.create(user.id, body.name, { withTemplate: body.template === 'article' });
    await audit(ctx.db, {
      actorId: user.id,
      action: 'project.created',
      targetType: 'project',
      targetId: id,
      ip: req.ip,
    });
    reply.code(201);
    return ctx.projects.details(id, user.id, 'owner');
  });

  /** Create a project from an uploaded ZIP archive (raw request body). */
  app.post('/import', async (req, reply): Promise<ProjectDetails> => {
    const user = requireUser(req);
    const { name } = parse(z.object({ name: projectNameSchema }), req.query);
    const limits = limitsInBytes(await ctx.settings.get('projectLimits'));
    const files = stripCommonRoot(await unpackZip(rawBody(req), ctx.paths.importTmpDir, ctx.blobs, limits));
    const id = await ctx.projects.create(user.id, name, { withTemplate: false });
    try {
      const mainSegments = detectMainFile(files);
      await ctx.db.transaction().execute(async (trx) => {
        const rootId = await ctx.files.rootId(id, trx);
        for (const f of files) {
          const dirs = f.text === null && f.blob === null ? f.segments : f.segments.slice(0, -1);
          const parentId = await ctx.files.ensureFolders(id, rootId, dirs, user.id, trx);
          if (f.text === null && f.blob === null) continue;
          const leaf = f.segments[f.segments.length - 1]!;
          const entity =
            f.text !== null
              ? await ctx.files.createDoc(id, parentId, leaf, f.text, user.id, trx)
              : await ctx.files.createFileFromBlob(id, parentId, leaf, f.blob!, user.id, trx);
          if (mainSegments && mainSegments.join('/') === f.segments.join('/')) {
            await trx.updateTable('projects').set({ main_file_id: entity.id }).where('id', '=', id).execute();
          }
        }
      });
    } catch (err) {
      await ctx.projects.delete(id);
      throw err;
    }
    await audit(ctx.db, {
      actorId: user.id,
      action: 'project.imported',
      targetType: 'project',
      targetId: id,
      ip: req.ip,
      details: { files: files.length },
    });
    reply.code(201);
    return ctx.projects.details(id, user.id, 'owner');
  });

  app.get('/:id', async (req): Promise<ProjectDetails> => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const { role } = await ctx.access.require(user.id, id, 'viewer');
    await ctx.projects.recordOpened(id, user.id);
    return ctx.projects.details(id, user.id, role);
  });

  app.patch('/:id', async (req): Promise<ProjectDetails> => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(patchSchema, req.body);
    // Renaming is an owner action; build settings can be changed by editors.
    const { role } = await ctx.access.require(user.id, id, body.name !== undefined ? 'owner' : 'editor');
    if (body.name !== undefined) await ctx.projects.rename(id, body.name);
    if (body.compiler !== undefined) await ctx.projects.setCompiler(id, body.compiler);
    if (body.mainFileId !== undefined) await ctx.projects.setMainFile(id, body.mainFileId);
    return ctx.projects.details(id, user.id, role);
  });

  app.delete('/:id', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const { project } = await ctx.access.require(user.id, id, 'owner');
    await ctx.projects.delete(id);
    await audit(ctx.db, {
      actorId: user.id,
      action: 'project.deleted',
      targetType: 'project',
      targetId: id,
      ip: req.ip,
      details: { name: project.name },
    });
    reply.code(204);
  });

  app.get('/:id/export.zip', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const { project } = await ctx.access.require(user.id, id, 'viewer');
    const snapshot = await snapshotProject(ctx.files, id);
    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', contentDisposition('attachment', `${project.name}.zip`))
      .header('Cache-Control', 'no-store');
    return reply.send(zipSnapshot(snapshot, ctx.blobs));
  });
}
