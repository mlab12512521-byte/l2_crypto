import { ldapSettingsSchema } from '@texcollab/shared';
import { describe, expect, it } from 'vitest';
import { escapeFilterValue, fillFilter } from './filter.js';

describe('LDAP filter escaping', () => {
  it('escapes the RFC 4515 special characters', () => {
    expect(escapeFilterValue('a*b(c)d\\e\0f')).toBe('a\\2ab\\28c\\29d\\5ce\\00f');
    expect(escapeFilterValue('Jürgen Müller')).toBe('Jürgen Müller');
  });

  it('cannot change the structure of a filter', () => {
    const f = fillFilter('(&(objectClass=person)(uid={username}))', { username: '*)(uid=*' });
    expect(f).toBe('(&(objectClass=person)(uid=\\2a\\29\\28uid=\\2a))');
    expect(fillFilter('(uid={username})', { username: '*' })).toBe('(uid=\\2a)');
  });

  it('fills several placeholders and leaves unknown ones alone', () => {
    expect(
      fillFilter('(|(member={dn})(memberUid={username})(x={other}))', { dn: 'uid=a(b),dc=x', username: 'a' }),
    ).toBe('(|(member=uid=a\\28b\\29,dc=x)(memberUid=a)(x={other}))');
  });
});

describe('LDAP settings validation', () => {
  const base = { enabled: true, url: 'ldaps://ldap.example.org', userSearchBase: 'ou=people,dc=example,dc=org' };

  it('accepts a complete configuration with defaults', () => {
    const s = ldapSettingsSchema.parse(base);
    expect(s).toMatchObject({ usernameAttribute: 'uid', timeoutSeconds: 10, bindDn: null });
  });

  it.each([
    [{ url: '' }, /Required/],
    [{ url: 'http://ldap.example.org' }, /ldaps/],
    [{ url: 'ldap://ldap.example.org' }, /StartTLS/],
    [{ userFilter: '(uid=alice)' }, /\{username\}/],
    [{ usernameAttribute: 'uid)(x' }, /attribute/],
    [{ caCertificate: 'not a cert' }, /PEM/],
  ])('rejects %j', (patch, message) => {
    const r = ldapSettingsSchema.safeParse({ ...base, ...patch });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(message);
  });

  it('allows plain ldap:// only with StartTLS or an explicit opt-in', () => {
    expect(ldapSettingsSchema.safeParse({ ...base, url: 'ldap://h:389', startTls: true }).success).toBe(true);
    expect(ldapSettingsSchema.safeParse({ ...base, url: 'ldap://h:389', allowUnencrypted: true }).success).toBe(true);
  });

  it('does not require server details while disabled', () => {
    expect(ldapSettingsSchema.parse({}).enabled).toBe(false);
  });
});
