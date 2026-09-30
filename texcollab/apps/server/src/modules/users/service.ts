import type { AdminUser, CurrentUser, PublicUser } from '@texcollab/shared';
import { sql } from 'kysely';
import type { Db } from '../../db/index.js';
import type { UserRow } from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { hashPassword } from '../auth/password.js';

export function toCurrentUser(u: UserRow): CurrentUser {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.display_name,
    authSource: u.auth_source,
    isAdmin: u.is_admin,
    mustChangePassword: u.must_change_password,
  };
}

export function toAdminUser(u: UserRow): AdminUser {
  return {
    ...toCurrentUser(u),
    isDisabled: u.is_disabled,
    lockedUntil: u.locked_until && u.locked_until > new Date() ? u.locked_until.toISOString() : null,
    createdAt: u.created_at.toISOString(),
    lastLoginAt: u.last_login_at ? u.last_login_at.toISOString() : null,
  };
}

export function toPublicUser(u: Pick<UserRow, 'id' | 'username' | 'display_name'>): PublicUser {
  return { id: u.id, username: u.username, displayName: u.display_name };
}

/** True if the error is a PostgreSQL unique-constraint violation. */
export function isUniqueViolation(err: unknown): err is { constraint?: string } {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

function uniqueViolationMessage(err: { constraint?: string }): string {
  if (err.constraint?.includes('email')) return 'A user with this e-mail address already exists';
  return 'A user with this username already exists';
}

export interface CreateLocalUserInput {
  username: string;
  email?: string | null;
  displayName: string;
  password: string;
  isAdmin?: boolean;
  mustChangePassword?: boolean;
}

export interface UpdateUserInput {
  displayName?: string;
  email?: string | null;
  isAdmin?: boolean;
  isDisabled?: boolean;
}

export class UserService {
  constructor(private readonly db: Db) {}

  findById(id: string): Promise<UserRow | undefined> {
    return this.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
  }

  findByUsername(username: string): Promise<UserRow | undefined> {
    return this.db.selectFrom('users').selectAll().where('username', '=', username).executeTakeFirst();
  }

  findByEmail(email: string): Promise<UserRow | undefined> {
    return this.db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
  }

  async count(): Promise<number> {
    const r = await this.db
      .selectFrom('users')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  async createLocalUser(input: CreateLocalUserInput): Promise<UserRow> {
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.db
        .insertInto('users')
        .values({
          username: input.username,
          email: input.email ?? null,
          display_name: input.displayName,
          auth_source: 'local',
          password_hash: passwordHash,
          is_admin: input.isAdmin ?? false,
          must_change_password: input.mustChangePassword ?? false,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(uniqueViolationMessage(err));
      throw err;
    }
  }

  async list(opts: { q?: string; limit: number; offset: number }): Promise<{ items: UserRow[]; total: number }> {
    let base = this.db.selectFrom('users');
    if (opts.q) {
      const pattern = `%${escapeLike(opts.q)}%`;
      base = base.where((eb) =>
        eb.or([eb('username', 'ilike', pattern), eb('display_name', 'ilike', pattern), eb('email', 'ilike', pattern)]),
      );
    }
    const [items, total] = await Promise.all([
      base.selectAll().orderBy('username').limit(opts.limit).offset(opts.offset).execute(),
      base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { items, total: Number(total.n) };
  }

  /**
   * Update profile/administrative flags. Refuses changes that would leave the
   * system without an enabled administrator.
   */
  async update(id: string, patch: UpdateUserInput): Promise<UserRow> {
    return this.db.transaction().execute(async (trx) => {
      // Serialise admin-status changes so two concurrent demotions cannot both pass the check.
      await sql`SELECT pg_advisory_xact_lock(${ADMIN_GUARD_LOCK})`.execute(trx);
      const user = await trx.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
      if (!user) throw notFound('User not found');
      const losesAdmin = user.is_admin && !user.is_disabled && (patch.isAdmin === false || patch.isDisabled === true);
      if (losesAdmin) {
        const r = await trx
          .selectFrom('users')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('is_admin', '=', true)
          .where('is_disabled', '=', false)
          .executeTakeFirstOrThrow();
        if (Number(r.n) <= 1) throw conflict('Cannot remove the last active administrator');
      }
      try {
        return await trx
          .updateTable('users')
          .set({
            ...(patch.displayName !== undefined ? { display_name: patch.displayName } : {}),
            ...(patch.email !== undefined ? { email: patch.email } : {}),
            ...(patch.isAdmin !== undefined ? { is_admin: patch.isAdmin } : {}),
            ...(patch.isDisabled !== undefined ? { is_disabled: patch.isDisabled } : {}),
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict(uniqueViolationMessage(err));
        throw err;
      }
    });
  }

  async setPassword(id: string, password: string, mustChange: boolean): Promise<void> {
    const user = await this.findById(id);
    if (!user) throw notFound('User not found');
    if (user.auth_source !== 'local') {
      throw badRequest('Passwords of directory (LDAP) accounts are managed by the directory');
    }
    await this.db
      .updateTable('users')
      .set({
        password_hash: await hashPassword(password),
        must_change_password: mustChange,
        failed_login_count: 0,
        locked_until: null,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
  }

  async unlock(id: string): Promise<void> {
    await this.db
      .updateTable('users')
      .set({ failed_login_count: 0, locked_until: null })
      .where('id', '=', id)
      .execute();
  }

  async delete(id: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(${ADMIN_GUARD_LOCK})`.execute(trx);
      const user = await trx.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
      if (!user) throw notFound('User not found');
      if (user.is_admin && !user.is_disabled) {
        const r = await trx
          .selectFrom('users')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('is_admin', '=', true)
          .where('is_disabled', '=', false)
          .executeTakeFirstOrThrow();
        if (Number(r.n) <= 1) throw conflict('Cannot delete the last active administrator');
      }
      await trx.deleteFrom('users').where('id', '=', id).execute();
    });
  }
}

const ADMIN_GUARD_LOCK = 7_431_902_201;

/** Escape LIKE wildcards in user-provided search text. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
