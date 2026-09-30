import { loadWorkerConfig } from './config.js';
import { createLogger } from './log.js';
import { removeStaleContainers } from './runner.js';
import { createWorkerServer } from './server.js';

async function main() {
  const cfg = loadWorkerConfig();
  const log = createLogger(cfg.logLevel);
  await removeStaleContainers(cfg);
  const { server, queue } = createWorkerServer(cfg, log);
  server.listen(cfg.port, cfg.host, () =>
    log.info({ port: cfg.port, image: cfg.image, runtime: cfg.runtime, ...queue.stats }, 'compile worker listening'),
  );
  const stop = () => {
    log.info({}, 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 30_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
