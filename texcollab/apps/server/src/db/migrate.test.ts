import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from '../test/helpers.js';
import { migrate } from './migrate.js';

let pool: pg.Pool;
let dbName: string;

beforeAll(async () => {
  dbName = `texcollab_mig_${randomBytes(5).toString('hex')}`;
  const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await c.connect();
  await c.query(`CREATE DATABASE ${dbName}`);
  await c.end();
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${dbName}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
});

afterAll(async () => {
  await pool.end();
  const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await c.end();
});

it('applies migrations once, concurrently safe, and refuses edited migrations', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mig-'));
  writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id int);');
  writeFileSync(path.join(dir, '0002_b.sql'), 'CREATE TABLE b (id int);');
  writeFileSync(path.join(dir, 'README.txt'), 'ignored');

  const results = await Promise.all([migrate(pool, undefined, dir), migrate(pool, undefined, dir)]);
  expect(results.flat().sort()).toEqual(['0001_a.sql', '0002_b.sql']);
  expect(await migrate(pool, undefined, dir)).toEqual([]);

  writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id bigint);');
  await expect(migrate(pool, undefined, dir)).rejects.toThrow(/modified/);
});

it('rolls back a failing migration', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mig-'));
  writeFileSync(path.join(dir, '0001_ok.sql'), 'CREATE TABLE ok_t (id int);');
  writeFileSync(path.join(dir, '0002_bad.sql'), 'CREATE TABLE half (id int); SELECT * FROM missing_table;');
  await expect(migrate(pool, undefined, dir)).rejects.toThrow(/0002_bad/);
  const { rows } = await pool.query("SELECT to_regclass('half') AS t");
  expect(rows[0].t).toBeNull();
});
