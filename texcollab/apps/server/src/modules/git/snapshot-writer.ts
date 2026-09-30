import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { BlobStore } from '../../storage/blob-store.js';
import type { ProjectSnapshot } from '../files/snapshot.js';
import type { GitRepo } from './git.js';

export interface GitIdentity {
  name: string;
  email: string;
}

/** Git identities must not contain angle brackets or line breaks. */
function clean(s: string): string {
  return s.replace(/[<>\n\r\0]/g, '').trim() || 'unknown';
}

function ident(who: GitIdentity, when: Date): string {
  return `${clean(who.name)} <${clean(who.email)}> ${Math.floor(when.getTime() / 1000)} +0000`;
}

/**
 * Stream a project snapshot into `git fast-import` as one commit whose tree
 * is exactly the snapshot (`deleteall` + one `M` per file). Git deduplicates
 * unchanged blobs itself. Returns the new commit on `ref`.
 */
async function* fastImportStream(
  snapshot: ProjectSnapshot,
  blobs: BlobStore,
  opts: { ref: string; parent: string | null; author: GitIdentity; message: string; when: Date },
): AsyncGenerator<Buffer> {
  let mark = 0;
  const marks: Array<{ mark: number; path: string }> = [];
  for (const f of snapshot.files) {
    mark++;
    const data = f.kind === 'doc' ? Buffer.from(f.text, 'utf8') : await blobs.read(f.blobHash);
    yield Buffer.from(`blob\nmark :${mark}\ndata ${data.length}\n`);
    yield data;
    yield Buffer.from('\n');
    marks.push({ mark, path: f.path });
  }
  const message = Buffer.from(opts.message, 'utf8');
  const lines = [
    `commit ${opts.ref}`,
    `author ${ident(opts.author, opts.when)}`,
    `committer ${ident({ name: 'TeXCollab', email: 'texcollab@texcollab.invalid' }, opts.when)}`,
    `data ${message.length}`,
  ];
  yield Buffer.from(`${lines.join('\n')}\n`);
  yield message;
  yield Buffer.from('\n');
  if (opts.parent) yield Buffer.from(`from ${opts.parent}\n`);
  yield Buffer.from('deleteall\n');
  for (const m of marks) {
    // Paths are validated tree paths: no newlines, quotes, backslashes or leading "/".
    yield Buffer.from(`M 100644 :${m.mark} ${m.path}\n`, 'utf8');
  }
  yield Buffer.from('\n');
}

/**
 * Commit a snapshot on top of `parent`. Returns the new commit sha, or null
 * if the tree is identical to the parent's (nothing to record).
 */
export async function commitSnapshot(
  repo: GitRepo,
  blobs: BlobStore,
  snapshot: ProjectSnapshot,
  opts: { parent: string | null; author: GitIdentity; message: string; when?: Date },
): Promise<{ commit: string; unchanged: boolean }> {
  const tmpRef = `refs/texcollab/tmp-${randomUUID()}`;
  try {
    await repo.run(['fast-import', '--quiet', '--date-format=raw', '--done'], {
      input: Readable.from(
        (async function* () {
          yield* fastImportStream(snapshot, blobs, { ...opts, ref: tmpRef, when: opts.when ?? new Date() });
          yield Buffer.from('done\n');
        })(),
      ),
      timeoutMs: 600_000,
    });
    const commit = await repo.resolve(tmpRef);
    if (!commit) throw new Error('fast-import produced no commit');
    if (opts.parent && (await repo.treeOf(commit)) === (await repo.treeOf(opts.parent))) {
      return { commit: opts.parent, unchanged: true };
    }
    return { commit, unchanged: false };
  } finally {
    await repo.run(['update-ref', '-d', tmpRef], { okCodes: [1, 128] }).catch(() => undefined);
  }
}
