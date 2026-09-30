import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BODY_HASH_HEADER,
  ReplayGuard,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifySignature,
} from '@texcollab/shared/node';
import type { WorkerConfig } from './config.js';
import type { Logger } from './log.js';
import { JobQueue, QueueFullError } from './queue.js';
import { dockerAvailable, runSandbox } from './runner.js';
import { clampJob, ENGINES, type Engine, isSafeMainFile } from './sandbox.js';

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(data.length), ...headers });
  res.end(data);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Receive the request body into a temp file, hashing and size-capping it on the way. */
async function receiveBody(req: IncomingMessage, file: string, maxBytes: number): Promise<string> {
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _e, cb) {
      size += chunk.length;
      if (size > maxBytes) return cb(new HttpError(413, 'project archive too large'));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(req, meter, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  return hash.digest('hex');
}

export function createWorkerServer(cfg: WorkerConfig, log: Logger): { server: Server; queue: JobQueue } {
  const queue = new JobQueue(cfg.maxConcurrency, cfg.maxQueue);
  const replay = new ReplayGuard();

  const handleCompile = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const query = Object.fromEntries(url.searchParams.entries());
    const timestamp = String(req.headers[TIMESTAMP_HEADER] ?? '');
    const signature = String(req.headers[SIGNATURE_HEADER] ?? '');
    const bodySha256 = String(req.headers[BODY_HASH_HEADER] ?? '');
    // Authenticate before accepting any body bytes.
    if (!verifySignature(cfg.secret, { method: 'POST', path: url.pathname, query, timestamp, bodySha256 }, signature)) {
      throw new HttpError(401, 'invalid signature');
    }
    if (!replay.check(signature)) throw new HttpError(401, 'replayed request');

    const engine = query.engine as Engine;
    if (!ENGINES.includes(engine)) throw new HttpError(400, 'invalid engine');
    const mainFile = query.main ?? '';
    if (!isSafeMainFile(mainFile)) throw new HttpError(400, 'invalid main file');
    const id = query.id ?? '';
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, 'invalid job id');
    const job = clampJob(
      cfg,
      {
        engine,
        mainFile,
        draft: query.draft === '1',
        timeoutSeconds: Number(query.timeout ?? 60) || 60,
        memoryMb: Number(query.memoryMb ?? 1024) || 1024,
        cpus: Number(query.cpus ?? 1) || 1,
      },
      id,
    );

    const input = path.join(cfg.tmpDir, `texcollab-in-${randomUUID()}.tar`);
    try {
      const actual = await receiveBody(req, input, cfg.maxInputBytes);
      if (actual !== bodySha256) throw new HttpError(400, 'body hash mismatch');
      const result = await queue.submit(() => runSandbox(cfg, job, input));
      log.info(
        { job: job.id, engine: job.engine, exitCode: result.exitCode, killed: result.killed, ms: result.durationMs },
        'compile finished',
      );
      if (result.exitCode !== 0 && result.output.length === 0) {
        // The sandbox itself failed (image missing, docker error, OOM before output...).
        const oom = result.exitCode === 137 && !result.killed;
        log.warn({ job: job.id, stderr: result.stderr.slice(0, 2000) }, 'sandbox failed');
        send(
          res,
          200,
          { error: oom ? 'out of memory' : result.killed ? 'timeout' : 'sandbox failure' },
          {
            'x-compile-outcome': oom ? 'oom' : result.killed ? 'timeout' : 'sandbox-error',
            'x-duration-ms': String(result.durationMs),
          },
        );
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/x-tar',
        'content-length': String(result.output.length),
        'x-compile-outcome': result.outputTruncated ? 'output-too-large' : result.killed ? 'timeout' : 'completed',
        'x-duration-ms': String(result.durationMs),
      });
      res.end(result.output);
    } finally {
      await rm(input, { force: true });
    }
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://worker');
    const done = (err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        if (err.status >= 400) req.resume();
        send(res, err.status, { error: err.message });
      } else if (err instanceof QueueFullError) {
        send(res, 503, { error: 'busy' }, { 'retry-after': '5' });
      } else {
        log.error({ err: String(err) }, 'request failed');
        send(res, 500, { error: 'internal error' });
      }
    };
    if (req.method === 'GET' && url.pathname === '/health') {
      dockerAvailable(cfg).then(
        (docker) => send(res, docker ? 200 : 503, { status: docker ? 'ok' : 'docker-unavailable', ...queue.stats }),
        done,
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/compile') {
      handleCompile(req, res, url).catch(done);
      return;
    }
    send(res, 404, { error: 'not found' });
  });
  server.requestTimeout = 0; // compiles can take minutes; the sandbox enforces its own limits
  server.headersTimeout = 30_000;
  return { server, queue };
}
