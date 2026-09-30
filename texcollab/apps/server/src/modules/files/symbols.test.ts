import { describe, expect, it } from 'vitest';
import { collectSymbols, extractBibEntries, extractLabels, stripComments } from './symbols.js';

describe('stripComments', () => {
  it('removes comments but keeps escaped percent signs', () => {
    expect(stripComments('a % comment\nb \\% not comment % yes')).toBe('a \nb \\% not comment ');
    expect(stripComments('x\\\\% after linebreak')).toBe('x\\\\');
  });
});

describe('extractLabels', () => {
  it('finds labels outside comments', () => {
    const tex = '\\section{A}\\label{sec:a}\n% \\label{commented}\n\\begin{equation}\\label{ eq:1 }\\end{equation}';
    expect(extractLabels(tex)).toEqual(['sec:a', 'eq:1']);
  });
});

describe('extractBibEntries', () => {
  it('parses keys and titles, skipping @string and @comment', () => {
    const bib = `@string{j = "Journal"}
@Article{knuth84,
  author = {Donald Knuth},
  title = {Literate {Programming}},
}
@comment{ignored,}
@book( lamport94 , title="LaTeX: A Document Preparation System")`;
    expect(extractBibEntries(bib)).toEqual([
      { key: 'knuth84', title: 'Literate Programming' },
      { key: 'lamport94', title: 'LaTeX: A Document Preparation System' },
    ]);
  });
});

describe('collectSymbols', () => {
  it('collects labels from tex files and keys from bib files', () => {
    const s = collectSymbols({
      folders: [],
      files: [
        { path: 'main.tex', kind: 'doc', entityId: '1', text: '\\label{intro}' },
        { path: 'refs.bib', kind: 'doc', entityId: '2', text: '@misc{k1, title={T}}' },
        { path: 'fig.png', kind: 'file', entityId: '3', blobHash: 'x', size: 1 },
      ],
    });
    expect(s.labels).toEqual([{ name: 'intro', file: 'main.tex' }]);
    expect(s.citations).toEqual([{ key: 'k1', title: 'T', file: 'refs.bib' }]);
    expect(s.files).toEqual(['main.tex', 'refs.bib', 'fig.png']);
  });
});
