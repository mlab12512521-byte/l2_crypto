import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { ApiErrorBody } from '@texcollab/shared';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { registerAuthHooks } from './http/auth-hooks.js';
import { registerRawBodyParser } from './http/content.js';
import { AppError } from './lib/errors.js';
import { adminRoutes } from './modules/admin/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { collabRoutes } from './modules/collab/routes.js';
import { compileRoutes } from './modules/compile/routes.js';
import { fileRoutes } from './modules/files/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { projectRoutes } from './modules/projects/routes.js';

/** Build the HTTP application. Does not listen; callers (server entry, tests) decide. */
export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log as FastifyBaseLogger,
    // Trust X-Forwarded-For only from the configured number of proxy hops.
    trustProxy: (_addr: string, hop: number) => hop < ctx.config.trustProxyHops,
    bodyLimit: 1024 * 1024,
    // Request IDs appear in logs and error responses for support.
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 * 1024 } });

  registerSecurityHeaders(app, ctx);
  registerErrorHandling(app);
  registerAuthHooks(app, ctx);
  registerRawBodyParser(app);

  await app.register(async (api) => healthRoutes(api, ctx));
  await app.register(async (api) => collabRoutes(api, ctx));
  await app.register(async (api) => authRoutes(api, ctx), { prefix: '/api/auth' });
  await app.register(async (api) => adminRoutes(api, ctx), { prefix: '/api/admin' });
  await app.register(async (api) => projectRoutes(api, ctx), { prefix: '/api/projects' });
  await app.register(async (api) => fileRoutes(api, ctx), { prefix: '/api/projects' });
  await app.register(async (api) => compileRoutes(api, ctx), { prefix: '/api/projects' });

  await registerSpa(app, ctx);
  return app;
}

function registerSecurityHeaders(app: FastifyInstance, ctx: AppContext): void {
  const wsOrigin = ctx.config.publicOrigin.replace(/^http/, 'ws');
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    // CodeMirror injects editor styles at runtime.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${wsOrigin}`,
    // pdf.js renders in a worker created from a same-origin script or blob.
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', csp);
    if (ctx.config.secureCookies) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });
}

function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError | AppError>((err, req, reply) => {
    if (err instanceof AppError) {
      const body: ApiErrorBody = {
        error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) },
      };
      return reply.code(err.statusCode).send(body);
    }
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      // Framework-level client errors (bad JSON, body too large, rate limited...).
      const code =
        status === 429
          ? 'rate_limited'
          : status === 413
            ? 'payload_too_large'
            : (err.code ?? 'bad_request').toLowerCase();
      const message = status === 429 ? 'Too many requests; please slow down' : err.message;
      return reply.code(status).send({ error: { code, message } } satisfies ApiErrorBody);
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({
      error: { code: 'internal_error', message: `Internal server error (request ${req.id})` },
    } satisfies ApiErrorBody);
  });
}

async function registerSpa(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const dir = ctx.config.webDistDir ? path.resolve(ctx.config.webDistDir) : '';
  const indexExists = dir !== '' && existsSync(path.join(dir, 'index.html'));
  if (indexExists) {
    await app.register(fastifyStatic, {
      root: dir,
      // Hashed asset files can be cached forever; index.html must not be.
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.header('Cache-Control', 'no-cache');
        }
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url.startsWith('/api/') || req.url === '/api';
    if (!isApi && indexExists && req.method === 'GET') {
      // Client-side routes of the SPA.
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } } satisfies ApiErrorBody);
  });
}
