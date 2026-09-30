import type { CompileDiagnostic } from '@texcollab/shared';

/**
 * Parsers for TeX engine, BibTeX and Biber logs.
 *
 * The sandbox runs TeX with -file-line-error and max_print_line=10000, so
 * errors look like "./chapter.tex:12: Undefined control sequence." and lines
 * are not wrapped. Warnings name only an input line; their file is inferred
 * from TeX's "(file ... )" nesting in the log.
 */

type Raw = Omit<CompileDiagnostic, 'entityId'>;

export const SANDBOX_ROOT = '/work/project/';
const MAX_DIAGNOSTICS = 500;
const MAX_MESSAGE = 2000;

/** Turn a path as printed by TeX into a project-relative path, or null for system files. */
export function projectPath(p: string): string | null {
  let s = p.trim();
  if (s.startsWith(SANDBOX_ROOT)) s = s.slice(SANDBOX_ROOT.length);
  else if (s.startsWith('/')) return null;
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/\/\.\//g, '/');
  if (s === '' || s.split('/').includes('..')) return null;
  return s;
}

const FILE_LINE_ERROR = /^(\.?\/?[^:\n]*?\.[A-Za-z0-9]+):(\d+): (.*)$/;
const INPUT_LINE = /on input line (\d+)\.?/;
const BADBOX =
  /^(Over|Under)full \\[hv]box .*?(?:at lines? (\d+)(?:--(\d+))?|while \\output is active|detected at line (\d+))/;
const PACKAGE_WARNING = /^(Package|Class|LaTeX|pdfTeX|LuaTeX|XeTeX)(?: ([\w.-]+))? Warning: (.*)$/;
const CONTINUATION = /^\(([\w.-]+)\)\s+(.*)$/;

/**
 * Track which file TeX is reading. TeX prints "(" + path when it opens a file
 * and ")" when it closes it. Paths contain no spaces in practice for project
 * files; we accept anything up to whitespace or a parenthesis.
 */
class FileStack {
  private stack: Array<string | null> = [];

  feed(line: string): void {
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '(') {
        const m = /^\(([^()\s]+)/.exec(line.slice(i));
        const candidate = m?.[1];
        if (
          candidate &&
          /\.[A-Za-z0-9]{1,8}$/.test(candidate) &&
          (candidate.startsWith('.') || candidate.startsWith('/'))
        ) {
          this.stack.push(candidate);
          i += candidate.length;
        } else {
          this.stack.push(null); // a parenthesis that is not a file
        }
      } else if (ch === ')') {
        this.stack.pop();
      }
    }
  }

  current(): string | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const f = this.stack[i];
      if (f) return projectPath(f);
    }
    return null;
  }
}

