import { useMutation } from '@tanstack/react-query';
import type { MeResponse } from '@texcollab/shared';
import { type FormEvent, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner, Field, fieldErrors } from '../components/ui';

export function RegisterPage() {
  const { user, signedIn } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ username: '', displayName: '', email: '', password: '' });
  const register = useMutation({
    mutationFn: () => api.post<MeResponse>('/api/auth/register', { ...form, email: form.email.trim() || undefined }),
    onSuccess: (me) => {
      signedIn(me);
      navigate('/', { replace: true });
    },
  });
  if (user) return <Navigate to="/" replace />;
  const errors = fieldErrors(register.error);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    register.mutate();
  };
  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={submit} noValidate>
        <h1 className="auth-title">Create account</h1>
        <ErrorBanner error={register.error} />
        <Field
          label="Username"
          autoComplete="username"
          value={form.username}
          onChange={set('username')}
          error={errors.username}
        />
        <Field
          label="Display name"
          autoComplete="name"
          value={form.displayName}
          onChange={set('displayName')}
          error={errors.displayName}
        />
        <Field
          label="E-mail (optional)"
          type="email"
          autoComplete="email"
          value={form.email}
          onChange={set('email')}
          error={errors.email}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={set('password')}
          error={errors.password}
          hint="At least 10 characters. A passphrase of several words works well."
        />
        <button className="btn btn-primary btn-block" type="submit" disabled={register.isPending}>
          Create account
        </button>
        <p className="auth-alt">
          Already registered? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
