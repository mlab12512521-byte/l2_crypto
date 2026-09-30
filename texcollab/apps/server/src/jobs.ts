import type { AppContext } from './context.js';

/**
 * Periodic maintenance. Each job is idempotent and safe to run on several
 * app instances at once.
 */
export function startBackgroundJobs(ctx: AppContext): () => void {
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
    const run = () => fn().catch((err: unknown) => ctx.log.error({ err, job: name }, 'background job failed'));
    timers.push(setInterval(run, ms).unref());
  };

  every(15 * 60_000, 'session-cleanup', async () => {
    const n = await ctx.sessions.deleteExpired();
    if (n > 0) ctx.log.info({ deleted: n }, 'deleted expired sessions');
  });

  return () => timers.forEach(clearInterval);
}
