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

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  system_settings: SystemSettingsTable;
  audit_log: AuditLogTable;
}

export type UserRow = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
export type SessionRow = Selectable<SessionsTable>;
