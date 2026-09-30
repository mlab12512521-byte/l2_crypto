import { foldService, HighlightStyle, LanguageSupport, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import type { EditorState, Extension } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';

/**
 * LaTeX language support built on CodeMirror's MIT-licensed `stex` stream
 * mode (see docs/architecture.md §4 for why the Lezer-based alternative is
 * not used: it is AGPL-licensed).
 */
const stexLanguage = StreamLanguage.define({
  ...stex,
  languageData: {
    commentTokens: { line: '%' },
    closeBrackets: { brackets: ['(', '[', '{', '$'] },
    indentOnInput: /^\s*\\end\{/,
  },
});

const SECTION_LEVEL: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

const SECTION_RE = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*[[{]/;
const BEGIN_RE = /\\begin\{([^}]+)\}/g;
const END_RE = /\\end\{([^}]+)\}/g;

/** Strip a line comment so commented-out \begin/\end do not confuse folding. */
function code(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '%') {
      let bs = 0;
      for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) bs++;
      if (bs % 2 === 0) return line.slice(0, i);
    }
  }
  return line;
}

const MAX_SCAN_LINES = 20_000;

/** Fold \begin{env} … \end{env} (nesting-aware) starting on this line. */
function foldEnvironment(state: EditorState, lineStart: number): { from: number; to: number } | null {
  const doc = state.doc;
  const line = doc.lineAt(lineStart);
  const text = code(line.text);
  const begins = [...text.matchAll(BEGIN_RE)];
  if (begins.length === 0) return null;
  // Fold the last environment opened on this line that is not closed on the same line.
  const last = begins[begins.length - 1]!;
  const env = last[1]!;
  if (env === 'document') return null;
  let depth = 0;
  for (let n = line.number; n <= Math.min(doc.lines, line.number + MAX_SCAN_LINES); n++) {
    const l = doc.line(n);
    let t = code(l.text);
    if (n === line.number) t = t.slice(last.index! + last[0].length);
    const events: Array<{ pos: number; open: boolean }> = [];
    for (const m of t.matchAll(BEGIN_RE)) if (m[1] === env) events.push({ pos: m.index!, open: true });
    for (const m of t.matchAll(END_RE)) if (m[1] === env) events.push({ pos: m.index!, open: false });
    events.sort((a, b) => a.pos - b.pos);
    for (const e of events) {
      if (e.open) depth++;
      else if (depth === 0) {
        if (n === line.number) return null;
        return { from: line.to, to: doc.line(n - 1).to };
      } else depth--;
    }
  }
  return null;
}

/** Fold a sectioning command up to the next heading of the same or higher level. */
function foldSection(state: EditorState, lineStart: number): { from: number; to: number } | null {
  const doc = state.doc;
  const line = doc.lineAt(lineStart);
  const m = SECTION_RE.exec(code(line.text));
  if (!m) return null;
  const level = SECTION_LEVEL[m[1]!]!;
  let end = line.number;
  for (let n = line.number + 1; n <= Math.min(doc.lines, line.number + MAX_SCAN_LINES); n++) {
    const text = code(doc.line(n).text);
    const next = SECTION_RE.exec(text);
    if ((next && SECTION_LEVEL[next[1]!]! <= level) || /^\s*\\end\{document\}/.test(text)) break;
    end = n;
  }
  // Do not swallow trailing blank lines.
  while (end > line.number && doc.line(end).text.trim() === '') end--;
  return end > line.number ? { from: line.to, to: doc.line(end).to } : null;
}

export const latexFolding = foldService.of(
  (state, lineStart) => foldSection(state, lineStart) ?? foldEnvironment(state, lineStart),
);

const latexHighlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--cm-keyword)' },
  { tag: t.tagName, color: 'var(--cm-keyword)' },
  { tag: [t.atom, t.bool], color: 'var(--cm-atom)' },
  { tag: t.number, color: 'var(--cm-number)' },
  { tag: t.variableName, color: 'var(--cm-variable)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--cm-string)' },
  { tag: t.comment, color: 'var(--cm-comment)', fontStyle: 'italic' },
  { tag: t.bracket, color: 'var(--cm-bracket)' },
  { tag: t.invalid, color: 'var(--danger)' },
  { tag: t.heading, fontWeight: 'bold' },
]);

export function latex(): Extension {
  return [new LanguageSupport(stexLanguage), latexFolding, syntaxHighlighting(latexHighlight)];
}
