import type { ProjectDetails, ProjectTree, VersionDiff, VersionInfo } from '@texcollab/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  upload,
} from '../../test/helpers.js';
import { readZip } from '../../test/zip-builder.js';

let env: TestEnv;
let alice: Client;
let bob: Client;
let bobId: string;
let outsider: Client;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await createUser(env.ctx);
  alice = await login(env.app, a.username, STRONG_PASSWORD);
  const b = await createUser(env.ctx);
  bobId = b.user.id;
  bob = await login(env.app, b.username, STRONG_PASSWORD);
  const o = await createUser(env.ctx);
  outsider = await login(env.app, o.username, STRONG_PASSWORD);
});
afterAll(async () => {
  await env.close();
});

const versions = async (p: ProjectDetails, as = alice) =>
  (await request(env.app, as, 'GET', `/api/projects/${p.id}/versions`)).json<{
    versions: VersionInfo[];
    dirty: boolean;
  }>();

async function setText(p: ProjectDetails, entityId: string, text: string, as = alice) {
  const cur = await request(env.app, as, 'GET', `/api/projects/${p.id}/entities/${entityId}/text`);
  const res = await request(env.app, as, 'PUT', `/api/projects/${p.id}/entities/${entityId}/text`, {
    payload: { text, baseHash: cur.json().contentHash },
  });
  if (res.statusCode !== 200) throw new Error(res.body);
}

const fileAt = async (p: ProjectDetails, ref: string, path: string) =>
  request(env.app, alice, 'GET', `/api/projects/${p.id}/history/file`, { query: { ref, path } });

