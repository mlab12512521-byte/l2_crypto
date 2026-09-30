import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  PUBLIC_URL: 'https://latex.example.org',
  DATABASE_URL: 'postgres://u:p@db/texcollab',
  APP_SECRET: 'x'.repeat(40),
};

describe('loadConfig', () => {
  it('derives origin and secure cookies from PUBLIC_URL', () => {
    const c = loadConfig(base);
    expect(c.publicOrigin).toBe('https://latex.example.org');
    expect(c.secureCookies).toBe(true);
    expect(loadConfig({ ...base, PUBLIC_URL: 'http://localhost:5173' }).secureCookies).toBe(false);
  });

  it('rejects short secrets without echoing values', () => {
    expect(() => loadConfig({ ...base, APP_SECRET: 'tooshort-secret-value' })).toThrow(/APP_SECRET/);
    try {
      loadConfig({ ...base, APP_SECRET: 'tooshort-secret-value' });
    } catch (err) {
      expect((err as Error).message).not.toContain('tooshort-secret-value');
    }
  });

  it('reads secrets from *_FILE variables', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
    const file = path.join(dir, 'secret');
    writeFileSync(file, `${'s'.repeat(48)}\n`);
    const { APP_SECRET: _omit, ...rest } = base;
    const c = loadConfig({ ...rest, APP_SECRET_FILE: file });
    expect(c.appSecret).toBe('s'.repeat(48));
  });

  it('assembles the database URL from parts, escaping the password', () => {
    const { DATABASE_URL: _omit, ...rest } = base;
    const c = loadConfig({ ...rest, DB_PASSWORD: 'p@ss:w/rd', DB_HOST: 'db' });
    expect(c.databaseUrl).toBe('postgres://texcollab:p%40ss%3Aw%2Frd@db:5432/texcollab');
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });

  it('parses booleans and numbers', () => {
    const c = loadConfig({ ...base, RUN_MIGRATIONS_ON_START: 'false', PORT: '8080' });
    expect(c.runMigrationsOnStart).toBe(false);
    expect(c.port).toBe(8080);
  });
});
