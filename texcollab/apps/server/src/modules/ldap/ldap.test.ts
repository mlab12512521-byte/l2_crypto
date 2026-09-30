import {
  CSRF_HEADER,
  type LdapSettings,
  type LdapSettingsView,
  type LdapTestResult,
  type MembersResponse,
} from '@texcollab/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Client,
  createProject,
  createTestEnv,
  createUser,
  login,
  PUBLIC_URL,
  request,
  STRONG_PASSWORD,
  type TestEnv,
} from '../../test/helpers.js';
import { ldapImageAvailable, TestLdapServer } from '../../test/ldap-server.js';

const d = ldapImageAvailable() ? describe : describe.skip;

d('LDAP directory (OpenLDAP container)', () => {
  const server = new TestLdapServer();
  let env: TestEnv;
  let admin: Client;
  let settings: Partial<LdapSettings>;

  const put = (s: Partial<LdapSettings>, bindPassword?: string | null) =>
    request(env.app, admin, 'PUT', '/api/admin/ldap', {
      payload: { settings: s, ...(bindPassword !== undefined ? { bindPassword } : {}) },
    });
  const tryLogin = (username: string, password: string) =>
    env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { [CSRF_HEADER]: '1', origin: PUBLIC_URL },
      payload: { username, password },
    });
  const user = (username: string) =>
    env.ctx.db.selectFrom('users').selectAll().where('username', '=', username).executeTakeFirst();

  beforeAll(async () => {
    await server.start();
    env = await createTestEnv({ AUTH_RATE_LIMIT_PER_MINUTE: '1000' });
    const a = await createUser(env.ctx, { isAdmin: true });
    admin = await login(env.app, a.username, STRONG_PASSWORD);
    settings = {
      enabled: true,
      url: `ldaps://localhost:${server.ldapsPort}`,
      caCertificate: server.caCertificate,
      bindDn: 'cn=reader,dc=example,dc=org',
      userSearchBase: 'ou=people,dc=example,dc=org',
      requiredGroupDn: 'cn=texcollab-users,ou=groups,dc=example,dc=org',
      adminGroupDn: 'cn=texcollab-admins,ou=groups,dc=example,dc=org',
    };
    const res = await put(settings, 'reader-secret');
    if (res.statusCode !== 200) throw new Error(res.body);
  }, 120_000);

  afterAll(async () => {
    await env?.close();
    server.stop();
  });

  describe('configuration API', () => {
    it('never returns or stores the bind password in clear text', async () => {
      const res = await request(env.app, admin, 'GET', '/api/admin/ldap');
      expect(res.json<LdapSettingsView>()).toMatchObject({
        enabled: true,
        hasBindPassword: true,
        bindDn: 'cn=reader,dc=example,dc=org',
      });
      expect(res.body).not.toContain('reader-secret');
      const row = await env.ctx.db
        .selectFrom('system_settings')
        .select('value')
        .where('key', '=', 'ldap')
        .executeTakeFirstOrThrow();
      expect(JSON.stringify(row.value)).not.toContain('reader-secret');
      // Not reachable through the generic settings API either.
      expect((await request(env.app, admin, 'GET', '/api/admin/settings/ldap')).statusCode).toBe(404);
    });

    it('keeps the stored password for the same server, but requires it again for another server', async () => {
      expect((await put({ ...settings, timeoutSeconds: 5 })).statusCode).toBe(200);
      expect((await request(env.app, admin, 'GET', '/api/admin/ldap')).json().hasBindPassword).toBe(true);
      const moved = await put({ ...settings, url: 'ldaps://attacker.example.net' });
      expect(moved.statusCode).toBe(400);
      expect(moved.json().error.message).toMatch(/bind password again/);
      const test = await request(env.app, admin, 'POST', '/api/admin/ldap/test', {
        payload: { settings: { ...settings, bindDn: 'cn=admin,dc=example,dc=org' } },
      });
      expect(test.statusCode).toBe(400);
    });

    it('is for administrators only', async () => {
      const u = await createUser(env.ctx);
      const c = await login(env.app, u.username, STRONG_PASSWORD);
      expect((await request(env.app, c, 'GET', '/api/admin/ldap')).statusCode).toBe(403);
      expect((await request(env.app, c, 'POST', '/api/admin/ldap/test', { payload: { settings } })).statusCode).toBe(
        403,
      );
    });
  });

  describe('sign-in', () => {
    it('provisions a directory user on first sign-in and claims invitations', async () => {
      const owner = await createUser(env.ctx);
      const oc = await login(env.app, owner.username, STRONG_PASSWORD);
      const p = await createProject(env.app, oc, 'Invited');
      await request(env.app, oc, 'POST', `/api/projects/${p.id}/members`, {
        payload: { identifier: 'bob@example.org', role: 'editor' },
      });

      const res = await tryLogin('bob', 'bob-password');
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({
        username: 'bob',
        displayName: 'Bob Builder',
        email: 'bob@example.org',
        authSource: 'ldap',
        isAdmin: false,
      });
      const row = await user('bob');
      expect(row).toMatchObject({
        auth_source: 'ldap',
        password_hash: null,
        ldap_dn: 'uid=bob,ou=people,dc=example,dc=org',
      });
      const members = (await request(env.app, oc, 'GET', `/api/projects/${p.id}/members`)).json<MembersResponse>();
      expect(members.members.map((m) => m.user.username)).toContain('bob');
    });

    it('grants and revokes administrator rights from the admin group', async () => {
      const res = await tryLogin('alice', 'alice-password');
      expect(res.statusCode).toBe(200);
      expect(res.json().user.isAdmin).toBe(true);
      await env.ctx.db.updateTable('users').set({ is_admin: true }).where('username', '=', 'bob').execute();
      await tryLogin('bob', 'bob-password');
      expect((await user('bob'))!.is_admin).toBe(false);
      const actions = await env.ctx.db
        .selectFrom('audit_log')
        .select('action')
        .where('action', 'like', 'user.admin_%')
        .execute();
      expect(actions.map((a) => a.action)).toContain('user.admin_revoked');
    });

    it('never removes the last active administrator', async () => {
      await env.ctx.db.updateTable('users').set({ is_admin: false }).where('is_admin', '=', true).execute();
      await env.ctx.db.updateTable('users').set({ is_admin: true }).where('username', '=', 'bob').execute();
      try {
        expect((await tryLogin('bob', 'bob-password')).statusCode).toBe(200);
        expect((await user('bob'))!.is_admin).toBe(true);
      } finally {
        await env.ctx.db.updateTable('users').set({ is_admin: true }).where('id', '=', admin.me.user.id).execute();
      }
      await tryLogin('bob', 'bob-password');
      expect((await user('bob'))!.is_admin).toBe(false);
    });

    it.each([
      ['wrong password', 'alice', 'nope'],
      ['unknown user', 'mallory', 'x'],
      ['not in the required group', 'carol', 'carol-password'],
      ['filter injection', '*', 'alice-password'],
      ['filter injection 2', 'alice)(uid=*', 'alice-password'],
      ['ambiguous match', 'dup', 'dup-password'],
      ['empty password (unauthenticated bind)', 'alice', ''],
    ])('refuses %s', async (_label, username, password) => {
      const res = await tryLogin(username, password);
      expect(res.statusCode).toBe(password === '' ? 400 : 401);
      expect(await user('carol')).toBeUndefined();
    });

    it('handles user names with filter metacharacters', async () => {
      const res = await tryLogin('d(ave)*', 'dave-password');
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({ username: 'd(ave)*', email: null });
    });

    it('respects disabled accounts', async () => {
      await tryLogin('alice', 'alice-password');
      await env.ctx.db.updateTable('users').set({ is_disabled: true }).where('username', '=', 'alice').execute();
      expect((await tryLogin('alice', 'alice-password')).statusCode).toBe(403);
      await env.ctx.db.updateTable('users').set({ is_disabled: false }).where('username', '=', 'alice').execute();
    });

    it('does not let a directory login take over a local account', async () => {
      // Point the filter at the mail attribute so "bob@example.org" maps to uid "bob"... and a local "bob" would clash.
      await env.ctx.db.updateTable('users').set({ username: 'bob-ldap' }).where('username', '=', 'bob').execute();
      await createUser(env.ctx, { username: 'bob' });
      await env.ctx.db
        .updateTable('users')
        .set({ ldap_dn: null, auth_source: 'local', password_hash: 'x' })
        .where('username', '=', 'bob-ldap')
        .execute();
      expect((await put({ ...settings, userFilter: '(|(uid={username})(mail={username}))' })).statusCode).toBe(200);
      const res = await tryLogin('bob@example.org', 'bob-password');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('account_conflict');
      expect((await put(settings)).statusCode).toBe(200);
    });

    it('lets directory users sign in without StartTLS only when explicitly allowed', async () => {
      const plain = { ...settings, url: `ldap://127.0.0.1:${server.ldapPort}` };
      expect((await put(plain, 'reader-secret')).statusCode).toBe(400);
      expect(
        (await put({ ...plain, startTls: true, url: `ldap://localhost:${server.ldapPort}` }, 'reader-secret'))
          .statusCode,
      ).toBe(200);
      expect((await tryLogin('alice', 'alice-password')).statusCode).toBe(200);
      expect((await put(settings, 'reader-secret')).statusCode).toBe(200);
    });

    it('reports an unavailable directory as a temporary error', async () => {
      expect(
        (await put({ ...settings, url: 'ldaps://127.0.0.1:1', timeoutSeconds: 2 }, 'reader-secret')).statusCode,
      ).toBe(200);
      const res = await tryLogin('alice', 'alice-password');
      expect(res.statusCode).toBe(503);
      // Local accounts keep working.
      const local = await createUser(env.ctx);
      expect((await tryLogin(local.username, STRONG_PASSWORD)).statusCode).toBe(200);
      expect((await put(settings, 'reader-secret')).statusCode).toBe(200);
    });

    it('rejects directory users while the directory is disabled', async () => {
      expect((await put({ ...settings, enabled: false })).statusCode).toBe(200);
      expect((await tryLogin('alice', 'alice-password')).statusCode).toBe(401);
      expect((await put(settings)).statusCode).toBe(200);
    });
  });

  describe('connection test', () => {
    const test = async (payload: object) =>
      (
        await request(env.app, admin, 'POST', '/api/admin/ldap/test', { payload: { settings, ...payload } })
      ).json<LdapTestResult>();

    it('checks connection, bind, search, groups and a user password', async () => {
      const r = await test({ username: 'alice', password: 'alice-password' });
      expect(r.steps.map((s) => [s.step, s.ok])).toEqual([
        ['connect', true],
        ['bind', true],
        ['search', true],
        ['search', true],
        ['groups', true],
        ['user-bind', true],
      ]);
      expect(r.ok).toBe(true);
      expect(r.user).toMatchObject({ dn: 'uid=alice,ou=people,dc=example,dc=org', allowed: true, admin: true });
      expect(JSON.stringify(r)).not.toContain('reader-secret');
    });

    it('explains failures', async () => {
      const noCa = await test({ settings: { ...settings, caCertificate: null } });
      expect(noCa.steps).toEqual([{ step: 'connect', ok: false, message: expect.stringMatching(/not trusted/) }]);

      const badBind = await test({ bindPassword: 'wrong' });
      expect(badBind.steps.at(-1)).toEqual({ step: 'bind', ok: false, message: 'Invalid credentials.' });

      const badBase = await test({ settings: { ...settings, userSearchBase: 'ou=nothing,dc=example,dc=org' } });
      expect(badBase.steps.at(-1)).toMatchObject({ step: 'search', ok: false });

      const refused = await test({
        settings: { ...settings, url: 'ldaps://127.0.0.1:1' },
        bindPassword: 'reader-secret',
      });
      expect(refused.steps).toEqual([{ step: 'connect', ok: false, message: 'Connection refused.' }]);

      const outsider = await test({ username: 'carol', password: 'wrong' });
      expect(outsider.ok).toBe(false);
      expect(outsider.steps.find((s) => s.step === 'groups')).toMatchObject({ ok: false });
      expect(outsider.steps.at(-1)).toEqual({ step: 'user-bind', ok: false, message: 'The password is wrong.' });
    });
  });
});
