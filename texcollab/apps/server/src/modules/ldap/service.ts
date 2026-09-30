import { isIP } from 'node:net';
import tls from 'node:tls';
import {
  type LdapSettings,
  type LdapSettingsView,
  type LdapTestResult,
  type LdapTestStep,
  ldapSettingsSchema,
} from '@texcollab/shared';
import { Client, type Entry, InvalidCredentialsError, NoSuchObjectError, SizeLimitExceededError } from 'ldapts';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import type { UserRow } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { SecretBox } from '../../lib/crypto.js';
import { AppError, badRequest } from '../../lib/errors.js';
import type { ExternalAuthenticator, ExternalIdentity } from '../auth/service.js';
import { isUniqueViolation } from '../users/service.js';
import { fillFilter } from './filter.js';

const SETTINGS_KEY = 'ldap';

interface StoredConfig {
  settings: LdapSettings;
  /** Base64 of the SecretBox-encrypted bind password. */
  bindPassword: string | null;
}

interface LoadedConfig {
  settings: LdapSettings;
  bindPassword: string | null;
}

interface DirectoryUser {
  dn: string;
  username: string;
  displayName: string;
  email: string | null;
}

type Lookup = { kind: 'found'; user: DirectoryUser } | { kind: 'none' } | { kind: 'ambiguous' };

/** Errors that mean "could not talk to the server" rather than "the server said no". */
function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string') return true; // Node socket/TLS errors (ECONNREFUSED, CERT_*, ...)
  return err instanceof Error && /timeout|timed out|closed|socket/i.test(err.message);
}

/** Describe an LDAP error for administrators without echoing credentials. */
export function describeLdapError(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (err instanceof InvalidCredentialsError) return 'Invalid credentials.';
  if (err instanceof NoSuchObjectError) return 'Entry not found; check the DN.';
  if (typeof code === 'string') {
    if (code === 'ECONNREFUSED') return 'Connection refused.';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Host name could not be resolved.';
    if (code === 'ETIMEDOUT') return 'Connection timed out.';
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|HOSTNAME/i.test(code))
      return `The server's TLS certificate is not trusted (${code}). Add the issuing CA certificate or fix the host name.`;
    return `Connection failed (${code}).`;
  }
  if (err instanceof Error) {
    if (/timeout|timed out/i.test(err.message)) return 'The server did not answer in time.';
    return err.message.slice(0, 300);
  }
  return 'Unknown error.';
}

function attr(entry: Entry, name: string): string | null {
  const key = Object.keys(entry).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return null;
  const v = entry[key];
  const first = Array.isArray(v) ? v[0] : v;
  if (first === undefined) return null;
  const s = (Buffer.isBuffer(first) ? first.toString('utf8') : first).trim();
  return s || null;
}

/**
 * LDAP / Active Directory authentication using search-then-bind:
 * a service account (or anonymous) searches for the user entry with an
 * administrator-defined filter, optional group checks run, and finally the
 * user's own password is verified by binding as the found DN.
 *
 * Configuration lives in `system_settings` under a key that the generic
 * settings API does not know, so it is only reachable through this service;
 * the bind password is encrypted and never returned.
 */
