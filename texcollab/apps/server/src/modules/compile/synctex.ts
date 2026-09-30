import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { projectPath } from './log-parser.js';

/**
 * Minimal SyncTeX reader for forward (source → PDF) and inverse
 * (PDF → source) search. The file comes from an untrusted compilation, so
 * parsing is bounded in size and record count and never evaluates anything.
 *
 * Coordinates returned to clients are PDF points (bp) measured from the
 * top-left corner of the page.
 */

const MAX_UNCOMPRESSED = 256 * 1024 * 1024;
const MAX_RECORDS = 5_000_000;
/** Scaled points per PDF big point: 65536 sp/pt × 72.27 pt / 72 bp. */
const SP_PER_BP = (65536 * 72.27) / 72;

export interface SyncRecord {
  kind: 'hbox' | 'vbox' | 'void' | 'point';
  file: number;
  line: number;
  page: number;
  /** Left edge / baseline in sp. */
  h: number;
  v: number;
  width: number;
  height: number;
  depth: number;
}

export interface SyncTexData {
  /** Input tag → project-relative path (null for files outside the project). */
  inputs: Map<number, string | null>;
  records: SyncRecord[];
  unit: number;
  xOffset: number;
  yOffset: number;
  magnification: number;
}

export interface PdfBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

const RECORD = /^([[(vhxkg$])(\d+),(-?\d+):(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/;

export function parseSyncTex(buf: Buffer): SyncTexData {
  let text: string;
  try {
    text = (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf, { maxOutputLength: MAX_UNCOMPRESSED }) : buf).toString(
      'utf8',
    );
  } catch {
    throw new Error('invalid synctex data');
  }
  const data: SyncTexData = { inputs: new Map(), records: [], unit: 1, xOffset: 0, yOffset: 0, magnification: 1000 };
  let page = 0;
  let inContent = false;
  for (const line of text.split('\n')) {
    if (!inContent) {
      if (line.startsWith('Input:')) {
        const m = /^Input:(\d+):(.*)$/.exec(line);
        if (m) data.inputs.set(Number(m[1]), projectPath(m[2]!));
      } else if (line.startsWith('Unit:')) data.unit = Number(line.slice(5)) || 1;
      else if (line.startsWith('X Offset:')) data.xOffset = Number(line.slice(9)) || 0;
      else if (line.startsWith('Y Offset:')) data.yOffset = Number(line.slice(9)) || 0;
      else if (line.startsWith('Magnification:')) data.magnification = Number(line.slice(14)) || 1000;
      else if (line.startsWith('Content:')) inContent = true;
      continue;
    }
    const c = line[0];
    if (c === '{') {
      page = Number(line.slice(1)) || page + 1;
      continue;
    }
    if (c === 'I' && line.startsWith('Input:')) {
      // Files opened later during typesetting appear inside the content section.
      const m = /^Input:(\d+):(.*)$/.exec(line);
      if (m) data.inputs.set(Number(m[1]), projectPath(m[2]!));
      continue;
    }
    const m = RECORD.exec(line);
    if (!m || page === 0) continue;
    if (data.records.length >= MAX_RECORDS) break;
    const kind = m[1] === '(' ? 'hbox' : m[1] === '[' ? 'vbox' : m[1] === 'h' || m[1] === 'v' ? 'void' : 'point';
    data.records.push({
      kind,
      file: Number(m[2]),
      line: Number(m[3]),
      page,
      h: Number(m[4]),
      v: Number(m[5]),
      width: Number(m[6] ?? 0),
      height: Number(m[7] ?? 0),
      depth: Number(m[8] ?? 0),
    });
  }
  return data;
}

function toBp(data: SyncTexData, sp: number): number {
  return (sp * data.unit * (data.magnification / 1000)) / SP_PER_BP;
}

function boxOf(data: SyncTexData, r: SyncRecord): PdfBox {
  const height = r.height + r.depth;
  return {
    page: r.page,
    x: toBp(data, r.h + data.xOffset),
    y: toBp(data, r.v - r.height + data.yOffset),
    width: toBp(data, Math.max(r.width, 0)),
    height: toBp(data, Math.max(height, 0)),
  };
}

/**
 * Forward search: PDF boxes for a source line. Uses the closest line that
 * produced output (searching downwards first, as typesetting of a paragraph
 * is attributed to its last line).
 */
export function forwardSearch(data: SyncTexData, file: string, line: number): PdfBox[] {
  const tags = [...data.inputs].filter(([, p]) => p === file).map(([t]) => t);
  if (tags.length === 0) return [];
  const candidates = data.records.filter((r) => tags.includes(r.file) && r.line > 0);
  if (candidates.length === 0) return [];
  let best = Number.POSITIVE_INFINITY;
  for (const r of candidates) {
    const dist = r.line >= line ? r.line - line : (line - r.line) * 2 + 1;
    if (dist < best) best = dist;
  }
  const matchLine = candidates.find((r) => (r.line >= line ? r.line - line : (line - r.line) * 2 + 1) === best)!.line;
  const matching = candidates.filter((r) => r.line === matchLine);
  const firstPage = Math.min(...matching.map((r) => r.page));
  const onPage = matching.filter((r) => r.page === firstPage);
  const boxes = onPage.filter((r) => r.kind === 'hbox' && r.width > 0);
  const chosen = boxes.length ? boxes : onPage;
  return chosen.slice(0, 50).map((r) => {
    const b = boxOf(data, r);
    // Point records have no extent: give them a small visible height.
    return b.height > 0 ? b : { ...b, y: b.y - 8, height: 10, width: Math.max(b.width, 20) };
  });
}

/**
 * Inverse search: source location for a point (PDF points from the top-left).
 *
 * 1. Find the innermost horizontal box containing the point (a typeset line).
 * 2. Within that line, glyph-level records (kerns, glue, math) carry the most
 *    precise source line: take the closest one at or before the click.
 * 3. Otherwise fall back to the box itself, or the nearest record on the page.
 */
export function inverseSearch(
  data: SyncTexData,
  page: number,
  x: number,
  y: number,
): { file: string; line: number } | null {
  const onPage = data.records.filter((r) => r.page === page && r.line > 0 && data.inputs.get(r.file));
  let box: { rec: SyncRecord; b: PdfBox; area: number } | null = null;
  for (const r of onPage) {
    if (r.kind !== 'hbox' && r.kind !== 'void') continue;
    const b = boxOf(data, r);
    if (b.width <= 0 || b.height <= 0) continue;
    if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) {
      const area = b.width * b.height;
      if (!box || area < box.area) box = { rec: r, b, area };
    }
  }
  const result = (r: SyncRecord) => ({ file: data.inputs.get(r.file)!, line: r.line });
  if (box) {
    const top = box.b.y;
    const bottom = box.b.y + box.b.height;
    let best: { rec: SyncRecord; dx: number } | null = null;
    for (const r of onPage) {
      if (r.kind !== 'point') continue;
      const px = toBp(data, r.h + data.xOffset);
      const py = toBp(data, r.v + data.yOffset);
      if (py < top - 0.5 || py > bottom + 0.5) continue;
      // Prefer records at or left of the click; penalise those to the right.
      const dx = px <= x ? x - px : (px - x) * 4;
      if (!best || dx < best.dx) best = { rec: r, dx };
    }
    return result(best?.rec ?? box.rec);
  }
  let nearest: { rec: SyncRecord; dist: number } | null = null;
  for (const r of onPage) {
    const b = boxOf(data, r);
    const dist = Math.hypot(Math.max(b.x - x, 0, x - (b.x + b.width)), b.y + b.height - y);
    if (!nearest || dist < nearest.dist) nearest = { rec: r, dist };
  }
  return nearest ? result(nearest.rec) : null;
}

/** Small cache so repeated clicks do not re-parse the same file. */
export class SyncTexCache {
  private readonly entries = new Map<string, SyncTexData>();

  constructor(private readonly capacity = 8) {}

  async get(key: string, file: string): Promise<SyncTexData> {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const data = parseSyncTex(await readFile(file));
    this.entries.set(key, data);
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    return data;
  }
}
