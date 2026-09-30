import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  snippetCompletion,
} from '@codemirror/autocomplete';
import type { ProjectSymbols } from '@texcollab/shared';
import { COMMANDS, ENVIRONMENTS, environmentBody, PACKAGES } from './latex-data';

/** Supplies the latest project symbols (labels, citation keys, files) to completion sources. */
export type SymbolProvider = () => ProjectSymbols | null;

const commandCompletions: Completion[] = COMMANDS.map((c) =>
  snippetCompletion(c.snippet ?? c.name, {
    label: `\\${c.name}`,
    type: 'keyword',
    ...(c.detail ? { detail: c.detail } : {}),
  }),
);

const environmentNameCompletions: Completion[] = ENVIRONMENTS.map((e) => ({ label: e, type: 'type' }));

const beginSnippets: Completion[] = ENVIRONMENTS.filter((e) => e !== 'document').map((env) =>
  snippetCompletion(`begin{${env}}\n${environmentBody(env)}\n\\end{${env}}`, {
    label: `\\begin{${env}}`,
    type: 'class',
    detail: 'environment',
    boost: -1,
  }),
);

const packageCompletions: Completion[] = PACKAGES.map((p) => ({ label: p, type: 'namespace' }));

const REF_COMMANDS = /\\(?:ref|eqref|pageref|autoref|cref|Cref|nameref|vref|labelcref)\*?\{([^}]*)$/;
const CITE_COMMANDS = /\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?(?:\[[^\]]*\]){0,2}\{([^}]*)$/;
const GRAPHICS = /\\includegraphics\*?(?:\[[^\]]*\])?\{([^}]*)$/;
const INPUT = /\\(?:input|include|subfile|import)\{([^}]*)$/;
const BIBFILE = /\\(?:bibliography|addbibresource)(?:\[[^\]]*\])?\{([^}]*)$/;
const BEGIN_END = /\\(?:begin|end)\{([^}]*)$/;
const USEPACKAGE = /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]*)$/;

const IMAGE_EXT = /\.(png|jpe?g|pdf|eps|svg|gif)$/i;

interface ArgumentRule {
  /** Matches the text before the cursor; group 1 is the argument typed so far. */
  pattern: RegExp;
  /** Comma-separated argument lists (cite keys, bib files): complete only the current item. */
  list: boolean;
  options: (s: ProjectSymbols | null, before: string) => Completion[];
}

const ARGUMENT_RULES: ArgumentRule[] = [
  {
    pattern: REF_COMMANDS,
    list: true,
    options: (s) => (s?.labels ?? []).map((l) => ({ label: l.name, type: 'variable', detail: l.file })),
  },
  {
    pattern: CITE_COMMANDS,
    list: true,
    options: (s) => (s?.citations ?? []).map((c) => ({ label: c.key, type: 'text', detail: c.title ?? c.file })),
  },
  {
    pattern: GRAPHICS,
    list: false,
    options: (s) => (s?.files ?? []).filter((f) => IMAGE_EXT.test(f)).map((f) => ({ label: f, type: 'constant' })),
  },
  {
    pattern: INPUT,
    list: false,
    options: (s) =>
      (s?.files ?? [])
        .filter((f) => /\.tex$/i.test(f))
        .map((f) => ({ label: f.replace(/\.tex$/i, ''), type: 'constant', detail: f })),
  },
  {
    pattern: BIBFILE,
    list: true,
    options: (s, before) =>
      (s?.files ?? [])
        .filter((f) => /\.bib$/i.test(f))
        .map((f) => ({ label: before.includes('addbibresource') ? f : f.replace(/\.bib$/i, ''), type: 'constant' })),
  },
  { pattern: BEGIN_END, list: false, options: () => environmentNameCompletions },
  { pattern: USEPACKAGE, list: true, options: () => packageCompletions },
];

/**
 * Argument completions: inside \ref{…}, \cite{…}, \includegraphics{…}, etc.
 * For comma-separated arguments (cite keys) only the current item is replaced.
 */
function argumentSource(symbols: SymbolProvider) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    for (const rule of ARGUMENT_RULES) {
      const m = rule.pattern.exec(before);
      if (!m) continue;
      const arg = m[1]!;
      let from = ctx.pos - arg.length;
      if (rule.list) {
        const current = arg.slice(arg.lastIndexOf(',') + 1);
        from = ctx.pos - current.trimStart().length;
      }
      return {
        from,
        options: rule.options(symbols(), before),
        validFor: rule.list ? /^[^},\s]*$/ : /^[^}]*$/,
      };
    }
    return null;
  };
}

/** Command completions after a backslash. */
function commandSource(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/\\[a-zA-Z@]*\*?/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  // An escaped backslash (\\) is a line break, not a command.
  if (word.from > 0 && ctx.state.sliceDoc(word.from - 1, word.from) === '\\') return null;
  return {
    from: word.from,
    options: [...commandCompletions, ...beginSnippets].map((c) => ({ ...c, apply: withBackslash(c) })),
    validFor: /^\\[a-zA-Z@]*\*?$/,
  };
}

/** Snippets are defined without the leading backslash; re-add it when applying. */
function withBackslash(c: Completion): Completion['apply'] {
  const apply = c.apply;
  if (typeof apply !== 'function') return `\\${String(apply ?? c.label).replace(/^\\/, '')}`;
  return (view, completion, from, to) => {
    view.dispatch({ changes: { from, to, insert: '\\' } });
    apply(view, completion, from + 1, from + 1);
  };
}

export function latexCompletionSources(symbols: SymbolProvider) {
  return [argumentSource(symbols), commandSource];
}
