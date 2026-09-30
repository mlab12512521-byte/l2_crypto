import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  type DocContent,
  isTextFileName,
  type ProjectLimits,
  type ProjectTree,
  parseRelativePath,
  type TreeEntity,
  validateEntityName,
} from '@texcollab/shared';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Db } from '../../db/index.js';
import type { Database, EntityRow } from '../../db/schema.js';
import { AppError, badRequest, conflict, notFound, tooLarge } from '../../lib/errors.js';
import type { BlobStore } from '../../storage/blob-store.js';
import { isUniqueViolation } from '../users/service.js';

type Executor = Kysely<Database> | Transaction<Database>;

export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Decode a buffer as UTF-8 text if it is plausibly a text file (valid UTF-8, no NUL bytes). */
export function decodeText(buf: Buffer): string | null {
  if (buf.includes(0)) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    // Strip a UTF-8 byte-order mark; TeX engines do not need it.
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

/**
 * Hook for writing document text. The default writes to the database; the
 * collaboration hub (phase 5) replaces it so that server-side changes reach
 * live editing sessions as regular collaborative edits.
 */
export interface DocWriter {
  /** Current text of a document, including unsaved in-memory collaborative edits. */
  read(entityId: string): Promise<DocContent | null>;
  /** Replace the text of an existing document. */
  write(entityId: string, text: string, userId: string | null): Promise<DocContent>;
}

export class DatabaseDocWriter implements DocWriter {
  constructor(private readonly db: Db) {}

  async read(entityId: string): Promise<DocContent | null> {
    const row = await this.db
      .selectFrom('doc_contents')
      .select(['text', 'content_hash'])
      .where('entity_id', '=', entityId)
      .executeTakeFirst();
    return row ? { text: row.text, contentHash: row.content_hash } : null;
  }

  async write(entityId: string, text: string, userId: string | null): Promise<DocContent> {
    const hash = contentHash(text);
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('doc_contents')
        .set({ text, content_hash: hash, yjs_state: null, updated_at: new Date(), updated_by: userId })
        .where('entity_id', '=', entityId)
        .execute();
      await trx
        .updateTable('project_entities')
        .set({ size: Buffer.byteLength(text), updated_at: new Date() })
        .where('id', '=', entityId)
        .execute();
    });
    return { text, contentHash: hash };
  }
}

export type TreeChangeListener = (projectId: string) => void;

function toTreeEntity(e: EntityRow): TreeEntity {
  return {
    id: e.id,
    parentId: e.parent_id,
    kind: e.kind,
    name: e.name,
    size: Number(e.size),
    updatedAt: e.updated_at.toISOString(),
  };
}

function nameError(name: string): AppError | null {
  const err = validateEntityName(name);
  return err ? badRequest(err, { name: err }) : null;
}

/**
 * The project file tree: folders, collaborative text documents and binary
 * files. The tree lives in PostgreSQL; binary content in the blob store;
 * nothing is ever written to a path derived from a user-supplied name.
 */
export class FileService {
  private docWriter: DocWriter;
  private readonly listeners: TreeChangeListener[] = [];
  private readonly deletedListeners: Array<(docIds: string[]) => void> = [];

  constructor(
    private readonly db: Db,
    private readonly blobs: BlobStore,
    private readonly getLimits: () => Promise<ProjectLimits>,
  ) {
    this.docWriter = new DatabaseDocWriter(db);
  }

  setDocWriter(writer: DocWriter): void {
    this.docWriter = writer;
  }

  get docs(): DocWriter {
    return this.docWriter;
  }

  onTreeChange(fn: TreeChangeListener): void {
    this.listeners.push(fn);
  }

  /** Called with the ids of text documents removed from the tree. */
  onDocsDeleted(fn: (docIds: string[]) => void): void {
    this.deletedListeners.push(fn);
  }

  private async changed(projectId: string, userId: string | null): Promise<void> {
    await recordChange(this.db, projectId, userId);
    for (const fn of this.listeners) fn(projectId);
  }

  // ---------------------------------------------------------------- queries

