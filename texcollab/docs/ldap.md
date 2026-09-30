# Directory sign-in (LDAP / Active Directory)

TeXCollab can let people sign in with their directory account. Local
accounts keep working alongside it (for example a break-glass administrator).

Configure it under **Administration → Directory (LDAP)**. Changes apply to
the next sign-in; no restart is needed.

## How sign-in works

1. The login name is looked up **locally first**. A local account with that
   name always authenticates locally — a directory entry can never take it
   over.
2. Otherwise TeXCollab connects to the directory, binds as the **service
   account** (or anonymously), and searches below the *user search base*
   with the *user filter*, in which `{username}` is replaced by the typed
   name, escaped per RFC 4515 (so `*`, `(`, `)` cannot change the filter).
   Exactly one entry must match; zero or several matches refuse the
   sign-in.
3. If a *required group* is set, the user must be a member (checked with the
   membership filter on the group entry).
4. The user's password is verified by **binding as the user's DN**. Empty
   passwords are refused before contacting the server (many servers treat
   them as a successful "unauthenticated bind").
5. The local account is created on first sign-in, or updated: display name,
   e-mail address and username follow the directory; if an
   *administrators group* is set, administrator rights follow membership
   (except that the last active administrator is never demoted). Pending
   project invitations for the user's e-mail address are claimed.

Passwords are never stored. Directory users cannot change their password in
TeXCollab, and administrators cannot reset it. Disabling a directory user in
TeXCollab blocks them even if the directory accepts the password.

If the directory cannot be reached, sign-in answers *"The directory service
is unavailable"* (HTTP 503) for directory users; local accounts are not
affected. While the directory is disabled, directory users cannot sign in.

## Settings

| Setting | Notes |
|---|---|
| Server URL | `ldaps://host[:636]`, or `ldap://host[:389]` with **StartTLS**. Unencrypted `ldap://` requires an explicit opt-in and should only be used on isolated test setups. |
| Trusted CA certificate | PEM of a private CA. Server certificates are **always verified** (host name and chain); there is no "ignore certificate errors" switch. |
| Bind DN / password | Service account used for searching. The password is encrypted (AES-256-GCM, key derived from `APP_SECRET`), write-only, and must be re-entered whenever the server URL or bind DN changes — so the stored password can never be sent to a different server. Grant the account read access to users and groups only. |
| User search base, filter | E.g. `ou=people,dc=example,dc=org` and `(&(objectClass=person)(uid={username}))`. |
| Attributes | Username (`uid` / `sAMAccountName`), name (`cn` / `displayName`), e-mail (`mail`). |
| Required group, administrators group | Full DNs of group entries. |
| Membership filter | Evaluated on the group entry with `{dn}` and `{username}` replaced. Default `(|(member={dn})(uniqueMember={dn})(memberUid={username}))` covers `groupOfNames`, `groupOfUniqueNames` and `posixGroup`. |
| Timeout | Connect and per-operation timeout. |

### Active Directory example

| Setting | Value |
|---|---|
| Server URL | `ldaps://dc01.corp.example.com` |
| User search base | `DC=corp,DC=example,DC=com` |
| User filter | `(&(objectClass=user)(sAMAccountName={username})(!(userAccountControl:1.2.840.113556.1.4.803:=2)))` (excludes disabled accounts) |
| Username attribute | `sAMAccountName` |
| Name attribute | `displayName` |
| Membership filter | `(member:1.2.840.113556.1.4.1941:={dn})` (includes nested groups) |

## Testing a configuration

**Test** on the same page tries the settings in the form (saved or not):
connection and TLS, service-account bind, search base, and optionally
looks up a user, shows the attributes and group results, and checks a
password. Nothing is stored and no account is created. Error messages are
specific (for example *certificate not trusted*, *connection refused*,
*invalid credentials*) but never contain passwords.

## Conflicts and edge cases

* **Local account with the same name:** the local account wins (step 1).
  If a directory login resolves to a username that belongs to a local
  account (e.g. signing in with an e-mail address), sign-in is refused with
  *"A local account with this username already exists"*. An administrator
  can rename or delete the local account.
* **E-mail already used by another account:** the address is not copied;
  a warning is logged.
* **User moved in the directory (new DN):** matched by username and the DN
  is updated.
* Accounts are not de-provisioned automatically when removed from the
  directory; they simply can no longer sign in. Disable or delete them on
  the Users page to also end their existing sessions.

## Tests

`apps/server/src/modules/ldap/ldap.test.ts` runs against a real OpenLDAP
server (`docker/test-ldap`, built as `texcollab/test-ldap:dev`) with LDAPS,
StartTLS, groups and hostile user names; the tests are skipped if the image
is not available.
