import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import type { WorkerConfig } from './config.js';
import { type CompileJob, containerName, dockerRunArgs } from './sandbox.js';

export interface RunResult {
  /** Exit code of `docker run` (the container's exit code, or docker's own error code). */
  exitCode: number | null;
  /** Tar archive written by the sandbox entrypoint. */
  output: Buffer;
  /** Diagnostic output from docker (truncated). */
  stderr: string;
  /** Wall-clock limit hit and the container was killed from outside. */
  killed: boolean;
  outputTruncated: boolean;
  durationMs: number;
}

const STDERR_LIMIT = 64 * 1024;
/** Grace period on top of the in-container timeout before the worker kills the container. */
const OUTER_GRACE_MS = 20_000;

/** Run one compilation in a fresh sandbox container, feeding `inputPath` (a tar) on stdin. */
export function runSandbox(cfg: WorkerConfig, job: CompileJob, inputPath: string): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cfg.dockerBin, dockerRunArgs(cfg, job), {
      stdio: ['pipe', 'pipe', 'pipe'],
      // The docker CLI needs no secrets from our environment.
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
      },
    });
    const chunks: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;
    let stderr = '';
    let killed = false;

    const kill = () => {
      killed = true;
      spawn(cfg.dockerBin, ['kill', containerName(job.id)], { stdio: 'ignore' }).on('error', () => undefined);
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    };

    child.stdout.on('data', (c: Buffer) => {
      if (outBytes + c.length > cfg.maxOutputBytes) {
        if (!truncated) kill(); // Output limit exceeded: stop the container.
        truncated = true;
        return;
      }
      outBytes += c.length;
      chunks.push(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += c.toString('utf8').slice(0, STDERR_LIMIT - stderr.length);
    });

    const input = createReadStream(inputPath);
    input.pipe(child.stdin);
    child.stdin.on('error', () => undefined); // container may exit before reading everything
    input.on('error', () => child.stdin.destroy());

    const timer = setTimeout(kill, job.timeoutSeconds * 1000 + OUTER_GRACE_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        output: Buffer.alloc(0),
        stderr: String(err),
        killed,
        outputTruncated: truncated,
        durationMs: Date.now() - started,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        output: Buffer.concat(chunks),
        stderr,
        killed,
        outputTruncated: truncated,
        durationMs: Date.now() - started,
      });
    });
  });
}

/** Remove containers left over from a previous worker process (e.g. after a crash). */
export function removeStaleContainers(cfg: WorkerConfig): Promise<void> {
  return new Promise((resolve) => {
    const ps = spawn(cfg.dockerBin, ['ps', '-aq', '--filter', 'label=texcollab.compile=1'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let ids = '';
    ps.stdout.on('data', (c: Buffer) => {
      ids += c.toString();
    });
    ps.on('error', () => resolve());
    ps.on('close', () => {
      const list = ids.split(/\s+/).filter((x) => /^[0-9a-f]{6,64}$/.test(x));
      if (list.length === 0) return resolve();
      spawn(cfg.dockerBin, ['rm', '-f', ...list], { stdio: 'ignore' })
        .on('close', () => resolve())
        .on('error', () => resolve());
    });
  });
}

/** Cheap liveness probe of the Docker daemon. */
export function dockerAvailable(cfg: WorkerConfig): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(cfg.dockerBin, ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' });
    const t = setTimeout(() => {
      p.kill('SIGKILL');
      resolve(false);
    }, 5000);
    p.on('error', () => {
      clearTimeout(t);
      resolve(false);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve(code === 0);
    });
  });
}
