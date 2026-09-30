import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A throw-away HTTPS Git server for tests: `git http-backend` behind Node's
 * HTTPS server, with a self-signed certificate and HTTP Basic auth.
 */
export class TestGitServer {
  readonly dir = mkdtempSync(path.join(tmpdir(), 'texcollab-gitsrv-'));
  readonly certFile = path.join(this.dir, 'cert.pem');
  private server!: Server;
  port = 0;

  constructor(
    readonly username = 'tester',
    readonly token = 'secret-token-123',
  ) {}

  get url() {
    return `https://127.0.0.1:${this.port}/origin.git`;
  }

  get repoDir() {
    return path.join(this.dir, 'origin.git');
  }

  git(args: string[], cwd = this.dir): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: this.dir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Ext',
        GIT_AUTHOR_EMAIL: 'ext@example.org',
        GIT_COMMITTER_NAME: 'Ext',
        GIT_COMMITTER_EMAIL: 'ext@example.org',
      },
    });
  }

  async start(): Promise<void> {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-keyout',
        path.join(this.dir, 'key.pem'),
        '-out',
        this.certFile,
      ],
      { stdio: 'ignore' },
    );
    this.git(['init', '--bare', '--initial-branch=main', this.repoDir]);
    this.git(['config', 'http.receivepack', 'true'], this.repoDir);
    const expected = `Basic ${Buffer.from(`${this.username}:${this.token}`).toString('base64')}`;
    this.server = createServer(
      { key: readFileSync(path.join(this.dir, 'key.pem')), cert: readFileSync(this.certFile) },
      (req, res) => {
        if (req.headers.authorization !== expected) {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' }).end();
          return;
        }
        const url = new URL(req.url!, 'https://x');
        const cgi = spawn('git', ['http-backend'], {
          env: {
            PATH: process.env.PATH,
            GIT_PROJECT_ROOT: this.dir,
            GIT_HTTP_EXPORT_ALL: '1',
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            REQUEST_METHOD: req.method!,
            CONTENT_TYPE: req.headers['content-type'] ?? '',
            HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? ''),
            REMOTE_USER: this.username,
            REMOTE_ADDR: '127.0.0.1',
          },
        });
        req.pipe(cgi.stdin);
        const chunks: Buffer[] = [];
        cgi.stdout.on('data', (c: Buffer) => chunks.push(c));
        cgi.on('close', () => {
          const out = Buffer.concat(chunks);
          const sep = out.indexOf('\r\n\r\n');
          const head = out.subarray(0, sep).toString();
          const body = out.subarray(sep + 4);
          let status = 200;
          const headers: Record<string, string> = {};
          for (const line of head.split('\r\n')) {
            const i = line.indexOf(':');
            const k = line.slice(0, i).trim();
            const v = line.slice(i + 1).trim();
            if (k.toLowerCase() === 'status') status = Number(v.split(' ')[0]);
            else headers[k] = v;
          }
          res.writeHead(status, headers).end(body);
        });
      },
    );
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  /** Make a commit on the server's branch from an independent clone (like a colleague using GitHub). */
  commitExternally(files: Record<string, string>, message: string, branch = 'main'): void {
    const work = mkdtempSync(path.join(tmpdir(), 'texcollab-ext-'));
    try {
      this.git(['clone', '--quiet', '--branch', branch, this.repoDir, work]);
      for (const [p, content] of Object.entries(files)) {
        execFileSync('mkdir', ['-p', path.dirname(path.join(work, p))]);
        writeFileSync(path.join(work, p), content);
      }
      this.git(['add', '-A'], work);
      this.git(['commit', '--quiet', '-m', message], work);
      this.git(['push', '--quiet', 'origin', `HEAD:${branch}`], work);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  fileOnServer(p: string, branch = 'main'): string | null {
    try {
      return this.git(['show', `${branch}:${p}`], this.repoDir);
    } catch {
      return null;
    }
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
    rmSync(this.dir, { recursive: true, force: true });
  }
}
