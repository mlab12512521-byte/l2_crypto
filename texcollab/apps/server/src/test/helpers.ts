import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CSRF_HEADER, type MeResponse } from '@texcollab/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { buildApp } from '../app.js';
import { type AppConfig, loadConfig } from '../config.js';
import { type AppContext, createContext, initStorage } from '../context.js';
import { createDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { createLogger } from '../logger.js';

/**
 * Integration-test harness: every test file gets a brand-new PostgreSQL
 * database (created from TEST_DATABASE_URL's server), fully migrated, and a
 * Fastify app driven through `inject()` (no network).
 */

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://texcollab:texcollab@127.0.0.1:5432/postgres';

export const PUBLIC_URL = 'http://texcollab.test';

export interface TestEnv {
  app: FastifyInstance;
  ctx: AppContext;
  config: AppConfig;
  close: () => Promise<void>;
}

export function testConfig(overrides: Record<string, string> = {}, databaseUrl = 'postgres://unused'): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    PUBLIC_URL,
    DATABASE_URL: databaseUrl,
    APP_SECRET: 'test-secret-test-secret-test-secret-000',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

export async function createTestEnv(overrides: Record<string, string> = {}): Promise<TestEnv> {
  const dbName = `texcollab_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${dbName}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), 'texcollab-data-'));
  const config = testConfig({ DATA_DIR: dataDir, ...overrides }, url.toString());
  const log = createLogger('silent');
  const { db, pool } = createDb(config.databaseUrl, 5);
  await migrate(pool);
  const ctx = createContext(config, db, log);
  await initStorage(ctx);
  const app = await buildApp(ctx);
  await app.ready();

  return {
    app,
    ctx,
    config,
    close: async () => {
      await app.close();
      await db.destroy();
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await c.end();
      const { rm } = await import('node:fs/promises');
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** A logged-in browser-like client: holds the session cookie and CSRF token. */
export interface Client {
  cookie: string;
  csrf: string;
  me: MeResponse;
}

export function sessionCookieFrom(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const session = list.find((c) => c.startsWith('texcollab_session=') || c.startsWith('__Host-texcollab_session='));
  if (!session) throw new Error('no session cookie in response');
  return session.split(';')[0]!;
}

export async function login(app: FastifyInstance, username: string, password: string): Promise<Client> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { [CSRF_HEADER]: '1', origin: PUBLIC_URL },
    payload: { username, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const me = res.json<MeResponse>();
  return { cookie: sessionCookieFrom(res), csrf: me.csrfToken, me };
}

export interface RequestOptions {
  payload?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** Omit the CSRF header (to test CSRF protection). */
  noCsrf?: boolean;
}

/** Issue a request as a client, the way the SPA would (cookie + CSRF header + same Origin). */
export function request(
  app: FastifyInstance,
  client: Client | null,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  opts: RequestOptions = {},
) {
  const headers: Record<string, string> = { origin: PUBLIC_URL, ...opts.headers };
  if (client) headers.cookie = client.cookie;
  if (!opts.noCsrf && method !== 'GET') headers[CSRF_HEADER] = client?.csrf ?? '1';
  return app.inject({
    method,
    url,
    headers,
    ...(opts.payload !== undefined ? { payload: opts.payload as object } : {}),
    ...(opts.query ? { query: opts.query } : {}),
  });
}

export const STRONG_PASSWORD = 'correct horse battery staple';

let counter = 0;
export async function createUser(
  ctx: AppContext,
  opts: { username?: string; isAdmin?: boolean; password?: string; mustChangePassword?: boolean } = {},
) {
  counter += 1;
  const username = opts.username ?? `user${counter}_${randomBytes(3).toString('hex')}`;
  const user = await ctx.users.createLocalUser({
    username,
    displayName: `User ${username}`,
    email: `${username}@example.test`,
    password: opts.password ?? STRONG_PASSWORD,
    isAdmin: opts.isAdmin ?? false,
    mustChangePassword: opts.mustChangePassword ?? false,
  });
  return { user, username, password: opts.password ?? STRONG_PASSWORD };
}

/** Create a project as `client` through the API and return its details. */
export async function createProject(app: FastifyInstance, client: Client, name = 'Test project', template = 'article') {
  const res = await request(app, client, 'POST', '/api/projects', { payload: { name, template } });
  if (res.statusCode !== 201) throw new Error(`create project failed: ${res.statusCode} ${res.body}`);
  return res.json<import('@texcollab/shared').ProjectDetails>();
}

/** Add a membership directly (the sharing API arrives in a later phase). */
export async function addMember(ctx: AppContext, projectId: string, userId: string, role: 'editor' | 'viewer') {
  await ctx.db
    .insertInto('project_members')
    .values({ project_id: projectId, user_id: userId, role, added_by: null })
    .execute();
}

/** Upload raw bytes the way the SPA does. */
export function upload(
  app: FastifyInstance,
  client: Client,
  url: string,
  data: Buffer | string,
  query: Record<string, string>,
) {
  return app.inject({
    method: 'POST',
    url,
    query,
    headers: {
      origin: PUBLIC_URL,
      cookie: client.cookie,
      [CSRF_HEADER]: client.csrf,
      'content-type': 'application/octet-stream',
    },
    payload: typeof data === 'string' ? Buffer.from(data) : data,
  });
}

/** Start the app on a random local port (for WebSocket tests). Returns the port. */
export async function listen(env: TestEnv): Promise<number> {
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = env.app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('not listening');
  return addr.port;
}

/** Poll until `fn` returns a truthy value (or throw after `timeoutMs`). */
export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 5000, what = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