describe('version history', () => {
  it('records an initial version when a project is created', async () => {
    const p = await createProject(env.app, alice, 'History');
    const v = await versions(p);
    expect(v.versions).toHaveLength(1);
    expect(v.versions[0]).toMatchObject({ kind: 'initial', createdBy: { id: alice.me.user.id } });
    expect(v.dirty).toBe(false);
    expect((await fileAt(p, v.versions[0]!.id, 'main.tex')).body).toContain('\\documentclass');
  });

  it('saves named versions with the people who contributed', async () => {
    const p = await createProject(env.app, alice, 'Named');
    await addMember(env.ctx, p.id, bobId, 'editor');
    await setText(p, p.mainFileId!, 'alice edit\n');
    await setText(p, p.mainFileId!, 'alice edit\nbob edit\n', bob);
    expect((await versions(p)).dirty).toBe(true);

    const res = await request(env.app, alice, 'POST', `/api/projects/${p.id}/versions`, {
      payload: { label: 'Draft 1' },
    });
    expect(res.statusCode).toBe(201);
    const v = res.json<VersionInfo>();
    expect(v).toMatchObject({ kind: 'named', label: 'Draft 1' });
    expect(v.contributors.map((c) => c.id).sort()).toEqual([alice.me.user.id, bobId].sort());
    expect((await fileAt(p, v.id, 'main.tex')).body).toBe('alice edit\nbob edit\n');
    expect((await versions(p)).dirty).toBe(false);

    // Git history carries co-authors but no real e-mail addresses.
    const log = await env.ctx.versions.repo(p.id).text(['log', '-1', '--format=%an <%ae>%n%B', 'main']);
    expect(log).toContain('Draft 1');
    expect(log).toContain('Co-authored-by:');
    expect(log).toContain('.invalid>');
    expect(log).not.toContain('@example.test');
  });

  it('creates automatic versions after a pause, and none without real changes', async () => {
    const p = await createProject(env.app, alice, 'Auto');
    await setText(p, p.mainFileId!, 'changed\n');
    // Not idle long enough yet.
    expect(await env.ctx.versions.runAutoVersioning()).toBe(0);
    await env.ctx.db
      .updateTable('project_changes')
      .set({ last_change_at: new Date(Date.now() - 10 * 60_000), first_change_at: new Date(Date.now() - 10 * 60_000) })
      .where('project_id', '=', p.id)
      .execute();
    expect(await env.ctx.versions.runAutoVersioning()).toBe(1);
    const list = (await versions(p)).versions;
    expect(list[0]).toMatchObject({ kind: 'auto', contributors: [{ id: alice.me.user.id }] });

    // An edit that is reverted before the next version produces no version.
    const initial = (await fileAt(p, list[0]!.id, 'main.tex')).body;
    await setText(p, p.mainFileId!, 'temporary');
    await setText(p, p.mainFileId!, initial);
    await env.ctx.db
      .updateTable('project_changes')
      .set({ last_change_at: new Date(Date.now() - 10 * 60_000) })
      .where('project_id', '=', p.id)
      .execute();
    expect(await env.ctx.versions.runAutoVersioning()).toBe(0);
    expect((await versions(p)).versions).toHaveLength(list.length);
    expect((await versions(p)).dirty).toBe(false);
  });

  it('versions long editing sessions even without a pause', async () => {
    const p = await createProject(env.app, alice, 'Long session');
    await setText(p, p.mainFileId!, 'still typing');
    await env.ctx.db
      .updateTable('project_changes')
      .set({ first_change_at: new Date(Date.now() - 60 * 60_000) })
      .where('project_id', '=', p.id)
      .execute();
    expect(await env.ctx.versions.runAutoVersioning()).toBe(1);
  });

  it('diffs versions and the current state, detecting binaries', async () => {
    const p = await createProject(env.app, alice, 'Diff');
    const v0 = (await versions(p)).versions[0]!;
    await setText(p, p.mainFileId!, 'new main');
    await upload(env.app, alice, `/api/projects/${p.id}/upload`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]), {
      parentId: p.rootFolderId,
      path: 'fig/a.png',
    });
    await request(env.app, alice, 'POST', `/api/projects/${p.id}/entities`, {
      payload: { parentId: p.rootFolderId, kind: 'doc', name: 'extra.tex', content: 'x' },
    });
    const v1 = (
      await request(env.app, alice, 'POST', `/api/projects/${p.id}/versions`, { payload: { label: 'v1' } })
    ).json<VersionInfo>();

    const d = (
      await request(env.app, alice, 'GET', `/api/projects/${p.id}/diff`, { query: { from: v0.id, to: v1.id } })
    ).json<VersionDiff>();
    expect(d.changes.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { status: 'added', path: 'extra.tex', binary: false },
      { status: 'added', path: 'fig/a.png', binary: true },
      { status: 'modified', path: 'main.tex', binary: false },
    ]);

    await request(env.app, alice, 'DELETE', `/api/projects/${p.id}/entities/${p.mainFileId}`);
    const cur = (
      await request(env.app, alice, 'GET', `/api/projects/${p.id}/diff`, { query: { from: v1.id, to: 'current' } })
    ).json<VersionDiff>();
    expect(cur.changes).toEqual([{ status: 'deleted', path: 'main.tex', binary: false }]);
    // The live state is not recorded as a version by diffing.
    expect((await versions(p)).versions).toHaveLength(2);

    const binary = await fileAt(p, v1.id, 'fig/a.png');
    expect(binary.headers['content-type']).toBe('application/octet-stream');
    expect((await fileAt(p, v1.id, 'nope.tex')).statusCode).toBe(404);
  });

  it('restores an earlier version without losing the current state', async () => {
    const p = await createProject(env.app, alice, 'Restore');
    const v0 = (await versions(p)).versions[0]!;
    const original = (await fileAt(p, v0.id, 'main.tex')).body;
    await setText(p, p.mainFileId!, 'rewritten');
    await upload(env.app, alice, `/api/projects/${p.id}/upload`, 'new', {
      parentId: p.rootFolderId,
      path: 'chapters/new.tex',
    });

    const res = await request(env.app, alice, 'POST', `/api/projects/${p.id}/versions/${v0.id}/restore`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'restore' });

    // Content is back, the extra file and its now-empty folder are gone, and main.tex kept its id.
    const tree = (await request(env.app, alice, 'GET', `/api/projects/${p.id}/tree`)).json<ProjectTree>();
    expect(tree.entities.map((e) => e.name)).toEqual(['main.tex']);
    expect(tree.entities[0]!.id).toBe(p.mainFileId);
    expect(
      (await request(env.app, alice, 'GET', `/api/projects/${p.id}/entities/${p.mainFileId}/text`)).json().text,
    ).toBe(original);

    // Nothing was lost: the pre-restore state is its own version.
    const list = (await versions(p)).versions;
    expect(list.map((v) => v.kind)).toEqual(['restore', 'auto', 'initial']);
    expect((await fileAt(p, list[1]!.id, 'main.tex')).body).toBe('rewritten');
    expect((await fileAt(p, list[1]!.id, 'chapters/new.tex')).body).toBe('new');
  });

  it('downloads a version as a ZIP', async () => {
    const p = await createProject(env.app, alice, 'Zip version');
    const v0 = (await versions(p)).versions[0]!;
    await setText(p, p.mainFileId!, 'later');
    const zip = await request(env.app, alice, 'GET', `/api/projects/${p.id}/versions/${v0.id}/download.zip`);
    const files = await readZip(zip.rawPayload);
    expect(files.get('main.tex')!.toString()).toContain('\\documentclass');
  });
});

