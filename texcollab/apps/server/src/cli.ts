import { createInterface } from 'node:readline/promises';
import { displayNameSchema, passwordSchema, usernameSchema } from '@texcollab/shared';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { audit } from './lib/audit.js';
import { createLogger } from './logger.js';

/**
 * Operator command line. Examples:
 *   node dist/cli.js migrate
 *   node dist/cli.js create-admin alice            (password read from stdin)
 *   node dist/cli.js reset-password alice          (password read from stdin)
 *
 * Passwords are read from standard input rather than arguments so they do
 * not end up in shell history or the process list.
 */

const USAGE = `Usage:
  cli migrate
  cli create-admin <username> [display name]
  cli reset-password <username>
  cli unlock <username>`;

async function readPassword(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  if (process.stdin.isTTY) process.stderr.write('Password: ');
  const line = (await rl[Symbol.asyncIterator]().next()).value as string | undefined;
  rl.close();
  return passwordSchema.parse(line ?? '');
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command) {
    console.error(USAGE);
    return 2;
  }
  const config = loadConfig();
  const log = createLogger(config.logLevel === 'debug' ? 'debug' : 'warn');
  const { db, pool } = createDb(config.databaseUrl, 2);
  try {
    if (command === 'migrate') {
      const applied = await migrate(pool, log);
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
      return 0;
    }
    const ctx = createContext(config, db, log);
    const username = usernameSchema.parse(args[0] ?? '');
    switch (command) {
      case 'create-admin': {
        const displayName = displayNameSchema.parse(args.slice(1).join(' ') || username);
        const user = await ctx.users.createLocalUser({
          username,
          displayName,
          password: await readPassword(),
          isAdmin: true,
        });
        await audit(db, { actorId: null, action: 'cli.admin_created', targetType: 'user', targetId: user.id });
        console.log(`Created administrator ${user.username}`);
        return 0;
      }
      case 'reset-password': {
        const user = await ctx.users.findByUsername(username);
        if (!user) throw new Error(`No such user: ${username}`);
        await ctx.users.setPassword(user.id, await readPassword(), false);
        await ctx.sessions.revokeAllForUser(user.id);
        await audit(db, { actorId: null, action: 'cli.password_reset', targetType: 'user', targetId: user.id });
        console.log(`Password reset for ${user.username}; existing sessions revoked`);
        return 0;
      }
      case 'unlock': {
        const user = await ctx.users.findByUsername(username);
        if (!user) throw new Error(`No such user: ${username}`);
        await ctx.users.unlock(user.id);
        console.log(`Unlocked ${user.username}`);
        return 0;
      }
      default:
        console.error(USAGE);
        return 2;
    }
  } finally {
    await db.destroy();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
