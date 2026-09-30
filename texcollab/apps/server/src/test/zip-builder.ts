import { deflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP writer for tests. Unlike real ZIP libraries it does not
 * validate entry names, so tests can craft hostile archives
 * ("../x", absolute paths, symlinks, zip bombs).
 */
export interface RawEntry {
  name: string;
  data?: Buffer | string;
  /** Unix mode for the external attributes, e.g. 0o120777 for a symlink. */
  unixMode?: number;
  deflate?: boolean;
}

function crc32(buf: Buffer): number {
  let c: number;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]!) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildZip(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = typeof e.data === 'string' ? Buffer.from(e.data) : (e.data ?? Buffer.alloc(0));
    const method = e.deflate ? 8 : 0;
    const body = e.deflate ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.unixMode ?? (e.name.endsWith('/') ? 0o40755 : 0o100644)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Parse a ZIP produced by the server (stored or deflated entries) back into name → content. */
export async function readZip(buf: Buffer): Promise<Map<string, Buffer>> {
  const yauzl = (await import('yauzl')).default;
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(err);
      const out = new Map<string, Buffer>();
      zf.on('entry', (entry: import('yauzl').Entry) => {
        if (entry.fileName.endsWith('/')) {
          out.set(entry.fileName, Buffer.alloc(0));
          zf.readEntry();
          return;
        }
        zf.openReadStream(entry, (e2, s) => {
          if (e2 || !s) return reject(e2);
          const chunks: Buffer[] = [];
          s.on('data', (c: Buffer) => chunks.push(c));
          s.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            zf.readEntry();
          });
        });
      });
      zf.on('end', () => resolve(out));
      zf.readEntry();
    });
  });
}
