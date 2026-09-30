import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CompileResult } from '@texcollab/shared';
import { BODY_HASH_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from '@texcollab/shared/node';
import tarStream from 'tar-stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

const SECRET = 'fake-worker-secret-fake-worker-secret-00';

interface Received {
  query: Record<string, string>;
  files: Map<string, string>;
}

type Reply =
  | {
      kind: 'tar';
      entries: Array<{ name: string; data?: string; type?: 'file' | 'symlink'; linkname?: string }>;
      outcome?: string;
    }
  | { kind: 'status'; code: number }
  | { kind: 'sandbox-failure'; outcome: string }
  | { kind: 'hang'; ms: number };

/** In-process stand-in for a compile worker: verifies signatures and returns canned archives. */
class FakeWorker {
  server!: Server;
  url = '';
  received: Received[] = [];
  reply: Reply = { kind: 'status', code: 500 };

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const url = new URL(req.url!, 'http://x');
    const query = Object.fromEntries(url.searchParams);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const sha = createHash('sha256').update(body).digest('hex');
    const ok =
      sha === req.headers[BODY_HASH_HEADER] &&
      verifySignature(
        SECRET,
        {
          method: 'POST',
          path: url.pathname,
          query,
          timestamp: String(req.headers[TIMESTAMP_HEADER]),
          bodySha256: sha,
        },
        String(req.headers[SIGNATURE_HEADER]),
      );
    if (!ok) {
      res.writeHead(401).end();
      return;
    }
    this.received.push({ query, files: await untar(body) });
    const r = this.reply;
    if (r.kind === 'status') {
      res.writeHead(r.code, { 'content-type': 'application/json' }).end('{}');
    } else if (r.kind === 'sandbox-failure') {
      res
        .writeHead(200, { 'content-type': 'application/json', 'x-compile-outcome': r.outcome, 'x-duration-ms': '5' })
        .end('{}');
    } else if (r.kind === 'hang') {
      await new Promise((resolve) => setTimeout(resolve, r.ms));
      res.writeHead(503).end();
    } else {
      const out = await makeTar(r.entries);
      res
        .writeHead(200, {
          'content-type': 'application/x-tar',
          'x-compile-outcome': r.outcome ?? 'completed',
          'x-duration-ms': '42',
        })
        .end(out);
    }
  }
}

async function untar(buf: Buffer): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ex = tarStream.extract();
  ex.on('entry', (h, s, next) => {
    const c: Buffer[] = [];
    s.on('data', (d: unknown) => c.push(d as Buffer));
    s.on('end', () => {
      out.set(h.name, Buffer.concat(c).toString('utf8'));
      next();
    });
  });
  const done = new Promise<void>((r) => ex.on('finish', () => r()));
  ex.end(buf);
  await done;
  return out;
}

async function makeTar(
  entries: Array<{ name: string; data?: string; type?: 'file' | 'symlink'; linkname?: string }>,
): Promise<Buffer> {
  const pack = tarStream.pack();
  const chunks: Buffer[] = [];
  pack.on('data', (c: unknown) => chunks.push(c as Buffer));
  const done = new Promise<void>((r) => pack.on('end', () => r()));
  for (const e of entries) {
    if (e.type === 'symlink') pack.entry({ name: e.name, type: 'symlink', linkname: e.linkname ?? '/etc/passwd' });
    else pack.entry({ name: e.name }, e.data ?? '');
  }
  pack.finalize();
  await done;
  return Buffer.concat(chunks);
}

const LOG = `This is pdfTeX
(./main.tex
LaTeX Warning: Reference \`nope' on page 1 undefined on input line 3.

(./chapter.tex
./chapter.tex:2: Undefined control sequence.
l.2 \\oops
)
)`;

const worker = new FakeWorker();
let env: TestEnv;
let alice: Client;
let bob: Client;
let bobId: string;

beforeAll(async () => {
  await worker.start();
  env = await createTestEnv({ COMPILE_WORKERS: worker.url, WORKER_SECRET: SECRET });
  const a = await createUser(env.ctx);
  alice = await login(env.app, a.username, STRONG_PASSWORD);
  const b = await createUser(env.ctx);
  bobId = b.user.id;
  bob = await login(env.app, b.username, STRONG_PASSWORD);
});
afterAll(async () => {
  await env.close();
  await worker.stop();
});
beforeEach(() => {
  worker.received = [];
});

