import { createServer, type Server } from 'node:http';
import type pg from 'pg';
import client from 'prom-client';
import type { Db } from './db/index.js';

/**
 * Prometheus metrics. Served on a separate port (METRICS_PORT) that is not
 * published through the reverse proxy, so no authentication is needed.
 * Labels never contain user or project identifiers.
 */
export class Metrics {
  readonly registry = new client.Registry();
  private readonly httpRequests: client.Counter<'method' | 'route' | 'status'>;
  private readonly httpDuration: client.Histogram<'method' | 'route'>;
  private readonly compilations: client.Counter<'status'>;
  private readonly compileDuration: client.Histogram<'status'>;

  constructor(
    db: Db,
    collab: () => { connections: number; users: number; documents: number },
    workers: () => Promise<Array<{ url: string; ok: boolean; running?: number; queued?: number }>>,
  ) {
    const registers = [this.registry];
    client.collectDefaultMetrics({ register: this.registry, prefix: 'texcollab_' });
    this.httpRequests = new client.Counter({
      name: 'texcollab_http_requests_total',
      help: 'HTTP requests by route template and status code',
      labelNames: ['method', 'route', 'status'],
      registers,
    });
    this.httpDuration = new client.Histogram({
      name: 'texcollab_http_request_duration_seconds',
      help: 'HTTP request duration by route template',
      labelNames: ['method', 'route'],
      buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 10, 60],
      registers,
    });
    this.compilations = new client.Counter({
      name: 'texcollab_compilations_total',
      help: 'Finished compilations by result',
      labelNames: ['status'],
      registers,
    });
    this.compileDuration = new client.Histogram({
      name: 'texcollab_compilation_duration_seconds',
      help: 'Compilation duration by result',
      labelNames: ['status'],
      buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300],
      registers,
    });
    new client.Gauge({
      name: 'texcollab_collab_connections',
      help: 'Open real-time collaboration connections',
      registers,
      collect() {
        this.set(collab().connections);
      },
    });
    new client.Gauge({
      name: 'texcollab_collab_documents',
      help: 'Documents loaded in the collaboration hub',
      registers,
      collect() {
        this.set(collab().documents);
      },
    });
    new client.Gauge({
      name: 'texcollab_collab_users',
      help: 'Users with at least one open collaboration connection',
      registers,
      collect() {
        this.set(collab().users);
      },
    });
    // One health request per worker and scrape; shared by the three gauges below.
    let pending: ReturnType<typeof workers> | null = null;
    const workerHealth = () => {
      pending ??= workers().finally(() => {
        pending = null;
      });
      return pending;
    };
    new client.Gauge({
      name: 'texcollab_compile_worker_up',
      help: 'Whether a compile worker answers its health check (1) or not (0)',
      labelNames: ['worker'],
      registers,
      async collect() {
        this.reset();
        for (const w of await workerHealth()) this.set({ worker: w.url }, w.ok ? 1 : 0);
      },
    });
    new client.Gauge({
      name: 'texcollab_compile_worker_running',
      help: 'Compilations running on a worker',
      labelNames: ['worker'],
      registers,
      async collect() {
        this.reset();
        for (const w of await workerHealth()) if (w.ok) this.set({ worker: w.url }, w.running ?? 0);
      },
    });
    new client.Gauge({
      name: 'texcollab_compile_worker_queued',
      help: 'Compilations waiting on a worker',
      labelNames: ['worker'],
      registers,
      async collect() {
        this.reset();
        for (const w of await workerHealth()) if (w.ok) this.set({ worker: w.url }, w.queued ?? 0);
      },
    });
    new client.Gauge({
      name: 'texcollab_users',
      help: 'User accounts by source and state',
      labelNames: ['source', 'state'],
      registers,
      async collect() {
        const rows = await db
          .selectFrom('users')
          .select(['auth_source', 'is_disabled', (eb) => eb.fn.countAll<string>().as('n')])
          .groupBy(['auth_source', 'is_disabled'])
          .execute();
        this.reset();
        for (const r of rows)
          this.set({ source: r.auth_source, state: r.is_disabled ? 'disabled' : 'active' }, Number(r.n));
      },
    });
    new client.Gauge({
      name: 'texcollab_projects',
      help: 'Projects',
      registers,
      async collect() {
        const r = await db
          .selectFrom('projects')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow();
        this.set(Number(r.n));
      },
    });
  }

  /** Expose PostgreSQL pool usage (called by the server entry, which owns the pool). */
  addPool(pool: pg.Pool): void {
    new client.Gauge({
      name: 'texcollab_db_pool_connections',
      help: 'PostgreSQL pool connections by state',
      labelNames: ['state'],
      registers: [this.registry],
      collect() {
        this.set({ state: 'total' }, pool.totalCount);
        this.set({ state: 'idle' }, pool.idleCount);
        this.set({ state: 'waiting' }, pool.waitingCount);
      },
    });
  }

  observeRequest(method: string, route: string, status: number, seconds: number): void {
    this.httpRequests.inc({ method, route, status: String(status) });
    this.httpDuration.observe({ method, route }, seconds);
  }

  observeCompile(status: string, seconds: number): void {
    this.compilations.inc({ status });
    this.compileDuration.observe({ status }, seconds);
  }

  /** Serve GET /metrics on its own port. */
  listen(host: string, port: number): Promise<Server> {
    const server = createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      this.registry
        .metrics()
        .then((body) => res.writeHead(200, { 'content-type': this.registry.contentType }).end(body))
        .catch(() => res.writeHead(500).end());
    });
    return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
  }
}