  async rootId(projectId: string, exec: Executor = this.db): Promise<string> {
    const root = await exec
      .selectFrom('project_entities')
      .select('id')
      .where('project_id', '=', projectId)
      .where('parent_id', 'is', null)
      .executeTakeFirstOrThrow();
    return root.id;
  }

  async entities(projectId: string, exec: Executor = this.db): Promise<EntityRow[]> {
    return exec.selectFrom('project_entities').selectAll().where('project_id', '=', projectId).execute();
  }

  async tree(projectId: string): Promise<ProjectTree> {
    const rows = await this.entities(projectId);
    const root = rows.find((r) => r.parent_id === null);
    if (!root) throw notFound('Project not found');
    return {
      rootId: root.id,
      entities: rows.filter((r) => r.parent_id !== null).map(toTreeEntity),
    };
  }

  /** Load an entity, guaranteeing that it belongs to the project (prevents cross-project IDOR). */
  async get(projectId: string, entityId: string, exec: Executor = this.db): Promise<EntityRow> {
    if (!/^[0-9a-f-]{36}$/i.test(entityId)) throw notFound('File not found');
    const row = await exec
      .selectFrom('project_entities')
      .selectAll()
      .where('id', '=', entityId)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    if (!row) throw notFound('File not found');
    return row;
  }

  /** Relative path of every non-root entity, computed from the tree. */
  static paths(rows: EntityRow[]): Map<string, string> {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const cache = new Map<string, string>();
    const resolve = (id: string, depth = 0): string => {
      const cached = cache.get(id);
      if (cached !== undefined) return cached;
      const e = byId.get(id);
      if (!e || e.parent_id === null) return '';
      if (depth > 64) throw new Error('file tree cycle detected');
      const parent = resolve(e.parent_id, depth + 1);
      const p = parent ? `${parent}/${e.name}` : e.name;
      cache.set(id, p);
      return p;
    };
    const out = new Map<string, string>();
    for (const r of rows) if (r.parent_id !== null) out.set(r.id, resolve(r.id));
    return out;
  }

  async pathOf(projectId: string, entityId: string): Promise<string> {
    const rows = await this.entities(projectId);
    const p = FileService.paths(rows).get(entityId);
    if (p === undefined) throw notFound('File not found');
    return p;
  }

  async usage(projectId: string, exec: Executor = this.db): Promise<{ count: number; bytes: number }> {
    const r = await exec
      .selectFrom('project_entities')
      .select((eb) => [
        eb.fn.countAll<string>().as('n'),
        eb.fn.coalesce(eb.fn.sum<string>('size'), sql<string>`0`).as('bytes'),
      ])
      .where('project_id', '=', projectId)
      .executeTakeFirstOrThrow();
    return { count: Number(r.n), bytes: Number(r.bytes) };
  }

  private async checkQuota(projectId: string, addEntities: number, addBytes: number, exec: Executor): Promise<void> {
    const limits = await this.getLimits();
    const u = await this.usage(projectId, exec);
    if (u.count + addEntities > limits.maxEntitiesPerProject) {
      throw new AppError(
        413,
        'quota_exceeded',
        `Projects may contain at most ${limits.maxEntitiesPerProject} files and folders`,
      );
    }
    if (u.bytes + addBytes > limits.maxProjectSizeBytes) {
      throw new AppError(413, 'quota_exceeded', 'The project would exceed its storage limit');
    }
  }

  private async requireFolder(projectId: string, folderId: string, exec: Executor): Promise<EntityRow> {
    const f = await this.get(projectId, folderId, exec);
    if (f.kind !== 'folder') throw badRequest('The target is not a folder');
    return f;
  }

  private async depthOf(entityId: string, exec: Executor): Promise<number> {
    const r = await sql<{ depth: number }>`
      WITH RECURSIVE up(id, parent_id, depth) AS (
        SELECT id, parent_id, 0 FROM project_entities WHERE id = ${entityId}
        UNION ALL
        SELECT e.id, e.parent_id, up.depth + 1 FROM project_entities e JOIN up ON e.id = up.parent_id
      )
      SELECT max(depth) AS depth FROM up`.execute(exec);
    return Number(r.rows[0]?.depth ?? 0);
  }

  // ---------------------------------------------------------------- mutations

