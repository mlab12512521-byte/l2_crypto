import { describe, expect, it } from 'vitest';
import { extensionOf, isTextFileName, parseRelativePath, roleAtLeast, validateEntityName } from './projects.js';

describe('validateEntityName', () => {
  it.each(['main.tex', 'Figure 1.png', 'my-style.sty', '.latexmkrc', 'ünïcödé.tex', 'a'.repeat(255)])(
    'accepts %j',
    (n) => expect(validateEntityName(n)).toBeNull(),
  );
  it.each([
    '',
    '.',
    '..',
    'a/b',
    'a\\b',
    'nul\u0000byte',
    'new\nline',
    ' leading',
    'trailing ',
    'dot.',
    'a:b',
    'a*b',
    'what?',
    '<x>',
    'pipe|',
    'q"uote',
    'a'.repeat(256),
    'é'.repeat(128), // 256 bytes in UTF-8
  ])('rejects %j', (n) => expect(validateEntityName(n)).not.toBeNull());
});

describe('parseRelativePath', () => {
  it('splits valid paths and normalises backslashes', () => {
    expect(parseRelativePath('figures/plot.png')).toEqual({ segments: ['figures', 'plot.png'] });
    expect(parseRelativePath('a\\b.tex')).toEqual({ segments: ['a', 'b.tex'] });
  });
  it.each(['', '/etc/passwd', '../secret', 'a/../b', 'a//b', 'a/./b', 'a/', 'C:\\x'])('rejects %j', (p) => {
    expect(parseRelativePath(p)).toHaveProperty('error');
  });
  it('rejects excessive depth', () => {
    expect(parseRelativePath(Array(40).fill('d').join('/'))).toHaveProperty('error');
  });
});

describe('file types and roles', () => {
  it('classifies text files by extension', () => {
    expect(isTextFileName('main.TEX')).toBe(true);
    expect(isTextFileName('refs.bib')).toBe(true);
    expect(isTextFileName('.latexmkrc')).toBe(true);
    expect(isTextFileName('fig.png')).toBe(false);
    expect(isTextFileName('Makefile')).toBe(false);
    expect(extensionOf('archive.tar.gz')).toBe('gz');
  });
  it('orders roles', () => {
    expect(roleAtLeast('owner', 'editor')).toBe(true);
    expect(roleAtLeast('editor', 'editor')).toBe(true);
    expect(roleAtLeast('viewer', 'editor')).toBe(false);
  });
});
