import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';
import type { LogRingBuffer } from './logger.js';
import { AuthService } from './modules/auth/service.js';
import { SessionStore } from './modules/auth/sessions.js';
import { FileService } from './modules/files/service.js';
import { ProjectAccess } from './modules/projects/access.js';
import { ProjectService } from './modules/projects/service.js';
import { limitsInBytes, SettingsService } from './modules/settings/service.js';
import { UserService } from './modules/users/service.js';
import { BlobStore } from './storage/blob-store.js';
import { StoragePaths } from './storage/paths.js';

/**
 * Explicit dependency container. Modules receive what they need from here
 * instead of importing singletons, which keeps them testable.
 */
export interface AppContext {
  config: AppConfig;
  db: Db;
  log: Logger;
  logRing: LogRingBuffer | undefined;
  sessions: SessionStore;
  users: UserService;
  auth: AuthService;
  settings: SettingsService;
  paths: StoragePaths;
  blobs: BlobStore;
  access: ProjectAccess;
  files: FileService;
  projects: ProjectService;
}

export function createContext(config: AppConfig, db: Db, log: Logger, logRing?: LogRingBuffer): AppContext {
  const sessions = new SessionStore(db, config.session);
  const users = new UserService(db);
  const settings = new SettingsService(db);
  const auth = new AuthService(db, users, sessions, log, {
    maxFailures: config.login.maxFailures,
    lockoutMs: config.login.lockoutMs,
  });
  const paths = new StoragePaths(config.dataDir);
  const blobs = new BlobStore(paths.blobsDir);
  const access = new ProjectAccess(db);
  const files = new FileService(db, blobs, async () => limitsInBytes(await settings.get('projectLimits')));
  const projects = new ProjectService(db, files, paths);
  return { config, db, log, logRing, sessions, users, auth, settings, paths, blobs, access, files, projects };
}

/** Create storage directories. Called once at startup (and by tests). */
export async function initStorage(ctx: AppContext): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await ctx.blobs.init();
  for (const dir of [ctx.paths.gitDir, ctx.paths.buildsDir, ctx.paths.importTmpDir]) {
    await mkdir(dir, { recursive: true });
  }
}
