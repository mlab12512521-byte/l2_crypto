import type { ProjectDetails, ProjectTree, VersionInfo } from '@texcollab/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestGitServer } from '../../test/git-server.js';
import {
  addMember,
  type Client,
  createProject,
  createTestEnv,
  createUser,
  login,
  request,
  STRONG_PASSWORD,
  type TestEnv,
} from '../../test/helpers.js';
import { friendlyGitError, validateRemoteUrl } from './remote.js';

describe('remote URL validation', () => {
  it.each([
    ['http://github.com/a/b.git', /https/],
    ['ftp://example.org/x', /https/],
    ['https://user:pass@github.com/a/b.git', /credentials/],
    ['https://127.0.0.1/x.git', /private/],
    ['https://10.1.2.3/x.git', /private/],
    ['https://192.168.0.5/x.git', /private/],
    ['https://169.254.169.254/latest', /private/],
    ['https://[::1]/x.git', /private/],
    ['https://localhost/x.git', /not allowed/],
    ['https://github.com/a/b.git?x=1', /query/],
    ['not a url', /valid/],
  ])('rejects %s', async (url, message) => {
    await expect(validateRemoteUrl(url, [])).rejects.toThrow(message);
  });

  it('accepts public hosts and allow-listed internal hosts', async () => {
    await expect(validateRemoteUrl('https://93.184.216.34/repo.git', [])).resolves.toBeInstanceOf(URL);
    await expect(validateRemoteUrl('https://10.1.2.3/repo.git', ['10.1.2.3'])).resolves.toBeInstanceOf(URL);
    await expect(validateRemoteUrl('https://93.184.216.34/repo.git', ['gitlab.internal.example'])).rejects.toThrow(
      /not allowed/,
    );
  });

  it('never echoes git output (which could contain secrets) to users', () => {
    expect(friendlyGitError('fatal: Authentication failed for https://x')).toMatch(/credentials/);
    expect(friendlyGitError('something with token=abc123 in it')).not.toContain('abc123');
  });
});

const server = new TestGitServer();
let env: TestEnv;
let owner: Client;
let editor: Client;

beforeAll(async () => {
  await server.start();
  env = await createTestEnv({ GIT_CA_BUNDLE: server.certFile });
  await env.ctx.settings.set('git', { allowedHosts: ['127.0.0.1'] }, null);
  const o = await createUser(env.ctx);
  owner = await login(env.app, o.username, STRONG_PASSWORD);
  const e = await createUser(env.ctx);
  editor = await login(env.app, e.username, STRONG_PASSWORD);
}, 60_000);

afterAll(async () => {
  await env.close();
  await server.stop();
});

async function configured(name: string) {
  const p = await createProject(env.app, owner, name);
  const res = await request(env.app, owner, 'PUT', `/api/projects/${p.id}/git`, {
    payload: {
      url: server.url,
      branch: name.toLowerCase().replace(/\W+/g, '-'),
      username: server.username,
      token: server.token,
    },
  });
  if (res.statusCode !== 200) throw new Error(res.body);
  return p;
}

const text = async (p: ProjectDetails, entityId: string) =>
  (await request(env.app, owner, 'GET', `/api/projects/${p.id}/entities/${entityId}/text`)).json<{
    text: string;
    contentHash: string;
  }>();

async function setText(p: ProjectDetails, entityId: string, t: string) {
  const cur = await text(p, entityId);
  await request(env.app, owner, 'PUT', `/api/projects/${p.id}/entities/${entityId}/text`, {
    payload: { text: t, baseHash: cur.contentHash },
  });
}

