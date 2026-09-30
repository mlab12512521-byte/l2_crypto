import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseBlg, parseTexLog, projectPath } from './log-parser.js';

const fixture = (name: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', name), 'utf8');

describe('projectPath', () => {
  it('maps sandbox paths to project paths and drops system files', () => {
    expect(projectPath('./main.tex')).toBe('main.tex');
    expect(projectPath('/work/project/./chapters/one.tex')).toBe('chapters/one.tex');
    expect(projectPath('/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls')).toBeNull();
    expect(projectPath('./../etc/passwd')).toBeNull();
  });
});

describe('parseTexLog (real pdflatex log)', () => {
  const diags = parseTexLog(fixture('errors.log'));

  it('reports errors in included files with their line and context', () => {
    const err = diags.find((d) => d.severity === 'error');
    expect(err).toMatchObject({ file: 'chapters/one.tex', line: 3, message: 'Undefined control sequence.' });
    expect(err?.context).toContain('\\undefinedmacro');
  });

  it('attributes warnings to the file being read', () => {
    expect(diags).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        file: 'main.tex',
        line: 4,
        message: expect.stringContaining("Reference `sec:missing'"),
      }),
    );
    expect(diags).toContainEqual(
      expect.objectContaining({ severity: 'warning', message: expect.stringContaining("Citation `nokey'") }),
    );
  });

  it('reports bad boxes as info', () => {
    expect(diags).toContainEqual(
      expect.objectContaining({ severity: 'info', kind: 'badbox', file: 'main.tex', line: 8 }),
    );
  });
});

describe('parseTexLog (synthetic cases)', () => {
  it('handles multi-line package warnings and errors without file:line', () => {
    const log = [
      '(./main.tex',
      "Package natbib Warning: Citation `x' on page 1 undefined on input line 7.",
      '',
      'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
      "(hyperref)                removing `math shift' on input line 12.",
      '',
      "! LaTeX Error: File `missing.sty' not found.",
      '',
      'l.3 \\usepackage',
      ')',
    ].join('\n');
    const d = parseTexLog(log);
    expect(d[0]).toMatchObject({
      severity: 'warning',
      file: 'main.tex',
      line: 7,
      message: expect.stringMatching(/^natbib: /),
    });
    expect(d[1]).toMatchObject({ line: 12, message: expect.stringContaining('removing `math shift') });
    expect(d[2]).toMatchObject({
      severity: 'error',
      message: "File `missing.sty' not found.",
      line: 3,
      file: 'main.tex',
    });
  });

  it('caps and de-duplicates output', () => {
    const log = Array.from({ length: 2000 }, (_, i) => `./main.tex:${i % 3}: Same error.`).join('\n');
    expect(parseTexLog(log)).toHaveLength(3);
  });
});

describe('bibliography logs', () => {
  it('parses BibTeX warnings', () => {
    const d = parseBlg(fixture('errors-bibtex.blg'));
    expect(d).toContainEqual(
      expect.objectContaining({ source: 'bibtex', severity: 'warning', message: expect.stringContaining('nokey') }),
    );
  });

  it('parses Biber logs', () => {
    expect(parseBlg(fixture('biber.blg')).filter((x) => x.severity === 'error')).toEqual([]);
    const d = parseBlg(
      '[0] Config.pm:1> INFO - This is Biber 2.20\n[99] Biber.pm:1> ERROR - BibTeX subsystem: /work/project/./refs.bib_1.utf8, line 3, syntax error: found "}"',
    );
    expect(d[0]).toMatchObject({ source: 'biber', severity: 'error', line: 3 });
    expect(d[0]!.message).not.toContain('/work/project');
  });
});
