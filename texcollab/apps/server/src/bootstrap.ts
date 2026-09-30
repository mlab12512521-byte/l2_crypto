import type { AppContext } from './context.js';
import { audit } from './lib/audit.js';

/**
 * Create the initial administrator from INITIAL_ADMIN_* variables, but only
 * when there are no users at all. The account must change its password at
 * first login, so the value in the environment file stops being valid.
 */
export async function ensureInitialAdmin(ctx: AppContext): Promise<void> {
  const cfg = ctx.config.initialAdmin;
  if (!cfg) return;
  if ((await ctx.users.count()) > 0) return;
  const user = await ctx.users.createLocalUser({
    username: cfg.username,
    email: cfg.email ?? null,
    displayName: cfg.username,
    password: cfg.password,
    isAdmin: true,
    mustChangePassword: true,
  });
  await audit(ctx.db, { actorId: null, action: 'bootstrap.admin_created', targetType: 'user', targetId: user.id });
  ctx.log.info({ username: user.username }, 'created initial administrator (password change required at first login)');
}
