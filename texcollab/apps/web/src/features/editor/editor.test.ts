import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { foldable } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { latexCompletionSources } from './completions';
import { latex } from './latex-language';
import { wrapSelection } from './setup';

const symbols = {
  labels: [{ name: 'sec:intro', file: 'main.tex' }],
  citations: [
    { key: 'knuth84', file: 'refs.bib', title: 'Literate Programming' },
    { key: 'lamport94', file: 'refs.bib' },
  ],
  files: ['main.tex', 'chapters/one.tex', 'figures/plot.png', 'refs.bib', 'notes.txt'],
};

function complete(doc: string): CompletionResult | null {
  const state = EditorState.create({ doc });
  const ctx = new CompletionContext(state, doc.length, false);
  for (const source of latexCompletionSources(() => symbols)) {
    const r = source(ctx);
    if (r) return r as CompletionResult;
  }
  return null;
}

describe('LaTeX completions', () => {
  it('completes commands after a backslash, but not after \\\\', () => {
    const r = complete('Text \\sec');
    expect(r?.from).toBe(5);
    expect(r?.options.map((o) => o.label)).toContain('\\section');
    expect(complete('line\\\\')).toBeNull();
  });

  it('completes labels inside \\ref-like commands', () => {
    for (const cmd of ['\\ref{', '\\eqref{s', '\\cref{', '\\autoref{']) {
      const r = complete(cmd);
      expect(
        r?.options.map((o) => o.label),
        cmd,
      ).toEqual(['sec:intro']);
    }
  });

  it('completes the current key in multi-key citations', () => {
    const doc = '\\citep[see][p.~3]{knuth84, lam';
    const r = complete(doc);
    expect(r?.options.map((o) => o.label)).toEqual(['knuth84', 'lamport94']);
    expect(r?.from).toBe(doc.length - 3);
  });

  it('offers images for \\includegraphics and tex files for \\input', () => {
    expect(complete('\\includegraphics[width=3cm]{')?.options.map((o) => o.label)).toEqual(['figures/plot.png']);
    expect(complete('\\input{')?.options.map((o) => o.label)).toEqual(['main', 'chapters/one']);
    expect(complete('\\bibliography{')?.options.map((o) => o.label)).toEqual(['refs']);
    expect(complete('\\addbibresource{')?.options.map((o) => o.label)).toEqual(['refs.bib']);
  });

  it('completes environment names and packages', () => {
    expect(complete('\\begin{ali')?.options.map((o) => o.label)).toContain('align*');
    expect(complete('\\usepackage[utf8]{input')?.options.map((o) => o.label)).toContain('inputenc');
  });
});

describe('LaTeX folding', () => {
  const doc = [
    '\\section{One}', // 1
    'text', // 2
    '\\begin{itemize}', // 3
    '  \\item a', // 4
    '  \\begin{itemize}', // 5
    '    \\item nested', // 6
    '  \\end{itemize}', // 7
    '\\end{itemize}', // 8
    '% \\begin{figure} commented', // 9
    '\\subsection{Sub}', // 10
    'more', // 11
    '\\section{Two}', // 12
    'end', // 13
  ].join('\n');
  const state = EditorState.create({ doc, extensions: [latex()] });
  const fold = (lineNo: number) => {
    const line = state.doc.line(lineNo);
    const r = foldable(state, line.from, line.to);
    return r ? [state.doc.lineAt(r.from).number, state.doc.lineAt(r.to).number] : null;
  };

  it('folds sections up to the next heading of the same level', () => {
    expect(fold(1)).toEqual([1, 11]);
    expect(fold(10)).toEqual([10, 11]);
  });

  it('folds environments with nesting', () => {
    expect(fold(3)).toEqual([3, 7]);
    expect(fold(5)).toEqual([5, 6]);
  });

  it('ignores commented-out environments', () => {
    expect(fold(9)).toBeNull();
  });
});

describe('formatting shortcuts', () => {
  it('wraps the selection or inserts an empty command', () => {
    const view = new EditorView({
      state: EditorState.create({ doc: 'hello world', selection: { anchor: 0, head: 5 } }),
    });
    wrapSelection(view, 'textbf');
    expect(view.state.doc.toString()).toBe('\\textbf{hello} world');
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('hello');
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    wrapSelection(view, 'emph');
    expect(view.state.doc.toString()).toBe('\\textbf{hello} world\\emph{}');
    expect(view.state.selection.main.head).toBe(view.state.doc.length - 1);
    view.destroy();
  });
});
