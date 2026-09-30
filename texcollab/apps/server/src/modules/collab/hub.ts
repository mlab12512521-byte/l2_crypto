import { createHash } from 'node:crypto';
import { Hocuspocus } from '@hocuspocus/server';
import {
  type AwarenessUser,
  DOC_PREFIX,
  type DocContent,
  docChannel,
  PROJECT_PREFIX,
  type ProjectEvent,
  projectChannel,
  userColor,
} from '@texcollab/shared';
import type { Logger } from 'pino';
import * as Y from 'yjs';
import type { Db } from '../../db/index.js';
import type { SessionStore } from '../auth/sessions.js';
import { type DocWriter, recordChange } from '../files/service.js';
import type { ProjectAccess } from '../projects/access.js';

/** Per-connection context, established when the WebSocket is accepted. */
export interface CollabContext {
  user: { id: string; displayName: string };
  sessionId: Buffer;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const DOC_NAME = new RegExp(`^${DOC_PREFIX}(${UUID})$`);
const PROJECT_NAME = new RegExp(`^${PROJECT_PREFIX}(${UUID})$`);

/** Text of a collaborative document lives in this Y.Text. */
export const TEXT_KEY = 'content';

const SYSTEM_CONTEXT = { system: true } as const;

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Replace the content of a Y.Text with `next` using the smallest single
 * edit (common prefix/suffix kept), so remote cursors outside the changed
 * region stay where they are.
 */
export function applyTextDiff(ytext: Y.Text, next: string): void {
  const prev = ytext.toString();
  if (prev === next) return;
  let start = 0;
  const minLen = Math.min(prev.length, next.length);
  while (start < minLen && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
    endPrev--;
    endNext--;
  }
  const apply = () => {
    if (endPrev > start) ytext.delete(start, endPrev - start);
    if (endNext > start) ytext.insert(start, next.slice(start, endNext));
  };
  // One transaction: peers see a single atomic replacement.
  if (ytext.doc) ytext.doc.transact(apply);
  else apply();
}

/**
 * Real-time collaboration: a Hocuspocus (Yjs) server embedded in the app.
 *
 * Channels:
 *  - `doc:<entityId>`     one Y.Doc per text document (content + cursors)
 *  - `project:<projectId>` presence (awareness) and server notifications
 *
 * Every channel is authorised on join against project membership; viewers get
 * read-only connections. The hub is also the DocWriter used by the rest of
 * the app, so server-side edits (uploads, restores, Git pulls) reach live
 * editors as ordinary collaborative changes.
 */
export class CollabHub implements DocWriter {
  readonly hocuspocus: Hocuspocus<CollabContext>;
  /** Contributors per document since its last store. */
  private readonly pendingContributors = new Map<string, Set<string>>();
  /** Project of each doc channel that is (or was) open. */
  private readonly docProject = new Map<string, string>();
  /** Live sockets per user, for revocation. */
  private readonly sockets = new Map<
    string,
    Set<{ close: (code?: number, reason?: string) => void; sessionId: Buffer }>
  >();

  constructor(
    private readonly db: Db,
    private readonly access: ProjectAccess,
    private readonly sessions: SessionStore,
    private readonly log: Logger,
    private readonly opts: { maxTextBytes: () => Promise<number> },
  ) {
    this.hocuspocus = new Hocuspocus<CollabContext>({
      name: 'texcollab',
      quiet: true,
      debounce: 2000,
      maxDebounce: 10_000,
      timeout: 60_000,
      unloadImmediately: false,
      onAuthenticate: (data) => this.authenticate(data),
      onLoadDocument: (data) => this.load(data.documentName, data.document),
      beforeHandleMessage: async (data) => {
        // Bound the size of any single update (a pasted novel is fine; megabytes of junk are not).
        if (data.update.byteLength > 8 * 1024 * 1024) throw new Error('update too large');
      },
      onChange: async (data) => {
        const ctx = data.context as Partial<CollabContext> | undefined;
        if (!ctx?.user || !DOC_NAME.test(data.documentName)) return;
        let set = this.pendingContributors.get(data.documentName);
        if (!set) {
          set = new Set();
          this.pendingContributors.set(data.documentName, set);
        }
        set.add(ctx.user.id);
      },
      onStoreDocument: (data) => this.store(data.documentName, data.document),
      beforeHandleAwareness: async (data) => {
        const ctx = data.context as Partial<CollabContext> | undefined;
        if (!ctx?.user) return;
        // Stamp the authenticated identity onto every awareness state from this
        // connection; clients cannot impersonate other users.
        const identity: AwarenessUser = { id: ctx.user.id, name: ctx.user.displayName, ...userColor(ctx.user.id) };
        for (const [clientId, state] of data.states) {
          if (!state || typeof state !== 'object') continue;
          if (JSON.stringify(state).length > 8192) {
            data.states.delete(clientId);
            continue;
          }
          state.user = identity;
        }
      },
    });
  }

