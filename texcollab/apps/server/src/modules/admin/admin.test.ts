import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Client,
  createTestEnv,
  createUser,
  login,
  request,
  STRONG_PASSWORD,
  type TestEnv,
} from '../../test/helpers.js';

let env: TestEnv;
let admin: Client;
let adminId: string;
let normal: Client;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await createUser(env.ctx, { isAdmin: true });
  adminId = a.user.id;
  admin = await login(env.app, a.username, STRONG_PASSWORD);
  const n = await createUser(env.ctx);
  normal = await login(env.app, n.username, STRONG_PASSWORD);
});
afterAll(async () => {
  await env.close();
});

describe('admin authorization', () => {
  const routes: Array<['GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', string]> = [
    ['GET', '/api/admin/users'],
    ['POST', '/api/admin/users'],
    ['GET', '/api/admin/users/00000000-0000-4000-8000-000000000000'],
    ['PATCH', '/api/admin/users/00000000-0000-4000-8000-000000000000'],
    ['DELETE', '/api/admin/users/00000000-0000-4000-8000-000000000000'],
    ['POST', '/api/admin/users/00000000-0000-4000-8000-000000000000/password'],
    ['GET', '/api/admin/settings/registration'],
    ['PUT', '/api/admin/settings/registration'],
    ['GET', '/api/admin/audit'],
    ['GET', '/api/admin/logs'],
    ['GET', '/api/admin/status'],
  ];

  it.each(routes)('%s %s is 401 without a session', async (method, url) => {
    const res = await request(env.app, null, method, url, { payload: method === 'GET' ? undefined : {} });
    expect(res.statusCode).toBe(401);
  });

  it.each(routes)('%s %s is 403 for non-admins', async (method, url) => {
    const res = await request(env.app, normal, method, url, { payload: method === 'GET' ? undefined : {} });
    expect(res.statusCode).toBe(403);
  });
});

