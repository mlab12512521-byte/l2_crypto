import type { FileChange, PublicUser, VersionDiff, VersionInfo, VersionKind } from '@texcollab/shared';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { notFound } from '../../lib/errors.js';
import type { BlobStore } from '../../storage/blob-store.js';
import type { StoragePaths } from '../../storage/paths.js';
import type { FileService } from '../files/service.js';
import { snapshotProject } from '../files/snapshot.js';
import type { SettingsService } from '../settings/service.js';
import { toPublicUser } from '../users/service.js';
import { GitRepo } from './git.js';
import { commitSnapshot, type GitIdentity } from './snapshot-writer.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAIN = 'refs/heads/main';
const SYSTEM: GitIdentity = { name: 'TeXCollab', email: 'texcollab@texcollab.invalid' };

/** Git identity for a user. E-mail addresses are not published in history. */
export function gitIdentity(u: { username: string; display_name: string }): GitIdentity {
  return { name: u.display_name, email: `${u.username}@users.texcollab.invalid` };
}

export type VersionListener = (projectId: string) => void;

/**
 * Project history. Every project has a bare Git repository; a *version* is
 * a commit on `main` plus a row in `versions` with who/when/why. Versions are
 * created automatically after a pause in editing (or during long sessions),
 * on demand, before and after restores, and on import/pull.
 */
export class VersionService {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly listeners: VersionListener[] = [];

  constructor(
    private readonly db: Db,
    private readonly files: FileService,
    private readonly blobs: BlobStore,
    private readonly paths: StoragePaths,
    private readonly settings: SettingsService,
    private readonly log: Logger,
  ) {}

  onVersionCreated(fn: VersionListener): void {
    this.listeners.push(fn);
  }

  repo(projectId: string): GitRepo {
    return new GitRepo(this.paths.projectGitDir(projectId));
  }

