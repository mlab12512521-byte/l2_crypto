# Sharing and permissions

## Roles

| Role | Can |
|---|---|
| **Owner** (exactly one) | Everything an editor can, plus: share, change roles, remove members, cancel invitations, transfer ownership, rename and delete the project |
| **Editor** | Edit files and folders, upload, change the engine and main file, compile, download, see members, leave |
| **Viewer** | Open files read-only, compile and view the PDF, download, see members, leave |

Anyone without a membership gets **404 Not found** for every project URL
(the project's existence is not revealed). Administrators have no implicit
access to projects.

## Sharing

Owners open **Share** in the project header and type a name, username or
e-mail address:

* An existing account is added immediately with the chosen role.
* An e-mail address without an account becomes an **invitation** (valid 30
  days). It is claimed automatically when a user with that address first
  signs in — typically a colleague's first LDAP login — or when an
  administrator creates their account. No e-mail is sent; tell the person
  about the project yourself.

User search only returns enabled accounts and shows names and usernames,
never e-mail addresses (an exact e-mail match still finds the person).

## Changing access

* Owners change roles and remove members in the Share dialog; members can
  **leave** a project (Share dialog or dashboard).
* **Transfer ownership** makes another member the owner; the previous owner
  becomes an editor. The owner cannot be removed or demoted otherwise.
* Changes take effect immediately, including in open editors: affected
  users' live connections are re-authorised (a demoted editor's editor
  turns read-only; a removed member loses access), and everyone in the
  project sees the updated member list.

All sharing actions are recorded in the audit log.
