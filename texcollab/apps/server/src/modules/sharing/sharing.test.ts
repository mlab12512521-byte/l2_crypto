import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { docChannel, type MembersResponse, type ProjectDetails } from '@texcollab/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import {
  type Client,
  createProject,
  createTestEnv,
  createUser,
  listen,
  login,
  PUBLIC_URL,
  request,
  STRONG_PASSWORD,
  type TestEnv,
  waitFor,
} from '../../test/helpers.js';

let env: TestEnv;
let owner: Client;
let bob: { client: Client; id: string; username: string };
let carol: { client: Client; id: string; username: string };

async function person() {
  const u = await createUser(env.ctx);
  return { client: await login(env.app, u.username, STRONG_PASSWORD), id: u.user.id, username: u.username };
}

const members = async (p: ProjectDetails, as: Client = owner) =>
  (await request(env.app, as, 'GET', `/api/projects/${p.id}/members`)).json<MembersResponse>();

beforeAll(async () => {
  env = await createTestEnv();
  const o = await createUser(env.ctx);
  owner = await login(env.app, o.username, STRONG_PASSWORD);
  bob = await person();
  carol = await person();
});
afterAll(async () => {
  await env.close();
});

describe('sharing with existing users', () => {
  it('shares by user id, username or e-mail and lists members', async () => {
    const p = await createProject(env.app, owner, 'Shared');
    const r1 = await request(env.app, owner, 'POST', `/api/projects/${p.id}/members`, {
      payload: { userId: bob.id, role: 'editor' },
    });
    expect(r1.statusCode).toBe(201);
    expect(r1.json()).toMatchObject({ kind: 'member', user: { id: bob.id } });
    const r2 = await request(env.app, owner, 'POST', `/api/projects/${p.id}/members`, {
      payload: { identifier: `${carol.username}@example.test`, role: 'viewer' },
    });
    expect(r2.json().kind).toBe('member');
    const dup = await request(env.app, owner, 'POST', `/api/projects/${p.id}/members`, {
      payload: { identifier: bob.username, role: 'viewer' },
    });
    expect(dup.statusCode).toBe(409);

    const list = await members(p);
    expect(list.members.map((m) => [m.user.id, m.role])).toEqual([
      [owner.me.user.id, 'owner'],
      [bob.id, 'editor'],
      [carol.id, 'viewer'],
    ]);
    expect(JSON.stringify(list)).not.toContain('@example.test');

    // Shared projects appear on the members' dashboards with their role.
    const dash = (await request(env.app, bob.client, 'GET', '/api/projects', { query: { filter: 'shared' } })).json();
    expect(dash.items.map((x: { id: string; role: string }) => [x.id, x.role])).toContainEqual([p.id, 'editor']);
  });

  it('only lets the owner manage members', async () => {
    const p = await createProject(env.app, owner, 'Owner only');
    await request(env.app, owner, 'POST', `/api/projects/${p.id}/members`, {
      payload: { userId: bob.id, role: 'editor' },
    });
    const asEditor = await request(env.app, bob.client, 'POST', `/api/projects/${p.id}/members`, {
      payload: { userId: carol.id, role: 'editor' },
    });
    expect(asEditor.statusCode).toBe(403);
    const asOutsider = await request(env.app, carol.client, 'POST', `/api/projects/${p.id}/members`, {
      payload: { userId: carol.id, role: 'editor' },
    });
    expect(asOutsider.statusCode).toBe(404);
    expect((await request(env.app, carol.client, 'GET', `/api/projects/${p.id}/members`)).statusCode).toBe(404);
    const promote = await request(env.app, bob.client, 'PATCH', `/api/projects/${p.id}/members/${bob.id}`, {
      payload: { role: 'editor' },
    });
    expect(promote.statusCode).toBe(403);
    const invalidRole = await request(env.app, owner, 'POST', `/api/projects/${p.id}/members`, {
      payload: { userId: carol.id, role: 'owner' },
    });
    expect(invalidRole.statusCode).toBe(400);
  });

  it('changes roles, which changes what members can do', async () => {
    const p = await createProject(env.app, owner, 'Roles');
    await request(env.app, owner, 'POST', `/api/projects/${p.id}/members`, {
      payload: { userId: bob.id, role: 'viewer' },
    });
    const create = () =>
      request(env.app, bob.client, 'POST', `/api/projects/${p.id}/entities`, {
        payload: { parentId: p.rootFolderId, kind: 'doc', name: `f${Math.random().toString(36).slice(2)}.tex` },
      });
    expect((await create()).statusCode).toBe(403);
    await request(env.app, owner, 'PATCH', `/api/projects/${p.id}/members/${bob.id}`, { payload: { role: 'editor' } });
    expect((await create()).statusCode).toBe(201);
    const ownerRole = await request(env.app, owner, 'PATCH', `/api/projects/${p.id}/members/${owner.me.user.id}`, {
      payload: { role: 'viewer' },
    });
    expect(ownerRole.statusCode).toBe(400);
  });

  it('removes members and lets members leave, but never removes the owner', async () => {
    const p = await createProject(env.app, owner, 'Removal');
    await request(env.app, owner, 'POST', `/api/projects/${p.id}/members`, {
      payload: { userId: bob.id, role: 'editor' },
    });
    await request(env.app, owner, 'POST', `/api/projects/${p.id}/members`, {
      payload: { userId: carol.id, role: 'editor' },
    });
    // A non-owner cannot remove someone else.
    expect((await request(env.app, bob.client, 'DELETE', `/api/projects/${p.id}/members/${carol.id}`)).statusCode).toBe(
      403,
    );
    // But can leave.
    expect((await request(env.app, bob.client, 'DELETE', `/api/projects/${p.id}/members/${bob.id}`)).statusCode).toBe(
      204,
    );
    expect((await request(env.app, bob.client, 'GET', `/api/projects/${p.id}`)).statusCode).toBe(404);
    expect((await request(env.app, owner, 'DELETE', `/api/projects/${p.id}/members/${carol.id}`)).statusCode).toBe(204);
    expect(
      (await request(env.app, owner, 'DELETE', `/api/projects/${p.id}/members/${owner.me.user.id}`)).statusCode,
    ).toBe(400);
  });

  it('transfers ownership', async () => {
    const p = await createProject(env.app, owner, 'Transfer');
    const notMember = await request(env.app, owner, 'POST', `/api/projects/${p.id}/transfer`, {
      payload: { userId: bob.id },
    });
    expect(notMember.statusCode).toBe(404);
    await request(env.app, owner, 'POST', `/api/projects/${p.id}/members`, {
      payload: { userId: bob.id, role: 'viewer' },
    });
    expect(
      (await request(env.app, owner, 'POST', `/api/projects/${p.id}/transfer`, { payload: { userId: bob.id } }))
        .statusCode,
    ).toBe(200);
    const list = await members(p, bob.client);
    expect(list.members.find((m) => m.user.id === bob.id)?.role).toBe('owner');
    expect(list.members.find((m) => m.user.id === owner.me.user.id)?.role).toBe('editor');
    // The former owner lost owner rights; the new owner has them.
    expect((await request(env.app, owner, 'DELETE', `/api/projects/${p.id}`)).statusCode).toBe(403);
    expect((await request(env.app, bob.client, 'DELETE', `/api/projects/${p.id}`)).statusCode).toBe(204);
  });
});

