import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { BODY_HASH_HEADER, SIGNATURE_HEADER, sign, TIMESTAMP_HEADER } from '@texcollab/shared/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadWorkerConfig, type WorkerConfig } from './config.js';
import { createLogger } from './log.js';
import { dockerRunArgs } from './sandbox.js';
import { createWorkerServer } from './server.js';

/**
 * Integration and isolation tests against real Docker and the sandbox image.
 * Build the image first:  docker build -t texcollab/texlive:dev docker/texlive
 * Skipped automatically when Docker or the image is unavailable.
 */

const IMAGE = process.env.COMPILE_TEST_IMAGE ?? 'texcollab/texlive:dev';
const SECRET = 'worker-test-secret-worker-test-secret-00';

function dockerReady(): boolean {
  const r = spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' });
  return r.status === 0;
}
const ready = dockerReady();
const d = ready ? describe : describe.skip;

// ---- minimal tar writer (ustar) for test projects
function tar(files: Record<string, string | Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? Buffer.from(content) : content;
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function untar(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(h.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim(), 8);
    out.set(name, buf.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

let cfg: WorkerConfig;
let baseUrl: string;
let close: () => Promise<void>;

async function compile(
  files: Record<string, string | Buffer>,
  params: Partial<Record<'engine' | 'main' | 'timeout' | 'memoryMb' | 'cpus', string>> = {},
  tamper?: (q: Record<string, string>) => void,
) {
  const body = tar(files);
  const query: Record<string, string> = {
    id: randomUUID(),
    engine: 'pdflatex',
    main: 'main.tex',
    timeout: '60',
    memoryMb: '1024',
    cpus: '1',
    draft: '0',
    ...params,
  };
  const timestamp = String(Date.now());
  const bodySha256 = createHash('sha256').update(body).digest('hex');
  const signature = sign(SECRET, { method: 'POST', path: '/compile', query, timestamp, bodySha256 });
  tamper?.(query);
  const res = await fetch(`${baseUrl}/compile?${new URLSearchParams(query)}`, {
    method: 'POST',
    headers: { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: signature, [BODY_HASH_HEADER]: bodySha256 },
    body,
  });
  const outcome = res.headers.get('x-compile-outcome');
  if (res.headers.get('content-type')?.includes('x-tar')) {
    const out = untar(Buffer.from(await res.arrayBuffer()));
    const status = JSON.parse(out.get('meta/status.json')?.toString() ?? '{}') as { result: string };
    return {
      http: res.status,
      outcome,
      out,
      status: status.result,
      log: out.get('project/output.log')?.toString() ?? '',
    };
  }
  return { http: res.status, outcome, out: new Map<string, Buffer>(), status: 'none', log: '', json: await res.json() };
}

const DOC = (body: string, preamble = '') =>
  `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;

beforeAll(async () => {
  if (!ready) return;
  cfg = {
    ...loadWorkerConfig({
      WORKER_SECRET: SECRET,
      COMPILE_IMAGE: IMAGE,
      MAX_CONCURRENCY: '2',
      MAX_TIMEOUT_SECONDS: '60',
      MAX_MEMORY_MB: '1024',
    }),
    port: 0,
    host: '127.0.0.1',
  };
  const { server } = createWorkerServer(cfg, createLogger('silent'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((r) => server.close(() => r()));
});

afterAll(async () => {
  await close?.();
});

d('compilation', () => {
  it('compiles with pdflatex and returns only whitelisted outputs', async () => {
    const r = await compile({ 'main.tex': DOC('Hello \\LaTeX.') });
    expect(r.http).toBe(200);
    expect(r.status).toBe('success');
    expect(r.out.get('project/output.pdf')!.subarray(0, 5).toString()).toBe('%PDF-');
    expect(
      [...r.out.keys()].every((k) =>
        /^(project\/output\.(pdf|log|synctex\.gz|blg)|meta\/(status\.json|latexmk\.log))$/.test(k),
      ),
    ).toBe(true);
  });

  it('runs BibTeX and multiple passes, with a main file in a subfolder', async () => {
    const r = await compile(
      {
        // Paths are relative to the project root (the compile directory), as in Overleaf.
        'src/paper.tex': DOC(
          'See~\\cite{k} and Section~\\ref{s}.\\section{S}\\label{s}\\bibliographystyle{plain}\\bibliography{refs}',
        ),
        'refs.bib': '@book{k, author={A. Author}, title={Title}, year={2000}, publisher={P}}',
      },
      { main: 'src/paper.tex' },
    );
    expect(r.status).toBe('success');
    expect(r.out.has('project/output.blg')).toBe(true);
    expect(r.log).not.toMatch(/Citation `k' .* undefined/);
  });

  it.each(['xelatex', 'lualatex'])('compiles with %s', async (engine) => {
    const r = await compile({ 'main.tex': DOC('Unicode äöü ∑', '\\usepackage{fontspec}') }, { engine });
    expect(r.status).toBe('success');
  });

  it('reports LaTeX errors as a failed build with a log', async () => {
    const r = await compile({ 'main.tex': DOC('\\undefinedcommand') });
    expect(r.status).toBe('failure');
    expect(r.log).toContain('Undefined control sequence');
  });
});

