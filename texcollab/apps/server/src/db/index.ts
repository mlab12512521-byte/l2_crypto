import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

// Return BIGINT/NUMERIC counts as strings (default) but parse int8 counts where
// callers need numbers explicitly; timestamps are parsed to Date by pg.

export type Db = Kysely<Database>;

export function createDb(connectionString: string, poolSize: number): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString,
    max: poolSize,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Guard against runaway queries holding connections.
    statement_timeout: 30_000,
  });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}