describe('user management', () => {
  it('creates, lists, updates and deletes users', async () => {
    const created = await request(env.app, admin, 'POST', '/api/admin/users', {
      payload: { username: 'carol', displayName: 'Carol', email: 'carol@example.test', password: STRONG_PASSWORD },
    });
    expect(created.statusCode).toBe(201);
    const carol = created.json();
    expect(carol).toMatchObject({ username: 'carol', mustChangePassword: true, isAdmin: false, authSource: 'local' });
    expect(carol).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(carol)).not.toContain('argon2');

    const list = await request(env.app, admin, 'GET', '/api/admin/users', { query: { q: 'caro' } });
    expect(list.json().items.map((u: { username: string }) => u.username)).toEqual(['carol']);

    const upd = await request(env.app, admin, 'PATCH', `/api/admin/users/${carol.id}`, {
      payload: { displayName: 'Carol C.', isAdmin: true },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json()).toMatchObject({ displayName: 'Carol C.', isAdmin: true });

    const del = await request(env.app, admin, 'DELETE', `/api/admin/users/${carol.id}`);
    expect(del.statusCode).toBe(204);
    expect((await request(env.app, admin, 'GET', `/api/admin/users/${carol.id}`)).statusCode).toBe(404);
  });

  it('rejects duplicate usernames and e-mails with 409', async () => {
    const payload = { username: 'dave', displayName: 'Dave', email: 'dave@example.test', password: STRONG_PASSWORD };
    expect((await request(env.app, admin, 'POST', '/api/admin/users', { payload })).statusCode).toBe(201);
    const dupName = await request(env.app, admin, 'POST', '/api/admin/users', {
      payload: { ...payload, email: 'other@example.test', username: 'DAVE' },
    });
    expect(dupName.statusCode).toBe(409);
    const dupMail = await request(env.app, admin, 'POST', '/api/admin/users', {
      payload: { ...payload, username: 'dave2', email: 'DAVE@example.test' },
    });
    expect(dupMail.statusCode).toBe(409);
    expect(dupMail.json().error.message).toContain('e-mail');
  });

  it('validates input', async () => {
    const res = await request(env.app, admin, 'POST', '/api/admin/users', {
      payload: { username: '../etc', displayName: 'x', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(Object.keys(res.json().error.fields)).toEqual(expect.arrayContaining(['username', 'password']));
    const unknownField = await request(env.app, admin, 'PATCH', `/api/admin/users/${adminId}`, {
      payload: { passwordHash: 'x' },
    });
    expect(unknownField.statusCode).toBe(400);
    const badId = await request(env.app, admin, 'GET', '/api/admin/users/not-a-uuid');
    expect(badId.statusCode).toBe(400);
  });

  it('disabling a user revokes their sessions immediately', async () => {
    const u = await createUser(env.ctx);
    const c = await login(env.app, u.username, STRONG_PASSWORD);
    const res = await request(env.app, admin, 'PATCH', `/api/admin/users/${u.user.id}`, {
      payload: { isDisabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect((await request(env.app, c, 'GET', '/api/auth/me')).statusCode).toBe(401);
    await expect(login(env.app, u.username, STRONG_PASSWORD)).rejects.toThrow();
  });

  it('resets passwords and forces a change', async () => {
    const u = await createUser(env.ctx);
    const c = await login(env.app, u.username, STRONG_PASSWORD);
    const res = await request(env.app, admin, 'POST', `/api/admin/users/${u.user.id}/password`, {
      payload: { password: 'temporary passphrase 1' },
    });
    expect(res.statusCode).toBe(200);
    expect((await request(env.app, c, 'GET', '/api/auth/me')).statusCode).toBe(401);
    const fresh = await login(env.app, u.username, 'temporary passphrase 1');
    expect(fresh.me.user.mustChangePassword).toBe(true);
  });

  it('refuses to delete users who own projects unless confirmed', async () => {
    const u = await createUser(env.ctx);
    const c = await login(env.app, u.username, STRONG_PASSWORD);
    const proj = await request(env.app, c, 'POST', '/api/projects', { payload: { name: 'Owned' } });
    const r1 = await request(env.app, admin, 'DELETE', `/api/admin/users/${u.user.id}`);
    expect(r1.statusCode).toBe(409);
    const r2 = await request(env.app, admin, 'DELETE', `/api/admin/users/${u.user.id}`, {
      query: { deleteOwnedProjects: 'true' },
    });
    expect(r2.statusCode).toBe(204);
    const left = await env.ctx.db.selectFrom('projects').select('id').where('id', '=', proj.json().id).execute();
    expect(left).toEqual([]);
  });

  it('never removes the last active administrator', async () => {
    const r1 = await request(env.app, admin, 'PATCH', `/api/admin/users/${adminId}`, { payload: { isAdmin: false } });
    expect(r1.statusCode).toBe(409);
    const r2 = await request(env.app, admin, 'PATCH', `/api/admin/users/${adminId}`, { payload: { isDisabled: true } });
    expect(r2.statusCode).toBe(409);
    const r3 = await request(env.app, admin, 'DELETE', `/api/admin/users/${adminId}`);
    expect(r3.statusCode).toBe(409);
  });

  it('records administrative actions in the audit log', async () => {
    const res = await request(env.app, admin, 'GET', '/api/admin/audit', { query: { action: 'admin.' } });
    expect(res.statusCode).toBe(200);
    const actions = res.json().items.map((i: { action: string }) => i.action);
    expect(actions).toEqual(
      expect.arrayContaining(['admin.user_created', 'admin.user_updated', 'admin.password_reset']),
    );
    expect(res.body).not.toContain(STRONG_PASSWORD);
    expect(res.body).not.toContain('temporary passphrase 1');
  });
});

describe('settings and status', () => {
  it('reads and writes typed settings', async () => {
    const get = await request(env.app, admin, 'GET', '/api/admin/settings/registration');
    expect(get.json()).toEqual({ enabled: false });
    const put = await request(env.app, admin, 'PUT', '/api/admin/settings/registration', {
      payload: { enabled: true },
    });
    expect(put.json()).toEqual({ enabled: true });
    const bad = await request(env.app, admin, 'PUT', '/api/admin/settings/registration', {
      payload: { enabled: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
    const unknown = await request(env.app, admin, 'GET', '/api/admin/settings/nope');
    expect(unknown.statusCode).toBe(404);
    await request(env.app, admin, 'PUT', '/api/admin/settings/registration', { payload: { enabled: false } });
  });

  it('reports system status', async () => {
    const res = await request(env.app, admin, 'GET', '/api/admin/status');
    expect(res.statusCode).toBe(200);
    expect(res.json().database.ok).toBe(true);
    expect(res.json().users.total).toBeGreaterThan(0);
  });
});
