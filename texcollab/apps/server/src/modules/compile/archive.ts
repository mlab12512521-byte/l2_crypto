import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseRelativePath } from '@texcollab/shared';
import tarStream from 'tar-stream';
import type { BlobStore } from '../../storage/blob-store.js';
import type { ProjectSnapshot } from '../files/snapshot.js';

/**
 * Write the project as a tar archive to a temporary file, returning its path
 * and SHA-256 (needed for the signed worker request). Only paths that pass
 * the shared path validation are included.
 */
export async function packProject(
  snapshot: ProjectSnapshot,
  blobs: BlobStore,
  tmpDir: string,
): Promise<{ file: string; sha256: string; size: number }> {
  await mkdir(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `compile-${randomUUID()}.tar`);
  const pack = tarStream.pack();
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _e, cb) {
      hash.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  const done = pipeline(pack, meter, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  try {
    const mtime = new Date(0);
    for (const f of snapshot.files) {
      if ('error' in parseRelativePath(f.path)) continue; // cannot happen for tree paths; defence in depth
      if (f.kind === 'doc') {
        const data = Buffer.from(f.text, 'utf8');
        await new Promise<void>((res, rej) =>
          pack.entry({ name: f.path, size: data.length, mode: 0o644, mtime }, data, (e) => (e ? rej(e) : res())),
        );
      } else {
        await new Promise<void>((res, rej) => {
          const entry = pack.entry({ name: f.path, size: f.size, mode: 0o644, mtime }, (e) => (e ? rej(e) : res()));
          pipeline(blobs.open(f.blobHash), entry).catch(rej);
        });
      }
    }
    pack.finalize();
    await done;
  } catch (err) {
    pack.destroy();
    await done.catch(() => undefined);
    await rm(file, { force: true });
    throw err;
  }
  return { file, sha256: hash.digest('hex'), size };
}

/** Output files accepted from the sandbox, mapped to their stored names. */
const OUTPUT_WHITELIST: Record<string, string> = {
  'project/output.pdf': 'output.pdf',
  'project/output.log': 'output.log',
  'project/output.synctex.gz': 'output.synctex.gz',
  'project/output.blg': 'output.blg',
  'meta/status.json': 'status.json',
  'meta/latexmk.log': 'latexmk.log',
};

export const OUTPUT_FILE_NAMES = Object.values(OUTPUT_WHITELIST);

/**
 * Extract the sandbox's output archive into `dir`. Anything not on the
 * whitelist (other names, links, directories, oversized entries) is ignored,
 * so a malicious document cannot plant files on the app host.
 */
export async function extractOutputs(
  archive: Buffer,
  dir: string,
  maxEntryBytes: number,
): Promise<Array<{ name: string; size: number }>> {
  await mkdir(dir, { recursive: true });
  const extract = tarStream.extract();
  const written: Array<{ name: string; size: number }> = [];
  extract.on('entry', (header, stream, next) => {
    const target = OUTPUT_WHITELIST[header.name];
    if (
      header.type !== 'file' ||
      !target ||
      (header.size ?? 0) > maxEntryBytes ||
      written.some((w) => w.name === target)
    ) {
      stream.resume();
      stream.on('end', next);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (data: unknown) => {
      const c = data as Buffer;
      size += c.length;
      if (size <= maxEntryBytes) chunks.push(c);
    });
    stream.on('end', () => {
      if (size > maxEntryBytes) return next();
      writeFile(path.join(dir, target), Buffer.concat(chunks), { mode: 0o640 }).then(
        () => {
          written.push({ name: target, size });
          next();
        },
        (err: Error) => next(err),
      );
    });
  });
  await pipeline(Readable.from([archive]), extract);
  return written;
}
