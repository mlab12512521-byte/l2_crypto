import { useMutation, useQuery } from '@tanstack/react-query';
import type { MeResponse } from '@texcollab/shared';
import { type FormEvent, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner, Field } from '../components/ui';

export function LoginPage() {
  const { user, signedIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const config = useQuery({
    queryKey: ['auth', 'config'],
    queryFn: () => api.get<{ registrationEnabled: boolean }>('/api/auth/config'),
  });

  const login = useMutation({
    mutationFn: () => api.post<MeResponse>('/api/auth/login', { username, password }),
    onSuccess: (me) => {
      signedIn(me);
      navigate(me.user.mustChangePassword ? '/change-password' : from, { replace: true });
    },
    onError: () => setPassword(''),
  });

  if (user) return <Navigate to={from} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={submit} noValidate>
        <h1 className="auth-title">
          <span className="brand-mark">TeX</span>Collab
        </h1>
        <p className="muted">Sign in with your organisation account.</p>
        <ErrorBanner error={login.error} />
        <Field
          label="Username"
          name="username"
          autoComplete="username"
          autoFocus
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button
          className="btn btn-primary btn-block"
          type="submit"
          disabled={login.isPending || !username || !password}
        >
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
        {config.data?.registrationEnabled && (
          <p className="auth-alt">
            No account? <Link to="/register">Create one</Link>
          </p>
        )}
      </form>
    </div>
  );
}
