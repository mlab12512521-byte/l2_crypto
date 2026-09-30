import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { mockFetch, renderApp } from '../../test/utils';
import { ShareDialog } from './ShareDialog';

afterEach(() => vi.unstubAllGlobals());

const u = (id: string, name: string) => ({ id, username: name.toLowerCase(), displayName: name });
const project = {
  id: 'p1',
  name: 'Paper',
  role: 'owner' as const,
  owner: u('me', 'Me'),
  createdAt: '',
  lastModifiedAt: '',
  lastModifiedBy: null,
  lastOpenedAt: null,
  compiler: 'pdflatex' as const,
  mainFileId: null,
  rootFolderId: 'r',
};

it('lets the owner find people, change roles and invite by e-mail', async () => {
  const fetchMock = mockFetch([
    { path: '/api/auth/me', status: 401, body: { error: { code: 'unauthorized', message: 'x' } } },
    {
      path: '/api/projects/p1/members',
      body: {
        members: [
          { user: u('me', 'Me'), role: 'owner', addedAt: '' },
          { user: u('b', 'Bob'), role: 'viewer', addedAt: '' },
        ],
        invitations: [
          { id: 'i1', email: 'x@example.org', role: 'editor', invitedBy: null, createdAt: '', expiresAt: '' },
        ],
      },
    },
    { path: '/api/users/search', body: { items: [u('c', 'Carol')] } },
    { method: 'POST', path: '/api/projects/p1/members', status: 201, body: { kind: 'member' } },
    { method: 'PATCH', path: '/api/projects/p1/members/b', body: { ok: true } },
  ]);
  renderApp(<ShareDialog project={project} meId="me" onClose={() => undefined} />);
  const user = userEvent.setup();
  expect(await screen.findByText('Bob')).toBeInTheDocument();
  expect(screen.getByText('x@example.org')).toBeInTheDocument();

  await user.type(screen.getByLabelText('Name, username or e-mail address'), 'car');
  await user.click(await screen.findByRole('button', { name: /Carol/ }));
  await user.click(screen.getByRole('button', { name: 'Share' }));
  await waitFor(() => {
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post![1]!.body))).toEqual({ userId: 'c', role: 'editor' });
  });

  await user.selectOptions(screen.getByLabelText('Access for Bob'), 'editor');
  await waitFor(() => {
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patch![1]!.body))).toEqual({ role: 'editor' });
  });
});

it('shows a read-only list and a leave button to non-owners', async () => {
  mockFetch([
    { path: '/api/auth/me', status: 401, body: { error: { code: 'unauthorized', message: 'x' } } },
    {
      path: '/api/projects/p1/members',
      body: { members: [{ user: u('me', 'Me'), role: 'editor', addedAt: '' }], invitations: [] },
    },
  ]);
  renderApp(<ShareDialog project={{ ...project, role: 'editor' }} meId="me" onClose={() => undefined} />);
  expect(await screen.findByRole('button', { name: 'Leave project' })).toBeInTheDocument();
  expect(screen.queryByLabelText('Name, username or e-mail address')).not.toBeInTheDocument();
});
