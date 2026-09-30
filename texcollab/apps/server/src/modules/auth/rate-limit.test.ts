import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestEnv, request, type TestEnv } from '../../test/helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv({ AUTH_RATE_LIMIT_PER_MINUTE: '3' });
});
afterAll(async () => {
  await env.close();
});

it('rate-limits login attempts per client', async () => {
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) {
    const res = await request(env.app, null, 'POST', '/api/auth/login', {
      payload: { username: 'someone', password: 'some-password' },
    });
    codes.push(res.statusCode);
  }
  expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
  expect(codes[3]).toBe(429);
  expect(codes[4]).toBe(429);
});