describe('remote configuration', () => {
  it('stores credentials encrypted and never returns them', async () => {
    const p = await configured('Creds');
    const get = await request(env.app, owner, 'GET', `/api/projects/${p.id}/git`);
    expect(get.json().remote).toMatchObject({ url: server.url, username: server.username, hasSecret: true });
    expect(get.body).not.toContain(server.token);
    const row = await env.ctx.db
      .selectFrom('git_remotes')
      .select('secret_encrypted')
      .where('project_id', '=', p.id)
      .executeTakeFirstOrThrow();
    expect(row.secret_encrypted!.toString('latin1')).not.toContain(server.token);
  });

  it('lets only the owner configure the remote', async () => {
    const p = await createProject(env.app, owner, 'Owner remote');
    await addMember(env.ctx, p.id, editor.me.user.id, 'editor');
    const res = await request(env.app, editor, 'PUT', `/api/projects/${p.id}/git`, {
      payload: { url: server.url, branch: 'main' },
    });
    expect(res.statusCode).toBe(403);
    const bad = await request(env.app, owner, 'PUT', `/api/projects/${p.id}/git`, {
      payload: { url: server.url, branch: '../x' },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('push and pull', () => {
  it('pushes the project history to the remote', async () => {
    const p = await configured('Push');
    await setText(p, p.mainFileId!, 'pushed content\n');
    const res = await request(env.app, owner, 'POST', `/api/projects/${p.id}/git/push`);
    expect(res.statusCode).toBe(200);
    expect(server.fileOnServer('main.tex', 'push')).toBe('pushed content\n');
    const info = (await request(env.app, owner, 'GET', `/api/projects/${p.id}/git`)).json().remote;
    expect(info.lastPushAt).not.toBeNull();
  });

  it('fast-forwards external commits into the project', async () => {
    const p = await configured('FF');
    await request(env.app, owner, 'POST', `/api/projects/${p.id}/git/push`);
    server.commitExternally(
      { 'chapters/ext.tex': 'from a colleague\n', 'main.tex': 'edited on the server\n' },
      'External edit',
      'ff',
    );
    const res = await request(env.app, owner, 'POST', `/api/projects/${p.id}/git/pull`);
    expect(res.json()).toEqual({ result: 'fast-forward' });
    const tree = (await request(env.app, owner, 'GET', `/api/projects/${p.id}/tree`)).json<ProjectTree>();
    expect(tree.entities.map((e) => e.name).sort()).toEqual(['chapters', 'ext.tex', 'main.tex']);
    expect((await text(p, p.mainFileId!)).text).toBe('edited on the server\n');
    const vs = (await request(env.app, owner, 'GET', `/api/projects/${p.id}/versions`)).json<{
      versions: VersionInfo[];
    }>().versions;
    expect(vs[0]!.kind).toBe('git-pull');
    // Up to date afterwards.
    expect((await request(env.app, owner, 'POST', `/api/projects/${p.id}/git/pull`)).json()).toEqual({
      result: 'up-to-date',
    });
  });

  it('merges non-conflicting changes from both sides', async () => {
    const p = await configured('Merge');
    const other = (
      await request(env.app, owner, 'POST', `/api/projects/${p.id}/entities`, {
        payload: { parentId: p.rootFolderId, kind: 'doc', name: 'local.tex', content: 'one\n' },
      })
    ).json();
    await request(env.app, owner, 'POST', `/api/projects/${p.id}/git/push`);
    server.commitExternally({ 'remote.tex': 'added remotely\n' }, 'Remote change', 'merge');
    await setText(p, other.id, 'one\nlocal change\n');
    const res = await request(env.app, owner, 'POST', `/api/projects/${p.id}/git/pull`);
    expect(res.json()).toEqual({ result: 'merged' });
    expect((await text(p, other.id)).text).toBe('one\nlocal change\n');
    const tree = (await request(env.app, owner, 'GET', `/api/projects/${p.id}/tree`)).json<ProjectTree>();
    expect(tree.entities.map((e) => e.name)).toContain('remote.tex');
    // The merge can be pushed back.
    expect((await request(env.app, owner, 'POST', `/api/projects/${p.id}/git/push`)).statusCode).toBe(200);
    expect(server.fileOnServer('local.tex', 'merge')).toBe('one\nlocal change\n');
  });

  it('reports conflicts and changes nothing', async () => {
    const p = await configured('Conflict');
    await request(env.app, owner, 'POST', `/api/projects/${p.id}/git/push`);
    server.commitExternally({ 'main.tex': 'their version\n' }, 'Theirs', 'conflict');
    await setText(p, p.mainFileId!, 'our version\n');
    const res = await request(env.app, owner, 'POST', `/api/projects/${p.id}/git/pull`);
    expect(res.json()).toEqual({ result: 'merged', conflicts: ['main.tex'] });
    expect((await text(p, p.mainFileId!)).text).toBe('our version\n');
    // Pushing is refused while the remote has changes we do not have.
    const push = await request(env.app, owner, 'POST', `/api/projects/${p.id}/git/push`);
    expect(push.statusCode).toBe(409);
    expect(push.json().error.message).toMatch(/Pull first/);
  });

  it('reports wrong credentials without leaking them', async () => {
    const p = await createProject(env.app, owner, 'Bad creds');
    await request(env.app, owner, 'PUT', `/api/projects/${p.id}/git`, {
      payload: { url: server.url, branch: 'x', username: server.username, token: 'wrong-token-value' },
    });
    const res = await request(env.app, owner, 'POST', `/api/projects/${p.id}/git/push`);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toMatch(/credentials/);
    expect(res.body).not.toContain('wrong-token-value');
    const info = (await request(env.app, owner, 'GET', `/api/projects/${p.id}/git`)).json().remote;
    expect(info.lastError).toMatch(/credentials/);
  });

  it('refuses pulled content with unsafe file names', async () => {
    const p = await configured('Unsafe');
    await request(env.app, owner, 'POST', `/api/projects/${p.id}/git/push`);
    server.commitExternally({ 'bad:name.tex': 'x' }, 'Unsafe name', 'unsafe');
    const res = await request(env.app, owner, 'POST', `/api/projects/${p.id}/git/pull`);
    expect(res.statusCode).toBe(400);
    const tree = (await request(env.app, owner, 'GET', `/api/projects/${p.id}/tree`)).json<ProjectTree>();
    expect(tree.entities.map((e) => e.name)).toEqual(['main.tex']);
  });

  it('lets editors push and pull but not viewers', async () => {
    const p = await configured('Editor push');
    await addMember(env.ctx, p.id, editor.me.user.id, 'viewer');
    expect((await request(env.app, editor, 'POST', `/api/projects/${p.id}/git/push`)).statusCode).toBe(403);
    await env.ctx.db
      .updateTable('project_members')
      .set({ role: 'editor' })
      .where('user_id', '=', editor.me.user.id)
      .execute();
    expect((await request(env.app, editor, 'POST', `/api/projects/${p.id}/git/push`)).statusCode).toBe(200);
  });
});
