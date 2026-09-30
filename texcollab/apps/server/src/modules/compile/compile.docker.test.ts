import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { CompileResult } from '@texcollab/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../../../../compile-worker/src/config.js';
import { createLogger } from '../../../../compile-worker/src/log.js';
import { createWorkerServer } from '../../../../compile-worker/src/server.js';
import {
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

/** Full path: API → compile service → real worker → Docker sandbox → stored PDF. */
const IMAGE = process.env.COMPILE_TEST_IMAGE ?? 'texcollab/texlive:dev';
const ready = spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0;
const d = ready ? describe : describe.skip;
const SECRET = 'e2e-worker-secret-e2e-worker-secret-000';

let env: TestEnv;
let alice: Client;
let stopWorker: () => Promise<void>;

beforeAll(async () => {
  if (!ready) return;
  const cfg = { ...loadWorkerConfig({ WORKER_SECRET: SECRET, COMPILE_IMAGE: IMAGE }), host: '127.0.0.1', port: 0 };
  const { server } = createWorkerServer(cfg, createLogger('silent'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  stopWorker = () => new Promise((r) => server.close(() => r()));
  env = await createTestEnv({
    COMPILE_WORKERS: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    WORKER_SECRET: SECRET,
  });
  const a = await createUser(env.ctx);
  alice = await login(env.app, a.username, STRONG_PASSWORD);
}, 120_000);

afterAll(async () => {
  await env?.close();
  await stopWorker?.();
});

d('end-to-end compilation', () => {
  it('compiles a multi-file project with a bibliography into a PDF', async () => {
    const p = await createProject(env.app, alice, 'E2E', 'blank');
    const main = await upload(
      env.app,
      alice,
      `/api/projects/${p.id}/upload`,
      '\\documentclass{article}\n\\begin{document}\nSee \\cite{k}.\n\\input{chapters/one}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n',
      { parentId: p.rootFolderId, path: 'main.tex' },
    );
    await upload(env.app, alice, `/api/projects/${p.id}/upload`, '\\section{One}\nText with \\oops here.\n', {
      parentId: p.rootFolderId,
      path: 'chapters/one.tex',
    });
    await upload(
      env.app,
      alice,
      `/api/projects/${p.id}/upload`,
      '@book{k, author={A}, title={T}, year={2001}, publisher={P}}',
      {
        parentId: p.rootFolderId,
        path: 'refs.bib',
      },
    );
    await request(env.app, alice, 'PATCH', `/api/projects/${p.id}`, { payload: { mainFileId: main.json().id } });

    const res = await request(env.app, alice, 'POST', `/api/projects/${p.id}/compile`, { payload: {} });
    const result = res.json<CompileResult>();
    expect(result.status).toBe('failure'); // \oops is undefined, but a PDF is still produced
    expect(result.outputFiles.map((f) => f.name)).toEqual(
      expect.arrayContaining(['output.pdf', 'output.log', 'output.synctex.gz', 'output.blg']),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        file: 'chapters/one.tex',
        line: 2,
        message: 'Undefined control sequence.',
      }),
    );

    const pdf = await request(env.app, alice, 'GET', `/api/projects/${p.id}/builds/${result.buildId}/output.pdf`);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const fwd = await request(env.app, alice, 'GET', `/api/projects/${p.id}/builds/${result.buildId}/synctex/code`, {
      query: { file: 'chapters/one.tex', line: '2' },
    });
    expect(fwd.json().boxes[0].page).toBe(1);
  });
});

if (!ready) it.skip(`needs Docker and ${IMAGE}`, () => undefined);
