import { rm } from 'node:fs/promises';
import type { Compiler, ProjectDetails, ProjectRole, ProjectSummary } from '@texcollab/shared';
import { sql } from 'kysely';
import type { Db } from '../../db/index.js';
import { badRequest, notFound } from '../../lib/errors.js';
import type { StoragePaths } from '../../storage/paths.js';
import type { FileService } from '../files/service.js';
import { escapeLike } from '../users/service.js';

export const DEFAULT_MAIN_TEX = String.raw`\documentclass[11pt]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath}
\usepackage{graphicx}
\usepackage{hyperref}

\title{Untitled}
\author{}
\date{\today}

\begin{document}

\maketitle

\section{Introduction}

Start writing here.

\end{document}
`;

export type ProjectFilter = 'all' | 'owned' | 'shared';
export type ProjectSort = 'lastModified' | 'lastOpened' | 'name' | 'created';

/** Hooks run when a project is deleted (e.g. drop collaboration state, stop compiles). */
export type ProjectDeletedHook = (projectId: string) => Promise<void> | void;

export class ProjectService {
  private readonly deletedHooks: ProjectDeletedHook[] = [];

  constructor(
    private readonly db: Db,
    private readonly files: FileService,
    private readonly paths: StoragePaths,
  ) {}

  onDeleted(hook: ProjectDeletedHook): void {
    this.deletedHooks.push(hook);
  }

  /**
   * Create a project owned by `ownerId`, with a root folder and (optionally)
   * a starter `main.tex`, in a single transaction.
   */
  async create(ownerId: string, name: string, opts: { withTemplate: boolean }): Promise<string> {
    return this.db.transaction().execute(async (trx) => {
      const project = await trx
        .insertInto('projects')
        .values({ name, last_modified_by: ownerId })
        .returning('id')
        .executeTakeFirstOrThrow();
      const root = await trx
        .insertInto('project_entities')
        .values({ project_id: project.id, parent_id: null, kind: 'folder', name: '', created_by: ownerId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('project_members')
        .values({ project_id: project.id, user_id: ownerId, role: 'owner', added_by: ownerId })
        .execute();
      if (opts.withTemplate) {
        const main = await this.files.createDoc(project.id, root.id, 'main.tex', DEFAULT_MAIN_TEX, ownerId, trx);
        await trx.updateTable('projects').set({ main_file_id: main.id }).where('id', '=', project.id).execute();
      }
      return project.id;
    });
  }

  async list(
    userId: string,
    opts: { filter: ProjectFilter; q?: string; sort: ProjectSort; projectId?: string },
  ): Promise<ProjectSummary[]> {
    let q = this.db
      .selectFrom('project_members as me')
      .innerJoin('projects as p', 'p.id', 'me.project_id')
      .innerJoin('project_members as om', (j) => j.onRef('om.project_id', '=', 'p.id').on('om.role', '=', 'owner'))
      .innerJoin('users as owner', 'owner.id', 'om.user_id')
      .leftJoin('users as mod', 'mod.id', 'p.last_modified_by')
      .leftJoin('project_user_state as st', (j) =>
        j.onRef('st.project_id', '=', 'p.id').onRef('st.user_id', '=', 'me.user_id'),
      )
      .select([
        'p.id',
        'p.name',
        'p.created_at',
        'p.last_modified_at',
        'me.role',
        'owner.id as owner_id',
        'owner.username as owner_username',
        'owner.display_name as owner_display_name',
        'mod.id as mod_id',
        'mod.username as mod_username',
        'mod.display_name as mod_display_name',
        'st.last_opened_at',
      ])
      .where('me.user_id', '=', userId);
    if (opts.filter === 'owned') q = q.where('me.role', '=', 'owner');
    if (opts.filter === 'shared') q = q.where('me.role', '!=', 'owner');
    if (opts.projectId) q = q.where('p.id', '=', opts.projectId);
    if (opts.q) q = q.where('p.name', 'ilike', `%${escapeLike(opts.q)}%`);
    switch (opts.sort) {
      case 'name':
        q = q.orderBy(sql`lower(p.name)`).orderBy('p.id');
        break;
      case 'created':
        q = q.orderBy('p.created_at', 'desc');
        break;
      case 'lastOpened':
        q = q.orderBy(sql`st.last_opened_at DESC NULLS LAST`).orderBy('p.last_modified_at', 'desc');
        break;
      default:
        q = q.orderBy('p.last_modified_at', 'desc');
    }
    const rows = await q.limit(1000).execute();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      owner: { id: r.owner_id, username: r.owner_username, displayName: r.owner_display_name },
      createdAt: r.created_at.toISOString(),
      lastModifiedAt: r.last_modified_at.toISOString(),
      lastModifiedBy: r.mod_id ? { id: r.mod_id, username: r.mod_username!, displayName: r.mod_display_name! } : null,
      lastOpenedAt: r.last_opened_at ? r.last_opened_at.toISOString() : null,
    }));
  }

  async details(projectId: string, userId: string, role: ProjectRole): Promise<ProjectDetails> {
    const [summary] = await this.list(userId, { filter: 'all', sort: 'lastModified', projectId });
    const p = await this.db.selectFrom('projects').selectAll().where('id', '=', projectId).executeTakeFirst();
    if (!summary || !p) throw notFound('Project not found');
    return {
      ...summary,
      role,
      compiler: p.compiler,
      mainFileId: p.main_file_id,
      rootFolderId: await this.files.rootId(projectId),
    };
  }

  async recordOpened(projectId: string, userId: string): Promise<void> {
    await this.db
      .insertInto('project_user_state')
      .values({ project_id: projectId, user_id: userId, last_opened_at: new Date() })
      .onConflict((oc) => oc.columns(['project_id', 'user_id']).doUpdateSet({ last_opened_at: new Date() }))
      .execute();
  }

  async rename(projectId: string, name: string): Promise<void> {
    await this.db.updateTable('projects').set({ name, updated_at: new Date() }).where('id', '=', projectId).execute();
  }

  async setCompiler(projectId: string, compiler: Compiler): Promise<void> {
    await this.db
      .updateTable('projects')
      .set({ compiler, updated_at: new Date() })
      .where('id', '=', projectId)
      .execute();
  }

  async setMainFile(projectId: string, entityId: string | null): Promise<void> {
    if (entityId !== null) {
      const e = await this.files.get(projectId, entityId);
      if (e.kind !== 'doc' || !/\.(tex|ltx|latex)$/i.test(e.name)) {
        throw badRequest('The main file must be a .tex document');
      }
    }
    await this.db
      .updateTable('projects')
      .set({ main_file_id: entityId, updated_at: new Date() })
      .where('id', '=', projectId)
      .execute();
  }

  /** Delete a project and everything stored for it. Irreversible. */
  async delete(projectId: string): Promise<void> {
    await this.db.deleteFrom('projects').where('id', '=', projectId).execute();
    for (const hook of this.deletedHooks) await hook(projectId);
    await rm(this.paths.projectGitDir(projectId), { recursive: true, force: true });
    await rm(this.paths.projectBuildsDir(projectId), { recursive: true, force: true });
  }

  async countOwnedBy(userId: string): Promise<number> {
    const r = await this.db
      .selectFrom('project_members')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('user_id', '=', userId)
      .where('role', '=', 'owner')
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  async ownedBy(userId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('project_members')
      .select('project_id')
      .where('user_id', '=', userId)
      .where('role', '=', 'owner')
      .execute();
    return rows.map((r) => r.project_id);
  }
}
