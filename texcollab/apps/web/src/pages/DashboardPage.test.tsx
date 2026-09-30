import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { mockFetch, renderApp } from '../test/utils';
import { DashboardPage } from './DashboardPage';

afterEach(() => vi.unstubAllGlobals());

const owner = { id: 'u1', username: 'alice', displayName: 'Alice' };
const bob = { id: 'u2', username: 'bob', displayName: 'Bob Builder' };
const now = new Date().toISOString();

it('lists owned and shared projects with owner-only actions', async () => {
  const fetchMock = mockFetch([
    {
      path: '/api/auth/me',
      body: {
        user: { ...owner, email: null, authSource: 'local', isAdmin: false, mustChangePassword: false },
        csrfToken: 'c',
      },
    },
    {
      path: '/api/projects',
      body: {
        items: [
          {
            id: 'p1',
            name: 'My paper',
            role: 'owner',
            owner,
            createdAt: now,
            lastModifiedAt: now,
            lastModifiedBy: owner,
            lastOpenedAt: null,
          },
          {
            id: 'p2',
            name: 'Bob thesis',
            role: 'viewer',
            owner: bob,
            createdAt: now,
            lastModifiedAt: now,
            lastModifiedBy: bob,
            lastOpenedAt: now,
          },
        ],
      },
    },
  ]);
  renderApp(<DashboardPage />);
  const mine = (await screen.findByText('My paper')).closest('tr')!;
  expect(within(mine).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  const shared = screen.getByText('Bob thesis').closest('tr')!;
  expect(within(shared).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  expect(within(shared).getByText('Bob Builder')).toBeInTheDocument();
  expect(within(shared).getByText('Read only')).toBeInTheDocument();

  await userEvent.setup().click(screen.getByRole('tab', { name: 'Shared with me' }));
  const lastUrl = String(fetchMock.mock.calls.at(-1)![0]);
  expect(lastUrl).toContain('filter=shared');
});
