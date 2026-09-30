import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';

/**
 * Hardened execution of the git CLI against a project's bare repository.
 *
 * - Arguments are passed as an array (no shell), never interpolated.
 * - System and global configuration are ignored, hooks are disabled, the
 *   `file://` and `ext::` transports are forbidden, and only https (and, if
 *   explicitly enabled, http) may be used for remotes.
 * - Terminal prompts are disabled; credentials come only from GIT_ASKPASS.
 */

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

const HARDENING = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'protocol.file.allow=never',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'core.symlinks=false',
  '-c',
  'credential.helper=',
  '-c',
  'gc.auto=0',
  '-c',
  'advice.detachedHead=false',
];

export interface RunOptions {
  input?: Buffer | string | Readable;
  env?: Record<string, string>;
  /** Exit codes that are not errors (e.g. 1 for merge-tree conflicts). */
  okCodes?: number[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export class GitRepo {
  constructor(readonly dir: string) {}

  static baseEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: '/nonexistent',
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: 'https',
      GIT_AUTHOR_NAME: 'TeXCollab',
      GIT_AUTHOR_EMAIL: 'texcollab@texcollab.invalid',
      GIT_COMMITTER_NAME: 'TeXCollab',
      GIT_COMMITTER_EMAIL: 'texcollab@texcollab.invalid',
      ...extra,
    };
  }

  async run(args: string[], opts: RunOptions = {}): Promise<GitResult> {
    const env = GitRepo.baseEnv(opts.env);
    const maxOut = opts.maxOutputBytes ?? 256 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      const child = spawn('git', [...HARDENING, `--git-dir=${this.dir}`, ...args], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      let outBytes = 0;
      let err = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs ?? 120_000);
      child.stdout.on('data', (c: Buffer) => {
        outBytes += c.length;
        if (outBytes > maxOut) {
          killed = true;
          child.kill('SIGKILL');
          return;
        }
        out.push(c);
      });
      child.stderr.on('data', (c: Buffer) => {
        if (err.length < 16_384) err += c.toString('utf8');
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const result = { code: code ?? -1, stdout: Buffer.concat(out), stderr: err };
        if (killed) return reject(new GitError(`git ${args[0]} was stopped (time or output limit)`, -1, err));
        if (result.code !== 0 && !(opts.okCodes ?? []).includes(result.code)) {
          return reject(
            new GitError(`git ${args[0]} failed: ${err.trim().split('\n').slice(-3).join(' ')}`, result.code, err),
          );
        }
        resolve(result);
      });
      child.stdin.on('error', () => undefined);
      const input = opts.input;
      if (input === undefined) child.stdin.end();
      else if (typeof input === 'string' || Buffer.isBuffer(input)) child.stdin.end(input);
      else input.pipe(child.stdin);
    });
  }

  async text(args: string[], opts: RunOptions = {}): Promise<string> {
    return (await this.run(args, opts)).stdout.toString('utf8');
  }

  async exists(): Promise<boolean> {
    return stat(this.dir).then(
      () => true,
      () => false,
    );
  }

  async init(): Promise<void> {
    if (await this.exists()) return;
    await mkdir(this.dir, { recursive: true, mode: 0o750 });
    await this.run(['init', '--bare', '--initial-branch=main', '--quiet', this.dir]);
  }

  /** Sha of a ref, or null if it does not exist. */
  async resolve(ref: string): Promise<string | null> {
    const r = await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { okCodes: [1, 128] });
    const sha = r.stdout.toString().trim();
    return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  async treeOf(commit: string): Promise<string> {
    return (await this.text(['rev-parse', `${commit}^{tree}`])).trim();
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const r = await this.run(['merge-base', '--is-ancestor', ancestor, descendant], { okCodes: [1] });
    return r.code === 0;
  }

  /** Files of a commit: path, blob sha, size, mode. */
  async listTree(
    commit: string,
  ): Promise<Array<{ path: string; sha: string; size: number; mode: string; type: string }>> {
    const out = await this.run(['ls-tree', '-r', '-z', '--long', '--full-tree', commit]);
    const items: Array<{ path: string; sha: string; size: number; mode: string; type: string }> = [];
    for (const rec of out.stdout.toString('utf8').split('\0')) {
      if (!rec) continue;
      const tab = rec.indexOf('\t');
      const [mode, type, sha, size] = rec.slice(0, tab).trim().split(/\s+/);
      items.push({
        path: rec.slice(tab + 1),
        mode: mode!,
        type: type!,
        sha: sha!,
        size: size === '-' ? 0 : Number(size),
      });
    }
    return items;
  }

  async readBlob(sha: string): Promise<Buffer> {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('invalid blob id');
    return (await this.run(['cat-file', 'blob', sha])).stdout;
  }

  /** Blob content of `path` at `commit`, or null if absent. */
  async readFileAt(commit: string, path: string): Promise<Buffer | null> {
    const r = await this.run(['cat-file', 'blob', `${commit}:${path}`], { okCodes: [128] });
    return r.code === 0 ? r.stdout : null;
  }
}