const success = (extra: Array<{ name: string; data?: string; type?: 'file' | 'symlink' }> = []): Reply => ({
  kind: 'tar',
  entries: [
    { name: 'project/output.pdf', data: '%PDF-1.5 fake' },
    { name: 'project/output.log', data: LOG },
    { name: 'meta/status.json', data: '{"result":"failure","exitCode":12,"message":""}' },
    ...extra,
  ],
});

describe('compiling a project', () => {
  it('sends the project snapshot and returns mapped diagnostics and the PDF', async () => {
    const p = await createProject(env.app, alice, 'Compile me');
    const ch = await upload(env.app, alice, `/api/projects/${p.id}/upload`, 'text\n\\oops', {
      parentId: p.rootFolderId,
      path: 'chapter.tex',
    });
    await upload(env.app, alice, `/api/projects/${p.id}/upload`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), {
      parentId: p.rootFolderId,
      path: 'fig/plot.png',
    });
    worker.reply = success();

    const res = await request(env.app, alice, 'POST', `/api/projects/${p.id}/compile`, { payload: {} });
    expect(res.statusCode).toBe(200);
    const result = res.json<CompileResult>();
    expect(result.status).toBe('failure');
    expect(result.outputFiles.map((f) => f.name).sort()).toEqual(['output.log', 'output.pdf']);

    const sent = worker.received[0]!;
    expect(sent.query).toMatchObject({ engine: 'pdflatex', main: 'main.tex', timeout: '120', memoryMb: '2048' });
    expect([...sent.files.keys()].sort()).toEqual(['chapter.tex', 'fig/plot.png', 'main.tex']);
    expect(sent.files.get('chapter.tex')).toBe('text\n\\oops');

    const err = result.diagnostics.find((d) => d.severity === 'error')!;
    expect(err).toMatchObject({ file: 'chapter.tex', line: 2, entityId: ch.json().id });
    const warn = result.diagnostics.find((d) => d.severity === 'warning')!;
    expect(warn).toMatchObject({ file: 'main.tex', line: 3, entityId: p.mainFileId });

    const pdf = await request(env.app, alice, 'GET', `/api/projects/${p.id}/builds/${result.buildId}/output.pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body).toBe('%PDF-1.5 fake');
    const dl = await request(env.app, alice, 'GET', `/api/projects/${p.id}/builds/${result.buildId}/output.pdf`, {
      query: { download: '1' },
    });
    expect(String(dl.headers['content-disposition'])).toMatch(/^attachment; filename="Compile me\.pdf"/);

    const latest = await request(env.app, alice, 'GET', `/api/projects/${p.id}/builds/latest`);
    expect(latest.json().build.buildId).toBe(result.buildId);
  });

  it('uses the project compiler and a main file in a subfolder', async () => {
    const p = await createProject(env.app, alice, 'Xe', 'blank');
    const main = await upload(env.app, alice, `/api/projects/${p.id}/upload`, '\\documentclass{article}', {
      parentId: p.rootFolderId,
      path: 'src/thesis.tex',
    });
    await request(env.app, alice, 'PATCH', `/api/projects/${p.id}`, {
      payload: { compiler: 'xelatex', mainFileId: main.json().id },
    });
    worker.reply = success();
    await request(env.app, alice, 'POST', `/api/projects/${p.id}/compile`, { payload: {} });
    expect(worker.received[0]!.query).toMatchObject({ engine: 'xelatex', main: 'src/thesis.tex' });
  });

  it('ignores unexpected files, links and traversal names in worker output', async () => {
    const p = await createProject(env.app, alice, 'Hostile output');
    worker.reply = success([
      { name: '../../../../tmp/evil.txt', data: 'x' },
      { name: 'project/../../evil2', data: 'x' },
      { name: 'project/extra.txt', data: 'x' },
      { name: 'project/output.synctex.gz', type: 'symlink' },
    ]);
    const res = await request(env.app, alice, 'POST', `/api/projects/${p.id}/compile`, { payload: {} });
    const result = res.json<CompileResult>();
    expect(result.outputFiles.map((f) => f.name).sort()).toEqual(['output.log', 'output.pdf']);
    const { readdir } = await import('node:fs/promises');
    const stored = await readdir(env.ctx.paths.buildDir(p.id, result.buildId));
    expect(stored.sort()).toEqual(['output.log', 'output.pdf', 'status.json']);
  });

  it('reports timeouts, sandbox failures and unavailable workers as results', async () => {
    const p = await createProject(env.app, alice, 'Failures');
    worker.reply = { kind: 'sandbox-failure', outcome: 'oom' };
    const oom = (
      await request(env.app, alice, 'POST', `/api/projects/${p.id}/compile`, { payload: {} })
    ).json<CompileResult>();
    expect(oom).toMatchObject({ status: 'error', message: expect.stringContaining('memory') });

    worker.reply = {
      kind: 'tar',
      outcome: 'timeout',
      entries: [{ name: 'meta/status.json', data: '{"result":"timeout","exitCode":137,"message":""}' }],
    };
    const to = (
      await request(env.app, alice, 'POST', `/api/projects/${p.id}/compile`, { payload: {} })
    ).json<CompileResult>();
    expect(to.status).toBe('timeout');

    worker.reply = { kind: 'status', code: 503 };
    const busy = (
      await request(env.app, alice, 'POST', `/api/projects/${p.id}/compile`, { payload: {} })
    ).json<CompileResult>();
    expect(busy).toMatchObject({ status: 'error', message: expect.stringContaining('busy') });

    worker.reply = { kind: 'status', code: 500 };
    const down = (
      await request(env.app, alice, 'POST', `/api/projects/${p.id}/compile`, { payload: {} })
    ).json<CompileResult>();
    expect(down).toMatchObject({ status: 'error', message: expect.stringContaining('unavailable') });
  });

  it('refuses a second concurrent compilation of the same project', async () => {
    const p = await createProject(env.app, alice, 'Concurrent');
    worker.reply = { kind: 'hang', ms: 500 };
    const first = request(env.app, alice, 'POST', `/api/projects/${p.id}/compile`, { payload: {} });
    await new Promise((r) => setTimeout(r, 100));
    const second = await request(env.app, alice, 'POST', `/api/projects/${p.id}/compile`, { payload: {} });
    expect(second.statusCode).toBe(409);
    expect((await first).statusCode).toBe(200);
  });

  it('asks for a main file when none is set', async () => {
    const p = await createProject(env.app, alice, 'No main', 'blank');
    const res = await request(env.app, alice, 'POST', `/api/projects/${p.id}/compile`, { payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('main');
  });

  it('keeps only the configured number of builds', async () => {
    await env.ctx.settings.set('compileLimits', { keepBuilds: 2 }, null);
    const p = await createProject(env.app, alice, 'Pruning');
    worker.reply = success();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        (await request(env.app, alice, 'POST', `/api/projects/${p.id}/compile`, { payload: {} })).json().buildId,
      );
    }
    const old = await request(env.app, alice, 'GET', `/api/projects/${p.id}/builds/${ids[0]}/output.pdf`);
    expect(old.statusCode).toBe(404);
    const { stat } = await import('node:fs/promises');
    await expect(stat(env.ctx.paths.buildDir(p.id, ids[0]!))).rejects.toThrow();
    expect((await request(env.app, alice, 'GET', `/api/projects/${p.id}/builds/${ids[2]}/output.pdf`)).statusCode).toBe(
      200,
    );
    await env.ctx.settings.set('compileLimits', {}, null);
  });
});

describe('SyncTeX endpoints', () => {
  it('maps between source and PDF for members only', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const synctex = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'errors.synctex.gz'),
    );
    const p = await createProject(env.app, alice, 'Sync');
    const chapter = await upload(env.app, alice, `/api/projects/${p.id}/upload`, 'x', {
      parentId: p.rootFolderId,
      path: 'chapters/one.tex',
    });
    worker.reply = {
      kind: 'tar',
      entries: [
        { name: 'project/output.pdf', data: '%PDF' },
        { name: 'meta/status.json', data: '{"result":"success","exitCode":0,"message":""}' },
      ],
    };
    const build = (
      await request(env.app, alice, 'POST', `/api/projects/${p.id}/compile`, { payload: {} })
    ).json<CompileResult>();
    // Place the real synctex file into the stored build and register it as an output.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${env.ctx.paths.buildDir(p.id, build.buildId)}/output.synctex.gz`, synctex);
    await env.ctx.db
      .updateTable('compile_builds')
      .set({
        output_files: JSON.stringify([...build.outputFiles, { name: 'output.synctex.gz', size: synctex.length }]),
      })
      .where('id', '=', build.buildId)
      .execute();

    const fwd = await request(env.app, alice, 'GET', `/api/projects/${p.id}/builds/${build.buildId}/synctex/code`, {
      query: { file: 'chapters/one.tex', line: '2' },
    });
    expect(fwd.statusCode).toBe(200);
    const box = fwd.json().boxes[0];
    expect(box.page).toBe(1);
    const inv = await request(env.app, alice, 'GET', `/api/projects/${p.id}/builds/${build.buildId}/synctex/pdf`, {
      query: { page: '1', x: String(box.x + box.width / 2), y: String(box.y + box.height / 2) },
    });
    expect(inv.json().location).toMatchObject({ file: 'chapters/one.tex', entityId: chapter.json().id });
    const denied = await request(env.app, bob, 'GET', `/api/projects/${p.id}/builds/${build.buildId}/synctex/pdf`, {
      query: { page: '1', x: '1', y: '1' },
    });
    expect(denied.statusCode).toBe(404);
  });
});