  // ---------------------------------------------------------------- hooks

  private async authenticate(data: {
    documentName: string;
    context: CollabContext;
    connectionConfig: { readOnly: boolean };
  }): Promise<void> {
    const user = data.context?.user;
    if (!user) throw new Error('unauthenticated');
    let projectId: string;
    const doc = DOC_NAME.exec(data.documentName);
    const project = PROJECT_NAME.exec(data.documentName);
    if (doc) {
      const entity = await this.db
        .selectFrom('project_entities')
        .select(['project_id', 'kind'])
        .where('id', '=', doc[1]!)
        .executeTakeFirst();
      if (entity?.kind !== 'doc') throw new Error('not found');
      projectId = entity.project_id;
      this.docProject.set(data.documentName, projectId);
    } else if (project) {
      projectId = project[1]!;
    } else {
      throw new Error('invalid document name');
    }
    const role = await this.access.roleOf(projectId, user.id);
    if (!role) throw new Error('not found');
    // Viewers may watch but never change documents.
    if (role === 'viewer') data.connectionConfig.readOnly = true;
  }

  private async load(documentName: string, document: Y.Doc): Promise<void> {
    const m = DOC_NAME.exec(documentName);
    if (!m) return; // project channels carry no document content
    const row = await this.db
      .selectFrom('doc_contents')
      .select(['yjs_state', 'text'])
      .where('entity_id', '=', m[1]!)
      .executeTakeFirst();
    if (!row) return;
    if (row.yjs_state) {
      Y.applyUpdate(document, new Uint8Array(row.yjs_state));
      // Defensive: the text mirror is authoritative if the two ever disagree.
      const ytext = document.getText(TEXT_KEY);
      if (ytext.toString() !== row.text) applyTextDiff(ytext, row.text);
    } else {
      document.getText(TEXT_KEY).insert(0, row.text);
    }
  }

  private async store(documentName: string, document: Y.Doc): Promise<void> {
    const m = DOC_NAME.exec(documentName);
    if (!m) return;
    const entityId = m[1]!;
    const text = document.getText(TEXT_KEY).toString();
    const hash = hashText(text);
    const contributors = [...(this.pendingContributors.get(documentName) ?? [])];
    this.pendingContributors.delete(documentName);
    const maxBytes = await this.opts.maxTextBytes();
    const size = Buffer.byteLength(text);
    if (size > maxBytes) {
      this.log.warn({ entityId, size }, 'collaborative document exceeds the text size limit');
    }
    const updated = await this.db.transaction().execute(async (trx) => {
      const prev = await trx
        .selectFrom('doc_contents')
        .select('content_hash')
        .where('entity_id', '=', entityId)
        .executeTakeFirst();
      if (!prev) return null; // document was deleted meanwhile
      await trx
        .updateTable('doc_contents')
        .set({
          yjs_state: Buffer.from(Y.encodeStateAsUpdate(document)),
          text,
          content_hash: hash,
          updated_at: new Date(),
          ...(contributors[0] ? { updated_by: contributors[contributors.length - 1] } : {}),
        })
        .where('entity_id', '=', entityId)
        .execute();
      const entity = await trx
        .updateTable('project_entities')
        .set({ size, ...(prev.content_hash !== hash ? { updated_at: new Date() } : {}) })
        .where('id', '=', entityId)
        .returning('project_id')
        .executeTakeFirst();
      return entity && prev.content_hash !== hash ? entity.project_id : null;
    });
    if (updated) {
      for (const userId of contributors.length ? contributors : [null]) await recordChange(this.db, updated, userId);
    }
  }

