import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { forwardSearch, inverseSearch, parseSyncTex } from './synctex.js';

const fixture = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'errors.synctex.gz'),
);

describe('SyncTeX (real pdflatex output)', () => {
  const data = parseSyncTex(fixture);

  it('maps inputs to project paths only', () => {
    const paths = [...data.inputs.values()];
    expect(paths).toContain('main.tex');
    expect(paths).toContain('chapters/one.tex');
    expect(paths.filter((p) => p?.startsWith('/'))).toEqual([]);
  });

  it('finds PDF boxes for a source line and maps them back', () => {
    const boxes = forwardSearch(data, 'chapters/one.tex', 2);
    expect(boxes.length).toBeGreaterThan(0);
    const b = boxes[0]!;
    expect(b.page).toBe(1);
    // A US-letter/A4 page is ~612x792 / 595x842 points.
    expect(b.x).toBeGreaterThan(50);
    expect(b.x).toBeLessThan(600);
    expect(b.y).toBeGreaterThan(50);
    expect(b.y).toBeLessThan(842);
    const back = inverseSearch(data, b.page, b.x + b.width / 2, b.y + b.height / 2);
    expect(back?.file).toBe('chapters/one.tex');
    expect(back?.line).toBeGreaterThanOrEqual(1);
  });

  it('finds main.tex text', () => {
    const boxes = forwardSearch(data, 'main.tex', 4);
    expect(boxes[0]?.page).toBe(1);
    const back = inverseSearch(data, 1, boxes[0]!.x + 2, boxes[0]!.y + boxes[0]!.height / 2);
    expect(back?.file).toBe('main.tex');
  });

  it('returns nothing for unknown files', () => {
    expect(forwardSearch(data, 'nope.tex', 1)).toEqual([]);
    expect(inverseSearch(data, 99, 10, 10)).toBeNull();
  });
});

describe('SyncTeX robustness', () => {
  it('rejects garbage and bounds decompression', () => {
    expect(() => parseSyncTex(Buffer.from([0x1f, 0x8b, 1, 2, 3]))).toThrow();
    const bomb = gzipSync(Buffer.alloc(300 * 1024 * 1024));
    expect(() => parseSyncTex(bomb)).toThrow();
  });

  it('ignores inputs outside the project', () => {
    const d = parseSyncTex(Buffer.from('SyncTeX Version:1\nInput:1:/etc/passwd\nContent:\n{1\n(1,1:0,0:10,10,0\n}1\n'));
    expect(d.inputs.get(1)).toBeNull();
    expect(inverseSearch(d, 1, 0, 0)).toBeNull();
  });
});