describe('compile authorization', () => {
  it('lets viewers compile and read outputs; hides everything from non-members', async () => {
    const p = await createProject(env.app, alice, 'Shared compile');
    worker.reply = success();
    const build = (
      await request(env.app, alice, 'POST', `/api/projects/${p.id}/compile`, { payload: {} })
    ).json<CompileResult>();
    const pdfUrl = `/api/projects/${p.id}/builds/${build.buildId}/output.pdf`;

    expect((await request(env.app, bob, 'POST', `/api/projects/${p.id}/compile`, { payload: {} })).statusCode).toBe(
      404,
    );
    expect((await request(env.app, bob, 'GET', pdfUrl)).statusCode).toBe(404);
    expect((await request(env.app, bob, 'GET', `/api/projects/${p.id}/builds/latest`)).statusCode).toBe(404);

    await addMember(env.ctx, p.id, bobId, 'viewer');
    expect((await request(env.app, bob, 'GET', pdfUrl)).statusCode).toBe(200);
    expect((await request(env.app, bob, 'POST', `/api/projects/${p.id}/compile`, { payload: {} })).statusCode).toBe(
      200,
    );
  });

  it('cannot fetch build outputs through another project id or arbitrary names', async () => {
    const a = await createProject(env.app, alice, 'A');
    const b = await createProject(env.app, alice, 'B');
    worker.reply = success();
    const build = (
      await request(env.app, alice, 'POST', `/api/projects/${a.id}/compile`, { payload: {} })
    ).json<CompileResult>();
    expect(
      (await request(env.app, alice, 'GET', `/api/projects/${b.id}/builds/${build.buildId}/output.pdf`)).statusCode,
    ).toBe(404);
    expect(
      (await request(env.app, alice, 'GET', `/api/projects/${a.id}/builds/${build.buildId}/status.json`)).statusCode,
    ).toBe(400);
    expect(
      (await request(env.app, alice, 'GET', `/api/projects/${a.id}/builds/${build.buildId}/..%2F..%2Fetc`)).statusCode,
    ).toBe(400);
  });
});

describe('compile fairness', () => {
  it('limits how many compilations one user can run at once', async () => {
    const projects = await Promise.all([1, 2, 3].map((i) => createProject(env.app, alice, `Busy ${i}`)));
    worker.reply = { kind: 'hang', ms: 400 };
    const results = await Promise.all(
      projects.map((p) => request(env.app, alice, 'POST', `/api/projects/${p.id}/compile`, { payload: {} })),
    );
    const refused = results.filter((r) => r.statusCode === 429);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.json().error.code).toBe('too_many_compilations');
    // Others are not affected, and the slots are released afterwards.
    worker.reply = success();
    const other = await createProject(env.app, bob, 'Bob meanwhile');
    expect((await request(env.app, bob, 'POST', `/api/projects/${other.id}/compile`, { payload: {} })).statusCode).toBe(
      200,
    );
    expect(
      (await request(env.app, alice, 'POST', `/api/projects/${projects[0]!.id}/compile`, { payload: {} })).statusCode,
    ).toBe(200);
  });
});