  // ---------------------------------------------------------------- DocWriter

  async read(entityId: string): Promise<DocContent | null> {
    const live = this.hocuspocus.documents.get(docChannel(entityId));
    if (live) {
      const text = live.getText(TEXT_KEY).toString();
      return { text, contentHash: hashText(text) };
    }
    const row = await this.db
      .selectFrom('doc_contents')
      .select(['text', 'content_hash'])
      .where('entity_id', '=', entityId)
      .executeTakeFirst();
    return row ? { text: row.text, contentHash: row.content_hash } : null;
  }

  /** Replace a document's text as a collaborative edit (live editors see it immediately). */
  async write(entityId: string, text: string, userId: string | null): Promise<DocContent> {
    const name = docChannel(entityId);
    if (userId) {
      let set = this.pendingContributors.get(name);
      if (!set) {
        set = new Set();
        this.pendingContributors.set(name, set);
      }
      set.add(userId);
    }
    const connection = await this.hocuspocus.openDirectConnection(name, SYSTEM_CONTEXT as unknown as CollabContext);
    try {
      await connection.transact((doc) => applyTextDiff(doc.getText(TEXT_KEY), text));
    } finally {
      await connection.disconnect();
    }
    // Persist now so the database mirror is current for callers that read it directly.
    const live = this.hocuspocus.documents.get(name);
    if (live) await this.store(name, live);
    return { text, contentHash: hashText(text) };
  }

  // ---------------------------------------------------------------- notifications & lifecycle

  /** Send an event to everyone in a project (no-op if nobody is connected). */
  notify(projectId: string, event: ProjectEvent): void {
    const doc = this.hocuspocus.documents.get(projectChannel(projectId));
    doc?.broadcastStateless(JSON.stringify(event));
  }

  /** Disconnect everyone from a document (e.g. it was deleted). */
  closeDocument(entityId: string): void {
    this.hocuspocus.closeConnections(docChannel(entityId));
    this.pendingContributors.delete(docChannel(entityId));
  }

  /** Disconnect everyone from every channel of a project (project deleted). */
  closeProject(projectId: string): void {
    this.hocuspocus.closeConnections(projectChannel(projectId));
    for (const [name, pid] of this.docProject) {
      if (pid === projectId) {
        this.hocuspocus.closeConnections(name);
        this.docProject.delete(name);
      }
    }
  }

  registerSocket(
    userId: string,
    sessionId: Buffer,
    socket: { close: (code?: number, reason?: string) => void },
  ): () => void {
    const entry = { close: socket.close.bind(socket), sessionId };
    let set = this.sockets.get(userId);
    if (!set) {
      set = new Set();
      this.sockets.set(userId, set);
    }
    set.add(entry);
    return () => {
      set.delete(entry);
      if (set.size === 0) this.sockets.delete(userId);
    };
  }

  socketCount(userId: string): number {
    return this.sockets.get(userId)?.size ?? 0;
  }

  /** Close all live connections of a user (account disabled, sessions revoked, access removed). */
  disconnectUser(userId: string): void {
    for (const s of this.sockets.get(userId) ?? []) s.close(4403, 'access revoked');
  }

  /** Close the connections opened with one session (logout on one device). */
  disconnectSession(sessionId: Buffer): void {
    for (const [, set] of this.sockets) {
      for (const s of set) if (s.sessionId.equals(sessionId)) s.close(4401, 'logged out');
    }
  }

  /** Close connections whose session is no longer valid (expired, logged out, revoked). */
  async sweepSessions(): Promise<number> {
    let closed = 0;
    for (const [, set] of this.sockets) {
      for (const s of [...set]) {
        if (!(await this.sessions.isValid(s.sessionId))) {
          s.close(4401, 'session ended');
          closed++;
        }
      }
    }
    return closed;
  }

  stats() {
    return {
      documents: this.hocuspocus.getDocumentsCount(),
      connections: this.hocuspocus.getConnectionsCount(),
      users: this.sockets.size,
    };
  }

  /** Persist all pending changes (shutdown). */
  async flush(): Promise<void> {
    for (const [name, doc] of this.hocuspocus.documents) {
      if (DOC_NAME.test(name)) await this.store(name, doc);
    }
  }
}
