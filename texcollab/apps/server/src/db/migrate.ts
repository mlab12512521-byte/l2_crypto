import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import type { Logger } from 'pino';

/**
 * Minimal forward-only SQL migrator.
 *
 * - Migrations are `NNNN_name.sql` files applied in lexical order.
 * - Each migration runs in its own transaction.
 * - A PostgreSQL advisory lock serialises concurrent migrators (several app
 *   instances starting at once).
 * - Checksums detect edits to already-applied migrations, which is refused:
 *   write a new migration instead.
 */

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

/** Arbitrary constant identifying the migration lock. */
const MIGRATION_LOCK_ID = 7_431_902_117;

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(path.join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

export async function migrate(pool: pg.Pool, log?: Logger, dir = MIGRATIONS_DIR): Promise<string[]> {
  const migrations = await loadMigrations(dir);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.name, r.checksum]));
    for (const m of migrations) {
      const prev = done.get(m.name);
      if (prev !== undefined) {
        if (prev !== m.checksum) {
          throw new Error(`Migration ${m.name} was modified after being applied`);
        }
        continue;
      }
      log?.info({ migration: m.name }, 'applying migration');
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [m.name, m.checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(m.name);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return applied;
}
