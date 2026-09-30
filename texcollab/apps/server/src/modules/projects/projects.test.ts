import type { ProjectSummary, ProjectTree } from '@texcollab/shared';
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
import { buildZip, readZip } from '../../test/zip-builder.js';

let env: TestEnv;
let alice: Client;
let bob: Client;
let bobId: string;

beforeAll(async () => {
  env = await createTestEnv();
  const a = await createUser(env.ctx);
  alice = await login(env.app, a.username, STRONG_PASSWORD);
  const b = await createUser(env.ctx);
  bobId = b.user.id;
  bob = await login(env.app, b.username, STRONG_PASSWORD);
});
afterAll(async () => {
  await env.close();
});

describe('project lifecycle', () => {
  it('creates a project with a starter main.tex set as main file', async () => {
    const p = await createProject(env.app, alice, 'Paper');
    expect(p).toMatchObject({ name: 'Paper', role: 'owner', compiler: 'pdflatex' });
    expect(p.owner.id).toBe(alice.me.user.id);
    const tree = (await request(env.app, alice, 'GET', `/api/projects/${p.id}/tree`)).json<ProjectTree>();
    expect(tree.entities.map((e) => e.name)).toEqual(['main.tex']);
    expect(p.mainFileId).toBe(tree.entities[0]!.id);
    const text = await request(env.app, alice, 'GET', `/api/projects/${p.id}/entities/${p.mainFileId}/text`);
    expect(text.json().text).toContain('\\documentclass');
  });

  it('creates blank projects and validates names', async () => {
    const p = await createProject(env.app, alice, 'Blank', 'blank');
    const tree = (await request(env.app, alice, 'GET', `/api/projects/${p.id}/tree`)).json<ProjectTree>();
    expect(tree.entities).toEqual([]);
    const bad = await request(env.app, alice, 'POST', '/api/projects', { payload: { name: '  ' } });
    expect(bad.statusCode).toBe(400);
  });

  it('lists owned and shared projects with filters, search and owner info', async () => {
    const own = await createProject(env.app, bob, 'Bob thesis');
    const shared = await createProject(env.app, alice, 'Shared with Bob');
    await addMember(env.ctx, shared.id, bobId, 'editor');
    const list = async (query: Record<string, string>) =>
      (await request(env.app, bob, 'GET', '/api/projects', { query })).json<{ items: ProjectSummary[] }>().items;

    const all = await list({});
    expect(all.map((p) => p.id)).toEqual(expect.arrayContaining([own.id, shared.id]));
    expect((await list({ filter: 'owned' })).map((p) => p.id)).toEqual([own.id]);
    const sharedList = await list({ filter: 'shared' });
    expect(sharedList.map((p) => p.id)).toEqual([shared.id]);
    expect(sharedList[0]).toMatchObject({ role: 'editor', owner: { id: alice.me.user.id } });
    expect(sharedList[0]!.owner).not.toHaveProperty('email');
    expect((await list({ q: 'thesis' })).map((p) => p.id)).toEqual([own.id]);
    expect(await list({ q: '%' })).toEqual([]);
  });

  it('records recently opened projects', async () => {
    const p1 = await createProject(env.app, alice, 'Opened first');
    const p2 = await createProject(env.app, alice, 'Opened second');
    await request(env.app, alice, 'GET', `/api/projects/${p2.id}`);
    await request(env.app, alice, 'GET', `/api/projects/${p1.id}`);
    const items = (await request(env.app, alice, 'GET', '/api/projects', { query: { sort: 'lastOpened' } })).json()
      .items;
    expect(items[0].id).toBe(p1.id);
    expect(items[0].lastOpenedAt).not.toBeNull();
  });

  it('lets owners rename and editors change build settings', async () => {
    const p = await createProject(env.app, alice, 'Settings');
    await addMember(env.ctx, p.id, bobId, 'editor');
    expect((await request(env.app, bob, 'PATCH', `/api/projects/${p.id}`, { payload: { name: 'X' } })).statusCode).toBe(
      403,
    );
    const c = await request(env.app, bob, 'PATCH', `/api/projects/${p.id}`, { payload: { compiler: 'lualatex' } });
    expect(c.json().compiler).toBe('lualatex');
    const r = await request(env.app, alice, 'PATCH', `/api/projects/${p.id}`, { payload: { name: 'Renamed' } });
    expect(r.json().name).toBe('Renamed');
    const badCompiler = await request(env.app, alice, 'PATCH', `/api/projects/${p.id}`, {
      payload: { compiler: 'sh' },
    });
    expect(badCompiler.statusCode).toBe(400);
  });

  it('only accepts .tex documents of the same project as main file', async () => {
    const p = await createProject(env.app, alice, 'Main');
    const other = await createProject(env.app, alice, 'Other');
    const bib = await request(env.app, alice, 'POST', `/api/projects/${p.id}/entities`, {
      payload: { parentId: p.rootFolderId, kind: 'doc', name: 'refs.bib' },
    });
    const r1 = await request(env.app, alice, 'PATCH', `/api/projects/${p.id}`, {
      payload: { mainFileId: bib.json().id },
    });
    expect(r1.statusCode).toBe(400);
    const r2 = await request(env.app, alice, 'PATCH', `/api/projects/${p.id}`, {
      payload: { mainFileId: other.mainFileId },
    });
    expect(r2.statusCode).toBe(404);
  });

  it('deletes projects (owner only) and everything in them', async () => {
    const p = await createProject(env.app, alice, 'Doomed');
    await addMember(env.ctx, p.id, bobId, 'editor');
    expect((await request(env.app, bob, 'DELETE', `/api/projects/${p.id}`)).statusCode).toBe(403);
    expect((await request(env.app, alice, 'DELETE', `/api/projects/${p.id}`)).statusCode).toBe(204);
    expect((await request(env.app, alice, 'GET', `/api/projects/${p.id}`)).statusCode).toBe(404);
    const left = await env.ctx.db.selectFrom('project_entities').select('id').where('project_id', '=', p.id).execute();
    expect(left).toEqual([]);
  });
});