  /** Serialise history operations per project (single app instance; see TD16 for scaling out). */
  async withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.locks.set(projectId, settled);
    try {
      return await next;
    } finally {
      if (this.locks.get(projectId) === settled) this.locks.delete(projectId);
    }
  }

  async head(projectId: string): Promise<string | null> {
    const repo = this.repo(projectId);
    if (!(await repo.exists())) return null;
    return repo.resolve(MAIN);
  }

  /**
   * Record the current project state as a version. Returns null for
   * automatic versions when nothing changed since the last version.
   */
  async createVersion(
    projectId: string,
    opts: { kind: VersionKind; label?: string | null; userId?: string | null },
  ): Promise<VersionInfo | null> {
    return this.withLock(projectId, () => this.createVersionLocked(projectId, opts));
  }

  private async createVersionLocked(
    projectId: string,
    opts: { kind: VersionKind; label?: string | null; userId?: string | null },
  ): Promise<VersionInfo | null> {
    const repo = this.repo(projectId);
    await repo.init();
    const cutoff = new Date();
    const changes = await this.db
      .selectFrom('project_changes as c')
      .innerJoin('users as u', 'u.id', 'c.user_id')
      .select(['u.id', 'u.username', 'u.display_name'])
      .where('c.project_id', '=', projectId)
      .where('c.last_change_at', '<=', cutoff)
      .execute();
    const actor = opts.userId
      ? await this.db
          .selectFrom('users')
          .select(['id', 'username', 'display_name'])
          .where('id', '=', opts.userId)
          .executeTakeFirst()
      : undefined;
    const contributors = changes.length ? changes : actor ? [actor] : [];
    const author = actor ? gitIdentity(actor) : contributors.length === 1 ? gitIdentity(contributors[0]!) : SYSTEM;
    const coAuthors = contributors.filter((c) => c.id !== actor?.id && (actor || contributors.length > 1));
    const title = opts.label?.trim() || defaultMessage(opts.kind);
    const message = [
      title,
      '',
      ...coAuthors.map((c) => `Co-authored-by: ${gitIdentity(c).name} <${gitIdentity(c).email}>`),
    ]
      .join('\n')
      .trim();

    const parent = await repo.resolve(MAIN);
    const snapshot = await snapshotProject(this.files, projectId);
    const { commit, unchanged } = await commitSnapshot(repo, this.blobs, snapshot, { parent, author, message });

    if (unchanged && (opts.kind === 'auto' || opts.kind === 'restore')) {
      await this.clearChanges(projectId, cutoff);
      return null;
    }
    if (!unchanged) {
      await repo.run(['update-ref', MAIN, commit, ...(parent ? [parent] : [])]);
    }
    const row = await this.db
      .insertInto('versions')
      .values({
        project_id: projectId,
        commit_sha: commit,
        kind: opts.kind,
        label: opts.label?.trim() || null,
        created_by: opts.userId ?? null,
        contributors: contributors.map((c) => c.id),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.clearChanges(projectId, cutoff);
    for (const fn of this.listeners) fn(projectId);
    return this.get(projectId, row.id);
  }

  private async clearChanges(projectId: string, cutoff: Date) {
    await this.db
      .deleteFrom('project_changes')
      .where('project_id', '=', projectId)
      .where('last_change_at', '<=', cutoff)
      .execute();
  }

  async isDirty(projectId: string): Promise<boolean> {
    const r = await this.db
      .selectFrom('project_changes')
      .select('user_id')
      .where('project_id', '=', projectId)
      .limit(1)
      .executeTakeFirst();
    return r !== undefined;
  }

  async list(projectId: string, limit = 500): Promise<VersionInfo[]> {
    const rows = await this.db
      .selectFrom('versions')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(limit)
      .execute();
    const ids = new Set<string>();
    for (const r of rows) {
      if (r.created_by) ids.add(r.created_by);
      for (const c of r.contributors) ids.add(c);
    }
    const users = ids.size
      ? await this.db
          .selectFrom('users')
          .select(['id', 'username', 'display_name'])
          .where('id', 'in', [...ids])
          .execute()
      : [];
    const byId = new Map<string, PublicUser>(users.map((u) => [u.id, toPublicUser(u)]));
    return rows.map((r) => ({
      id: r.id,
      commitSha: r.commit_sha,
      kind: r.kind,
      label: r.label,
      createdAt: r.created_at.toISOString(),
      createdBy: r.created_by ? (byId.get(r.created_by) ?? null) : null,
      contributors: r.contributors.map((c) => byId.get(c)).filter((u): u is PublicUser => !!u),
    }));
  }

  async get(projectId: string, versionId: string): Promise<VersionInfo> {
    const v = (await this.list(projectId, 10_000)).find((x) => x.id === versionId);
    if (!v) throw notFound('Version not found');
    return v;
  }

  /** Commit sha for a version id, or a fresh snapshot commit for "current". */
  async resolveRef(projectId: string, ref: string): Promise<string> {
    if (ref === 'current') {
      return this.withLock(projectId, async () => {
        const repo = this.repo(projectId);
        await repo.init();
        const parent = await repo.resolve(MAIN);
        const snapshot = await snapshotProject(this.files, projectId);
        const { commit } = await commitSnapshot(repo, this.blobs, snapshot, {
          parent,
          author: SYSTEM,
          message: 'Current state',
        });
        return commit;
      });
    }
    if (!/^[0-9a-f-]{36}$/.test(ref)) throw notFound('Version not found');
    const row = await this.db
      .selectFrom('versions')
      .select('commit_sha')
      .where('project_id', '=', projectId)
      .where('id', '=', ref)
      .executeTakeFirst();
    if (!row) throw notFound('Version not found');
    return row.commit_sha;
  }

  /** Files changed between two commits (from = null means "since the beginning"). */
  async diff(projectId: string, from: string | null, to: string): Promise<VersionDiff> {
    const repo = this.repo(projectId);
    const a = from ?? EMPTY_TREE;
    const nameStatus = (await repo.run(['diff', '--no-renames', '--name-status', '-z', a, to])).stdout
      .toString('utf8')
      .split('\0');
    const numstat = (await repo.run(['diff', '--no-renames', '--numstat', '-z', a, to])).stdout
      .toString('utf8')
      .split('\0');
    const binary = new Set<string>();
    for (const rec of numstat) {
      const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
      if (m && m[1] === '-') binary.add(m[3]!);
    }
    const changes: FileChange[] = [];
    for (let i = 0; i + 1 < nameStatus.length; i += 2) {
      const code = nameStatus[i]!;
      const path = nameStatus[i + 1]!;
      if (!code) continue;
      const status = code[0] === 'A' ? 'added' : code[0] === 'D' ? 'deleted' : 'modified';
      changes.push({ status, path, binary: binary.has(path) });
    }
    return { from, to, changes };
  }

  async fileAt(projectId: string, commit: string, path: string): Promise<Buffer | null> {
    return this.repo(projectId).readFileAt(commit, path);
  }

  /** All files of a commit, validated for use as project content. */
  async filesOf(projectId: string, commit: string): Promise<Array<{ path: string; content: Buffer }>> {
    const repo = this.repo(projectId);
    const out: Array<{ path: string; content: Buffer }> = [];
    for (const item of await repo.listTree(commit)) {
      // Only regular files; symbolic links and submodules are ignored.
      if (item.type !== 'blob' || (item.mode !== '100644' && item.mode !== '100755')) continue;
      out.push({ path: item.path, content: await repo.readBlob(item.sha) });
    }
    return out;
  }

  /**
   * Restore a version without losing anything: the current state is saved
   * first, then the old content is applied and recorded as a new version.
   */
  async restore(projectId: string, versionId: string, userId: string): Promise<VersionInfo | null> {
    const target = await this.get(projectId, versionId);
    await this.createVersion(projectId, { kind: 'auto', label: 'Before restoring an earlier version', userId });
    const files = await this.filesOf(projectId, target.commitSha);
    await this.files.applyFiles(projectId, files, userId);
    const label = `Restored version from ${target.createdAt.slice(0, 16).replace('T', ' ')} UTC`;
    return this.createVersion(projectId, { kind: 'restore', label, userId });
  }

  /** Repack the repositories of recently active projects (git gc). Returns how many were processed. */
  async maintainRepositories(activeSinceMs = 7 * 86_400_000): Promise<number> {
    const since = new Date(Date.now() - activeSinceMs);
    const projects = await this.db.selectFrom('projects').select('id').where('last_modified_at', '>', since).execute();
    let done = 0;
    for (const { id } of projects) {
      const repo = this.repo(id);
      if (!(await repo.exists())) continue;
      await this.withLock(id, () => repo.run(['gc', '--quiet', '--prune=2.weeks.ago'], { timeoutMs: 600_000 })).catch(
        (err: unknown) => this.log.warn({ err, projectId: id }, 'git maintenance failed'),
      );
      done++;
    }
    return done;
  }

  /**
   * Create automatic versions for projects that have been idle long enough,
   * or edited continuously for too long. Safe to run on several instances.
   */
  async runAutoVersioning(): Promise<number> {
    const cfg = await this.settings.get('versioning');
    if (!cfg.enabled) return 0;
    const idleBefore = new Date(Date.now() - cfg.idleMinutes * 60_000);
    const startedBefore = new Date(Date.now() - cfg.maxMinutes * 60_000);
    const due = await this.db
      .selectFrom('project_changes')
      .select('project_id')
      .groupBy('project_id')
      .having((eb) =>
        eb.or([eb(eb.fn.max('last_change_at'), '<', idleBefore), eb(eb.fn.min('first_change_at'), '<', startedBefore)]),
      )
      .limit(100)
      .execute();
    let created = 0;
    for (const { project_id } of due) {
      // Cross-instance guard: advisory locks belong to a session, so take and
      // release the lock on one dedicated connection.
      await this.db.connection().execute(async (conn) => {
        const key = `versions:${project_id}`;
        const lock = await sql<{ ok: boolean }>`SELECT pg_try_advisory_lock(hashtext(${key})) AS ok`.execute(conn);
        if (!lock.rows[0]?.ok) return;
        try {
          if (await this.createVersion(project_id, { kind: 'auto' })) created++;
        } catch (err) {
          this.log.error({ err, projectId: project_id }, 'automatic versioning failed');
        } finally {
          await sql`SELECT pg_advisory_unlock(hashtext(${key}))`.execute(conn);
        }
      });
    }
    return created;
  }
}

function defaultMessage(kind: VersionKind): string {
  switch (kind) {
    case 'initial':
      return 'Project created';
    case 'import':
      return 'Project imported';
    case 'restore':
      return 'Restored an earlier version';
    case 'git-pull':
      return 'Changes pulled from the remote repository';
    case 'named':
      return 'Saved version';
    default:
      return 'Automatic version';
  }
}
