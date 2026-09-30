import type { TreeEntity } from '@texcollab/shared';
import { describe, expect, it } from 'vitest';
import { buildTree, isWithin, pathIndex } from './tree-model';

const e = (id: string, parentId: string, kind: TreeEntity['kind'], name: string): TreeEntity => ({
  id,
  parentId,
  kind,
  name,
  size: 0,
  updatedAt: '2026-01-01T00:00:00Z',
});

const entities = [
  e('f2', 'root', 'doc', 'b.tex'),
  e('f10', 'root', 'doc', 'chapter10.tex'),
  e('f9', 'root', 'doc', 'chapter9.tex'),
  e('d1', 'root', 'folder', 'figures'),
  e('i1', 'd1', 'file', 'plot.png'),
  e('d2', 'd1', 'folder', 'raw'),
  e('a', 'root', 'doc', 'A.tex'),
];

describe('buildTree', () => {
  it('puts folders first and sorts names naturally, case-insensitively', () => {
    const t = buildTree('root', entities);
    expect(t.map((n) => n.name)).toEqual(['figures', 'A.tex', 'b.tex', 'chapter9.tex', 'chapter10.tex']);
    expect(t[0]!.children.map((n) => n.name)).toEqual(['raw', 'plot.png']);
  });

  it('computes relative paths', () => {
    const paths = pathIndex(buildTree('root', entities));
    expect(paths.get('i1')).toBe('figures/plot.png');
    expect(paths.get('d2')).toBe('figures/raw');
  });

  it('detects descendants for move validation', () => {
    expect(isWithin(entities, 'd2', 'd1')).toBe(true);
    expect(isWithin(entities, 'd1', 'd1')).toBe(true);
    expect(isWithin(entities, 'd1', 'd2')).toBe(false);
  });
});
