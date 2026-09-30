# History, versions and Git

Every project has its own Git repository on the server. Users never need to
know Git to benefit from it: the **History** view shows versions, diffs and
restores; people who do use Git can connect the project to GitHub, GitLab,
Gitea or any HTTPS Git server.

## Versions

A *version* is a Git commit of the complete project plus a row in the
`versions` table (kind, label, author, contributors). Versions are created:

| Kind | When |
|---|---|
| `initial` / `import` | A project is created or imported from a ZIP. |
| `auto` | After **5 minutes** without edits, or at the latest **30 minutes** after the first unsaved edit (admin-configurable under *Admin → Settings → Project history*). Also just before a restore, so nothing is ever lost. |
| `named` | A user clicks **Save version** and gives it a label ("Submitted to journal"). |
| `restore` | An earlier version was restored. |
| `git-pull` | Changes were pulled from the external remote. |

No version is created when nothing actually changed (an edit that was
reverted produces the same tree and is skipped). Contributors are tracked
per project between versions (`project_changes`) and recorded on the version
and as `Co-authored-by` trailers. Git author addresses are pseudonymous
(`<username>@users.texcollab.invalid`) — real e-mail addresses never enter the
repository, so pushing a project does not publish them.

Automatic versioning runs every minute on each app instance; a PostgreSQL
advisory lock per project makes it safe to run on several instances, and a
per-project lock serialises all writes to one repository.

## History view

*History* (project header) lists versions grouped by day with their authors.
Selecting a version shows the files changed compared with the previous
version (or with the current state), side-by-side text diffs, and a summary
for binary files. From there users can:

* **Download** a version as a ZIP (viewers too);
* **Restore** it (editors): the current state is first saved as an automatic
  version, then files are updated in place — documents keep their identity,
  so open editors and collaborators see the change live. Restoring is itself
  a new version; history is never rewritten.

## How snapshots are written

Snapshots are built from the database and blob store, never from a checkout:
`git fast-import` writes blobs, trees and the commit into a temporary ref,
which is then moved to `refs/heads/main` with `update-ref` (compare-and-swap
against the expected old commit). No working tree exists on the server, so
user-controlled path names never touch the host file system, and hooks are
disabled for every git invocation (`core.hooksPath=/dev/null`, no system or
global config).

Repositories live at `DATA_DIR/git/<project-uuid>.git`; the path is derived
from the validated project id only. They are deleted with the project and
compacted daily (`git gc`) for projects active in the past week.

## External remotes

Project **owners** configure a remote under *History → Git*: an HTTPS URL, a
branch, and optionally a username and access token. **Editors** can then
push and pull; viewers see the configuration (never the token).

* **Push** sends the project history to the branch. If the remote has
  commits the project does not, the push is refused with "Pull first".
* **Pull** fetches the branch and
  * fast-forwards if the project has no new changes,
  * otherwise merges with `git merge-tree --write-tree` (no working tree); a
    clean merge is applied to the project and recorded as a `git-pull`
    version,
  * or, on conflicts, changes nothing and reports the conflicting files so
    they can be resolved on one side.

  Pulled content goes through the same validation as uploads (safe names,
  size and entity limits) and is applied non-destructively.

Providers (`apps/server/src/modules/git/remote.ts`, `PROVIDERS`) only
contribute defaults and help text — GitHub, GitLab and Gitea/Forgejo all use
plain HTTPS Git with a token as the password, so one implementation serves
them all. Adding a provider is one entry in that list.

### Security

* **HTTPS only** (decision D15). `GIT_ALLOW_PROTOCOL=https`; `file://`,
  `ext::`, `ssh://` and plain `http://` are rejected.
* **No SSRF into the internal network.** The host is resolved before every
  push/pull and rejected if any address is private, loopback, link-local
  (including cloud metadata) or CGNAT, unless the administrator allow-lists
  the host (*Admin → Settings → Git remotes*). Once hosts are listed, only
  those hosts are allowed. Redirects are not followed
  (`http.followRedirects=false`).
* **Credentials** are encrypted at rest (AES-256-GCM, key derived from
  `APP_SECRET`), never returned by the API, and handed to git through a
  short-lived `GIT_ASKPASS` helper reading environment variables — never in
  the URL, command line or logs. URLs containing credentials are rejected.
* Git error output is never shown to users (it may contain URLs or server
  messages); it is mapped to generic messages. The raw output (truncated)
  goes to the server log for administrators; it cannot contain the token,
  which git only ever receives through the askpass helper.
* Private CA: set `GIT_CA_BUNDLE` to a PEM file to trust an internal
  certificate authority.

## Limitations

See `docs/tech-debt.md` (TD18–TD20): no SSH remotes, empty folders are not
versioned (Git has no empty directories), and fetch size is bounded only by
the timeout.
