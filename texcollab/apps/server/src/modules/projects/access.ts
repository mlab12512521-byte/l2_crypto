import { type ProjectRole, roleAtLeast } from '@texcollab/shared';
import type { Db } from '../../db/index.js';
import type { ProjectRow } from '../../db/schema.js';
import { forbidden, notFound } from '../../lib/errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProjectAccessGrant {
  project: ProjectRow;
  role: ProjectRole;
}

/**
 * The single authorization gate for project resources, used by every
 * project route and by the collaboration hub.
 *
 * - Non-members get 404 (the project's existence is not revealed).
 * - Members with an insufficient role get 403.
 * - Administrators get no implicit access to other people's projects.
 */
export class ProjectAccess {
  constructor(private readonly db: Db) {}

  async roleOf(projectId: string, userId: string): Promise<ProjectRole | null> {
    if (!UUID_RE.test(projectId)) return null;
    const row = await this.db
      .selectFrom('project_members')
      .select('role')
      .where('project_id', '=', projectId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row?.role ?? null;
  }

  async require(userId: string, projectId: string, minRole: ProjectRole): Promise<ProjectAccessGrant> {
    if (!UUID_RE.test(projectId)) throw notFound('Project not found');
    const row = await this.db
      .selectFrom('projects')
      .innerJoin('project_members', 'project_members.project_id', 'projects.id')
      .selectAll('projects')
      .select('project_members.role')
      .where('projects.id', '=', projectId)
      .where('project_members.user_id', '=', userId)
      .executeTakeFirst();
    if (!row) throw notFound('Project not found');
    const { role, ...project } = row;
    if (!roleAtLeast(role, minRole)) {
      throw forbidden(
        minRole === 'owner' ? 'Only the project owner can do this' : 'You have read-only access to this project',
      );
    }
    return { project, role };
  }
}