describe('invitations by e-mail', () => {
  it('invites unknown addresses and converts the invitation at first sign-in', async () => {
    const p = await createProject(env.app, owner, 'Invites');
    const bad = await request(env.app, owner, 'POST', `/api/projects/${p.id}/members`, {
      payload: { identifier: 'nobody', role: 'editor' },
    });
    expect(bad.statusCode).toBe(404);
    const inv = await request(env.app, owner, 'POST', `/api/projects/${p.id}/members`, {
      payload: { identifier: 'newcomer@example.test', role: 'editor' },
    });
    expect(inv.json()).toEqual({ kind: 'invitation', email: 'newcomer@example.test' });
    expect((await members(p)).invitations.map((i) => i.email)).toEqual(['newcomer@example.test']);
    // Invitations (with e-mail addresses) are visible to the owner only.
    await request(env.app, owner, 'POST', `/api/projects/${p.id}/members`, {
      payload: { userId: bob.id, role: 'viewer' },
    });
    expect((await members(p, bob.client)).invitations).toEqual([]);

    // The person gets an account (here: created by an admin) and signs in.
    const created = await env.ctx.users.createLocalUser({
      username: 'newcomer',
      displayName: 'New Comer',
      email: 'NewComer@example.test',
      password: STRONG_PASSWORD,
    });
    const c = await login(env.app, 'newcomer', STRONG_PASSWORD);
    const got = await request(env.app, c, 'GET', `/api/projects/${p.id}`);
    expect(got.statusCode).toBe(200);
    expect(got.json().role).toBe('editor');
    expect((await members(p)).invitations).toEqual([]);
    expect(created.id).toBe(c.me.user.id);
  });

  it('ignores expired invitations and allows cancelling', async () => {
    const p = await createProject(env.app, owner, 'Expired');
    await request(env.app, owner, 'POST', `/api/projects/${p.id}/members`, {
      payload: { identifier: 'late@example.test', role: 'viewer' },
    });
    await env.ctx.db
      .updateTable('project_invitations')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('email', '=', 'late@example.test')
      .execute();
    await env.ctx.users.createLocalUser({
      username: 'late',
      displayName: 'Late',
      email: 'late@example.test',
      password: STRONG_PASSWORD,
    });
    const c = await login(env.app, 'late', STRONG_PASSWORD);
    expect((await request(env.app, c, 'GET', `/api/projects/${p.id}`)).statusCode).toBe(404);

    await request(env.app, owner, 'POST', `/api/projects/${p.id}/members`, {
      payload: { identifier: 'cancel@example.test', role: 'viewer' },
    });
    const id = (await members(p)).invitations[0]!.id;
    expect((await request(env.app, bob.client, 'DELETE', `/api/projects/${p.id}/invitations/${id}`)).statusCode).toBe(
      404,
    );
    expect((await request(env.app, owner, 'DELETE', `/api/projects/${p.id}/invitations/${id}`)).statusCode).toBe(204);
    expect((await members(p)).invitations).toEqual([]);
  });
});

