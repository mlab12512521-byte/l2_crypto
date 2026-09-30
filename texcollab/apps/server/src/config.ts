import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Application configuration, loaded once from environment variables.
 *
 * Every secret can alternatively be supplied as a file by setting
 * `<NAME>_FILE` (Docker secrets convention). Secrets are never logged.
 */

const booleanString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Port for /metrics; bound separately so it is never exposed through the proxy. */
  METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
  /** Externally visible base URL, e.g. https://latex.example.org. Used for Origin checks and cookie flags. */
  PUBLIC_URL: z.string().url(),
  /** Full connection string; alternatively give the DB_* parts below (password via DB_PASSWORD_FILE). */
  DATABASE_URL: z.string().min(1).optional(),
  DB_HOST: z.string().default('db'),
  DB_PORT: z.coerce.number().int().default(5432),
  DB_USER: z.string().default('texcollab'),
  DB_NAME: z.string().default('texcollab'),
  DB_PASSWORD: z.string().optional(),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(200).default(20),
  /** Master secret (>= 32 chars). Used to derive encryption keys for secrets stored in the database. */
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),
  /** Root of persistent file storage (blobs, git repositories, build outputs). */
  DATA_DIR: z.string().default('/data'),
  /** Directory containing the built SPA; empty to disable static serving (e.g. in development). */
  WEB_DIST_DIR: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Number of reverse proxies in front of the app whose X-Forwarded-For can be trusted. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce
    .number()
    .int()
    .min(5)
    .default(60 * 24 * 7),
  SESSION_ABSOLUTE_TIMEOUT_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .default(24 * 30),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).default(10),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),
  /** Requests per minute per IP for authentication endpoints. */
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  /** Optional bootstrap admin, created only when the users table is empty. */
  INITIAL_ADMIN_USERNAME: z.string().optional(),
  INITIAL_ADMIN_PASSWORD: z.string().optional(),
  INITIAL_ADMIN_EMAIL: z.string().optional(),
  RUN_MIGRATIONS_ON_START: booleanString.default(true),
  /** Comma-separated base URLs of compile workers, e.g. http://compile-worker:8080 */
  COMPILE_WORKERS: z.string().default(''),
  /** Shared secret authenticating requests to compile workers (>= 32 chars). */
  WORKER_SECRET: z.string().optional(),
  /** PEM bundle of extra CAs trusted for HTTPS Git remotes (e.g. an internal GitLab). */
  GIT_CA_BUNDLE: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  host: string;
  port: number;
  metricsPort: number;
  publicUrl: URL;
  /** Origin (scheme://host[:port]) that browsers must send on state-changing requests. */
  publicOrigin: string;
  /** Whether cookies are marked Secure (true whenever PUBLIC_URL is https). */
  secureCookies: boolean;
  databaseUrl: string;
  databasePoolSize: number;
  appSecret: string;
  dataDir: string;
  webDistDir: string;
  logLevel: Env['LOG_LEVEL'];
  trustProxyHops: number;
  session: {
    idleTimeoutMs: number;
    absoluteTimeoutMs: number;
  };
  login: {
    maxFailures: number;
    lockoutMs: number;
    rateLimitPerMinute: number;
  };
  initialAdmin?: { username: string; password: string; email?: string };
  runMigrationsOnStart: boolean;
  compile: {
    workers: string[];
    workerSecret: string | null;
  };
  git: {
    caBundle: string | null;
  };
}

const SECRET_VARS = ['DATABASE_URL', 'DB_PASSWORD', 'APP_SECRET', 'INITIAL_ADMIN_PASSWORD', 'WORKER_SECRET'] as const;

/** Resolve `<NAME>_FILE` indirections for secret variables. */
function resolveFileSecrets(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...source };
  for (const name of SECRET_VARS) {
    const filePath = source[`${name}_FILE`];
    if (filePath && !source[name]) {
      out[name] = readFileSync(filePath, 'utf8').trim();
    }
  }
  return out;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(resolveFileSecrets(source));
  if (!parsed.success) {
    // Report variable names and messages only, never values.
    const details = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  const e = parsed.data;
  if (e.COMPILE_WORKERS.trim() && (!e.WORKER_SECRET || e.WORKER_SECRET.length < 32)) {
    throw new Error(
      'Invalid configuration:\n  WORKER_SECRET (>= 32 characters) is required when COMPILE_WORKERS is set',
    );
  }
  let databaseUrl = e.DATABASE_URL;
  if (!databaseUrl) {
    if (!e.DB_PASSWORD)
      throw new Error('Invalid configuration:\n  DATABASE_URL or DB_PASSWORD/DB_PASSWORD_FILE is required');
    const u = new URL('postgres://placeholder');
    u.hostname = e.DB_HOST;
    u.port = String(e.DB_PORT);
    u.username = encodeURIComponent(e.DB_USER);
    u.password = encodeURIComponent(e.DB_PASSWORD);
    u.pathname = `/${encodeURIComponent(e.DB_NAME)}`;
    databaseUrl = u.toString();
  }
  const publicUrl = new URL(e.PUBLIC_URL);
  if (e.NODE_ENV === 'production' && publicUrl.protocol !== 'https:') {
    // Allowed (e.g. a TLS-terminating proxy on a trusted LAN), but warn loudly at startup.
    process.emitWarning('PUBLIC_URL is not https: session cookies will not be marked Secure.');
  }
  let initialAdmin: AppConfig['initialAdmin'];
  if (e.INITIAL_ADMIN_USERNAME && e.INITIAL_ADMIN_PASSWORD) {
    initialAdmin = {
      username: e.INITIAL_ADMIN_USERNAME,
      password: e.INITIAL_ADMIN_PASSWORD,
      ...(e.INITIAL_ADMIN_EMAIL ? { email: e.INITIAL_ADMIN_EMAIL } : {}),
    };
  }
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    metricsPort: e.METRICS_PORT,
    publicUrl,
    publicOrigin: publicUrl.origin,
    secureCookies: publicUrl.protocol === 'https:',
    databaseUrl,
    databasePoolSize: e.DATABASE_POOL_SIZE,
    appSecret: e.APP_SECRET,
    dataDir: e.DATA_DIR,
    webDistDir: e.WEB_DIST_DIR,
    logLevel: e.LOG_LEVEL,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    session: {
      idleTimeoutMs: e.SESSION_IDLE_TIMEOUT_MINUTES * 60_000,
      absoluteTimeoutMs: e.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3_600_000,
    },
    login: {
      maxFailures: e.LOGIN_MAX_FAILURES,
      lockoutMs: e.LOGIN_LOCKOUT_MINUTES * 60_000,
      rateLimitPerMinute: e.AUTH_RATE_LIMIT_PER_MINUTE,
    },
    ...(initialAdmin ? { initialAdmin } : {}),
    runMigrationsOnStart: e.RUN_MIGRATIONS_ON_START,
    compile: {
      workers: parseWorkerUrls(e.COMPILE_WORKERS),
      workerSecret: e.WORKER_SECRET ?? null,
    },
    git: { caBundle: e.GIT_CA_BUNDLE ?? null },
  };
}

function parseWorkerUrls(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:')
        throw new Error('Invalid configuration:\n  COMPILE_WORKERS must be http(s) URLs');
      return u.origin;
    });
}
