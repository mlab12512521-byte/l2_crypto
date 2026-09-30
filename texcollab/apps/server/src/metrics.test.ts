import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createProject,
  createTestEnv,
  createUser,
  login,
  request,
  STRONG_PASSWORD,
  type TestEnv,
} from './test/helpers.js';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

describe('metrics', () => {
  it('counts requests by route template, never by id', async () => {
    const u = await createUser(env.ctx);
    const c = await login(env.app, u.username, STRONG_PASSWORD);
    const p = await createProject(env.app, c, 'Metrics');
    await request(env.app, c, 'GET', `/api/projects/${p.id}`);
    const text = await env.ctx.metrics.registry.metrics();
    expect(text).toMatch(/texcollab_http_requests_total\{method="GET",route="\/api\/projects\/:id",status="200"\} 1/);
    expect(text).not.toContain(p.id);
    expect(text).toMatch(/texcollab_users\{source="local",state="active"\} 1/);
    expect(text).toMatch(/texcollab_projects 1/);
    expect(text).toMatch(/texcollab_collab_connections 0/);
    expect(text).toContain('texcollab_process_cpu_seconds_total');
  });

  it('serves /metrics on its own port and nothing else', async () => {
    const server = await env.ctx.metrics.listen('127.0.0.1', 0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const ok = await fetch(`${base}/metrics`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toContain('text/plain');
      expect((await fetch(`${base}/`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('is not reachable through the public application port', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).not.toContain('texcollab_http_requests_total');
  });
});
