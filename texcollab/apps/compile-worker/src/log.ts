/** Minimal structured JSON logger (the worker has no other dependencies). */
export interface Logger {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

const LEVELS: Record<string, number> = { debug: 20, info: 30, warn: 40, error: 50, silent: 100 };

export function createLogger(level: string): Logger {
  const min = LEVELS[level] ?? 30;
  const write = (lvl: number, name: string, fields: Record<string, unknown>, msg: string) => {
    if (lvl < min) return;
    process.stdout.write(
      `${JSON.stringify({ time: new Date().toISOString(), level: lvl, levelName: name, service: 'texcollab-compile-worker', msg, ...fields })}\n`,
    );
  };
  return {
    info: (f, m) => write(30, 'info', f, m),
    warn: (f, m) => write(40, 'warn', f, m),
    error: (f, m) => write(50, 'error', f, m),
  };
}
