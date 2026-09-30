import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from '../test/utils';
import { ApiError, api, setCsrfToken } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

describe('api client', () => {
  it('sends the CSRF token on state-changing requests only', async () => {
    const fetchMock = mockFetch([
      { method: 'POST', path: '/api/x', body: { ok: true } },
      { method: 'GET', path: '/api/y', body: { ok: true } },
    ]);
    setCsrfToken('tok123');
    await api.post('/api/x', { a: 1 });
    await api.get('/api/y');
    const postHeaders = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    const getHeaders = fetchMock.mock.calls[1]![1]!.headers as Record<string, string>;
    expect(postHeaders['x-csrf-token']).toBe('tok123');
    expect(postHeaders['content-type']).toBe('application/json');
    expect(getHeaders['x-csrf-token']).toBeUndefined();
    expect(fetchMock.mock.calls[0]![1]!.credentials).toBe('same-origin');
  });

  it('turns error bodies into ApiError', async () => {
    mockFetch([
      {
        method: 'POST',
        path: '/api/x',
        status: 400,
        body: { error: { code: 'bad_request', message: 'Nope', fields: { name: 'Required' } } },
      },
    ]);
    const err = await api.post('/api/x', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'bad_request', message: 'Nope', fields: { name: 'Required' } });
  });

  it('encodes query parameters and skips empty ones', async () => {
    const fetchMock = mockFetch([{ path: '/api/users', body: [] }]);
    await api.get('/api/users', { query: { q: 'a b&c', empty: '', limit: 5 } });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/users?q=a+b%26c&limit=5');
  });
});
