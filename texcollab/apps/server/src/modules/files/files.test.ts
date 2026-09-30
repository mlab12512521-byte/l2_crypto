import type { ProjectDetails, ProjectTree, TreeEntity } from '@texcollab/shared';
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

let env: TestEnv;
let alice: Client;
let bob: Client;
let bobId: string;
let p: ProjectDetails;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await createUser(env.ctx);
  alice = await login(env.app, a.username, STRONG_PASSWORD);
  const b = await createUser(env.ctx);
  bobId = b.user.id;
  bob = await login(env.app, b.username, STRONG_PASSWORD);
  p = await createProject(env.app, alice, 'Files');
});
afterAll(async () => {
  await env.close();
});

const tree = async (projectId = p.id, client = alice) =>
  (await request(env.app, client, 'GET', `/api/projects/${projectId}/tree`)).json<ProjectTree>();

async function create(kind: 'folder' | 'doc', name: string, parentId = p.rootFolderId, content?: string) {
  return request(env.app, alice, 'POST', `/api/projects/${p.id}/entities`, {
    payload: { parentId, kind, name, ...(content !== undefined ? { content } : {}) },
  });
}

describe('file tree operations', () => {
  it('creates folders and documents, rejecting duplicates', async () => {
    const folder = await create('folder', 'chapters');
    expect(folder.statusCode).toBe(201);
    const doc = await create('doc', 'intro.tex', folder.json().id, '\\section{Intro}');
    expect(doc.statusCode).toBe(201);
    expect(doc.json()).toMatchObject({ kind: 'doc', name: 'intro.tex', parentId: folder.json().id });
    const dup = await create('doc', 'intro.tex', folder.json().id);
    expect(dup.statusCode).toBe(409);
    // Same name in another folder is fine.
    expect((await create('doc', 'intro.tex')).statusCode).toBe(201);
  });

  it.each(['../x.tex', 'a/b.tex', '..', '.', 'x\u0000.tex', ' spaced', 'a:b', ''])(
    'rejects the name %j',
    async (name) => {
      const res = await create('doc', name);
      expect(res.statusCode).toBe(400);
    },
  );

  it('renames and moves entries, preventing cycles', async () => {
    const outer = (await create('folder', 'outer')).json<TreeEntity>();
    const inner = (await create('folder', 'inner', outer.id)).json<TreeEntity>();
    const doc = (await create('doc', 'moveme.tex')).json<TreeEntity>();

    const renamed = await request(env.app, alice, 'PATCH', `/api/projects/${p.id}/entities/${doc.id}`, {
      payload: { name: 'moved.tex' },
    });
    expect(renamed.json().name).toBe('moved.tex');
    const moved = await request(env.app, alice, 'PATCH', `/api/projects/${p.id}/entities/${doc.id}`, {
      payload: { parentId: inner.id },
    });
    expect(moved.json().parentId).toBe(inner.id);
    expect(await env.ctx.files.pathOf(p.id, doc.id)).toBe('outer/inner/moved.tex');

    const intoSelf = await request(env.app, alice, 'PATCH', `/api/projects/${p.id}/entities/${outer.id}`, {
      payload: { parentId: outer.id },
    });
    expect(intoSelf.statusCode).toBe(400);
    const intoChild = await request(env.app, alice, 'PATCH', `/api/projects/${p.id}/entities/${outer.id}`, {
      payload: { parentId: inner.id },
    });
    expect(intoChild.statusCode).toBe(400);
    const intoFile = await request(env.app, alice, 'PATCH', `/api/projects/${p.id}/entities/${inner.id}`, {
      payload: { parentId: doc.id },
    });
    expect(intoFile.statusCode).toBe(400);
  });

  it('deletes folders recursively', async () => {
    const f = (await create('folder', 'trash')).json<TreeEntity>();
    const d = (await create('doc', 'gone.tex', f.id)).json<TreeEntity>();
    expect((await request(env.app, alice, 'DELETE', `/api/projects/${p.id}/entities/${f.id}`)).statusCode).toBe(204);
    const ids = (await tree()).entities.map((e) => e.id);
    expect(ids).not.toContain(f.id);
    expect(ids).not.toContain(d.id);
    const content = await env.ctx.db
      .selectFrom('doc_contents')
      .select('entity_id')
      .where('entity_id', '=', d.id)
      .execute();
    expect(content).toEqual([]);
  });

  it('refuses to delete, rename or move the root', async () => {
    const t = await tree();
    expect((await request(env.app, alice, 'DELETE', `/api/projects/${p.id}/entities/${t.rootId}`)).statusCode).toBe(
      400,
    );
    const r = await request(env.app, alice, 'PATCH', `/api/projects/${p.id}/entities/${t.rootId}`, {
      payload: { name: 'x' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('updates the project modification time and author', async () => {
    const before = (await request(env.app, alice, 'GET', `/api/projects/${p.id}`)).json<ProjectDetails>();
    await new Promise((r) => setTimeout(r, 10));
    await create('doc', 'touch.tex');
    const after = (await request(env.app, alice, 'GET', `/api/projects/${p.id}`)).json<ProjectDetails>();
    expect(new Date(after.lastModifiedAt).getTime()).toBeGreaterThan(new Date(before.lastModifiedAt).getTime());
    expect(after.lastModifiedBy?.id).toBe(alice.me.user.id);
  });
});

describe('cross-project access (IDOR)', () => {
  it('cannot address another project entity through a project the user can access', async () => {
    const secret = await createProject(env.app, bob, 'Bob secret');
    const mine = await createProject(env.app, alice, 'Alice own');
    const target = secret.mainFileId!;
    const urls: Array<['GET' | 'PATCH' | 'DELETE' | 'PUT', string, unknown?]> = [
      ['GET', `/api/projects/${mine.id}/entities/${target}/content`],
      ['GET', `/api/projects/${mine.id}/entities/${target}/text`],
      ['PUT', `/api/projects/${mine.id}/entities/${target}/text`, { text: 'x', baseHash: null }],
      ['PATCH', `/api/projects/${mine.id}/entities/${target}`, { name: 'x.tex' }],
      ['DELETE', `/api/projects/${mine.id}/entities/${target}`],
    ];
    for (const [method, url, payload] of urls) {
      const res = await request(env.app, alice, method, url, payload ? { payload } : {});
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    // Moving my file into Bob's folder is refused too.
    const move = await request(env.app, alice, 'PATCH', `/api/projects/${mine.id}/entities/${mine.mainFileId}`, {
      payload: { parentId: secret.rootFolderId },
    });
    expect(move.statusCode).toBe(404);
    const text = await env.ctx.files.readDoc(secret.id, target);
    expect(text.text).toContain('documentclass');
  });

  it('returns 404 for every project route to non-members', async () => {
    const secret = await createProject(env.app, bob, 'Hidden');
    const e = secret.mainFileId!;
    const routes: Array<['GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', string, unknown?]> = [
      ['GET', `/api/projects/${secret.id}`],
      ['PATCH', `/api/projects/${secret.id}`, { compiler: 'xelatex' }],
      ['DELETE', `/api/projects/${secret.id}`],
      ['GET', `/api/projects/${secret.id}/export.zip`],
      ['GET', `/api/projects/${secret.id}/tree`],
      ['POST', `/api/projects/${secret.id}/entities`, { parentId: secret.rootFolderId, kind: 'doc', name: 'x.tex' }],
      ['PATCH', `/api/projects/${secret.id}/entities/${e}`, { name: 'y.tex' }],
      ['DELETE', `/api/projects/${secret.id}/entities/${e}`],
      ['GET', `/api/projects/${secret.id}/entities/${e}/content`],
      ['GET', `/api/projects/${secret.id}/entities/${e}/text`],
      ['PUT', `/api/projects/${secret.id}/entities/${e}/text`, { text: '', baseHash: null }],
    ];
    for (const [method, url, payload] of routes) {
      const res = await request(env.app, alice, method, url, payload ? { payload } : {});
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    const up = await upload(env.app, alice, `/api/projects/${secret.id}/upload`, 'x', {
      parentId: secret.rootFolderId,
      path: 'x.tex',
    });
    expect(up.statusCode).toBe(404);
    expect((await request(env.app, alice, 'GET', '/api/projects/not-a-uuid')).statusCode).toBe(400);
  });

  it('lets viewers read but not modify', async () => {
    const shared = await createProject(env.app, alice, 'Viewer test');
    await addMember(env.ctx, shared.id, bobId, 'viewer');
    const e = shared.mainFileId!;
    expect((await request(env.app, bob, 'GET', `/api/projects/${shared.id}/tree`)).statusCode).toBe(200);
    expect((await request(env.app, bob, 'GET', `/api/projects/${shared.id}/entities/${e}/text`)).statusCode).toBe(200);
    expect((await request(env.app, bob, 'GET', `/api/projects/${shared.id}/export.zip`)).statusCode).toBe(200);
    const writes: Array<['POST' | 'PATCH' | 'DELETE' | 'PUT', string, unknown?]> = [
      ['POST', `/api/projects/${shared.id}/entities`, { parentId: shared.rootFolderId, kind: 'doc', name: 'v.tex' }],
      ['PATCH', `/api/projects/${shared.id}/entities/${e}`, { name: 'v.tex' }],
      ['DELETE', `/api/projects/${shared.id}/entities/${e}`],
      ['PUT', `/api/projects/${shared.id}/entities/${e}/text`, { text: 'x', baseHash: null }],
      ['PATCH', `/api/projects/${shared.id}`, { compiler: 'xelatex' }],
      ['DELETE', `/api/projects/${shared.id}`],
    ];
    for (const [method, url, payload] of writes) {
      const res = await request(env.app, bob, method, url, payload ? { payload } : {});
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    const up = await upload(env.app, bob, `/api/projects/${shared.id}/upload`, 'x', {
      parentId: shared.rootFolderId,
      path: 'x.tex',
    });
    expect(up.statusCode).toBe(403);
  });
});

describe('uploads', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

  it('stores text files as documents and binaries as blobs', async () => {
    const t = await upload(env.app, alice, `/api/projects/${p.id}/upload`, 'Hello ünicode', {
      parentId: p.rootFolderId,
      path: 'notes.txt',
    });
    expect(t.statusCode).toBe(201);
    expect(t.json().kind).toBe('doc');
    const b = await upload(env.app, alice, `/api/projects/${p.id}/upload`, PNG, {
      parentId: p.rootFolderId,
      path: 'img.png',
    });
    expect(b.json()).toMatchObject({ kind: 'file', size: PNG.length });
    // A .tex file that is not valid UTF-8 is kept as binary rather than corrupted.
    const latin1 = await upload(env.app, alice, `/api/projects/${p.id}/upload`, Buffer.from([0x63, 0xe9, 0x0a]), {
      parentId: p.rootFolderId,
      path: 'latin1.tex',
    });
    expect(latin1.json().kind).toBe('file');
  });

  it('creates intermediate folders for directory uploads', async () => {
    const res = await upload(env.app, alice, `/api/projects/${p.id}/upload`, PNG, {
      parentId: p.rootFolderId,
      path: 'dirupload/sub/deep/fig.png',
    });
    expect(res.statusCode).toBe(201);
    expect(await env.ctx.files.pathOf(p.id, res.json().id)).toBe('dirupload/sub/deep/fig.png');
    const again = await upload(env.app, alice, `/api/projects/${p.id}/upload`, PNG, {
      parentId: p.rootFolderId,
      path: 'dirupload/sub/other.png',
    });
    expect(again.statusCode).toBe(201);
    const folders = (await tree()).entities.filter((e) => e.name === 'sub');
    expect(folders).toHaveLength(1);
  });

  it('replaces existing files in place, keeping their id', async () => {
    const first = await upload(env.app, alice, `/api/projects/${p.id}/upload`, 'v1', {
      parentId: p.rootFolderId,
      path: 'replace.txt',
    });
    const second = await upload(env.app, alice, `/api/projects/${p.id}/upload`, 'v2', {
      parentId: p.rootFolderId,
      path: 'replace.txt',
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ id: first.json().id, replaced: true });
    const text = await request(env.app, alice, 'GET', `/api/projects/${p.id}/entities/${first.json().id}/text`);
    expect(text.json().text).toBe('v2');
  });

  it.each(['../escape.png', '/abs.png', 'a/../../b.png', 'con\u0000.png', 'x/./y.png'])(
    'rejects the path %j',
    async (path) => {
      const res = await upload(env.app, alice, `/api/projects/${p.id}/upload`, PNG, { parentId: p.rootFolderId, path });
      expect(res.statusCode).toBe(400);
    },
  );

  it('refuses to replace a folder with a file', async () => {
    await create('folder', 'afolder');
    const res = await upload(env.app, alice, `/api/projects/${p.id}/upload`, 'x', {
      parentId: p.rootFolderId,
      path: 'afolder',
    });
    expect(res.statusCode).toBe(409);
  });

  it('enforces file size and project quotas', async () => {
    await env.ctx.settings.set(
      'projectLimits',
      { maxFileSizeMb: 1, maxProjectSizeMb: 2, maxEntitiesPerProject: 10_000 },
      null,
    );
    try {
      const big = Buffer.alloc(1024 * 1024 + 1, 1);
      const r1 = await upload(env.app, alice, `/api/projects/${p.id}/upload`, big, {
        parentId: p.rootFolderId,
        path: 'big.bin',
      });
      expect(r1.statusCode).toBe(413);
      const almost = Buffer.alloc(900 * 1024, 2);
      for (let i = 0; i < 2; i++) {
        const r = await upload(env.app, alice, `/api/projects/${p.id}/upload`, almost, {
          parentId: p.rootFolderId,
          path: `part${i}.bin`,
        });
        expect(r.statusCode).toBe(201);
      }
      const over = await upload(env.app, alice, `/api/projects/${p.id}/upload`, Buffer.alloc(400 * 1024, 3), {
        parentId: p.rootFolderId,
        path: 'over.bin',
      });
      expect(over.statusCode).toBe(413);
      expect(over.json().error.code).toBe('quota_exceeded');
    } finally {
      await env.ctx.settings.set('projectLimits', {}, null);
    }
  });

  it('requires a raw body', async () => {
    const res = await request(env.app, alice, 'POST', `/api/projects/${p.id}/upload`, {
      query: { parentId: p.rootFolderId, path: 'x.txt' },
      payload: { not: 'raw' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('downloads', () => {
  it('serves binaries as attachments with hardening headers', async () => {
    const up = await upload(env.app, alice, `/api/projects/${p.id}/upload`, '<svg onload="alert(1)"/>', {
      parentId: p.rootFolderId,
      path: 'evil.svg',
    });
    // .svg is a text type, so it is a doc; downloads are still plain-text attachments.
    const res = await request(env.app, alice, 'GET', `/api/projects/${p.id}/entities/${up.json().id}/content`, {
      query: { inline: '1' },
    });
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(String(res.headers['content-security-policy'])).toContain('sandbox');

    const html = await upload(
      env.app,
      alice,
      `/api/projects/${p.id}/upload`,
      Buffer.from([0, 60, 104, 116, 109, 108, 62]),
      {
        parentId: p.rootFolderId,
        path: 'page.html',
      },
    );
    const r2 = await request(env.app, alice, 'GET', `/api/projects/${p.id}/entities/${html.json().id}/content`, {
      query: { inline: '1' },
    });
    expect(r2.headers['content-type']).toBe('application/octet-stream');
    expect(String(r2.headers['content-disposition'])).toMatch(/^attachment/);
  });

  it('allows inline display only for safe raster types', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const up = await upload(env.app, alice, `/api/projects/${p.id}/upload`, png, {
      parentId: p.rootFolderId,
      path: 'ok.png',
    });
    const res = await request(env.app, alice, 'GET', `/api/projects/${p.id}/entities/${up.json().id}/content`, {
      query: { inline: '1' },
    });
    expect(res.headers['content-type']).toBe('image/png');
    expect(String(res.headers['content-disposition'])).toMatch(/^inline/);
    expect(res.rawPayload.equals(png)).toBe(true);
  });

  it('encodes unusual file names safely in Content-Disposition', async () => {
    const up = await upload(env.app, alice, `/api/projects/${p.id}/upload`, 'x', {
      parentId: p.rootFolderId,
      path: 'ümlaut; name=evil.txt',
    });
    const res = await request(env.app, alice, 'GET', `/api/projects/${p.id}/entities/${up.json().id}/content`);
    const cd = String(res.headers['content-disposition']);
    expect(cd).toContain("filename*=UTF-8''%C3%BCmlaut%3B%20name%3Devil.txt");
    expect(cd).not.toMatch(/filename="[^"]*;/);
  });
});

describe('document text API', () => {
  it('uses optimistic concurrency instead of last-write-wins', async () => {
    const doc = (await create('doc', 'occ.tex', p.rootFolderId, 'v0')).json<TreeEntity>();
    const url = `/api/projects/${p.id}/entities/${doc.id}/text`;
    const v0 = (await request(env.app, alice, 'GET', url)).json();
    const a = await request(env.app, alice, 'PUT', url, { payload: { text: 'alice', baseHash: v0.contentHash } });
    expect(a.statusCode).toBe(200);
    const stale = await request(env.app, alice, 'PUT', url, { payload: { text: 'bob', baseHash: v0.contentHash } });
    expect(stale.statusCode).toBe(409);
    expect((await request(env.app, alice, 'GET', url)).json().text).toBe('alice');
  });
});

describe('symbols', () => {
  it('returns labels, citation keys and paths to members only', async () => {
    const proj = await createProject(env.app, alice, 'Symbols');
    await upload(env.app, alice, `/api/projects/${proj.id}/upload`, '@article{key1, title={A Title}}', {
      parentId: proj.rootFolderId,
      path: 'refs.bib',
    });
    await upload(env.app, alice, `/api/projects/${proj.id}/upload`, '\\section{X}\\label{sec:x}', {
      parentId: proj.rootFolderId,
      path: 'ch/one.tex',
    });
    const res = await request(env.app, alice, 'GET', `/api/projects/${proj.id}/symbols`);
    expect(res.json()).toMatchObject({
      labels: [{ name: 'sec:x', file: 'ch/one.tex' }],
      citations: [{ key: 'key1', title: 'A Title', file: 'refs.bib' }],
    });
    expect(res.json().files).toEqual(expect.arrayContaining(['main.tex', 'refs.bib', 'ch/one.tex']));
    expect((await request(env.app, bob, 'GET', `/api/projects/${proj.id}/symbols`)).statusCode).toBe(404);
  });
});

describe('garbage collection', () => {
  it('removes unreferenced blobs after the grace period only', async () => {
    const data = Buffer.from(`unique-${Date.now()}-\u0000`);
    const up = await upload(env.app, alice, `/api/projects/${p.id}/upload`, data, {
      parentId: p.rootFolderId,
      path: 'gc.bin',
    });
    const entity = await env.ctx.files.get(p.id, up.json().id);
    const hash = entity.blob_hash!;
    await request(env.app, alice, 'DELETE', `/api/projects/${p.id}/entities/${entity.id}`);
    expect(await env.ctx.files.collectGarbage(60_000)).toBe(0);
    expect(await env.ctx.blobs.exists(hash)).toBe(true);
    await env.ctx.db
      .updateTable('blobs')
      .set({ created_at: new Date(Date.now() - 3_600_000) })
      .where('hash', '=', hash)
      .execute();
    const { utimes } = await import('node:fs/promises');
    const old = new Date(Date.now() - 3_600_000);
    await utimes(env.ctx.blobs.pathFor(hash), old, old);
    expect(await env.ctx.files.collectGarbage(60_000)).toBeGreaterThanOrEqual(1);
    expect(await env.ctx.blobs.exists(hash)).toBe(false);
  });
});
