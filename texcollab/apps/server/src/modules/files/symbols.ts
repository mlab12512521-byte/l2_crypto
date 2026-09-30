import type { ProjectSymbols } from '@texcollab/shared';
import type { ProjectSnapshot } from './snapshot.js';

const MAX_SYMBOLS = 5000;

/** Remove LaTeX comments: an unescaped % (preceded by an even number of backslashes) to end of line. */
export function stripComments(tex: string): string {
  return tex
    .split('\n')
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] !== '%') continue;
        let backslashes = 0;
        for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) backslashes++;
        if (backslashes % 2 === 0) return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

export function extractLabels(tex: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(tex).matchAll(/\\label\s*\{([^{}\n]{1,200})\}/g)) out.push(m[1]!.trim());
  return out;
}

const NON_ENTRY_TYPES = new Set(['string', 'comment', 'preamble']);

/** Read a BibTeX field value starting at `i` ({...} with nesting, or "..."). */
function readBibValue(text: string, i: number): string | null {
  const open = text[i];
  if (open === '"') {
    const close = text.indexOf('"', i + 1);
    return close < 0 ? null : text.slice(i + 1, close);
  }
  if (open !== '{') return null;
  let depth = 0;
  for (let j = i; j < text.length && j < i + 2000; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}' && --depth === 0) return text.slice(i + 1, j);
  }
  return null;
}

export function extractBibEntries(bib: string): Array<{ key: string; title?: string }> {
  const out: Array<{ key: string; title?: string }> = [];
  const starts = [...bib.matchAll(/@(\w+)\s*[{(]\s*([^,\s{}()]+)\s*,/g)];
  starts.forEach((m, idx) => {
    if (NON_ENTRY_TYPES.has(m[1]!.toLowerCase())) return;
    const bodyEnd = starts[idx + 1]?.index ?? bib.length;
    const body = bib.slice(m.index! + m[0].length, bodyEnd);
    const field = /\btitle\s*=\s*/i.exec(body);
    const raw = field ? readBibValue(body, field.index + field[0].length) : null;
    const title = raw?.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
    out.push({ key: m[2]!, ...(title ? { title } : {}) });
  });
  return out;
}

export function collectSymbols(snapshot: ProjectSnapshot): ProjectSymbols {
  const labels: ProjectSymbols['labels'] = [];
  const citations: ProjectSymbols['citations'] = [];
  for (const f of snapshot.files) {
    if (f.kind !== 'doc') continue;
    const lower = f.path.toLowerCase();
    if (/\.(tex|ltx|latex|sty|cls)$/.test(lower)) {
      for (const name of extractLabels(f.text)) if (labels.length < MAX_SYMBOLS) labels.push({ name, file: f.path });
    } else if (lower.endsWith('.bib')) {
      for (const e of extractBibEntries(f.text))
        if (citations.length < MAX_SYMBOLS) citations.push({ ...e, file: f.path });
    }
  }
  return { labels, citations, files: snapshot.files.map((f) => f.path) };
}
