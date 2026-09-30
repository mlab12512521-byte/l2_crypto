import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { BODY_HASH_HEADER, SIGNATURE_HEADER, sign, TIMESTAMP_HEADER } from '@texcollab/shared/node';

export interface WorkerHealth {
  url: string;
  ok: boolean;
  status: string;
  running?: number;
  queued?: number;
  concurrency?: number;
  maxQueued?: number;
  latencyMs?: number;
  error?: string;
}

export interface WorkerJob {
  id: string;
  engine: string;
  mainFile: string;
  timeoutSeconds: number;
  memoryMb: number;
  cpus: number;
  draft: boolean;
}

export type WorkerOutcome =
  | { kind: 'output'; archive: Buffer; outcome: string; durationMs: number }
  | { kind: 'sandbox-failure'; outcome: string; durationMs: number }
  | { kind: 'busy' }
  | { kind: 'unavailable'; error: string };

/** Talks to compile workers over HTTP with signed requests; picks workers round-robin. */
export class WorkerPool {
  private next = 0;

  constructor(
    private readonly urls: string[],
    private readonly secret: string | null,
  ) {}

  get configured(): boolean {
    return this.urls.length > 0 && this.secret !== null;
  }

  get workerUrls(): string[] {
    return [...this.urls];
  }

  async health(): Promise<WorkerHealth[]> {
    return Promise.all(
      this.urls.map(async (url) => {
        const started = Date.now();
        try {
          const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
          const body = (await res.json()) as Record<string, unknown>;
          return {
            url,
            ok: res.ok,
            status: String(body.status ?? res.status),
            running: Number(body.running ?? 0),
            queued: Number(body.queued ?? 0),
            concurrency: Number(body.concurrency ?? 0),
            maxQueued: Number(body.maxQueued ?? 0),
            latencyMs: Date.now() - started,
          };
        } catch (err) {
          return { url, ok: false, status: 'unreachable', error: (err as Error).message };
        }
      }),
    );
  }

  /** Try workers in round-robin order until one accepts the job. */
  async compile(job: WorkerJob, archive: { file: string; sha256: string; size: number }): Promise<WorkerOutcome> {
    if (!this.configured) return { kind: 'unavailable', error: 'No compile workers are configured' };
    let lastError = 'no worker reachable';
    let sawBusy = false;
    for (let attempt = 0; attempt < this.urls.length; attempt++) {
      const url = this.urls[this.next++ % this.urls.length]!;
      const query: Record<string, string> = {
        id: job.id,
        engine: job.engine,
        main: job.mainFile,
        timeout: String(job.timeoutSeconds),
        memoryMb: String(job.memoryMb),
        cpus: String(job.cpus),
        draft: job.draft ? '1' : '0',
      };
      const timestamp = String(Date.now());
      const signature = sign(this.secret!, {
        method: 'POST',
        path: '/compile',
        query,
        timestamp,
        bodySha256: archive.sha256,
      });
      try {
        const res = await fetch(`${url}/compile?${new URLSearchParams(query)}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-tar',
            'content-length': String(archive.size),
            [TIMESTAMP_HEADER]: timestamp,
            [SIGNATURE_HEADER]: signature,
            [BODY_HASH_HEADER]: archive.sha256,
          },
          body: Readable.toWeb(createReadStream(archive.file)) as ReadableStream,
          duplex: 'half',
          // Queue wait + compile time; the worker enforces the compile limit itself.
          signal: AbortSignal.timeout((job.timeoutSeconds + 600) * 1000),
        } as RequestInit);
        if (res.status === 503) {
          sawBusy = true;
          await res.body?.cancel();
          continue;
        }
        const outcome = res.headers.get('x-compile-outcome') ?? 'unknown';
        const durationMs = Number(res.headers.get('x-duration-ms') ?? 0);
        if (!res.ok) {
          lastError = `worker ${url} answered ${res.status}: ${(await res.text()).slice(0, 200)}`;
          continue;
        }
        if (res.headers.get('content-type')?.includes('application/x-tar')) {
          return { kind: 'output', archive: Buffer.from(await res.arrayBuffer()), outcome, durationMs };
        }
        await res.body?.cancel();
        return { kind: 'sandbox-failure', outcome, durationMs };
      } catch (err) {
        lastError = `worker ${url}: ${(err as Error).message}`;
      }
    }
    return sawBusy ? { kind: 'busy' } : { kind: 'unavailable', error: lastError };
  }
}
