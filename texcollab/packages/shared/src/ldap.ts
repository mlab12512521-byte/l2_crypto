import { z } from 'zod';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

/** Attribute names: letters, digits and hyphens (RFC 4512 descr) or a numeric OID. */
const attributeName = z
  .string()
  .trim()
  .regex(/^([A-Za-z][A-Za-z0-9-]{0,63}|\d+(\.\d+)+)$/, 'Not a valid attribute name');

export const LDAP_DEFAULT_USER_FILTER = '(&(objectClass=person)(uid={username}))';
export const LDAP_DEFAULT_MEMBERSHIP_FILTER = '(|(member={dn})(uniqueMember={dn})(memberUid={username}))';

/**
 * Directory settings as edited by administrators (without the bind password,
 * which is write-only and handled separately).
 */
export const ldapSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** ldap://host[:port] or ldaps://host[:port]. */
    url: z
      .string()
      .trim()
      .max(500)
      .regex(/^ldaps?:\/\/[^\s/?#]+\/?$/i, 'Use ldap://host[:port] or ldaps://host[:port]')
      .or(z.literal(''))
      .default(''),
    /** Upgrade ldap:// connections with StartTLS. */
    startTls: z.boolean().default(false),
    /**
     * Explicitly accept an unencrypted connection (ldap:// without StartTLS).
     * Passwords would travel in clear text; only for isolated test setups.
     */
    allowUnencrypted: z.boolean().default(false),
    /** Extra trusted CA certificates (PEM) for a private certificate authority. */
    caCertificate: optionalText(100_000).refine((v) => v === null || v.includes('-----BEGIN CERTIFICATE-----'), {
      message: 'Paste one or more PEM certificates',
    }),
    /** Service account used to search for users; empty = anonymous search. */
    bindDn: optionalText(1000),
    userSearchBase: z.string().trim().max(1000).default(''),
    /** Search filter; {username} is replaced by the escaped login name. */
    userFilter: z
      .string()
      .trim()
      .max(2000)
      .refine((v) => v.includes('{username}'), { message: 'The filter must contain {username}' })
      .default(LDAP_DEFAULT_USER_FILTER),
    usernameAttribute: attributeName.default('uid'),
    displayNameAttribute: attributeName.default('cn'),
    emailAttribute: attributeName.default('mail'),
    /** Only members of this group may sign in (empty = everyone the filter finds). */
    requiredGroupDn: optionalText(1000),
    /** Members of this group become administrators; others lose admin rights at sign-in (empty = not managed). */
    adminGroupDn: optionalText(1000),
    /** Filter evaluated on a group entry; {dn} and {username} are replaced (escaped). */
    groupMembershipFilter: z.string().trim().max(2000).default(LDAP_DEFAULT_MEMBERSHIP_FILTER),
    timeoutSeconds: z.number().int().min(1).max(60).default(10),
  })
  .superRefine((v, ctx) => {
    if (!v.enabled) return;
    if (!v.url) ctx.addIssue({ code: 'custom', path: ['url'], message: 'Required when the directory is enabled' });
    if (!v.userSearchBase)
      ctx.addIssue({ code: 'custom', path: ['userSearchBase'], message: 'Required when the directory is enabled' });
    if (v.url.toLowerCase().startsWith('ldap://') && !v.startTls && !v.allowUnencrypted)
      ctx.addIssue({
        code: 'custom',
        path: ['startTls'],
        message: 'Use ldaps:// or StartTLS, or explicitly allow an unencrypted connection',
      });
  });

export type LdapSettings = z.infer<typeof ldapSettingsSchema>;

/** What the admin API returns: settings plus whether a bind password is stored. */
export interface LdapSettingsView extends LdapSettings {
  hasBindPassword: boolean;
}

/** Update body: settings plus the bind password (omit = keep, null = remove). */
export const ldapUpdateSchema = z.object({
  settings: ldapSettingsSchema,
  bindPassword: z.string().max(1000).nullish(),
});

export const ldapTestSchema = ldapUpdateSchema.extend({
  /** Optionally look up (and with a password, verify) a user. */
  username: z.string().trim().max(256).optional(),
  password: z.string().max(1000).optional(),
});

export interface LdapTestStep {
  step: 'connect' | 'bind' | 'search' | 'groups' | 'user-bind';
  ok: boolean;
  message: string;
}

export interface LdapTestResult {
  ok: boolean;
  steps: LdapTestStep[];
  user?: {
    dn: string;
    username: string;
    displayName: string;
    email: string | null;
    allowed: boolean;
    admin: boolean | null;
  };
}
