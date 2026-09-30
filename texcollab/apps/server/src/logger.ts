import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';

/**
 * Structured JSON logging to stdout (collected by Docker), plus a bounded
 * in-memory ring buffer so administrators can view recent logs in the UI
 * without shell access to the host.
 */

/** Paths that must never appear in logs. pino replaces their values. */
export const REDACT_PATHS = [
  'password',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.bindPassword',
  '*.secret',
  '*.token',
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
];

export interface LogRecord {
  /** Monotonic sequence number assigned by the ring buffer. */
  seq: number;
  time: string | number;
  level: number;
  msg: string;
  [key: string]: unknown;
}

export class LogRingBuffer extends Writable {
  private readonly records: LogRecord[] = [];
  private seq = 0;

  constructor(private readonly capacity = 2000) {
    super();
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    try {
      const record = JSON.parse(chunk.toString('utf8')) as LogRecord;
      this.seq += 1;
      record.seq = this.seq;
      this.records.push(record);
      if (this.records.length > this.capacity) this.records.shift();
    } catch {
      // Ignore malformed lines; stdout still has them.
    }
    cb();
  }

  /** Most recent records first, optionally filtered by minimum level. */
  recent(limit = 200, minLevel = 0): LogRecord[] {
    const out: LogRecord[] = [];
    for (let i = this.records.length - 1; i >= 0 && out.length < limit; i--) {
      const r = this.records[i]!;
      if (r.level >= minLevel) out.push(r);
    }
    return out;
  }
}

export function createLogger(level: string, ring?: LogRingBuffer): Logger {
  const streams: pino.StreamEntry[] = [{ level: level as pino.Level, stream: process.stdout }];
  if (ring) streams.push({ level: 'info', stream: ring });
  return pino(
    {
      level,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      base: { service: 'texcollab-app' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label, number) => ({ level: number, levelName: label }),
      },
    },
    pino.multistream(streams),
  );
}
