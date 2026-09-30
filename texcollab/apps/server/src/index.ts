import { buildApp } from './app.js';
import { ensureInitialAdmin } from './bootstrap.js';
import { loadConfig } from './config.js';
import { createContext, initStorage } from './context.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { startBackgroundJobs } from './jobs.js';
import { createLogger, LogRingBuffer } from './logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const ring = new LogRingBuffer();
  const log = createLogger(config.logLevel, ring);
  const { db, pool } = createDb(config.databaseUrl, config.databasePoolSize);

  if (config.runMigrationsOnStart) {
    const applied = await migrate(pool, log);
    if (applied.length) log.info({ applied }, 'database migrations applied');
  }

  const ctx = createContext(config, db, log, ring);
  await initStorage(ctx);
  await ensureInitialAdmin(ctx);
  const app = await buildApp(ctx);
  const stopJobs = startBackgroundJobs(ctx);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    // Hard deadline so a stuck connection cannot block container restarts forever.
    setTimeout(() => process.exit(1), 25_000).unref();
    stopJobs();
    try {
      await app.close();
      await db.destroy();
    } catch (err) {
      log.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  // Configuration errors are expected operator mistakes: print them plainly.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
