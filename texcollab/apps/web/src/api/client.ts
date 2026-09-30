import { type ApiErrorBody, CSRF_HEADER } from '@texcollab/shared';

/**
 * Thin typed wrapper around fetch for the TeXCollab API.
 * - Sends cookies (same origin) and the per-session CSRF token.
 * - Converts error responses into ApiError with the server's code/message.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Called when any request reports that the session is gone. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function apiRequest<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    body = opts.body;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  if (method !== 'GET') headers[CSRF_HEADER] = csrfToken ?? 'none';

  const res = await fetch(buildUrl(path, opts.query), {
    method,
    headers,
    body,
    credentials: 'same-origin',
    signal: opts.signal,
  });

  if (res.status === 204) return undefined as T;
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const payload: unknown = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const err = (payload as Partial<ApiErrorBody>)?.error;
    if (res.status === 401 && onUnauthorized && !path.startsWith('/api/auth/login')) onUnauthorized();
    throw new ApiError(
      res.status,
      err?.code ?? 'http_error',
      err?.message ?? `Request failed (${res.status})`,
      err?.fields,
    );
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => apiRequest<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => apiRequest<T>('POST', path, { ...opts, body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => apiRequest<T>('PUT', path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => apiRequest<T>('PATCH', path, { ...opts, body }),
  delete: <T>(path: string, opts?: RequestOptions) => apiRequest<T>('DELETE', path, opts),
};
