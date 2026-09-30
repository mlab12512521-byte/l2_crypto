import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { CompileResult } from '@texcollab/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser } from '../../http/auth-hooks.js';
import { contentDisposition } from '../../http/content.js';
import { parse } from '../../http/validation.js';
import { notFound } from '../../lib/errors.js';
import { FileService } from '../files/service.js';
import { forwardSearch, inverseSearch, SyncTexCache } from './synctex.js';

const projectParams = z.object({ id: z.uuid() });
const buildFileParams = z.object({
  id: z.uuid(),
  bid: z.uuid(),
  file: z.enum(['output.pdf', 'output.log', 'output.blg', 'latexmk.log']),
});

const CONTENT_TYPES: Record<string, string> = {
  'output.pdf': 'application/pdf',
  'output.log': 'text/plain; charset=utf-8',
  'output.blg': 'text/plain; charset=utf-8',
  'latexmk.log': 'text/plain; charset=utf-8',
};

const buildParams = z.object({ id: z.uuid(), bid: z.uuid() });

export async function compileRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const synctex = new SyncTexCache();

  async function loadSyncTex(userId: string, projectId: string, buildId: string) {
    await ctx.access.require(userId, projectId, 'viewer');
    const build = await ctx.compile.getBuild(projectId, buildId);
    if (!build?.outputFiles.some((f) => f.name === 'output.synctex.gz'))
      throw notFound('No SyncTeX data for this build');
    return synctex.get(buildId, `${ctx.paths.buildDir(projectId, buildId)}/output.synctex.gz`);
  }

  /** Source → PDF: boxes (PDF points from the page's top-left) for a file and line. */
  app.get('/:id/builds/:bid/synctex/code', async (req) => {
    const user = requireUser(req);
    const { id, bid } = parse(buildParams, req.params);
    const q = parse(
      z.object({ file: z.string().min(1).max(4096), line: z.coerce.number().int().min(1).max(10_000_000) }),
      req.query,
    );
    const data = await loadSyncTex(user.id, id, bid);
    return { boxes: forwardSearch(data, q.file, q.line) };
  });

  /** PDF → source: file, line and entity id for a point on a page. */
  app.get('/:id/builds/:bid/synctex/pdf', async (req) => {
    const user = requireUser(req);
    const { id, bid } = parse(buildParams, req.params);
    const q = parse(
      z.object({
        page: z.coerce.number().int().min(1).max(100_000),
        x: z.coerce.number().min(-1e5).max(1e5),
        y: z.coerce.number().min(-1e5).max(1e5),
      }),
      req.query,
    );
    const data = await loadSyncTex(user.id, id, bid);
    const hit = inverseSearch(data, q.page, q.x, q.y);
    if (!hit) return { location: null };
    const rows = await ctx.files.entities(id);
    const paths = FileService.paths(rows);
    const entity = rows.find((e) => e.kind === 'doc' && paths.get(e.id) === hit.file);
    return { location: { ...hit, entityId: entity?.id ?? null } };
  });

  /** Compile the project. Viewers may compile too: it changes nothing in the project. */
  app.post('/:id/compile', async (req): Promise<CompileResult> => {
    const user = requireUser(req);
    const { id } = parse(projectParams, req.params);
    const body = parse(z.object({ draft: z.boolean().default(false) }).default({ draft: false }), req.body ?? {});
    await ctx.access.require(user.id, id, 'viewer');
    return ctx.compile.compile(id, user.id, { draft: body.draft });
  });

  app.get('/:id/builds/latest', async (req): Promise<{ build: CompileResult | null; running: boolean }> => {
    const user = requireUser(req);
    const { id } = parse(projectParams, req.params);
    await ctx.access.require(user.id, id, 'viewer');
    return { build: await ctx.compile.latest(id), running: ctx.compile.isRunning(id) };
  });

  app.get('/:id/builds/:bid/:file', async (req, reply) => {
    const user = requireUser(req);
    const { id, bid, file } = parse(buildFileParams, req.params);
    const { download } = parse(z.object({ download: z.enum(['0', '1']).default('0') }), req.query);
    const { project } = await ctx.access.require(user.id, id, 'viewer');
    const build = await ctx.compile.getBuild(id, bid);
    if (!build?.outputFiles.some((f) => f.name === file)) throw notFound('Output file not found');
    const filePath = `${ctx.paths.buildDir(id, bid)}/${file}`;
    const info = await stat(filePath).catch(() => null);
    if (!info) throw notFound('Output file not found');
    const downloadName = file === 'output.pdf' ? `${project.name}.pdf` : `${project.name}-${file}`;
    reply
      .header('Content-Type', CONTENT_TYPES[file]!)
      .header('Content-Length', String(info.size))
      // Build outputs never change; clients may cache them for the session.
      .header('Cache-Control', 'private, max-age=3600, immutable')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "sandbox; default-src 'none'")
      .header('Content-Disposition', contentDisposition(download === '1' ? 'attachment' : 'inline', downloadName));
    return reply.send(createReadStream(filePath));
  });
}
