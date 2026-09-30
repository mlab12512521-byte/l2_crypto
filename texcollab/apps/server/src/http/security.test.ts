import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Client,
  createTestEnv,
  createUser,
  login,
  PUBLIC_URL,
  request,
  STRONG_PASSWORD,
  type TestEnv,
} from '../test/helpers.js';

let env: TestEnv;
let client: Client;

beforeAll(async () => {
  env = await createTestEnv();
  const { username } = await createUser(env.ctx);
  client = await login(env.app, username, STRONG_PASSWORD);
});
afterAll(async () => {
  await env.close();
});

describe('CSRF protection', () => {
  const payload = { currentPassword: STRONG_PASSWORD, newPassword: 'irrelevant passphrase' };

  it('rejects state-changing requests without the CSRF header', async () => {
    const res = await request(env.app, client, 'POST', '/api/auth/password', { payload, noCsrf: true });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_failed');
  });

  it('rejects a CSRF token that does not belong to the session', async () => {
    const res = await request(env.app, client, 'POST', '/api/auth/password', {
      payload,
      noCsrf: true,
      headers: { 'x-csrf-token': 'not-the-token' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects foreign Origin headers', async () => {
    const res = await request(env.app, client, 'POST', '/api/auth/logout', {
      headers: { origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    // Session still valid.
    expect((await request(env.app, client, 'GET', '/api/auth/me')).statusCode).toBe(200);
  });

  it('rejects cross-site fetch metadata', async () => {
    const res = await request(env.app, client, 'POST', '/api/auth/logout', {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('requires the header even for unauthenticated login (login CSRF)', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: PUBLIC_URL },
      payload: { username: 'a', password: 'b' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows safe methods without a token', async () => {
    const res = await request(env.app, client, 'GET', '/api/auth/me');
    expect(res.statusCode).toBe(200);
  });
});

describe('response hardening', () => {
  it('sets security headers on API responses', async () => {
    const res = await request(env.app, client, 'GET', '/api/auth/me');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(String(res.headers['content-security-policy'])).toContain("script-src 'self'");
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const res = await request(env.app, client, 'GET', '/api/does-not-exist');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('rejects oversized JSON bodies', async () => {
    const res = await request(env.app, null, 'POST', '/api/auth/login', {
      payload: { username: 'x'.repeat(2 * 1024 * 1024), password: 'y' },
    });
    expect(res.statusCode).toBe(413);
  });

  it('does not leak internals for invalid JSON', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', 'x-csrf-token': '1', origin: PUBLIC_URL },
      payload: '{"username": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('node_modules');
  });

  it('health endpoints respond without authentication', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const ready = await env.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks.database).toBe(true);
  });
});
