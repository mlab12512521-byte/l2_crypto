import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from '@codemirror/language';
import { type Diagnostic, lintGutter, lintKeymap, setDiagnostics } from '@codemirror/lint';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, type Extension, Prec } from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { latexCompletionSources, type SymbolProvider } from './completions';
import { latex } from './latex-language';

export interface EditorCallbacks {
  /** Ctrl/Cmd+S and Ctrl/Cmd+Enter: compile (and flush saves). */
  onCompile?: () => void;
  symbols: SymbolProvider;
}

/** Wrap the selection in a command, e.g. \textbf{…}; with no selection, place the cursor inside. */
export function wrapSelection(view: EditorView, command: string): boolean {
  if (view.state.readOnly) return false;
  view.dispatch(
    view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to);
      const insert = `\\${command}{${text}}`;
      const open = command.length + 2;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: range.empty
          ? EditorSelection.cursor(range.from + open)
          : EditorSelection.range(range.from + open, range.from + open + text.length),
      };
    }),
  );
  return true;
}

export const readOnlyCompartment = new Compartment();
export const wrapCompartment = new Compartment();

export const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--editor-font-size, 14px)',
    backgroundColor: 'var(--surface)',
    color: 'var(--text)',
  },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--text)' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface-2)',
    color: 'var(--text-muted)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--cm-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--cm-active-line)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--cm-selection) !important',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--cm-selection-match)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--cm-selection-match)', outline: '1px solid var(--accent)' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', border: '1px solid var(--border)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent)', color: '#fff' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--surface-2)',
    border: '1px solid var(--border)',
    color: 'var(--text-muted)',
  },
});

/** The standard extension set of the TeXCollab editor, without the document binding. */
export function baseExtensions(cb: EditorCallbacks, opts: { readOnly: boolean; wrap: boolean }): Extension[] {
  const compile = () => {
    cb.onCompile?.();
    return true;
  };
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    indentUnit.of('  '),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ override: latexCompletionSources(cb.symbols), icons: false, activateOnTyping: true }),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    lintGutter(),
    latex(),
    editorTheme,
    readOnlyCompartment.of([
      EditorView.editable.of(!opts.readOnly),
      EditorView.contentAttributes.of({ 'aria-readonly': String(opts.readOnly) }),
    ]),
    wrapCompartment.of(opts.wrap ? EditorView.lineWrapping : []),
    Prec.high(
      keymap.of([
        { key: 'Mod-s', run: compile, preventDefault: true },
        { key: 'Mod-Enter', run: compile, preventDefault: true },
        { key: 'Mod-b', run: (v) => wrapSelection(v, 'textbf') },
        { key: 'Mod-i', run: (v) => wrapSelection(v, 'textit') },
        { key: 'Tab', run: acceptCompletion },
      ]),
    ),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
      indentWithTab,
    ]),
    EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'off', autocapitalize: 'off' }),
  ];
}

/** Show compile diagnostics (1-based line numbers) in the editor. */
export function showDiagnostics(
  view: EditorView,
  items: Array<{ line: number; severity: 'error' | 'warning' | 'info'; message: string }>,
) {
  const doc = view.state.doc;
  const diagnostics: Diagnostic[] = items
    .filter((d) => d.line >= 1)
    .map((d) => {
      const line = doc.line(Math.min(d.line, doc.lines));
      return { from: line.from, to: line.to, severity: d.severity, message: d.message, source: 'LaTeX' };
    });
  view.dispatch(setDiagnostics(view.state, diagnostics));
}
