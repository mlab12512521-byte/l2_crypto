import {
  type DocContent,
  entityNameSchema,
  extensionOf,
  type ProjectSymbols,
  type ProjectTree,
  type TreeEntity,
} from '@texcollab/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { EntityRow } from '../../db/schema.js';
import { requireUser } from '../../http/auth-hooks.js';
import { contentDisposition, inlineContentType, rawBody, USER_CONTENT_HEADERS } from '../../http/content.js';
import { parse } from '../../http/validation.js';
import { badRequest } from '../../lib/errors.js';
import { snapshotProject } from './snapshot.js';
import { collectSymbols } from './symbols.js';

const projectParams = z.object({ id: z.uuid() });
const entityParams = z.object({ id: z.uuid(), eid: z.uuid() });

const createSchema = z.object({
  parentId: z.uuid(),
  kind: z.enum(['folder', 'doc']),
  name: entityNameSchema,
  content: z.string().optional(),
});

const patchSchema = z
  .object({ name: entityNameSchema, parentId: z.uuid() })
  .partial()
  .strict()
  .refine((v) => v.name !== undefined || v.parentId !== undefined, 'Nothing to change');

const uploadQuery = z.object({
  parentId: z.uuid(),
  /** Relative path below parentId, e.g. "figures/plot.png" (directory uploads). */
  path: z.string().min(1).max(4096),
});

const writeSchema = z.object({
  text: z.string(),
  /** Hash of the content the edit is based on; null to overwrite unconditionally. */
  baseHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});

function toDto(e: EntityRow): TreeEntity {
  return {
    id: e.id,
    parentId: e.parent_id,
    kind: e.kind,
    name: e.name,
    size: Number(e.size),
    updatedAt: e.updated_at.toISOString(),
  };
}

export async function fileRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/:id/tree', async (req): Promise<ProjectTree> => {
    const user = requireUser(req);
    const { id } = parse(projectParams, req.params);
    await ctx.access.require(user.id, id, 'viewer');
    return ctx.files.tree(id);
  });

  /** Labels, citation keys and file paths for editor autocompletion. */
  app.get('/:id/symbols', async (req): Promise<ProjectSymbols> => {
    const user = requireUser(req);
    const { id } = parse(projectParams, req.params);
    await ctx.access.require(user.id, id, 'viewer');
    return collectSymbols(await snapshotProject(ctx.files, id));
  });

  app.post('/:id/entities', async (req, reply): Promise<TreeEntity> => {
    const user = requireUser(req);
    const { id } = parse(projectParams, req.params);
    const body = parse(createSchema, req.body);
    await ctx.access.require(user.id, id, 'editor');
    const row =
      body.kind === 'folder'
        ? await ctx.files.createFolder(id, body.parentId, body.name, user.id)
        : await ctx.files.createDoc(id, body.parentId, body.name, body.content ?? '', user.id);
    reply.code(201);
    return toDto(row);
  });

  app.patch('/:id/entities/:eid', async (req): Promise<TreeEntity> => {
    const user = requireUser(req);
    const { id, eid } = parse(entityParams, req.params);
    const body = parse(patchSchema, req.body);
    await ctx.access.require(user.id, id, 'editor');
    let row: EntityRow | undefined;
    if (body.parentId !== undefined) row = await ctx.files.move(id, eid, body.parentId, user.id);
    if (body.name !== undefined) row = await ctx.files.rename(id, eid, body.name, user.id);
    return toDto(row!);
  });

  app.delete('/:id/entities/:eid', async (req, reply) => {
    const user = requireUser(req);
    const { id, eid } = parse(entityParams, req.params);
    await ctx.access.require(user.id, id, 'editor');
    await ctx.files.delete(id, eid, user.id);
    reply.code(204);
  });

  /** Upload one file as the raw request body. Directory uploads send one request per file with a relative path. */
  app.post('/:id/upload', async (req, reply): Promise<TreeEntity & { replaced: boolean }> => {
    const user = requireUser(req);
    const { id } = parse(projectParams, req.params);
    const q = parse(uploadQuery, req.query);
    await ctx.access.require(user.id, id, 'editor');
    const { entity, replaced } = await ctx.files.upload(id, q.parentId, q.path, rawBody(req), user.id);
    reply.code(replaced ? 200 : 201);
    return { ...toDto(entity), replaced };
  });

  /** Download or preview a file. Text documents are returned as text/plain. */
  app.get('/:id/entities/:eid/content', async (req, reply) => {
    const user = requireUser(req);
    const { id, eid } = parse(entityParams, req.params);
    const { inline } = parse(z.object({ inline: z.enum(['0', '1']).default('0') }), req.query);
    await ctx.access.require(user.id, id, 'viewer');
    const e = await ctx.files.get(id, eid);
    reply.headers(USER_CONTENT_HEADERS);
    if (e.kind === 'folder') throw badRequest('Folders cannot be downloaded individually');
    if (e.kind === 'doc') {
      const c = await ctx.files.readDoc(id, eid);
      reply.header('Content-Type', 'text/plain; charset=utf-8').header('ETag', `"${c.contentHash}"`);
      if (inline === '0') reply.header('Content-Disposition', contentDisposition('attachment', e.name));
      return c.text;
    }
    const safeType = inlineContentType(extensionOf(e.name));
    const showInline = inline === '1' && safeType !== null;
    reply
      .header('Content-Type', showInline ? safeType : 'application/octet-stream')
      .header('Content-Length', String(e.size))
      .header('ETag', `"${e.blob_hash}"`)
      .header('Content-Disposition', contentDisposition(showInline ? 'inline' : 'attachment', e.name));
    return reply.send(ctx.blobs.open(e.blob_hash!));
  });

  /** Read a text document as JSON (with its content hash for optimistic concurrency). */
  app.get('/:id/entities/:eid/text', async (req): Promise<DocContent> => {
    const user = requireUser(req);
    const { id, eid } = parse(entityParams, req.params);
    await ctx.access.require(user.id, id, 'viewer');
    return ctx.files.readDoc(id, eid);
  });

  app.put('/:id/entities/:eid/text', { bodyLimit: 64 * 1024 * 1024 }, async (req): Promise<DocContent> => {
    const user = requireUser(req);
    const { id, eid } = parse(entityParams, req.params);
    const body = parse(writeSchema, req.body);
    await ctx.access.require(user.id, id, 'editor');
    return ctx.files.writeDoc(id, eid, body.text, body.baseHash, user.id);
  });
}
