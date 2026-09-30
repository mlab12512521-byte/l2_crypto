import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import type { CompileDiagnostic, CompileResult, Compiler, CompileStatus } from '@texcollab/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { AppError, badRequest, conflict } from '../../lib/errors.js';
import type { BlobStore } from '../../storage/blob-store.js';
import type { StoragePaths } from '../../storage/paths.js';
import type { FileService } from '../files/service.js';
import { snapshotProject } from '../files/snapshot.js';
import type { SettingsService } from '../settings/service.js';
import { extractOutputs, packProject } from './archive.js';
import { parseBlg, parseTexLog } from './log-parser.js';
import type { WorkerPool } from './worker-client.js';

const MAX_OUTPUT_ENTRY_BYTES = 512 * 1024 * 1024;

interface BuildRow {
  id: string;
  engine: Compiler;
  status: CompileStatus | 'running';
  started_at: Date;
  duration_ms: number | null;
  output_files: unknown;
  diagnostics: unknown;
  message: string | null;
}

export function toCompileResult(row: BuildRow): CompileResult {
  return {
    buildId: row.id,
    status: row.status === 'running' ? 'error' : row.status,
    message: row.message,
    durationMs: row.duration_ms ?? 0,
    startedAt: row.started_at.toISOString(),
    engine: row.engine,
    outputFiles: (row.output_files as CompileResult['outputFiles']) ?? [],
    diagnostics: (row.diagnostics as CompileDiagnostic[]) ?? [],
  };
}

/** Listeners notified when a build finishes (e.g. to tell collaborators to refresh the PDF). */
export type CompileListener = (projectId: string, result: CompileResult) => void;

/**
 * Orchestrates compilations: snapshot → tar → worker → stored outputs +
 * parsed diagnostics. At most one compilation per project runs at a time.
 */
export class CompileService {
  private readonly running = new Set<string>();
  private readonly listeners: CompileListener[] = [];

  constructor(
    private readonly db: Db,
    private readonly files: FileService,
    private readonly blobs: BlobStore,
    private readonly paths: StoragePaths,
    private readonly settings: SettingsService,
    private readonly workers: WorkerPool,
    private readonly log: Logger,
  ) {}

  onCompiled(fn: CompileListener): void {
    this.listeners.push(fn);
  }

  isRunning(projectId: string): boolean {
    return this.running.has(projectId);
  }

  async compile(projectId: string, userId: string, opts: { draft?: boolean } = {}): Promise<CompileResult> {
    if (!this.workers.configured) {
      throw new AppError(503, 'compile_unavailable', 'Compilation is not configured on this server');
    }
    if (this.running.has(projectId)) {
      throw conflict('A compilation of this project is already running');
    }
    this.running.add(projectId);
    try {
      return await this.run(projectId, userId, opts);
    } finally {
      this.running.delete(projectId);
    }
  }

