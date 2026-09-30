import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { AuthProvider } from '../auth/AuthContext';

export interface MockRoute {
  method?: string;
  path: string;
  status?: number;
  body?: unknown;
}

/** Install a fetch mock answering from a route table; returns the mock for call assertions. */
export function mockFetch(routes: MockRoute[]) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const route = routes.find((r) => r.path === url.pathname && (r.method ?? 'GET') === method);
    const status = route?.status ?? (route ? 200 : 404);
    const body = route ? route.body : { error: { code: 'not_found', message: 'Not found' } };
    return new Response(status === 204 ? null : JSON.stringify(body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

export function renderApp(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>{ui}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