function clip(s: string): string {
  return s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}…` : s;
}

export function parseTexLog(log: string): Raw[] {
  const lines = log.split(/\r?\n/);
  const out: Raw[] = [];
  const files = new FileStack();
  const seen = new Set<string>();
  const push = (d: Raw) => {
    const key = `${d.severity}|${d.file}|${d.line}|${d.message}`;
    if (seen.has(key) || out.length >= MAX_DIAGNOSTICS) return;
    seen.add(key);
    out.push({ ...d, message: clip(d.message) });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Errors: "file:line: message" (from -file-line-error), then context lines until "l.<n>".
    const fle = FILE_LINE_ERROR.exec(line);
    if (fle && !line.startsWith('(')) {
      const context: string[] = [];
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
        const l = lines[j]!;
        if (l.trim() === '' && context.length > 0) break;
        context.push(l);
        if (/^l\.\d+/.test(l)) {
          if (lines[j + 1]?.trim()) context.push(lines[j + 1]!);
          break;
        }
      }
      push({
        severity: 'error',
        message: fle[3]!.replace(/^LaTeX Error: /, ''),
        file: projectPath(fle[1]!),
        line: Number(fle[2]),
        context: context.join('\n').trim(),
        source: 'latex',
      });
      continue;
    }

    // Errors without location ("! Emergency stop.", "! LaTeX Error: ..." without -file-line-error).
    if (line.startsWith('! ')) {
      const msg = line.slice(2).replace(/^LaTeX Error: /, '');
      const lineRef = lines.slice(i + 1, i + 10).find((l) => /^l\.\d+/.test(l));
      push({
        severity: 'error',
        message: msg,
        file: files.current(),
        line: lineRef ? Number(/^l\.(\d+)/.exec(lineRef)![1]) : null,
        source: 'latex',
      });
      continue;
    }

    const warn = PACKAGE_WARNING.exec(line);
    if (warn) {
      // Collect continuation lines "(pkg)   more text".
      let msg = warn[3]!;
      let j = i + 1;
      while (j < lines.length && CONTINUATION.test(lines[j]!)) {
        msg += ` ${CONTINUATION.exec(lines[j]!)![2]}`;
        j++;
      }
      const inputLine = INPUT_LINE.exec(msg);
      const prefix = warn[1] === 'Package' || warn[1] === 'Class' ? `${warn[2]}: ` : '';
      push({
        severity: 'warning',
        message: prefix + msg.replace(/\s+/g, ' ').trim(),
        file: files.current(),
        line: inputLine ? Number(inputLine[1]) : null,
        source: 'latex',
      });
      files.feed(lines.slice(i, j).join(' '));
      i = j - 1;
      continue;
    }

    const box = BADBOX.exec(line);
    if (box) {
      const ln = box[2] ?? box[4];
      push({
        severity: 'info',
        kind: 'badbox',
        message: line.trim(),
        file: files.current(),
        line: ln ? Number(ln) : null,
        source: 'latex',
      });
    }

    if (/^No file .*\.(bbl|ind|gls|toc)\.$/.test(line)) {
      files.feed(line);
      continue;
    }
    files.feed(line);
  }
  return out;
}

/** BibTeX .blg: "Warning--..." and error lines ending with "---line N of file x.bib". */
export function parseBibtexLog(log: string): Raw[] {
  const out: Raw[] = [];
  const lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('Warning--')) {
      const where = /--line (\d+) of file (.+)$/.exec(lines[i + 1] ?? '');
      out.push({
        severity: 'warning',
        message: line.slice('Warning--'.length),
        file: where ? projectPath(where[2]!) : null,
        line: where ? Number(where[1]) : null,
        source: 'bibtex',
      });
      continue;
    }
    const err = /^(.*)---line (\d+) of file (.+)$/.exec(line);
    if (err) {
      out.push({
        severity: 'error',
        message: err[1]!.trim() || 'BibTeX error',
        file: projectPath(err[3]!),
        line: Number(err[2]),
        source: 'bibtex',
      });
      continue;
    }
    if (/^I couldn't open (database|style) file/.test(line) || /^I found no /.test(line)) {
      out.push({ severity: 'error', message: line.trim(), file: null, line: null, source: 'bibtex' });
    }
  }
  return out.slice(0, MAX_DIAGNOSTICS);
}

/** Biber .blg: "[n] Module> ERROR - message" / "WARN - message". */
export function parseBiberLog(log: string): Raw[] {
  const out: Raw[] = [];
  for (const line of log.split(/\r?\n/)) {
    const m = /^\[\d+\] [^>]*> (ERROR|WARN) - (.*)$/.exec(line);
    if (!m) continue;
    const msg = m[2]!;
    const loc = /line (\d+)/.exec(msg);
    const file = /(?:file|datasource) '([^']+)'/.exec(msg);
    out.push({
      severity: m[1] === 'ERROR' ? 'error' : 'warning',
      message: clip(msg.replace(/\/work\/project\/(\.\/)?/g, '')),
      file: file ? projectPath(file[1]!) : null,
      line: loc ? Number(loc[1]) : null,
      source: 'biber',
    });
  }
  return out.slice(0, MAX_DIAGNOSTICS);
}

/** Choose the right bibliography log parser based on content. */
export function parseBlg(log: string): Raw[] {
  return /^\[\d+\] .*INFO - This is Biber/m.test(log) ? parseBiberLog(log) : parseBibtexLog(log);
}
