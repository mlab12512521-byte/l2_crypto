import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { PresenceBar } from './PresenceBar';

const user = (id: string, name: string) => ({ id, name, color: '#123456', colorLight: '#12345633' });

it('shows one avatar per user, you first, with the file they have open', () => {
  const files = new Map([
    ['f1', { id: 'f1', parentId: 'r', kind: 'doc' as const, name: 'intro.tex', size: 1, updatedAt: '' }],
  ]);
  render(
    <PresenceBar
      meId="u1"
      state="connected"
      files={files}
      presence={[
        { clientId: 1, user: user('u2', 'Bob Builder'), openFile: 'f1' },
        { clientId: 2, user: user('u1', 'Alice Smith'), openFile: null },
        { clientId: 3, user: user('u2', 'Bob Builder'), openFile: null },
      ]}
    />,
  );
  const avatars = screen.getAllByLabelText(/Alice|Bob/);
  expect(avatars.map((a) => a.textContent)).toEqual(['AS', 'BB']);
  expect(screen.getByLabelText('Bob Builder — intro.tex')).toBeInTheDocument();
  expect(screen.getByLabelText('Alice Smith (you)')).toBeInTheDocument();
});

it('shows the offline state', () => {
  render(<PresenceBar meId="u1" state="disconnected" files={new Map()} presence={[]} />);
  expect(screen.getByText(/Offline/)).toBeInTheDocument();
});
