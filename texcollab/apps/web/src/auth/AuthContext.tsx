import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CurrentUser, MeResponse } from '@texcollab/shared';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo } from 'react';
import { ApiError, api, setCsrfToken, setUnauthorizedHandler } from '../api/client';

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  /** Store the result of login/registration. */
  signedIn: (me: MeResponse) => void;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export const ME_QUERY_KEY = ['auth', 'me'] as const;

async function fetchMe(): Promise<MeResponse | null> {
  try {
    const me = await api.get<MeResponse>('/api/auth/me');
    setCsrfToken(me.csrfToken);
    return me;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setCsrfToken(null);
      return null;
    }
    throw err;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ME_QUERY_KEY, queryFn: fetchMe, staleTime: 5 * 60_000, retry: 1 });

  const signedIn = useCallback(
    (data: MeResponse) => {
      setCsrfToken(data.csrfToken);
      qc.setQueryData(ME_QUERY_KEY, data);
    },
    [qc],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      setCsrfToken(null);
      qc.clear();
      qc.setQueryData(ME_QUERY_KEY, null);
    }
  }, [qc]);

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
  }, [qc]);

  useEffect(() => {
    // A 401 anywhere means the session ended (expired, revoked, user disabled).
    setUnauthorizedHandler(() => {
      setCsrfToken(null);
      qc.setQueryData(ME_QUERY_KEY, null);
    });
    return () => setUnauthorizedHandler(null);
  }, [qc]);

  const value = useMemo<AuthState>(
    () => ({ user: me.data?.user ?? null, loading: me.isLoading, signedIn, logout, refresh }),
    [me.data, me.isLoading, signedIn, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
