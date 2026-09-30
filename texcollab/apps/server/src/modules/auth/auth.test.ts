import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../../lib/crypto.js';
import {
  type Client,
  createTestEnv,
  createUser,
  login,
  PUBLIC_URL,
  request,
  STRONG_PASSWORD,
  sessionCookieFrom,
  type TestEnv,
} from '../../test/helpers.js';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({ LOGIN_MAX_FAILURES: '3', AUTH_RATE_LIMIT_PER_MINUTE: '1000' });
});
afterAll(async () => {
  await env.close();
});

describe('login', () => {
  it('logs in with valid credentials and sets a hardened session cookie', async () => {
    const { username } = await createUser(env.ctx);
    const res = await request(env.app, null, 'POST', '/api/auth/login', {
      payload: { username, password: STRONG_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.username).toBe(username);
    expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(body.user).not.toHaveProperty('passwordHash');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });

  it('accepts the username case-insensitively', async () => {
    const { username } = await createUser(env.ctx);
    const client = await login(env.app, username.toUpperCase(), STRONG_PASSWORD);
    expect(client.me.user.username).toBe(username);
  });

  it('stores only a hash of the session token', async () => {
    const { username } = await createUser(env.ctx);
    const client = await login(env.app, username, STRONG_PASSWORD);
    const token = decodeURIComponent(client.cookie.split('=')[1]!);
    const rows = await env.ctx.db.selectFrom('sessions').select('id').execute();
    const ids = rows.map((r) => r.id.toString('hex'));
    expect(ids).toContain(sha256(token).toString('hex'));
    expect(ids).not.toContain(Buffer.from(token).toString('hex'));
  });

  it('returns the same generic error for unknown users and wrong passwords', async () => {
    const { username } = await createUser(env.ctx);
    const wrong = await request(env.app, null, 'POST', '/api/auth/login', {
      payload: { username, password: 'not the password' },
    });
    const unknown = await request(env.app, null, 'POST', '/api/auth/login', {
      payload: { username: 'nobody-here', password: 'whatever-password' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error).toEqual(unknown.json().error);
  });

  it('rejects malformed bodies with 400', async () => {
    const res = await request(env.app, null, 'POST', '/api/auth/login', { payload: { username: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('locks the account after repeated failures, even for the right password', async () => {
    const { username, user } = await createUser(env.ctx);
    for (let i = 0; i < 3; i++) {
      const r = await request(env.app, null, 'POST', '/api/auth/login', {
        payload: { username, password: 'wrong-password' },
      });
      expect(r.statusCode).toBe(401);
    }
    const locked = await request(env.app, null, 'POST', '/api/auth/login', {
      payload: { username, password: STRONG_PASSWORD },
    });
    expect(locked.statusCode).toBe(401);
    await env.ctx.users.unlock(user.id);
    await expect(login(env.app, username, STRONG_PASSWORD)).resolves.toBeTruthy();
  });

  it('writes audit entries for successful and failed logins without secrets', async () => {
    const { username, user } = await createUser(env.ctx);
    await request(env.app, null, 'POST', '/api/auth/login', { payload: { username, password: 'bad-password-1' } });
    await login(env.app, username, STRONG_PASSWORD);
    const rows = await env.ctx.db.selectFrom('audit_log').selectAll().where('actor_id', '=', user.id).execute();
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('auth.login_failed');
    expect(actions).toContain('auth.login');
    expect(JSON.stringify(rows)).not.toContain('bad-password-1');
  });

  it('refuses disabled users and says so only after correct credentials', async () => {
    const { username, user } = await createUser(env.ctx);
    await env.ctx.db.updateTable('users').set({ is_disabled: true }).where('id', '=', user.id).execute();
    const right = await request(env.app, null, 'POST', '/api/auth/login', {
      payload: { username, password: STRONG_PASSWORD },
    });
    expect(right.statusCode).toBe(403);
    expect(right.json().error.code).toBe('account_disabled');
    const wrong = await request(env.app, null, 'POST', '/api/auth/login', {
      payload: { username, password: 'wrong-password' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('discards a pre-existing session on login (session fixation)', async () => {
    const { username } = await createUser(env.ctx);
    const first = await login(env.app, username, STRONG_PASSWORD);
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { cookie: first.cookie, 'x-csrf-token': first.csrf, origin: PUBLIC_URL },
      payload: { username, password: STRONG_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(sessionCookieFrom(res)).not.toBe(first.cookie);
    const old = await request(env.app, first, 'GET', '/api/auth/me');
    expect(old.statusCode).toBe(401);
  });
});

describe('session lifecycle', () => {
  let client: Client;
  beforeAll(async () => {
    const { username } = await createUser(env.ctx);
    client = await login(env.app, username, STRONG_PASSWORD);
  });

  it('GET /me returns the user and CSRF token', async () => {
    const res = await request(env.app, client, 'GET', '/api/auth/me');
    expect(res.statusCode).toBe(200);
    expect(res.json().csrfToken).toBe(client.csrf);
  });

  it('GET /me without a session is 401', async () => {
    const res = await request(env.app, null, 'GET', '/api/auth/me');
    expect(res.statusCode).toBe(401);
  });

  it('rejects forged or garbage cookies', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: 'texcollab_session=forged-token-value' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('expires sessions after the idle timeout', async () => {
    const { username } = await createUser(env.ctx);
    const c = await login(env.app, username, STRONG_PASSWORD);
    const token = decodeURIComponent(c.cookie.split('=')[1]!);
    await env.ctx.db
      .updateTable('sessions')
      .set({ idle_expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', sha256(token))
      .execute();
    const res = await request(env.app, c, 'GET', '/api/auth/me');
    expect(res.statusCode).toBe(401);
    // The expired session row is removed.
    const row = await env.ctx.db.selectFrom('sessions').select('id').where('id', '=', sha256(token)).executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it('logout revokes the session server-side', async () => {
    const { username } = await createUser(env.ctx);
    const c = await login(env.app, username, STRONG_PASSWORD);
    const out = await request(env.app, c, 'POST', '/api/auth/logout');
    expect(out.statusCode).toBe(200);
    const after = await request(env.app, c, 'GET', '/api/auth/me');
    expect(after.statusCode).toBe(401);
  });
});

describe('password change', () => {
  it('requires the current password and revokes other sessions', async () => {
    const { username } = await createUser(env.ctx);
    const a = await login(env.app, username, STRONG_PASSWORD);
    const b = await login(env.app, username, STRONG_PASSWORD);

    const bad = await request(env.app, a, 'POST', '/api/auth/password', {
      payload: { currentPassword: 'wrong', newPassword: 'another strong passphrase' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_current_password');

    const ok = await request(env.app, a, 'POST', '/api/auth/password', {
      payload: { currentPassword: STRONG_PASSWORD, newPassword: 'another strong passphrase' },
    });
    expect(ok.statusCode).toBe(200);
    expect((await request(env.app, a, 'GET', '/api/auth/me')).statusCode).toBe(200);
    expect((await request(env.app, b, 'GET', '/api/auth/me')).statusCode).toBe(401);
    await expect(login(env.app, username, 'another strong passphrase')).resolves.toBeTruthy();
    await expect(login(env.app, username, STRONG_PASSWORD)).rejects.toThrow();
  });

  it('enforces the password policy', async () => {
    const { username } = await createUser(env.ctx);
    const c = await login(env.app, username, STRONG_PASSWORD);
    const short = await request(env.app, c, 'POST', '/api/auth/password', {
      payload: { currentPassword: STRONG_PASSWORD, newPassword: 'short' },
    });
    expect(short.statusCode).toBe(400);
    const containsName = await request(env.app, c, 'POST', '/api/auth/password', {
      payload: { currentPassword: STRONG_PASSWORD, newPassword: `${username}-password-123` },
    });
    expect(containsName.statusCode).toBe(400);
  });

  it('blocks other API use until a forced password change is done', async () => {
    const { username } = await createUser(env.ctx, { isAdmin: true, mustChangePassword: true });
    const c = await login(env.app, username, STRONG_PASSWORD);
    expect(c.me.user.mustChangePassword).toBe(true);
    const blocked = await request(env.app, c, 'GET', '/api/admin/users');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('password_change_required');
    await request(env.app, c, 'POST', '/api/auth/password', {
      payload: { currentPassword: STRONG_PASSWORD, newPassword: 'a brand new passphrase' },
    });
    const allowed = await request(env.app, c, 'GET', '/api/admin/users');
    expect(allowed.statusCode).toBe(200);
  });
});

describe('registration', () => {
  it('is disabled by default', async () => {
    const res = await request(env.app, null, 'POST', '/api/auth/register', {
      payload: { username: 'newbie', displayName: 'Newbie', password: STRONG_PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    const cfg = await request(env.app, null, 'GET', '/api/auth/config');
    expect(cfg.json()).toEqual({ registrationEnabled: false });
  });

  it('works when enabled by an administrator and rejects duplicates', async () => {
    await env.ctx.settings.set('registration', { enabled: true }, null);
    const res = await request(env.app, null, 'POST', '/api/auth/register', {
      payload: { username: 'newbie', displayName: 'Newbie', password: STRONG_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.isAdmin).toBe(false);
    const dup = await request(env.app, null, 'POST', '/api/auth/register', {
      payload: { username: 'NEWBIE', displayName: 'Other', password: STRONG_PASSWORD },
    });
    expect(dup.statusCode).toBe(409);
    await env.ctx.settings.set('registration', { enabled: false }, null);
  });
});