  private async run(projectId: string, userId: string, opts: { draft?: boolean }): Promise<CompileResult> {
    const project = await this.db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', projectId)
      .executeTakeFirstOrThrow();
    const snapshot = await snapshotProject(this.files, projectId);
    const main = snapshot.files.find((f) => f.entityId === project.main_file_id);
    if (main?.kind !== 'doc') {
      throw badRequest('Choose a main .tex file to compile (right-click a file → "Set as main file")');
    }
    const limits = await this.settings.get('compileLimits');
    const buildId = randomUUID();
    const started = new Date();
    await this.db
      .insertInto('compile_builds')
      .values({
        id: buildId,
        project_id: projectId,
        requested_by: userId,
        engine: project.compiler,
        main_file: main.path,
        status: 'running',
        started_at: started,
      })
      .execute();

    let status: CompileStatus = 'error';
    let message: string | null = null;
    let outputFiles: Array<{ name: string; size: number }> = [];
    let diagnostics: CompileDiagnostic[] = [];
    let durationMs = 0;
    const archive = await packProject(snapshot, this.blobs, this.paths.importTmpDir);
    try {
      const outcome = await this.workers.compile(
        {
          id: buildId,
          engine: project.compiler,
          mainFile: main.path,
          timeoutSeconds: limits.timeoutSeconds,
          memoryMb: limits.memoryMb,
          cpus: limits.cpus,
          draft: opts.draft ?? false,
        },
        archive,
      );
      if (outcome.kind === 'busy') {
        status = 'error';
        message = 'All compile workers are busy; please try again shortly.';
      } else if (outcome.kind === 'unavailable') {
        this.log.error({ projectId, error: outcome.error }, 'no compile worker available');
        status = 'error';
        message = 'The compile service is unavailable. Please contact an administrator.';
      } else if (outcome.kind === 'sandbox-failure') {
        durationMs = outcome.durationMs;
        status = outcome.outcome === 'timeout' ? 'timeout' : 'error';
        message =
          outcome.outcome === 'oom'
            ? 'Compilation ran out of memory.'
            : outcome.outcome === 'timeout'
              ? `Compilation exceeded the time limit of ${limits.timeoutSeconds} seconds.`
              : 'The compile sandbox failed. Please contact an administrator.';
      } else {
        durationMs = outcome.durationMs;
        const dir = this.paths.buildDir(projectId, buildId);
        outputFiles = await extractOutputs(outcome.archive, dir, MAX_OUTPUT_ENTRY_BYTES);
        const sandbox = await this.readStatus(dir);
        diagnostics = await this.diagnostics(dir, snapshot);
        const hasPdf = outputFiles.some((f) => f.name === 'output.pdf');
        if (outcome.outcome === 'timeout' || sandbox.result === 'timeout') {
          status = 'timeout';
          message = `Compilation exceeded the time limit of ${limits.timeoutSeconds} seconds.`;
        } else if (outcome.outcome === 'output-too-large') {
          status = 'error';
          message = 'The compilation produced too much output.';
        } else if (sandbox.result === 'success') {
          status = 'success';
        } else if (sandbox.result === 'failure') {
          status = 'failure';
          message = hasPdf ? 'Compiled with errors.' : 'Compilation failed; no PDF was produced.';
        } else {
          status = 'error';
          message = sandbox.message || 'The compilation could not be run.';
        }
        // Keep only files clients may download.
        outputFiles = outputFiles.filter((f) => f.name !== 'status.json');
      }
    } finally {
      await rm(archive.file, { force: true });
    }

    const row = await this.db
      .updateTable('compile_builds')
      .set({
        status,
        message,
        finished_at: new Date(),
        duration_ms: durationMs,
        output_files: JSON.stringify(outputFiles),
        diagnostics: JSON.stringify(diagnostics),
      })
      .where('id', '=', buildId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.pruneBuilds(projectId, limits.keepBuilds);
    const result = toCompileResult(row);
    for (const fn of this.listeners) fn(projectId, result);
    return result;
  }

  private async readStatus(dir: string): Promise<{ result: string; message: string }> {
    try {
      const s = JSON.parse(await readFile(`${dir}/status.json`, 'utf8')) as { result?: unknown; message?: unknown };
      return { result: String(s.result ?? 'error'), message: String(s.message ?? '') };
    } catch {
      return { result: 'error', message: 'The sandbox did not report a status' };
    }
  }

  private async diagnostics(
    dir: string,
    snapshot: Awaited<ReturnType<typeof snapshotProject>>,
  ): Promise<CompileDiagnostic[]> {
    const byPath = new Map(snapshot.files.map((f) => [f.path, f.entityId]));
    const read = async (name: string) => readFile(`${dir}/${name}`, 'utf8').catch(() => '');
    const raw = [...parseTexLog(await read('output.log')), ...parseBlg(await read('output.blg'))];
    return raw.map((d) => ({ ...d, entityId: d.file ? (byPath.get(d.file) ?? null) : null }));
  }

  private async pruneBuilds(projectId: string, keep: number): Promise<void> {
    const old = await this.db
      .selectFrom('compile_builds')
      .select('id')
      .where('project_id', '=', projectId)
      .orderBy('started_at', 'desc')
      .offset(keep)
      .limit(1000)
      .execute();
    for (const b of old) {
      await rm(this.paths.buildDir(projectId, b.id), { recursive: true, force: true });
      await this.db.deleteFrom('compile_builds').where('id', '=', b.id).execute();
    }
  }

  async latest(projectId: string): Promise<CompileResult | null> {
    const row = await this.db
      .selectFrom('compile_builds')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('status', '!=', 'running')
      .orderBy('started_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ? toCompileResult(row) : null;
  }

  async getBuild(projectId: string, buildId: string): Promise<CompileResult | null> {
    if (!/^[0-9a-f-]{36}$/.test(buildId)) return null;
    const row = await this.db
      .selectFrom('compile_builds')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('id', '=', buildId)
      .executeTakeFirst();
    return row ? toCompileResult(row) : null;
  }

  /** Mark builds left "running" by a crashed process as errors (called at startup). */
  async failStaleBuilds(): Promise<void> {
    await this.db
      .updateTable('compile_builds')
      .set({ status: 'error', message: 'Interrupted by a server restart', finished_at: new Date() })
      .where('status', '=', 'running')
      .execute();
  }
}