export class LdapService implements ExternalAuthenticator {
  private readonly box: SecretBox;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    appSecret: string,
  ) {
    this.box = new SecretBox(appSecret, 'ldap-bind');
  }

  // ---- configuration

  async load(): Promise<LoadedConfig> {
    const row = await this.db
      .selectFrom('system_settings')
      .select('value')
      .where('key', '=', SETTINGS_KEY)
      .executeTakeFirst();
    const stored = (row?.value ?? {}) as Partial<StoredConfig>;
    const parsed = ldapSettingsSchema.safeParse(stored.settings ?? {});
    if (!parsed.success) {
      this.log.error({ issues: parsed.error.issues }, 'stored LDAP settings are invalid; directory disabled');
      return { settings: ldapSettingsSchema.parse({}), bindPassword: null };
    }
    let bindPassword: string | null = null;
    if (stored.bindPassword) {
      try {
        bindPassword = this.box.decrypt(Buffer.from(stored.bindPassword, 'base64'));
      } catch {
        this.log.error('the stored LDAP bind password cannot be decrypted (was APP_SECRET changed?)');
      }
    }
    return { settings: parsed.data, bindPassword };
  }

  async view(): Promise<LdapSettingsView> {
    const { settings, bindPassword } = await this.load();
    return { ...settings, hasBindPassword: bindPassword !== null };
  }

  /**
   * Work out which bind password applies to settings being saved or tested.
   * The stored password is only reused for the same server and bind DN, so
   * pointing the configuration at another host cannot leak it.
   */
  private resolvePassword(
    current: LoadedConfig,
    settings: LdapSettings,
    given: string | null | undefined,
  ): string | null {
    if (given !== undefined) return given ? given : null;
    if (current.bindPassword === null || !settings.bindDn) return null;
    const sameServer =
      current.settings.url.toLowerCase().replace(/\/$/, '') === settings.url.toLowerCase().replace(/\/$/, '');
    if (!sameServer || current.settings.bindDn !== settings.bindDn) {
      throw badRequest('Enter the bind password again: the server or bind DN changed.');
    }
    return current.bindPassword;
  }

  async save(
    input: { settings: LdapSettings; bindPassword?: string | null | undefined },
    actorId: string,
  ): Promise<LdapSettingsView> {
    const current = await this.load();
    const settings = ldapSettingsSchema.parse(input.settings);
    const password = this.resolvePassword(current, settings, input.bindPassword);
    if (settings.enabled && settings.bindDn && !password)
      throw badRequest('A bind password is required for the bind DN.');
    const stored: StoredConfig = {
      settings,
      bindPassword: password ? this.box.encrypt(password).toString('base64') : null,
    };
    const json = JSON.stringify(stored);
    await this.db
      .insertInto('system_settings')
      .values({ key: SETTINGS_KEY, value: json, updated_by: actorId })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: json, updated_by: actorId, updated_at: new Date() }))
      .execute();
    return { ...settings, hasBindPassword: password !== null };
  }

  // ---- ExternalAuthenticator

  async isEnabled(): Promise<boolean> {
    return (await this.load()).settings.enabled;
  }

  async authenticate(username: string, password: string): Promise<ExternalIdentity | null> {
    // An empty password would be an "unauthenticated bind", which many servers accept.
    if (!password || !username || username.length > 256 || username.includes('\0')) return null;
    const { settings: s, bindPassword } = await this.load();
    if (!s.enabled) return null;
    const client = await this.connect(s);
    try {
      await this.serviceBind(client, s, bindPassword);
      const found = await this.findUser(client, s, username);
      if (found.kind === 'ambiguous') {
        this.log.warn({ username: username.slice(0, 64) }, 'LDAP user filter matched several entries; sign-in refused');
        return null;
      }
      if (found.kind === 'none') return null;
      const u = found.user;
      if (s.requiredGroupDn && !(await this.inGroup(client, s, s.requiredGroupDn, u))) {
        this.log.info({ dn: u.dn }, 'LDAP user is not in the required group');
        return null;
      }
      const isAdmin = s.adminGroupDn ? await this.inGroup(client, s, s.adminGroupDn, u) : undefined;
      try {
        await client.bind(u.dn, password);
      } catch (err) {
        if (err instanceof InvalidCredentialsError) return null;
        throw err;
      }
      return {
        username: u.username,
        dn: u.dn,
        displayName: u.displayName,
        email: u.email,
        ...(isAdmin !== undefined ? { isAdmin } : {}),
      };
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }

  /** Create or update the local account for a directory user. */
  async provision(identity: ExternalIdentity): Promise<UserRow> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.provisionOnce(identity);
      } catch (err) {
        // Two first sign-ins racing each other: the second finds the row on retry.
        if (attempt === 0 && isUniqueViolation(err) && !(err.constraint ?? '').includes('email')) continue;
        throw err;
      }
    }
  }

  private async provisionOnce(id: ExternalIdentity): Promise<UserRow> {
    const result = await this.db.transaction().execute(async (trx) => {
      let row = await trx
        .selectFrom('users')
        .selectAll()
        .where('auth_source', '=', 'ldap')
        .where('ldap_dn', '=', id.dn)
        .executeTakeFirst();
      if (!row) {
        const byName = await trx.selectFrom('users').selectAll().where('username', '=', id.username).executeTakeFirst();
        if (byName?.auth_source === 'local') {
          throw new AppError(
            409,
            'account_conflict',
            'A local account with this username already exists. Ask an administrator to resolve the conflict.',
          );
        }
        row = byName;
      }

      // E-mail addresses are unique; never take one away from another account.
      let email = id.email;
      if (email) {
        const owner = await trx.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
        if (owner && owner.id !== row?.id) {
          this.log.warn({ dn: id.dn }, 'directory e-mail address already belongs to another account; not copied');
          email = row?.email ?? null;
        }
      }

      if (!row) {
        const created = await trx
          .insertInto('users')
          .values({
            username: id.username,
            email,
            display_name: id.displayName,
            auth_source: 'ldap',
            password_hash: null,
            ldap_dn: id.dn,
            is_admin: id.isAdmin ?? false,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return { user: created, created: true, adminChanged: false };
      }

      // Keep the username in step with the directory unless it clashes.
      let username = row.username;
      if (id.username.toLowerCase() !== row.username.toLowerCase()) {
        const clash = await trx.selectFrom('users').select('id').where('username', '=', id.username).executeTakeFirst();
        if (!clash) username = id.username;
      }
      let isAdmin = id.isAdmin;
      if (isAdmin === false && row.is_admin && !row.is_disabled) {
        // Same rule as the admin API: never remove the last active administrator.
        const others = await trx
          .selectFrom('users')
          .select('id')
          .where('is_admin', '=', true)
          .where('is_disabled', '=', false)
          .where('id', '!=', row.id)
          .executeTakeFirst();
        if (!others) {
          this.log.warn(
            { userId: row.id },
            'directory group would remove the last administrator; keeping admin rights',
          );
          isAdmin = true;
        }
      }
      const updated = await trx
        .updateTable('users')
        .set({
          username,
          email,
          display_name: id.displayName,
          ldap_dn: id.dn,
          ...(isAdmin !== undefined ? { is_admin: isAdmin } : {}),
          updated_at: new Date(),
        })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { user: updated, created: false, adminChanged: updated.is_admin !== row.is_admin };
    });
    if (result.created) {
      await audit(this.db, {
        actorId: result.user.id,
        action: 'user.provisioned',
        targetType: 'user',
        targetId: result.user.id,
        details: { source: 'ldap' },
      });
    }
    if (result.adminChanged) {
      await audit(this.db, {
        actorId: null,
        action: result.user.is_admin ? 'user.admin_granted' : 'user.admin_revoked',
        targetType: 'user',
        targetId: result.user.id,
        details: { source: 'ldap-group' },
      });
    }
    return result.user;
  }

  // ---- connection test for administrators

  async test(input: {
    settings: LdapSettings;
    bindPassword?: string | null | undefined;
    username?: string | undefined;
    password?: string | undefined;
  }): Promise<LdapTestResult> {
    const s = ldapSettingsSchema.parse(input.settings);
    const bindPassword = this.resolvePassword(await this.load(), s, input.bindPassword);
    const steps: LdapTestStep[] = [];
    const result: LdapTestResult = { ok: false, steps };
    let current: LdapTestStep['step'] = 'connect';
    let connected = false;
    const pass = (step: LdapTestStep['step'], message: string) => steps.push({ step, ok: true, message });
    const connectedMessage = `Connected to ${new URL(s.url).host}${s.startTls && s.url.toLowerCase().startsWith('ldap:') ? ' using StartTLS' : ''}.`;
    let client: Client | undefined;
    try {
      client = await this.connect(s);
      current = 'bind';
      await this.serviceBind(client, s, bindPassword);
      if (s.bindDn) {
        connected = true;
        pass('connect', connectedMessage);
        pass('bind', `Signed in as ${s.bindDn}.`);
      }
      current = 'search';
      // For anonymous access this is the first round trip, so connection problems surface here.
      await client.search(s.userSearchBase, { scope: 'base', filter: '(objectClass=*)', attributes: ['1.1'] });
      if (!connected) {
        connected = true;
        pass('connect', connectedMessage);
        pass('bind', 'Using anonymous search.');
      }
      pass('search', `Search base ${s.userSearchBase} exists.`);

      if (input.username) {
        const found = await this.findUser(client, s, input.username);
        if (found.kind !== 'found') {
          steps.push({
            step: 'search',
            ok: false,
            message:
              found.kind === 'none'
                ? `No entry matches ${input.username}.`
                : `Several entries match ${input.username}; make the filter more specific.`,
          });
          return result;
        }
        const u = found.user;
        pass('search', `Found ${u.dn}.`);
        current = 'groups';
        const allowed = s.requiredGroupDn ? await this.inGroup(client, s, s.requiredGroupDn, u) : true;
        const admin = s.adminGroupDn ? await this.inGroup(client, s, s.adminGroupDn, u) : null;
        steps.push({
          step: 'groups',
          ok: allowed,
          message: s.requiredGroupDn
            ? allowed
              ? `Member of ${s.requiredGroupDn}${admin ? ' and of the administrator group' : ''}.`
              : `Not a member of ${s.requiredGroupDn}; sign-in would be refused.`
            : `No group restriction${admin ? '; member of the administrator group' : ''}.`,
        });
        result.user = { ...u, allowed, admin };
        if (input.password) {
          current = 'user-bind';
          try {
            await client.bind(u.dn, input.password);
            pass('user-bind', 'The password is correct.');
          } catch (err) {
            if (!(err instanceof InvalidCredentialsError)) throw err;
            steps.push({ step: 'user-bind', ok: false, message: 'The password is wrong.' });
          }
        }
      }
      result.ok = steps.every((st) => st.ok);
      return result;
    } catch (err) {
      const unreachable = !connected && isConnectionError(err);
      // Any answer from the server proves the connection worked.
      if (!connected && !unreachable) pass('connect', connectedMessage);
      const step = unreachable ? 'connect' : current;
      steps.push({ step, ok: false, message: describeLdapError(err) });
      return result;
    } finally {
      await client?.unbind().catch(() => undefined);
    }
  }

  // ---- directory operations

  private async connect(s: LdapSettings): Promise<Client> {
    const url = new URL(s.url);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const tlsOptions: tls.ConnectionOptions = {
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      ...(isIP(host) ? {} : { servername: host }),
      ...(s.caCertificate ? { ca: [...tls.rootCertificates, s.caCertificate] } : {}),
    };
    const ms = s.timeoutSeconds * 1000;
    // ldapts connects with TLS whenever tlsOptions are given, so they are only passed for ldaps://;
    // it also mutates the options (storing the socket in them), so each use gets its own copy.
    const secure = url.protocol === 'ldaps:';
    const client = new Client({
      url: s.url,
      timeout: ms,
      connectTimeout: ms,
      strictDN: false,
      ...(secure ? { tlsOptions: { ...tlsOptions } } : {}),
    });
    if (!secure && s.startTls) {
      try {
        await client.startTLS({ ...tlsOptions });
      } catch (err) {
        await client.unbind().catch(() => undefined);
        throw err;
      }
    }
    return client;
  }

  private async serviceBind(client: Client, s: LdapSettings, bindPassword: string | null): Promise<void> {
    if (!s.bindDn) return;
    if (!bindPassword) throw new Error('No bind password is configured for the bind DN.');
    await client.bind(s.bindDn, bindPassword);
  }

  private async findUser(client: Client, s: LdapSettings, username: string): Promise<Lookup> {
    const filter = fillFilter(s.userFilter, { username });
    let entries: Entry[];
    try {
      entries = (
        await client.search(s.userSearchBase, {
          scope: 'sub',
          filter,
          attributes: [s.usernameAttribute, s.displayNameAttribute, s.emailAttribute],
          sizeLimit: 2,
        })
      ).searchEntries;
    } catch (err) {
      if (err instanceof SizeLimitExceededError) return { kind: 'ambiguous' };
      throw err;
    }
    if (entries.length === 0) return { kind: 'none' };
    if (entries.length > 1) return { kind: 'ambiguous' };
    const e = entries[0]!;
    const canonical = attr(e, s.usernameAttribute) ?? username;
    return {
      kind: 'found',
      user: {
        dn: e.dn,
        username: canonical,
        displayName: attr(e, s.displayNameAttribute) ?? canonical,
        email: attr(e, s.emailAttribute)?.toLowerCase() ?? null,
      },
    };
  }

  private async inGroup(client: Client, s: LdapSettings, groupDn: string, u: DirectoryUser): Promise<boolean> {
    const filter = fillFilter(s.groupMembershipFilter, { dn: u.dn, username: u.username });
    try {
      const { searchEntries } = await client.search(groupDn, { scope: 'base', filter, attributes: ['1.1'] });
      return searchEntries.length > 0;
    } catch (err) {
      if (err instanceof NoSuchObjectError) {
        this.log.warn({ groupDn }, 'configured LDAP group does not exist');
        return false;
      }
      throw err;
    }
  }
}
