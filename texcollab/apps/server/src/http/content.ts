import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { badRequest } from '../lib/errors.js';

/**
 * Build a Content-Disposition header value with an ASCII fallback and an
 * RFC 5987 UTF-8 filename, so arbitrary (validated) names cannot inject
 * header syntax.
 */
export function contentDisposition(type: 'attachment' | 'inline', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/[";]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Raster image and PDF types that are safe to display inline (never SVG/HTML). */
const INLINE_SAFE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

export function inlineContentType(ext: string): string | null {
  return INLINE_SAFE[ext.toLowerCase()] ?? null;
}

/**
 * Headers for serving user-supplied content: never sniffed, never able to run
 * script even if a browser renders it (CSP sandbox).
 */
export const USER_CONTENT_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
  'Cache-Control': 'private, no-cache',
} as const;

const RAW_TYPES = ['application/octet-stream', 'application/zip', 'application/x-zip-compressed'];

/**
 * Accept raw binary uploads as streams (not buffered). Size limits are
 * enforced by the consumers (blob store / ZIP importer) while streaming.
 */
export function registerRawBodyParser(app: FastifyInstance): void {
  app.addContentTypeParser(RAW_TYPES, (_req, payload, done) => done(null, payload));
}

export function rawBody(req: FastifyRequest): Readable {
  const body = req.body as Readable | undefined;
  if (!body || typeof (body as Readable).pipe !== 'function') {
    throw badRequest('Send the file as the raw request body with Content-Type: application/octet-stream');
  }
  return body;
}
