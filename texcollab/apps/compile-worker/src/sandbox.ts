import type { WorkerConfig } from './config.js';

export const ENGINES = ['pdflatex', 'xelatex', 'lualatex'] as const;
export type Engine = (typeof ENGINES)[number];

export interface CompileJob {
  id: string;
  engine: Engine;
  mainFile: string;
  timeoutSeconds: number;
  memoryMb: number;
  cpus: number;
  draft: boolean;
}

/** Validate the relative path of the main file (the sandbox re-checks it). */
export function isSafeMainFile(p: string): boolean {
  if (p.length === 0 || p.length > 1024) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  for (const ch of p) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false; // control characters
  }
  if (p.split('/').some((s) => s === '' || s === '.' || s === '..')) return false;
  return /\.(tex|ltx|latex)$/i.test(p);
}

export function containerName(jobId: string): string {
  return `texcollab-compile-${jobId}`;
}

/**
 * The complete `docker run` argument vector for one compilation. Nothing in
 * here is taken verbatim from the request except values already validated
 * against strict patterns (job id, engine enum, main-file path, clamped numbers).
 */
export function dockerRunArgs(cfg: WorkerConfig, job: CompileJob): string[] {
  const args = [
    'run',
    '--rm',
    '--interactive',
    `--name=${containerName(job.id)}`,
    '--label=texcollab.compile=1',
    // Isolation
    '--network=none',
    '--read-only',
    `--tmpfs=/work:rw,nosuid,nodev,noexec,size=${cfg.tmpfsSizeMb}m,mode=1777`,
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=256m,mode=1777',
    // Only exec-allowed writable mount: biber's unpacked runtime (see docker/texlive/biber-wrapper.sh).
    '--tmpfs=/par:rw,nosuid,nodev,exec,size=256m,mode=1777',
    '--user=10000:10000',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    // Private IPC/PID/UTS namespaces are Docker's defaults; IPC is set explicitly.
    '--ipc=private',
    '--hostname=sandbox',
    // Resources
    `--memory=${job.memoryMb}m`,
    `--memory-swap=${job.memoryMb}m`,
    `--cpus=${job.cpus}`,
    `--pids-limit=${cfg.pidsLimit}`,
    '--ulimit=nofile=1024:1024',
    '--ulimit=nproc=512:512',
    `--ulimit=fsize=${Math.min(cfg.tmpfsSizeMb, 1024) * 1024 * 1024}`,
    '--ulimit=core=0',
    `--stop-timeout=2`,
    // No logs kept by the Docker daemon; outputs come back through stdout.
    '--log-driver=none',
    // No inherited environment.
    '--env=LANG=C.UTF-8',
  ];
  if (cfg.runtime) args.push(`--runtime=${cfg.runtime}`);
  args.push(cfg.image, job.engine, job.mainFile, String(job.timeoutSeconds), job.draft ? '1' : '0');
  return args;
}

export function clampJob(cfg: WorkerConfig, requested: Omit<CompileJob, 'id'>, id: string): CompileJob {
  return {
    id,
    engine: requested.engine,
    mainFile: requested.mainFile,
    draft: requested.draft,
    timeoutSeconds: Math.max(5, Math.min(Math.floor(requested.timeoutSeconds), cfg.maxTimeoutSeconds)),
    memoryMb: Math.max(128, Math.min(Math.floor(requested.memoryMb), cfg.maxMemoryMb)),
    cpus: Math.max(0.1, Math.min(requested.cpus, cfg.maxCpus)),
  };
}
