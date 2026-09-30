import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';

export interface WorkerConfig {
  host: string;
  port: number;
  secret: string;
  image: string;
  dockerBin: string;
  /** Optional OCI runtime, e.g. "runsc" for gVisor. */
  runtime: string | null;
  maxConcurrency: number;
  maxQueue: number;
  /** Upper bounds; the app's requested limits are clamped to these. */
  maxTimeoutSeconds: number;
  maxMemoryMb: number;
  maxCpus: number;
  tmpfsSizeMb: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  pidsLimit: number;
  tmpDir: string;
  logLevel: string;
}

function num(v: string | undefined, def: number, min: number, max: number, name: string): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new Error(`Invalid configuration: ${name} must be between ${min} and ${max}`);
  return n;
}

function secret(env: NodeJS.ProcessEnv): string {
  const s = env.WORKER_SECRET ?? (env.WORKER_SECRET_FILE ? readFileSync(env.WORKER_SECRET_FILE, 'utf8').trim() : '');
  if (s.length < 32)
    throw new Error('Invalid configuration: WORKER_SECRET (or WORKER_SECRET_FILE) must be at least 32 characters');
  return s;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const image = env.COMPILE_IMAGE ?? 'texcollab/texlive:latest';
  if (!/^[a-z0-9][a-z0-9._/:@-]*$/i.test(image)) throw new Error('Invalid configuration: COMPILE_IMAGE');
  const runtime = env.DOCKER_RUNTIME?.trim() || null;
  if (runtime && !/^[a-z0-9._-]+$/i.test(runtime)) throw new Error('Invalid configuration: DOCKER_RUNTIME');
  return {
    host: env.HOST ?? '0.0.0.0',
    port: num(env.PORT, 8080, 1, 65535, 'PORT'),
    secret: secret(env),
    image,
    dockerBin: env.DOCKER_BIN ?? 'docker',
    runtime,
    maxConcurrency: num(env.MAX_CONCURRENCY, Math.max(1, Math.floor(cpus().length / 2)), 1, 256, 'MAX_CONCURRENCY'),
    maxQueue: num(env.MAX_QUEUE, 50, 0, 10_000, 'MAX_QUEUE'),
    maxTimeoutSeconds: num(env.MAX_TIMEOUT_SECONDS, 300, 5, 3600, 'MAX_TIMEOUT_SECONDS'),
    maxMemoryMb: num(env.MAX_MEMORY_MB, 4096, 128, 262_144, 'MAX_MEMORY_MB'),
    maxCpus: num(env.MAX_CPUS, 4, 0.1, 256, 'MAX_CPUS'),
    tmpfsSizeMb: num(env.WORK_TMPFS_MB, 1024, 64, 65_536, 'WORK_TMPFS_MB'),
    maxInputBytes: num(env.MAX_INPUT_MB, 1024, 1, 65_536, 'MAX_INPUT_MB') * 1024 * 1024,
    maxOutputBytes: num(env.MAX_OUTPUT_MB, 256, 1, 16_384, 'MAX_OUTPUT_MB') * 1024 * 1024,
    pidsLimit: num(env.PIDS_LIMIT, 256, 32, 32_768, 'PIDS_LIMIT'),
    tmpDir: env.WORKER_TMP_DIR ?? '/tmp',
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