describe('history permissions', () => {
  it('lets viewers read history but not change it; hides it from non-members', async () => {
    const p = await createProject(env.app, alice, 'Perms');
    await addMember(env.ctx, p.id, bobId, 'viewer');
    const v0 = (await versions(p)).versions[0]!;
    expect((await request(env.app, bob, 'GET', `/api/projects/${p.id}/versions`)).statusCode).toBe(200);
    expect(
      (await request(env.app, bob, 'GET', `/api/projects/${p.id}/diff`, { query: { to: 'current' } })).statusCode,
    ).toBe(200);
    expect(
      (await request(env.app, bob, 'POST', `/api/projects/${p.id}/versions`, { payload: { label: 'x' } })).statusCode,
    ).toBe(403);
    expect((await request(env.app, bob, 'POST', `/api/projects/${p.id}/versions/${v0.id}/restore`)).statusCode).toBe(
      403,
    );
    for (const [method, url] of [
      ['GET', `/api/projects/${p.id}/versions`],
      ['GET', `/api/projects/${p.id}/diff?to=current`],
      ['GET', `/api/projects/${p.id}/history/file?ref=current&path=main.tex`],
      ['POST', `/api/projects/${p.id}/versions/${v0.id}/restore`],
      ['GET', `/api/projects/${p.id}/versions/${v0.id}/download.zip`],
      ['GET', `/api/projects/${p.id}/git`],
    ] as const) {
      expect((await request(env.app, outsider, method, url)).statusCode, url).toBe(404);
    }
  });

  it('cannot address versions of another project', async () => {
    const a = await createProject(env.app, alice, 'A');
    const b = await createProject(env.app, alice, 'B');
    const va = (await versions(a)).versions[0]!;
    expect((await request(env.app, alice, 'POST', `/api/projects/${b.id}/versions/${va.id}/restore`)).statusCode).toBe(
      404,
    );
    expect((await fileAt(b, va.id, 'main.tex')).statusCode).toBe(404);
  });
});

describe('repository maintenance', () => {
  it('compacts repositories without losing history', async () => {
    const p = await createProject(env.app, alice, 'GC');
    for (let i = 0; i < 3; i++) {
      await setText(p, p.mainFileId!, `rev ${i}`);
      await request(env.app, alice, 'POST', `/api/projects/${p.id}/versions`, { payload: { label: `v${i}` } });
    }
    expect(await env.ctx.versions.maintainRepositories()).toBeGreaterThan(0);
    const list = (await versions(p)).versions;
    expect((await fileAt(p, list[1]!.id, 'main.tex')).body).toBe('rev 1');
    const count = await env.ctx.versions.repo(p.id).text(['count-objects', '-v']);
    expect(count).toMatch(/packs: 1\b/);
  });
});