  private async insert(
    exec: Executor,
    values: {
      projectId: string;
      parentId: string;
      kind: 'folder' | 'doc' | 'file';
      name: string;
      blobHash?: string;
      size?: number;
      userId: string | null;
    },
  ): Promise<EntityRow> {
    try {
      return await exec
        .insertInto('project_entities')
        .values({
          project_id: values.projectId,
          parent_id: values.parentId,
          kind: values.kind,
          name: values.name,
          blob_hash: values.blobHash ?? null,
          size: values.size ?? 0,
          created_by: values.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`An item named "${values.name}" already exists in this folder`);
      throw err;
    }
  }

  async createFolder(projectId: string, parentId: string, name: string, userId: string): Promise<EntityRow> {
    const bad = nameError(name);
    if (bad) throw bad;
    const row = await this.db.transaction().execute(async (trx) => {
      await this.requireFolder(projectId, parentId, trx);
      if ((await this.depthOf(parentId, trx)) >= 32) throw badRequest('Folders are nested too deeply');
      await this.checkQuota(projectId, 1, 0, trx);
      return this.insert(trx, { projectId, parentId, kind: 'folder', name, userId });
    });
    await this.changed(projectId, userId);
    return row;
  }

  async createDoc(
    projectId: string,
    parentId: string,
    name: string,
    text: string,
    userId: string | null,
    exec?: Executor,
  ): Promise<EntityRow> {
    const bad = nameError(name);
    if (bad) throw bad;
    const limits = await this.getLimits();
    const size = Buffer.byteLength(text);
    if (size > limits.maxTextFileSizeBytes) throw tooLarge('The text file is too large');
    const run = async (trx: Executor) => {
      await this.requireFolder(projectId, parentId, trx);
      await this.checkQuota(projectId, 1, size, trx);
      const row = await this.insert(trx, { projectId, parentId, kind: 'doc', name, size, userId });
      await trx
        .insertInto('doc_contents')
        .values({ entity_id: row.id, text, content_hash: contentHash(text), updated_by: userId })
        .execute();
      return row;
    };
    const row = exec ? await run(exec) : await this.db.transaction().execute(run);
    if (!exec) await this.changed(projectId, userId);
    return row;
  }

  /** Register a stored blob (idempotent) and refresh its timestamp so GC does not race with new references. */
  private async upsertBlob(exec: Executor, hash: string, size: number): Promise<void> {
    await exec
      .insertInto('blobs')
      .values({ hash, size })
      .onConflict((oc) => oc.column('hash').doUpdateSet({ created_at: new Date() }))
      .execute();
  }

  async createFileFromBlob(
    projectId: string,
    parentId: string,
    name: string,
    blob: { hash: string; size: number },
    userId: string | null,
    exec: Executor,
  ): Promise<EntityRow> {
    const bad = nameError(name);
    if (bad) throw bad;
    await this.requireFolder(projectId, parentId, exec);
    await this.checkQuota(projectId, 1, blob.size, exec);
    await this.upsertBlob(exec, blob.hash, blob.size);
    return this.insert(exec, { projectId, parentId, kind: 'file', name, blobHash: blob.hash, size: blob.size, userId });
  }

  /** Create any missing folders along `segments` below `baseId` (like mkdir -p). */
  async ensureFolders(
    projectId: string,
    baseId: string,
    segments: string[],
    userId: string | null,
    exec: Executor,
  ): Promise<string> {
    let current = baseId;
    for (const seg of segments) {
      const existing = await exec
        .selectFrom('project_entities')
        .selectAll()
        .where('parent_id', '=', current)
        .where('name', '=', seg)
        .executeTakeFirst();
      if (existing) {
        if (existing.kind !== 'folder') throw conflict(`"${seg}" exists and is not a folder`);
        current = existing.id;
      } else {
        await this.checkQuota(projectId, 1, 0, exec);
        current = (await this.insert(exec, { projectId, parentId: current, kind: 'folder', name: seg, userId })).id;
      }
    }
    return current;
  }

  /**
   * Store an uploaded file at `relativePath` below `parentId`, creating
   * intermediate folders. Text files become collaborative documents; other
   * content is stored as a binary blob. An existing file with the same name is
   * replaced (a folder is never replaced).
   */
  async upload(
    projectId: string,
    parentId: string,
    relativePath: string,
    content: Readable,
    userId: string,
  ): Promise<{ entity: EntityRow; replaced: boolean }> {
    const parsed = parseRelativePath(relativePath);
    if ('error' in parsed) throw badRequest(parsed.error, { path: parsed.error });
    const segments = parsed.segments;
    const name = segments.pop()!;
    const limits = await this.getLimits();

    // Stream to the blob store first (bounded); decide afterwards whether it is text.
    const blob = await this.blobs.put(content, limits.maxFileSizeBytes);
    let text: string | null = null;
    if (isTextFileName(name) && blob.size <= limits.maxTextFileSizeBytes) {
      text = decodeText(await this.blobs.read(blob.hash));
    }

    let replacedDocId: string | null = null;
    const result = await this.db.transaction().execute(async (trx) => {
      await this.requireFolder(projectId, parentId, trx);
      const folderId = await this.ensureFolders(projectId, parentId, segments, userId, trx);
      const existing = await trx
        .selectFrom('project_entities')
        .selectAll()
        .where('parent_id', '=', folderId)
        .where('name', '=', name)
        .executeTakeFirst();
      if (existing?.kind === 'folder') throw conflict(`A folder named "${name}" already exists`);

      if (existing && existing.kind === (text !== null ? 'doc' : 'file')) {
        // Same kind: replace content in place, keeping the entity id (open editors stay valid).
        if (text !== null) return { entity: existing, replaced: true, docText: text };
        await this.checkQuota(projectId, 0, blob.size - Number(existing.size), trx);
        await this.upsertBlob(trx, blob.hash, blob.size);
        const entity = await trx
          .updateTable('project_entities')
          .set({ blob_hash: blob.hash, size: blob.size, updated_at: new Date() })
          .where('id', '=', existing.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return { entity, replaced: true, docText: null };
      }
      if (existing) {
        await trx.deleteFrom('project_entities').where('id', '=', existing.id).execute();
        if (existing.kind === 'doc') replacedDocId = existing.id;
      }
      const entity =
        text !== null
          ? await this.createDoc(projectId, folderId, name, text, userId, trx)
          : await this.createFileFromBlob(projectId, folderId, name, blob, userId, trx);
      return { entity, replaced: existing !== undefined, docText: null };
    });

    if (replacedDocId) for (const fn of this.deletedListeners) fn([replacedDocId]);
    if (result.docText !== null) {
      // Replacing an existing document goes through the doc writer so live editors see it.
      await this.docWriter.write(result.entity.id, result.docText, userId);
    }
    await this.changed(projectId, userId);
    return { entity: result.entity, replaced: result.replaced };
  }

  async rename(projectId: string, entityId: string, name: string, userId: string): Promise<EntityRow> {
    const bad = nameError(name);
    if (bad) throw bad;
    const e = await this.get(projectId, entityId);
    if (e.parent_id === null) throw badRequest('The project root cannot be renamed');
    try {
      const row = await this.db
        .updateTable('project_entities')
        .set({ name, updated_at: new Date() })
        .where('id', '=', entityId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.changed(projectId, userId);
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`An item named "${name}" already exists in this folder`);
      throw err;
    }
  }

  async move(projectId: string, entityId: string, newParentId: string, userId: string): Promise<EntityRow> {
    const row = await this.db.transaction().execute(async (trx) => {
      const e = await this.get(projectId, entityId, trx);
      if (e.parent_id === null) throw badRequest('The project root cannot be moved');
      await this.requireFolder(projectId, newParentId, trx);
      // Refuse moving a folder into itself or one of its descendants.
      const cycle = await sql<{ hit: boolean }>`
        WITH RECURSIVE up(id, parent_id) AS (
          SELECT id, parent_id FROM project_entities WHERE id = ${newParentId}
          UNION ALL
          SELECT p.id, p.parent_id FROM project_entities p JOIN up ON p.id = up.parent_id
        )
        SELECT EXISTS (SELECT 1 FROM up WHERE id = ${entityId}) AS hit`.execute(trx);
      if (cycle.rows[0]?.hit) throw badRequest('A folder cannot be moved into itself');
      try {
        return await trx
          .updateTable('project_entities')
          .set({ parent_id: newParentId, updated_at: new Date() })
          .where('id', '=', entityId)
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict(`An item named "${e.name}" already exists in the target folder`);
        throw err;
      }
    });
    await this.changed(projectId, userId);
    return row;
  }

  async delete(projectId: string, entityId: string, userId: string): Promise<void> {
    const e = await this.get(projectId, entityId);
    if (e.parent_id === null) throw badRequest('The project root cannot be deleted');
    const docs = await sql<{ id: string }>`
      WITH RECURSIVE sub(id, kind) AS (
        SELECT id, kind FROM project_entities WHERE id = ${entityId}
        UNION ALL
        SELECT e.id, e.kind FROM project_entities e JOIN sub ON e.parent_id = sub.id
      )
      SELECT id FROM sub WHERE kind = 'doc'`.execute(this.db);
    // Children, document contents are removed by ON DELETE CASCADE; blobs by GC.
    await this.db.deleteFrom('project_entities').where('id', '=', entityId).execute();
    const ids = docs.rows.map((r) => r.id);
    for (const fn of this.deletedListeners) fn(ids);
    await this.changed(projectId, userId);
  }

  // ---------------------------------------------------------------- documents

  async readDoc(projectId: string, entityId: string): Promise<DocContent> {
    const e = await this.get(projectId, entityId);
    if (e.kind !== 'doc') throw badRequest('Not a text document');
    const c = await this.docWriter.read(e.id);
    if (!c) throw notFound('File not found');
    return c;
  }

  /**
   * Replace a document's text with optimistic concurrency: the caller states
   * the hash it based its edit on and gets 409 if the document changed since.
   * (Interactive editing uses the collaboration channel, not this.)
   */
  async writeDoc(
    projectId: string,
    entityId: string,
    text: string,
    baseHash: string | null,
    userId: string,
  ): Promise<DocContent> {
    const e = await this.get(projectId, entityId);
    if (e.kind !== 'doc') throw badRequest('Not a text document');
    const limits = await this.getLimits();
    if (Buffer.byteLength(text) > limits.maxTextFileSizeBytes) throw tooLarge('The text file is too large');
    const current = await this.docWriter.read(e.id);
    if (!current) throw notFound('File not found');
    if (baseHash !== null && current.contentHash !== baseHash) {
      throw new AppError(409, 'edit_conflict', 'The document was changed by someone else; reload and try again');
    }
    const result = await this.docWriter.write(e.id, text, userId);
    await this.changed(projectId, userId);
    return result;
  }

  // ---------------------------------------------------------------- maintenance

  /**
   * Delete blobs no longer referenced by any file. Only blobs whose row and
   * file are older than `graceMs` are touched, which avoids racing with
   * uploads that are about to reference them.
   */
  async collectGarbage(graceMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - graceMs);
    const deleted = await this.db
      .deleteFrom('blobs')
      .where('created_at', '<', cutoff)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(selectFrom('project_entities').select('id').whereRef('project_entities.blob_hash', '=', 'blobs.hash')),
        ),
      )
      .returning('hash')
      .execute();
    let removed = 0;
    for (const { hash } of deleted) {
      const mtime = await this.blobs.mtime(hash);
      if (mtime && mtime < cutoff) {
        await this.blobs.delete(hash);
        removed++;
      }
    }
    await this.blobs.cleanTmp(graceMs);
    return removed;
  }
}

/**
 * Mark a project as modified by a user: updates the "last modified" fields and
 * records the user as a contributor to the next automatic version.
 */
export async function recordChange(db: Db, projectId: string, userId: string | null): Promise<void> {
  const now = new Date();
  await db
    .updateTable('projects')
    .set({ last_modified_at: now, last_modified_by: userId })
    .where('id', '=', projectId)
    .execute();
  if (userId) {
    await db
      .insertInto('project_changes')
      .values({ project_id: projectId, user_id: userId, first_change_at: now, last_change_at: now })
      .onConflict((oc) => oc.columns(['project_id', 'user_id']).doUpdateSet({ last_change_at: now }))
      .execute();
  }
}