describe('ZIP export and import', () => {
  it('round-trips a multi-file project', async () => {
    const p = await createProject(env.app, alice, 'Roundtrip');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
    await upload(env.app, alice, `/api/projects/${p.id}/upload`, png, {
      parentId: p.rootFolderId,
      path: 'figures/plot.png',
    });
    await upload(env.app, alice, `/api/projects/${p.id}/upload`, '@book{k, title={T}}', {
      parentId: p.rootFolderId,
      path: 'refs.bib',
    });
    await request(env.app, alice, 'POST', `/api/projects/${p.id}/entities`, {
      payload: { parentId: p.rootFolderId, kind: 'folder', name: 'empty' },
    });

    const res = await request(env.app, alice, 'GET', `/api/projects/${p.id}/export.zip`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain('Roundtrip.zip');
    const files = await readZip(res.rawPayload);
    expect([...files.keys()].sort()).toEqual(['empty/', 'figures/', 'figures/plot.png', 'main.tex', 'refs.bib']);
    expect(files.get('figures/plot.png')!.equals(png)).toBe(true);

    const imported = await upload(env.app, bob, '/api/projects/import', res.rawPayload, { name: 'Imported' });
    expect(imported.statusCode).toBe(201);
    const ip = imported.json();
    expect(ip.role).toBe('owner');
    const tree = (await request(env.app, bob, 'GET', `/api/projects/${ip.id}/tree`)).json<ProjectTree>();
    const byName = Object.fromEntries(tree.entities.map((e) => [e.name, e]));
    expect(byName['main.tex']!.kind).toBe('doc');
    expect(byName['refs.bib']!.kind).toBe('doc');
    expect(byName['plot.png']!.kind).toBe('file');
    expect(byName.empty!.kind).toBe('folder');
    expect(ip.mainFileId).toBe(byName['main.tex']!.id);
  });

  it('strips a single top-level folder and detects the main file', async () => {
    const zip = buildZip([
      { name: 'thesis/' },
      { name: 'thesis/chapters/intro.tex', data: '\\section{Intro}' },
      { name: 'thesis/thesis.tex', data: '% comment\n\\documentclass{report}\n\\begin{document}\\end{document}' },
      { name: '__MACOSX/thesis/._thesis.tex', data: 'junk' },
      { name: 'thesis/.DS_Store', data: 'junk' },
    ]);
    const res = await upload(env.app, alice, '/api/projects/import', zip, { name: 'Thesis' });
    expect(res.statusCode).toBe(201);
    const p = res.json();
    const tree = (await request(env.app, alice, 'GET', `/api/projects/${p.id}/tree`)).json<ProjectTree>();
    const names = tree.entities.map((e) => e.name).sort();
    expect(names).toEqual(['chapters', 'intro.tex', 'thesis.tex']);
    const main = tree.entities.find((e) => e.name === 'thesis.tex')!;
    expect(p.mainFileId).toBe(main.id);
    expect(main.parentId).toBe(tree.rootId);
  });

  it.each([
    ['parent traversal', '../evil.tex'],
    ['nested traversal', 'a/../../evil.tex'],
    ['absolute path', '/etc/cron.d/evil'],
    ['windows traversal', '..\\evil.tex'],
    ['control characters', 'bad\u0001name.tex'],
  ])('rejects archives with %s entries (zip slip)', async (_label, name) => {
    const zip = buildZip([
      { name: 'ok.tex', data: 'x' },
      { name, data: 'pwned' },
    ]);
    const res = await upload(env.app, alice, '/api/projects/import', zip, { name: 'Evil' });
    expect(res.statusCode).toBe(400);
    const projects = await request(env.app, alice, 'GET', '/api/projects', { query: { q: 'Evil' } });
    expect(projects.json().items).toEqual([]);
  });

  it('rejects symbolic links', async () => {
    const zip = buildZip([{ name: 'link.tex', data: '/etc/passwd', unixMode: 0o120777 }]);
    const res = await upload(env.app, alice, '/api/projects/import', zip, { name: 'Symlink' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('symbolic link');
  });

  it('rejects non-zip uploads', async () => {
    const res = await upload(env.app, alice, '/api/projects/import', 'definitely not a zip', { name: 'Junk' });
    expect(res.statusCode).toBe(400);
  });

  it('stops zip bombs by counting decompressed bytes', async () => {
    await env.ctx.settings.set('projectLimits', { maxProjectSizeMb: 2, maxFileSizeMb: 1 }, null);
    try {
      const bomb = buildZip([{ name: 'zeros.dat', data: Buffer.alloc(20 * 1024 * 1024), deflate: true }]);
      expect(bomb.length).toBeLessThan(100 * 1024);
      const res = await upload(env.app, alice, '/api/projects/import', bomb, { name: 'Bomb' });
      expect(res.statusCode).toBe(413);
    } finally {
      await env.ctx.settings.set('projectLimits', {}, null);
    }
  });

  it('rejects archives whose declared sizes lie', async () => {
    const zip = buildZip([{ name: 'a.tex', data: 'hello world', deflate: true }]);
    // Corrupt the declared uncompressed size in the central directory.
    const cdStart = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(3, cdStart + 24);
    const res = await upload(env.app, alice, '/api/projects/import', zip, { name: 'Liar' });
    expect(res.statusCode).toBe(400);
  });
});
