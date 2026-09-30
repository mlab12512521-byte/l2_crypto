import type { VersionInfo } from '@texcollab/shared';
import { expect, it } from 'vitest';
import { groupByDay, versionAuthors } from './group';

const v = (id: string, createdAt: string, names: string[] = []): VersionInfo => ({
  id,
  commitSha: 'a'.repeat(40),
  kind: 'auto',
  label: null,
  createdAt,
  createdBy: null,
  contributors: names.map((n, i) => ({ id: `u${i}`, username: n.toLowerCase(), displayName: n })),
});

it('groups by Today / Yesterday / date', () => {
  const now = new Date(2026, 8, 30, 22, 0);
  const groups = groupByDay(
    [
      v('1', new Date(2026, 8, 30, 21, 32).toISOString()),
      v('2', new Date(2026, 8, 30, 20, 14).toISOString()),
      v('3', new Date(2026, 8, 29, 18, 52).toISOString()),
      v('4', new Date(2026, 8, 1).toISOString()),
    ],
    now,
  );
  expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
    ['Today', ['1', '2']],
    ['Yesterday', ['3']],
    [expect.stringContaining('2026'), ['4']],
  ]);
});

it('names contributors', () => {
  expect(versionAuthors(v('1', '', ['Alice', 'Bob']))).toBe('Alice, Bob');
  expect(versionAuthors(v('1', ''))).toBe('TeXCollab');
});
