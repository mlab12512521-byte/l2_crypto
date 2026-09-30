import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import type { UserRow } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { UserService } from '../users/service.js';
import { verifyDummy, verifyPassword } from './password.js';
import type { SessionStore } from './sessions.js';

/**
 * Identity returned by an external directory after a successful bind.
 * Implemented by the LDAP module.
 */
export interface ExternalIdentity {
  username: string;
  dn: string;
  displayName: string;
  email: string | null;
  isAdmin?: boolean;
}

export interface ExternalAuthenticator {
  /** Whether the directory is configured and enabled right now. */
  isEnabled(): Promise<boolean>;
  /**
   * Verify credentials against the directory. Returns null for invalid
   * credentials or an unknown user; throws only for infrastructure errors.
   */
  authenticate(username: string, password: string): Promise<ExternalIdentity | null>;
  /** Create or update the local shadow account for a directory identity. */
  provision(identity: ExternalIdentity): Promise<UserRow>;
}

export interface LoginContext {
  ip: string | null;
  userAgent: string | null;
}

export const INVALID_CREDENTIALS = 'Invalid username or password';

export class AuthService {
  private external: ExternalAuthenticator | undefined;

  constructor(
    private readonly db: Db,
    private readonly users: UserService,
    private readonly sessions: SessionStore,
    private readonly log: Logger,
    private readonly policy: { maxFailures: number; lockoutMs: number },
  ) {}

  setExternalAuthenticator(auth: ExternalAuthenticator): void {
    this.external = auth;
  }

  /**
   * Authenticate and create a session. All credential failures produce the
   * same message; details go to the audit log only.
   */
  async login(
    username: string,
    password: string,
    ctx: LoginContext,
  ): Promise<{ user: UserRow; token: string; csrfToken: string; expiresAt: Date }> {
    const user = await this.authenticate(username, password, ctx);
    await this.db
      .updateTable('users')
      .set({ failed_login_count: 0, locked_until: null, last_login_at: new Date() })
      .where('id', '=', user.id)
      .execute();
    const session = await this.sessions.create(user.id, ctx);
    await audit(this.db, { actorId: user.id, action: 'auth.login', ip: ctx.ip, details: { source: user.auth_source } });
    return { user, ...session };
  }

  private async authenticate(username: string, password: string, ctx: LoginContext): Promise<UserRow> {
    const fail = async (reason: string, userId: string | null): Promise<never> => {
      await audit(this.db, {
        actorId: userId,
        action: 'auth.login_failed',
        ip: ctx.ip,
        details: { username: username.slice(0, 64), reason },
      });
      throw new AppError(401, 'invalid_credentials', INVALID_CREDENTIALS);
    };

    if (!password) return fail('empty_password', null);

    const existing = await this.users.findByUsername(username);

    if (existing?.locked_until && existing.locked_until > new Date()) {
      await verifyDummy(password);
      return fail('locked', existing.id);
    }

    if (existing?.auth_source === 'local') {
      const ok = await verifyPassword(existing.password_hash ?? '', password);
      if (!ok) {
        await this.recordFailure(existing);
        return fail('bad_password', existing.id);
      }
      if (existing.is_disabled) return this.disabled(existing, ctx);
      return existing;
    }

    // Directory users (existing or not yet provisioned).
    const external = this.external;
    if (external && (await external.isEnabled())) {
      let identity: ExternalIdentity | null;
      try {
        identity = await external.authenticate(username, password);
      } catch (err) {
        this.log.error({ err }, 'directory authentication error');
        throw new AppError(503, 'directory_unavailable', 'The directory service is unavailable; try again later');
      }
      if (!identity) {
        if (existing) await this.recordFailure(existing);
        return fail('directory_rejected', existing?.id ?? null);
      }
      if (existing?.is_disabled) return this.disabled(existing, ctx);
      return external.provision(identity);
    }

    if (existing) {
      // LDAP user while the directory is disabled.
      await verifyDummy(password);
      return fail('directory_disabled', existing.id);
    }
    await verifyDummy(password);
    return fail('unknown_user', null);
  }

  private async disabled(user: UserRow, ctx: LoginContext): Promise<never> {
    // Only reached with correct credentials, so telling the user is not an information leak.
    await audit(this.db, { actorId: user.id, action: 'auth.login_disabled', ip: ctx.ip });
    throw new AppError(403, 'account_disabled', 'This account has been disabled. Contact an administrator.');
  }

  private async recordFailure(user: UserRow): Promise<void> {
    const failures = user.failed_login_count + 1;
    const lock = failures >= this.policy.maxFailures;
    await this.db
      .updateTable('users')
      .set({
        failed_login_count: lock ? 0 : failures,
        locked_until: lock ? new Date(Date.now() + this.policy.lockoutMs) : user.locked_until,
      })
      .where('id', '=', user.id)
      .execute();
    if (lock) this.log.warn({ userId: user.id }, 'account temporarily locked after repeated login failures');
  }
}
