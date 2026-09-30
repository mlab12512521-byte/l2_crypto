import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isTextFileName, type ProjectLimits, parseRelativePath } from '@texcollab/shared';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { AppError, badRequest, tooLarge } from '../../lib/errors.js';
import type { BlobStore } from '../../storage/blob-store.js';
import { decodeText } from './service.js';
import type { ProjectSnapshot } from './snapshot.js';

/** Build a ZIP stream of a project snapshot. Entries use only validated relative paths. */
export function zipSnapshot(snapshot: ProjectSnapshot, blobs: BlobStore): Readable {
  const zip = new yazl.ZipFile();
  const mtime = new Date();
  for (const folder of snapshot.folders) zip.addEmptyDirectory(folder, { mtime });
  for (const f of snapshot.files) {
    if (f.kind === 'doc') {
      zip.addBuffer(Buffer.from(f.text, 'utf8'), f.path, { mtime });
    } else {
      zip.addReadStream(blobs.open(f.blobHash), f.path, { mtime, size: f.size });
    }
  }
  zip.end();
  return zip.outputStream as unknown as Readable;
}

export interface ImportedFile {
  segments: string[];
  /** Decoded text for text documents, otherwise null. */
  text: string | null;
  blob: { hash: string; size: number } | null;
}

/** Names that are metadata from other tools, silently skipped on import. */
const IGNORED_SEGMENTS = new Set(['__MACOSX', '.DS_Store', 'Thumbs.db', 'desktop.ini', '.git']);

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      file,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: false },
      (err, zf) => (err || !zf ? reject(err ?? new Error('zip open failed')) : resolve(zf)),
    );
  });
}

function openEntry(zf: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zf.openReadStream(entry, (err, stream) =>
      err || !stream ? reject(err ?? new Error('zip read failed')) : resolve(stream),
    );
  });
}

/**
 * Safely unpack an uploaded ZIP archive into memory-light records:
 * binary content is streamed into the blob store, text is decoded.
 *
 * Defences:
 *  - the archive itself is size-capped while it is received;
 *  - entry names are validated segment by segment (no absolute paths, "..",
 *    control characters...) — "zip slip" is impossible because nothing is
 *    ever written to a path derived from an entry name;
 *  - symbolic links and other special entries are rejected;
 *  - the number of entries, each entry's size and the total *actually
 *    decompressed* bytes are capped (zip bombs), independent of the sizes
 *    the archive claims.
 */
export async function unpackZip(
  input: Readable,
  tmpDir: string,
  blobs: BlobStore,
  limits: ProjectLimits,
): Promise<ImportedFile[]> {
  await mkdir(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `import-${randomUUID()}.zip`);
  try {
    let received = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _e, cb) {
        received += chunk.length;
        if (received > limits.maxProjectSizeBytes) cb(tooLarge('The archive is too large'));
        else cb(null, chunk);
      },
    });
    await pipeline(input, cap, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));

    let zf: yauzl.ZipFile;
    try {
      zf = await openZip(tmp);
    } catch {
      throw badRequest('The file is not a valid ZIP archive');
    }
    try {
      if (zf.entryCount > limits.maxEntitiesPerProject * 2) throw tooLarge('The archive contains too many entries');
      const out: ImportedFile[] = [];
      let totalBytes = 0;
      await new Promise<void>((resolve, reject) => {
        zf.on('error', reject);
        zf.on('end', resolve);
        zf.on('entry', (entry: yauzl.Entry) => {
          handleEntry(entry)
            .then(() => zf.readEntry())
            .catch(reject);
        });
        zf.readEntry();
      });
      return out;

      async function handleEntry(entry: yauzl.Entry): Promise<void> {
        const name = entry.fileName;
        const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
        if (mode === S_IFLNK)
          throw badRequest(`The archive contains a symbolic link (${name.slice(0, 100)}), which is not allowed`);
        if (entry.generalPurposeBitFlag & 0x1) throw badRequest('Encrypted archives are not supported');
        const isDir = name.endsWith('/');
        const trimmed = isDir ? name.slice(0, -1) : name;
        if (trimmed === '') return;
        if (trimmed.split(/[\\/]/).some((s) => IGNORED_SEGMENTS.has(s))) return;
        const parsed = parseRelativePath(trimmed);
        if ('error' in parsed) throw badRequest(`Invalid file name in archive: ${parsed.error}`);
        if (out.length >= limits.maxEntitiesPerProject) throw tooLarge('The archive contains too many files');
        if (isDir) {
          out.push({ segments: parsed.segments, text: null, blob: null });
          return;
        }
        const leaf = parsed.segments[parsed.segments.length - 1]!;
        const maxForEntry = Math.min(limits.maxFileSizeBytes, limits.maxProjectSizeBytes - totalBytes);
        const stream = await openEntry(zf, entry);
        // blobs.put counts the real decompressed bytes and aborts past the limit;
        // pipeline() also propagates yauzl's size-mismatch errors.
        const blob = await blobs.put(stream, Math.max(0, maxForEntry));
        totalBytes += blob.size;
        let text: string | null = null;
        if (isTextFileName(leaf) && blob.size <= limits.maxTextFileSizeBytes) {
          text = decodeText(await blobs.read(blob.hash));
        }
        out.push({ segments: parsed.segments, text, blob: text === null ? blob : null });
      }
    } finally {
      zf.close();
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge('The archive is too large');
    throw badRequest(`Could not read the archive: ${(err as Error).message}`);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** If every entry lives under one common top-level folder, drop that folder. */
export function stripCommonRoot(files: ImportedFile[]): ImportedFile[] {
  const withContent = files.filter((f) => f.segments.length > 0);
  if (withContent.length === 0) return files;
  const first = withContent[0]!.segments[0]!;
  const allUnder = withContent.every(
    (f) => f.segments[0] === first && (f.segments.length > 1 || (f.blob === null && f.text === null)),
  );
  if (!allUnder || !withContent.some((f) => f.segments.length > 1)) return files;
  return withContent.map((f) => ({ ...f, segments: f.segments.slice(1) })).filter((f) => f.segments.length > 0);
}

/** Choose the file to compile: main.tex at the top, else the shallowest .tex with \documentclass. */
export function detectMainFile(files: ImportedFile[]): string[] | null {
  const tex = files.filter((f) => f.text !== null && /\.tex$/i.test(f.segments[f.segments.length - 1]!));
  const top = tex.find((f) => f.segments.length === 1 && f.segments[0]!.toLowerCase() === 'main.tex');
  if (top) return top.segments;
  const candidates = tex
    .filter((f) => /^[^%\n]*\\documentclass/m.test(f.text!))
    .sort((a, b) => a.segments.length - b.segments.length || a.segments.join('/').localeCompare(b.segments.join('/')));
  return candidates[0]?.segments ?? null;
}
