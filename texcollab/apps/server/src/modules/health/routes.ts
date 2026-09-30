import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { AppContext } from '../../context.js';

/** Liveness and readiness probes for Docker/monitoring. No authentication, no details. */
export async function healthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/healthz', { logLevel: 'warn' }, async () => ({ status: 'ok' }));

  app.get('/readyz', { logLevel: 'warn' }, async (_req, reply) => {
    const checks: Record<string, boolean> = {};
    try {
      await sql`SELECT 1`.execute(ctx.db);
      checks.database = true;
    } catch {
      checks.database = false;
    }
    const ok = Object.values(checks).every(Boolean);
    reply.code(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', checks };
  });
}
