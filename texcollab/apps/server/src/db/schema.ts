import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * TypeScript view of the database schema (see /migrations). Keep in sync
 * with the SQL migrations; integration tests exercise every table.
 */

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export interface UsersTable {
  id: Generated<string>;
  username: string;
  email: string | null;
  display_name: string;
  auth_source: 'local' | 'ldap';
  password_hash: string | null;
  ldap_dn: string | null;
  is_admin: Generated<boolean>;
  is_disabled: Generated<boolean>;
  must_change_password: Generated<boolean>;
  failed_login_count: Generated<number>;
  locked_until: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  last_login_at: NullableTimestamp;
}

export interface SessionsTable {
  id: Buffer;
  user_id: string;
  csrf_token: string;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  expires_at: Timestamp;
  idle_expires_at: Timestamp;
  ip: string | null;
  user_agent: string | null;
}

export interface SystemSettingsTable {
  key: string;
  value: ColumnType<unknown, string, string>;
  updated_at: Generated<Date>;
  updated_by: string | null;
}

export interface AuditLogTable {
  id: Generated<string>;
  at: Generated<Date>;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  details: ColumnType<Record<string, unknown>, string | undefined, string>;
}

export type ProjectRoleColumn = 'owner' | 'editor' | 'viewer';

export interface ProjectsTable {
  id: Generated<string>;
  name: string;
  main_file_id: string | null;
  compiler: Generated<'pdflatex' | 'xelatex' | 'lualatex'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  last_modified_at: Generated<Date>;
  last_modified_by: string | null;
}

export interface ProjectMembersTable {
  project_id: string;
  user_id: string;
  role: ProjectRoleColumn;
  added_by: string | null;
  created_at: Generated<Date>;
}

export interface ProjectUserStateTable {
  project_id: string;
  user_id: string;
  last_opened_at: Generated<Date>;
}

export interface BlobsTable {
  hash: string;
  size: ColumnType<number, number, number>;
  created_at: Generated<Date>;
}

export interface ProjectEntitiesTable {
  id: Generated<string>;
  project_id: string;
  parent_id: string | null;
  kind: 'folder' | 'doc' | 'file';
  name: string;
  blob_hash: string | null;
  size: ColumnType<number, number | undefined, number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  created_by: string | null;
}

export interface DocContentsTable {
  entity_id: string;
  yjs_state: Buffer | null;
  text: string;
  content_hash: string;
  updated_at: Generated<Date>;
  updated_by: string | null;
}

export interface CompileBuildsTable {
  id: Generated<string>;
  project_id: string;
  requested_by: string | null;
  engine: 'pdflatex' | 'xelatex' | 'lualatex';
  main_file: string;
  status: 'running' | 'success' | 'failure' | 'timeout' | 'error';
  started_at: Generated<Date>;
  finished_at: NullableTimestamp;
  duration_ms: number | null;
  output_files: ColumnType<unknown, string | undefined, string>;
  diagnostics: ColumnType<unknown, string | undefined, string>;
  message: string | null;
}

export interface ProjectChangesTable {
  project_id: string;
  user_id: string;
  first_change_at: Generated<Date>;
  last_change_at: Generated<Date>;
}

export interface ProjectInvitationsTable {
  id: Generated<string>;
  project_id: string;
  email: string;
  role: 'editor' | 'viewer';
  invited_by: string | null;
  created_at: Generated<Date>;
  expires_at: Timestamp;
}

export type VersionKind = 'auto' | 'named' | 'restore' | 'import' | 'git-pull' | 'initial';

export interface VersionsTable {
  id: Generated<string>;
  project_id: string;
  commit_sha: string;
  kind: VersionKind;
  label: string | null;
  created_at: Generated<Date>;
  created_by: string | null;
  contributors: ColumnType<string[], string[] | undefined, string[]>;
}

export interface GitRemotesTable {
  project_id: string;
  url: string;
  branch: Generated<string>;
  username: string | null;
  secret_encrypted: Buffer | null;
  updated_by: string | null;
  updated_at: Generated<Date>;
  last_push_at: NullableTimestamp;
  last_pull_at: NullableTimestamp;
  last_error: string | null;
}

export interface Database {
  versions: VersionsTable;
  git_remotes: GitRemotesTable;
  project_invitations: ProjectInvitationsTable;
  project_changes: ProjectChangesTable;
  compile_builds: CompileBuildsTable;
  users: UsersTable;
  sessions: SessionsTable;
  system_settings: SystemSettingsTable;
  audit_log: AuditLogTable;
  projects: ProjectsTable;
  project_members: ProjectMembersTable;
  project_user_state: ProjectUserStateTable;
  blobs: BlobsTable;
  project_entities: ProjectEntitiesTable;
  doc_contents: DocContentsTable;
}

export type ProjectRow = Selectable<ProjectsTable>;
export type EntityRow = Selectable<ProjectEntitiesTable>;

export type UserRow = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
export type SessionRow = Selectable<SessionsTable>;
