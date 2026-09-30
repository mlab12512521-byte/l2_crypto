import type { z } from 'zod';
import { badRequest } from '../lib/errors.js';

/** Parse untrusted input with a Zod schema, converting failures to a 400 with per-field messages. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  const first = r.error.issues[0];
  const message = first ? `${first.path.length ? `${first.path.join('.')}: ` : ''}${first.message}` : 'Invalid request';
  throw badRequest(message, fields);
}
