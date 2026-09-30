# Real-time collaboration

## Model

TeXCollab uses the **Yjs** CRDT through a **Hocuspocus** server embedded in
the app process (`apps/server/src/modules/collab/`).

| Channel | Content |
|---|---|
| `doc:<entityId>` | One Y.Doc per text file (`Y.Text('content')`) plus awareness (cursors/selections) |
| `project:<projectId>` | Awareness only (who is in the project, which file they have open) and server notifications (`tree`, `project`, `compiled`, …) |

All channels of a project share one WebSocket (`/collab`), which reconnects
automatically with backoff. Because Yjs merges by state vectors, edits made
while offline are merged when the connection returns — nothing is
overwritten ("last write wins" never happens).

## Persistence

* Documents are loaded from `doc_contents` (Yjs state, or the plain-text
  mirror for documents never opened collaboratively).
* Changes are stored at most 2 s after typing stops and at least every 10 s
  while typing continues, together with the plain-text mirror used by
  compilation, export, history and search. Pending changes are flushed on
  shutdown.
* Compilation and export read the **live** in-memory document, so a compile
  always includes the latest keystrokes.
* Server-side changes (uploading over a file, restoring a version, Git pull,
  the REST text API) are applied to the live document as a minimal
  collaborative edit, so everyone's editor updates in place and cursors
  outside the changed region stay put.
* Contributors are recorded per project (`project_changes`) for automatic
  versioning.

## Security

* The WebSocket upgrade is authenticated with the session cookie and must
  come from `PUBLIC_URL`'s origin (prevents cross-site WebSocket hijacking).
* Every channel join is authorised against project membership; viewers get
  **read-only** connections (the server discards their updates).
* Identity in cursors and presence cannot be forged: the server overwrites
  the `user` field of every awareness update with the authenticated user's
  id, display name and colour. No e-mail addresses are shared.
* Logging out, session expiry, password resets and disabling an account
  close the user's live connections (sessions are re-checked every minute);
  deleting a file or project closes its channels.
* Limits: 30 WebSockets per user, 16 MB per message, 8 MB per update.

## In the editor

* Remote cursors and selections carry the collaborator's name and colour.
* Undo/redo (`Ctrl/Cmd+Z`, `Ctrl/Cmd+Y`, `Ctrl/Cmd+Shift+Z`) only undoes
  **your own** changes.
* The header shows everyone currently in the project (hover for the file
  they have open) and the connection state; the file tree marks files other
  people have open.
* When anyone compiles, everyone's PDF refreshes.

## Scaling beyond one app instance

Hocuspocus supports a Redis extension that relays updates between
instances. Adding it requires Redis and sticky sessions for `/collab` on the
reverse proxy; no data-model change is needed (see architecture §3.3).
