import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';
import type { LogRingBuffer } from './logger.js';
import { AuthService } from './modules/auth/service.js';
import { SessionStore } from './modules/auth/sessions.js';
import { SettingsService } from './modules/settings/service.js';
import { UserService } from './modules/users/service.js';

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
}

export function createContext(config: AppConfig, db: Db, log: Logger, logRing?: LogRingBuffer): AppContext {
  const sessions = new SessionStore(db, config.session);
  const users = new UserService(db);
  const settings = new SettingsService(db);
  const auth = new AuthService(db, users, sessions, log, {
    maxFailures: config.login.maxFailures,
    lockoutMs: config.login.lockoutMs,
  });
  return { config, db, log, logRing, sessions, users, auth, settings };
}
