import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tooLarge } from '../lib/errors.js';

const HASH_RE = /^[0-9a-f]{64}$/;

export function isBlobHash(hash: string): boolean {
  return HASH_RE.test(hash);
}

/**
 * Content-addressed storage for binary project files.
 *
 * Files live at `<root>/<aa>/<bb>/<sha256>`; the path is derived only from a
 * validated hex digest, never from user input, so no traversal is possible.
 * Writes go to a temporary file first and are renamed into place atomically,
 * so readers never observe partial blobs. Identical content is stored once.
 */
export class BlobStore {
  private readonly tmpDir: string;

  constructor(private readonly root: string) {
    this.tmpDir = path.join(root, '.tmp');
  }

  async init(): Promise<void> {
    await mkdir(this.tmpDir, { recursive: true });
  }

  pathFor(hash: string): string {
    if (!isBlobHash(hash)) throw new Error('invalid blob hash');
    return path.join(this.root, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  /**
   * Stream `input` into the store, aborting with 413 if it exceeds `maxBytes`.
   * Returns the digest and size.
   */
  async put(input: Readable, maxBytes: number): Promise<{ hash: string; size: number }> {
    const tmp = path.join(this.tmpDir, randomUUID());
    const hasher = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) {
          cb(tooLarge(`File exceeds the maximum size of ${maxBytes} bytes`));
          return;
        }
        hasher.update(chunk);
        cb(null, chunk);
      },
    });
    // The source is piped manually rather than via pipeline(): on failure we
    // must not destroy it, because for HTTP uploads that would reset the
    // connection before the client receives the error response. Instead the
    // rest of the source is drained and discarded (the reverse proxy bounds
    // request sizes).
    const sourceError = new Promise<never>((_, reject) => input.once('error', reject));
    sourceError.catch(() => undefined); // only observed through the race below
    input.pipe(meter);
    try {
      await Promise.race([pipeline(meter, createWriteStream(tmp, { flags: 'wx', mode: 0o640 })), sourceError]);
      const hash = hasher.digest('hex');
      const dest = this.pathFor(hash);
      await mkdir(path.dirname(dest), { recursive: true });
      await rename(tmp, dest);
      return { hash, size };
    } catch (err) {
      input.unpipe(meter);
      input.resume();
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async putBuffer(data: Buffer): Promise<{ hash: string; size: number }> {
    return this.put(Readable.from([data]), Number.MAX_SAFE_INTEGER);
  }

  open(hash: string, range?: { start: number; end: number }): ReadStream {
    return createReadStream(this.pathFor(hash), range);
  }

  async exists(hash: string): Promise<boolean> {
    try {
      await stat(this.pathFor(hash));
      return true;
    } catch {
      return false;
    }
  }

  async read(hash: string): Promise<Buffer> {
    return readFile(this.pathFor(hash));
  }

  /** Modification time of the blob file, or null if it does not exist. */
  async mtime(hash: string): Promise<Date | null> {
    try {
      return (await stat(this.pathFor(hash))).mtime;
    } catch {
      return null;
    }
  }

  async delete(hash: string): Promise<void> {
    await rm(this.pathFor(hash), { force: true });
  }

  /** Remove abandoned temporary files (interrupted uploads). */
  async cleanTmp(olderThanMs: number): Promise<void> {
    const cutoff = Date.now() - olderThanMs;
    for (const name of await readdir(this.tmpDir)) {
      const p = path.join(this.tmpDir, name);
      const s = await stat(p).catch(() => null);
      if (s && s.mtimeMs < cutoff) await rm(p, { force: true });
    }
  }
}
