import { expect, it } from 'vitest';
import { computeRows } from './DiffViewer';

it('numbers lines and marks additions and deletions', () => {
  const rows = computeRows('a\nb\nc\n', 'a\nB\nc\nd\n');
  expect(rows.map((r) => [r.kind, r.oldNo, r.newNo, r.text])).toEqual([
    ['same', 1, 1, 'a'],
    ['del', 2, null, 'b'],
    ['add', null, 2, 'B'],
    ['same', 3, 3, 'c'],
    ['add', null, 4, 'd'],
  ]);
});

it('collapses long unchanged runs', () => {
  const old = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const neu = old.replace('line 25', 'changed');
  const rows = computeRows(old, neu);
  expect(rows.filter((r) => r.kind === 'gap').map((r) => r.text)).toEqual(['22 unchanged lines', '21 unchanged lines']);
  expect(rows.find((r) => r.kind === 'add')?.newNo).toBe(26);
});
