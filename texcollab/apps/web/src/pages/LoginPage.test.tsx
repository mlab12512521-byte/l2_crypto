import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { RequireAuth } from '../auth/guards';
import { mockFetch, renderApp } from '../test/utils';
import { LoginPage } from './LoginPage';

afterEach(() => vi.unstubAllGlobals());

const me = {
  user: {
    id: 'u1',
    username: 'alice',
    email: null,
    displayName: 'Alice',
    authSource: 'local',
    isAdmin: false,
    mustChangePassword: false,
  },
  csrfToken: 'csrf',
};

function routes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <div>Dashboard content</div>
          </RequireAuth>
        }
      />
      <Route
        path="/change-password"
        element={
          <RequireAuth>
            <div>Change password screen</div>
          </RequireAuth>
        }
      />
    </Routes>
  );
}

it('redirects anonymous users to the login page', async () => {
  mockFetch([
    {
      path: '/api/auth/me',
      status: 401,
      body: { error: { code: 'unauthorized', message: 'Authentication required' } },
    },
    { path: '/api/auth/config', body: { registrationEnabled: false } },
  ]);
  renderApp(routes(), { route: '/' });
  expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  expect(screen.queryByText('Dashboard content')).not.toBeInTheDocument();
});

it('shows the server error on failed login and clears the password', async () => {
  mockFetch([
    { path: '/api/auth/me', status: 401, body: { error: { code: 'unauthorized', message: 'x' } } },
    { path: '/api/auth/config', body: { registrationEnabled: false } },
    {
      method: 'POST',
      path: '/api/auth/login',
      status: 401,
      body: { error: { code: 'invalid_credentials', message: 'Invalid username or password' } },
    },
  ]);
  renderApp(routes(), { route: '/login' });
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Username'), 'alice');
  await user.type(screen.getByLabelText('Password'), 'wrong password');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password');
  expect(screen.getByLabelText('Password')).toHaveValue('');
});

it('signs in and lands on the dashboard', async () => {
  mockFetch([
    { path: '/api/auth/me', status: 401, body: { error: { code: 'unauthorized', message: 'x' } } },
    { path: '/api/auth/config', body: { registrationEnabled: true } },
    { method: 'POST', path: '/api/auth/login', body: me },
  ]);
  renderApp(routes(), { route: '/login' });
  const user = userEvent.setup();
  expect(await screen.findByText('Create one')).toBeInTheDocument();
  await user.type(screen.getByLabelText('Username'), 'alice');
  await user.type(screen.getByLabelText('Password'), 'correct horse battery');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(screen.getByText('Dashboard content')).toBeInTheDocument());
});

it('forces a pending password change before anything else', async () => {
  mockFetch([{ path: '/api/auth/me', body: { ...me, user: { ...me.user, mustChangePassword: true } } }]);
  renderApp(routes(), { route: '/' });
  expect(await screen.findByText('Change password screen')).toBeInTheDocument();
});
