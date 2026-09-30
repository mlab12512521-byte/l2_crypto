import type { MembersResponse, ProjectRole, PublicUser } from '@texcollab/shared';
import { sql } from 'kysely';
import type { Db } from '../../db/index.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { escapeLike, isUniqueViolation, toPublicUser } from '../users/service.js';

const INVITATION_DAYS = 30;

export type ShareRole = 'editor' | 'viewer';

/** Callbacks so live collaboration can react to membership changes. */
export interface SharingHooks {
  /** A user's access to a project changed (removed or role changed): drop and re-authorise their connections. */
  accessChanged(projectId: string, userId: string): void;
  /** Members changed; tell everyone in the project to refresh. */
  membersChanged(projectId: string): void;
}

/**
 * Project membership: sharing with existing users, e-mail invitations for
 * people without an account, role changes and ownership transfer. Every
 * method expects the caller to have checked the actor's role with
 * ProjectAccess; the invariants (exactly one owner, owner cannot be demoted
 * or removed) are enforced here and by the database.
 */
export class SharingService {
  private hooks: SharingHooks | null = null;

  constructor(private readonly db: Db) {}

  setHooks(hooks: SharingHooks): void {
    this.hooks = hooks;
  }

  async list(projectId: string, includeInvitations: boolean): Promise<MembersResponse> {
    const rows = await this.db
      .selectFrom('project_members as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['u.id', 'u.username', 'u.display_name', 'm.role', 'm.created_at'])
      .where('m.project_id', '=', projectId)
      .orderBy(sql`CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END`)
      .orderBy('u.display_name')
      .execute();
    const members = rows.map((r) => ({
      user: toPublicUser(r),
      role: r.role,
      addedAt: r.created_at.toISOString(),
    }));
    if (!includeInvitations) return { members, invitations: [] };
    const inv = await this.db
      .selectFrom('project_invitations as i')
      .leftJoin('users as u', 'u.id', 'i.invited_by')
      .select([
        'i.id',
        'i.email',
        'i.role',
        'i.created_at',
        'i.expires_at',
        'u.id as by_id',
        'u.username as by_username',
        'u.display_name as by_name',
      ])
      .where('i.project_id', '=', projectId)
      .where('i.expires_at', '>', new Date())
      .orderBy('i.created_at')
      .execute();
    return {
      members,
      invitations: inv.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        invitedBy: i.by_id ? { id: i.by_id, username: i.by_username!, displayName: i.by_name! } : null,
        createdAt: i.created_at.toISOString(),
        expiresAt: i.expires_at.toISOString(),
      })),
    };
  }

  /**
   * Share with an existing user (by id, username or e-mail) or, if the
   * identifier is an e-mail address without an account, create an invitation.
   */
  async share(
    projectId: string,
    actorId: string,
    target: { userId?: string; identifier?: string },
    role: ShareRole,
    ip: string | null,
  ): Promise<{ kind: 'member'; user: PublicUser } | { kind: 'invitation'; email: string }> {
    let user: { id: string; username: string; display_name: string; is_disabled: boolean } | undefined;
    const identifier = target.identifier?.trim();
    if (target.userId) {
      user = await this.db
        .selectFrom('users')
        .select(['id', 'username', 'display_name', 'is_disabled'])
        .where('id', '=', target.userId)
        .executeTakeFirst();
      if (!user) throw notFound('User not found');
    } else if (identifier) {
      user = await this.db
        .selectFrom('users')
        .select(['id', 'username', 'display_name', 'is_disabled'])
        .where((eb) => eb.or([eb('username', '=', identifier), eb('email', '=', identifier)]))
        .executeTakeFirst();
    } else {
      throw badRequest('Choose a user or enter an e-mail address');
    }

    if (!user) {
      // Unknown identifier: only e-mail addresses can be invited.
      if (!identifier || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(identifier) || identifier.length > 254) {
        throw notFound(
          'No user with this username or e-mail address. Enter an e-mail address to invite someone without an account.',
        );
      }
      try {
        await this.db
          .insertInto('project_invitations')
          .values({
            project_id: projectId,
            email: identifier,
            role,
            invited_by: actorId,
            expires_at: new Date(Date.now() + INVITATION_DAYS * 86_400_000),
          })
          .execute();
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('This e-mail address has already been invited');
        throw err;
      }
      await audit(this.db, {
        actorId,
        action: 'project.invitation_created',
        targetType: 'project',
        targetId: projectId,
        ip,
        details: { role },
      });
      this.hooks?.membersChanged(projectId);
      return { kind: 'invitation', email: identifier };
    }

    if (user.is_disabled) throw badRequest('This account is disabled');
    try {
      await this.db
        .insertInto('project_members')
        .values({ project_id: projectId, user_id: user.id, role, added_by: actorId })
        .execute();
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`${user.display_name} already has access to this project`);
      throw err;
    }
    await audit(this.db, {
      actorId,
      action: 'project.member_added',
      targetType: 'project',
      targetId: projectId,
      ip,
      details: { userId: user.id, role },
    });
    this.hooks?.membersChanged(projectId);
    return { kind: 'member', user: toPublicUser(user) };
  }

  async changeRole(
    projectId: string,
    actorId: string,
    userId: string,
    role: ShareRole,
    ip: string | null,
  ): Promise<void> {
    const member = await this.member(projectId, userId);
    if (member.role === 'owner') throw badRequest('Transfer ownership to change the owner’s role');
    if (member.role === role) return;
    await this.db
      .updateTable('project_members')
      .set({ role })
      .where('project_id', '=', projectId)
      .where('user_id', '=', userId)
      .execute();
    await audit(this.db, {
      actorId,
      action: 'project.member_role_changed',
      targetType: 'project',
      targetId: projectId,
      ip,
      details: { userId, from: member.role, to: role },
    });
    this.hooks?.accessChanged(projectId, userId);
    this.hooks?.membersChanged(projectId);
  }

  /** Remove a member. Owners remove others; any member may remove themselves (leave). */
  async remove(
    projectId: string,
    actor: { id: string; role: ProjectRole },
    userId: string,
    ip: string | null,
  ): Promise<void> {
    const member = await this.member(projectId, userId);
    if (member.role === 'owner')
      throw badRequest('The owner cannot be removed. Transfer ownership or delete the project.');
    if (actor.role !== 'owner' && actor.id !== userId)
      throw forbidden('Only the project owner can remove other members');
    await this.db
      .deleteFrom('project_members')
      .where('project_id', '=', projectId)
      .where('user_id', '=', userId)
      .execute();
    await this.db
      .deleteFrom('project_user_state')
      .where('project_id', '=', projectId)
      .where('user_id', '=', userId)
      .execute();
    await audit(this.db, {
      actorId: actor.id,
      action: actor.id === userId ? 'project.member_left' : 'project.member_removed',
      targetType: 'project',
      targetId: projectId,
      ip,
      details: { userId },
    });
    this.hooks?.accessChanged(projectId, userId);
    this.hooks?.membersChanged(projectId);
  }

  /** Make another member the owner; the previous owner becomes an editor. */
  async transferOwnership(projectId: string, ownerId: string, newOwnerId: string, ip: string | null): Promise<void> {
    if (ownerId === newOwnerId) throw badRequest('You already own this project');
    const target = await this.member(projectId, newOwnerId);
    const user = await this.db
      .selectFrom('users')
      .select('is_disabled')
      .where('id', '=', newOwnerId)
      .executeTakeFirstOrThrow();
    if (user.is_disabled) throw badRequest('This account is disabled');
    await this.db.transaction().execute(async (trx) => {
      // Order matters: the partial unique index allows only one owner at a time.
      await trx
        .updateTable('project_members')
        .set({ role: 'editor' })
        .where('project_id', '=', projectId)
        .where('user_id', '=', ownerId)
        .execute();
      await trx
        .updateTable('project_members')
        .set({ role: 'owner' })
        .where('project_id', '=', projectId)
        .where('user_id', '=', newOwnerId)
        .execute();
    });
    await audit(this.db, {
      actorId: ownerId,
      action: 'project.ownership_transferred',
      targetType: 'project',
      targetId: projectId,
      ip,
      details: { from: ownerId, to: newOwnerId, previousRole: target.role },
    });
    this.hooks?.accessChanged(projectId, ownerId);
    this.hooks?.accessChanged(projectId, newOwnerId);
    this.hooks?.membersChanged(projectId);
  }

  async cancelInvitation(projectId: string, actorId: string, invitationId: string, ip: string | null): Promise<void> {
    const res = await this.db
      .deleteFrom('project_invitations')
      .where('id', '=', invitationId)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) throw notFound('Invitation not found');
    await audit(this.db, {
      actorId,
      action: 'project.invitation_cancelled',
      targetType: 'project',
      targetId: projectId,
      ip,
    });
    this.hooks?.membersChanged(projectId);
  }

  /**
   * Turn pending, unexpired invitations for this user's e-mail address into
   * memberships. Called after sign-in and when accounts are created.
   */
  async claimInvitations(user: { id: string; email: string | null }): Promise<number> {
    if (!user.email) return 0;
    const pending = await this.db
      .selectFrom('project_invitations')
      .selectAll()
      .where('email', '=', user.email)
      .where('expires_at', '>', new Date())
      .execute();
    let claimed = 0;
    for (const inv of pending) {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('project_members')
          .values({ project_id: inv.project_id, user_id: user.id, role: inv.role, added_by: inv.invited_by })
          .onConflict((oc) => oc.columns(['project_id', 'user_id']).doNothing())
          .execute();
        await trx.deleteFrom('project_invitations').where('id', '=', inv.id).execute();
      });
      await audit(this.db, {
        actorId: user.id,
        action: 'project.invitation_claimed',
        targetType: 'project',
        targetId: inv.project_id,
      });
      this.hooks?.membersChanged(inv.project_id);
      claimed++;
    }
    return claimed;
  }

  /** People a user can share with: enabled accounts matching the query (never returns e-mail addresses). */
  async searchUsers(query: string, excludeUserId: string): Promise<PublicUser[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const pattern = `%${escapeLike(q)}%`;
    const rows = await this.db
      .selectFrom('users')
      .select(['id', 'username', 'display_name'])
      .where('is_disabled', '=', false)
      .where('id', '!=', excludeUserId)
      .where((eb) =>
        eb.or([eb('username', 'ilike', pattern), eb('display_name', 'ilike', pattern), eb('email', '=', q)]),
      )
      .orderBy('display_name')
      .limit(10)
      .execute();
    return rows.map(toPublicUser);
  }

  private async member(projectId: string, userId: string) {
    const m = await this.db
      .selectFrom('project_members')
      .select(['role'])
      .where('project_id', '=', projectId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!m) throw notFound('This person is not a member of the project');
    return m;
  }
}
