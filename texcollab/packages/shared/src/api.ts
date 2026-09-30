/** Shape of every error response body produced by the API. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** Optional per-field validation messages. */
    fields?: Record<string, string>;
  };
}

/** Header carrying the per-session CSRF token on state-changing requests. */
export const CSRF_HEADER = 'x-csrf-token';

export interface Paginated<T> {
  items: T[];
  total: number;
}