describe('user search', () => {
  it('finds enabled users by name, never returns e-mail addresses, excludes the caller', async () => {
    await env.ctx.users.createLocalUser({
      username: 'zelda',
      displayName: 'Zelda Hyrule',
      email: 'zelda@example.test',
      password: STRONG_PASSWORD,
    });
    const hidden = await env.ctx.users.createLocalUser({
      username: 'zeldadisabled',
      displayName: 'Zelda Gone',
      password: STRONG_PASSWORD,
    });
    await env.ctx.db.updateTable('users').set({ is_disabled: true }).where('id', '=', hidden.id).execute();
    const res = await request(env.app, owner, 'GET', '/api/users/search', { query: { q: 'zeld' } });
    expect(res.json().items).toEqual([{ id: expect.any(String), username: 'zelda', displayName: 'Zelda Hyrule' }]);
    const byMail = await request(env.app, owner, 'GET', '/api/users/search', { query: { q: 'zelda@example.test' } });
    expect(byMail.json().items).toHaveLength(1);
    expect(byMail.body).not.toContain('@example.test');
    expect((await request(env.app, owner, 'GET', '/api/users/search', { query: { q: 'z' } })).json().items).toEqual([]);
    expect((await request(env.app, null, 'GET', '/api/users/search', { query: { q: 'zeld' } })).statusCode).toBe(401);
  });
});

describe('live access changes', () => {
  it('turns a demoted editor read-only in open editing sessions', async () => {
    const port = await listen(env);
    const p = await createProject(env.app, owner, 'Live demotion');
    await request(env.app, owner, 'POST', `/api/projects/${p.id}/members`, {
      payload: { userId: bob.id, role: 'editor' },
    });
    const Ws = class extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { cookie: bob.client.cookie, origin: PUBLIC_URL } });
      }
    };
    const doc = new Y.Doc();
    const socket = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/collab`,
      WebSocketPolyfill: Ws,
      minDelay: 50,
      delay: 50,
      maxDelay: 200,
    });
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: docChannel(p.mainFileId!),
      document: doc,
      token: 'session',
    });
    provider.attach();
    try {
      await waitFor(() => provider.isSynced, 5000, 'sync');
      doc.getText('content').insert(0, '% editor edit\n');
      await waitFor(
        async () => (await env.ctx.files.readDoc(p.id, p.mainFileId!)).text.startsWith('% editor edit'),
        5000,
        'edit applied',
      );

      await request(env.app, owner, 'PATCH', `/api/projects/${p.id}/members/${bob.id}`, {
        payload: { role: 'viewer' },
      });
      // The connection is dropped and re-established read-only.
      await new Promise((r) => setTimeout(r, 300));
      await waitFor(() => provider.isSynced, 5000, 'resync');
      doc.getText('content').insert(0, '% viewer edit\n');
      await new Promise((r) => setTimeout(r, 500));
      expect((await env.ctx.files.readDoc(p.id, p.mainFileId!)).text).not.toContain('viewer edit');
    } finally {
      socket.disconnect();
      provider.destroy();
      socket.destroy();
    }
  });
});