d('request authentication', () => {
  it('rejects tampered parameters and bad signatures', async () => {
    const r = await compile({ 'main.tex': DOC('x') }, {}, (q) => {
      q.timeout = '3600';
    });
    expect(r.http).toBe(401);
  });

  it('rejects requests without a signature', async () => {
    const res = await fetch(`${baseUrl}/compile?engine=pdflatex&main=main.tex`, { method: 'POST', body: 'x' });
    expect(res.status).toBe(401);
  });

  it.each([
    ['engine', 'sh'],
    ['main', '../main.tex'],
    ['main', '/etc/passwd.tex'],
    ['main', 'main.sh'],
    ['main', 'a/./main.tex'],
  ])('rejects invalid %s=%s', async (key, value) => {
    const r = await compile({ 'main.tex': DOC('x') }, { [key]: value });
    expect(r.http).toBe(400);
  });
});

d('sandbox isolation', () => {
  /** Run a shell script inside a container started with exactly the production flags. */
  function inSandbox(script: string): { code: number; out: string } {
    const args = dockerRunArgs(cfg, {
      id: randomUUID(),
      engine: 'pdflatex',
      mainFile: 'main.tex',
      timeoutSeconds: 30,
      memoryMb: 256,
      cpus: 1,
      draft: false,
    });
    const imageIdx = args.indexOf(IMAGE);
    const patched = [...args.slice(0, imageIdx), '--entrypoint=sh', IMAGE, '-c', script].filter(
      (a) => a !== '--interactive',
    );
    const r = spawnSync('docker', patched, { encoding: 'utf8', timeout: 60_000 });
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  }

  it('has no network access', () => {
    const r = inSandbox('cat /proc/net/dev | tail -n +3 | cut -d: -f1 | tr -d " "; ls /sys/class/net');
    expect(
      r.out
        .split(/\s+/)
        .filter(Boolean)
        .every((i) => i === 'lo'),
    ).toBe(true);
    const dns = inSandbox('getent hosts example.com && echo RESOLVED || echo NO_DNS');
    expect(dns.out).toContain('NO_DNS');
  });

  it('runs as an unprivileged user with no capabilities and no new privileges', () => {
    const r = inSandbox('id -u; grep -E "^(CapEff|CapPrm|CapBnd|NoNewPrivs)" /proc/self/status');
    expect(r.out).toMatch(/^10000/m);
    expect(r.out).toMatch(/CapEff:\s+0+$/m);
    expect(r.out).toMatch(/CapBnd:\s+0+$/m);
    expect(r.out).toMatch(/NoNewPrivs:\s+1$/m);
  });

  it('has a read-only root filesystem and noexec scratch space', () => {
    const r = inSandbox(
      'touch /usr/pwned 2>/dev/null && echo ROOT_WRITABLE; cp /bin/true /work/t && /work/t && echo WORK_EXEC; cp /bin/true /tmp/t && /tmp/t && echo TMP_EXEC; echo done',
    );
    expect(r.out).toContain('done');
    expect(r.out).not.toContain('ROOT_WRITABLE');
    expect(r.out).not.toContain('WORK_EXEC');
    expect(r.out).not.toContain('TMP_EXEC');
  });

  it('enforces memory and process limits', () => {
    // cgroup v2 paths first, then v1.
    const r = inSandbox(
      'cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes; cat /sys/fs/cgroup/pids.max 2>/dev/null || cat /sys/fs/cgroup/pids/pids.max',
    );
    expect(r.out).toContain(String(256 * 1024 * 1024));
    expect(r.out).toContain(String(cfg.pidsLimit));
  });

  it('does not expose host secrets or the Docker socket', () => {
    const r = inSandbox('env; ls -la /var/run/docker.sock 2>&1; ls /run/secrets 2>&1; mount | grep -c docker.sock');
    expect(r.out).not.toContain(SECRET);
    expect(r.out).not.toMatch(/WORKER_SECRET|APP_SECRET|DATABASE_URL/);
    expect(r.out).toMatch(/docker\.sock: No such file|cannot access/);
  });

  it('blocks \\write18 shell escape', async () => {
    const r = await compile({
      'main.tex': DOC('\\immediate\\write18{touch /work/project/pwned.txt}\\input{|"echo PIPED"}X'),
    });
    expect(r.log).toMatch(/runsystem\(touch .*\)\.\.\.disabled/);
    // Piped input is not executed: TeX looks for a file literally named like the command.
    expect(r.log).toContain('I can\'t find file `"|echo PIPED"\'');
    expect(r.out.has('project/pwned.txt')).toBe(false);
  });

  it('cannot read files of the host, only the image', async () => {
    // TeX primitives can read any file *inside the container* (kpathsea's
    // openin_any does not stop \\input of absolute paths), which is why the
    // container holds nothing but TeX Live and the project. Host files must be
    // unreachable.
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(`${tmpdir()}/texcollab-host-`);
    const marker = `HOST-MARKER-${randomUUID()}`;
    writeFileSync(`${dir}/secret.tex`, marker);
    try {
      const r = await compile({ 'main.tex': DOC(`\\input{${dir}/secret.tex}\\input{/etc/hostname}`) });
      expect(r.log).not.toContain(marker);
      expect(r.log).toMatch(/File `[^']*secret\.tex' not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps Lua code from executing programs or seeing secrets', async () => {
    const r = await compile(
      {
        'main.tex': DOC(
          '\\directlua{local ok = pcall(os.execute, "touch /work/project/lua-pwned"); texio.write_nl("EXEC=" .. tostring(os.execute == nil or not ok)); local p = io.popen and io.popen("id"); texio.write_nl("POPEN=" .. tostring(p == nil)); texio.write_nl("ENV=" .. tostring(os.getenv("WORKER_SECRET")))}',
        ),
      },
      { engine: 'lualatex' },
    );
    expect(r.log).toContain('ENV=nil');
    expect(r.out.has('project/lua-pwned')).toBe(false);
    expect(r.log).not.toContain('uid=');
  });

  it('stops infinite loops at the time limit', async () => {
    const started = Date.now();
    const r = await compile({ 'main.tex': DOC('\\def\\loop{\\loop}\\loop') }, { timeout: '8' });
    expect(Date.now() - started).toBeLessThan(40_000);
    expect(['timeout']).toContain(r.status === 'none' ? r.outcome : r.status);
  });

  it('contains memory exhaustion', async () => {
    const r = await compile(
      { 'main.tex': DOC('\\directlua{local t = {} for i = 1, 1e9 do t[i] = string.rep("x", 4096) .. i end}') },
      { engine: 'lualatex', memoryMb: '256', timeout: '30' },
    );
    expect(r.http).toBe(200);
    expect(r.status === 'success').toBe(false);
  });

  it('leaves no containers behind', () => {
    const left = execFileSync('docker', ['ps', '-aq', '--filter', 'label=texcollab.compile=1'], { encoding: 'utf8' });
    expect(left.trim()).toBe('');
  });
});

if (!ready) {
  it.skip(`sandbox tests need Docker and the image ${IMAGE}`, () => undefined);
}
