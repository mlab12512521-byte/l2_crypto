import { type Extension, Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { type AwarenessUser, docChannel, type ProjectEvent, projectChannel } from '@texcollab/shared';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import type { DocumentSession, SaveStatus } from '../editor/document-session';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface PresenceEntry {
  clientId: number;
  user: AwarenessUser;
  openFile: string | null;
}

function collabUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/collab`;
}

/**
 * One multiplexed WebSocket per open project: a presence/notification
 * channel for the project plus one channel per open document. Reconnects
 * automatically with backoff; Yjs merges edits made while offline.
 */
export class ProjectConnection {
  readonly socket: HocuspocusProviderWebsocket;
  readonly project: HocuspocusProvider;
  private state: ConnectionState = 'connecting';
  private stateListeners = new Set<(s: ConnectionState) => void>();
  private eventListeners = new Set<(e: ProjectEvent) => void>();
  private presenceListeners = new Set<(p: PresenceEntry[]) => void>();

  constructor(
    readonly projectId: string,
    readonly me: AwarenessUser,
  ) {
    this.socket = new HocuspocusProviderWebsocket({
      url: collabUrl(),
      minDelay: 500,
      maxDelay: 10_000,
      onStatus: ({ status }) => this.setState(status as ConnectionState),
    });
    this.project = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: projectChannel(projectId),
      token: 'session',
      onStateless: ({ payload }) => {
        try {
          const event = JSON.parse(payload) as ProjectEvent;
          for (const fn of this.eventListeners) fn(event);
        } catch {
          // Ignore malformed notifications.
        }
      },
      onAwarenessChange: () => this.emitPresence(),
    });
    this.project.attach();
    // The server overwrites `user` with the authenticated identity; set it locally for our own view.
    this.project.setAwarenessField('user', me);
    this.project.setAwarenessField('openFile', null);
  }

  private setState(s: ConnectionState) {
    this.state = s;
    for (const fn of this.stateListeners) fn(s);
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  onState(fn: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(fn);
    fn(this.state);
    return () => this.stateListeners.delete(fn);
  }

  onEvent(fn: (e: ProjectEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  onPresence(fn: (p: PresenceEntry[]) => void): () => void {
    this.presenceListeners.add(fn);
    fn(this.presence());
    return () => this.presenceListeners.delete(fn);
  }

  presence(): PresenceEntry[] {
    const out: PresenceEntry[] = [];
    this.project.awareness?.getStates().forEach((state, clientId) => {
      const s = state as { user?: AwarenessUser; openFile?: string | null };
      if (s.user?.id) out.push({ clientId, user: s.user, openFile: s.openFile ?? null });
    });
    return out;
  }

  private emitPresence() {
    const p = this.presence();
    for (const fn of this.presenceListeners) fn(p);
  }

  setOpenFile(entityId: string | null) {
    this.project.setAwarenessField('openFile', entityId);
  }

  openDocument(entityId: string): CollabDocumentSession {
    return new CollabDocumentSession(this, entityId);
  }

  destroy() {
    this.project.destroy();
    this.socket.destroy();
    this.stateListeners.clear();
    this.eventListeners.clear();
    this.presenceListeners.clear();
  }
}

/** A document bound to the editor through Yjs (see DocumentSession). */
export class CollabDocumentSession implements DocumentSession {
  readonly collaborative = true;
  private readonly doc = new Y.Doc();
  private provider: HocuspocusProvider | null = null;
  private listeners = new Set<(s: SaveStatus, m?: string) => void>();
  private unsubscribeState: (() => void) | null = null;
  private status: SaveStatus = 'loading';

  constructor(
    private readonly connection: ProjectConnection,
    private readonly entityId: string,
  ) {}

  private emit(s: SaveStatus, m?: string) {
    this.status = s;
    for (const fn of this.listeners) fn(s, m);
  }

  onStatus(fn: (s: SaveStatus, m?: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private refresh() {
    const p = this.provider;
    if (!p) return;
    if (this.connection.connectionState !== 'connected') {
      this.emit(
        'offline',
        'Connection lost. Keep typing — your changes are kept and will sync when the connection returns.',
      );
    } else if (p.hasUnsyncedChanges) {
      this.emit('saving');
    } else {
      this.emit('saved');
    }
  }

  open(): Promise<{ text: string; extensions: Extension[] }> {
    this.emit('loading');
    return new Promise((resolve, reject) => {
      let settled = false;
      const provider = new HocuspocusProvider({
        websocketProvider: this.connection.socket,
        name: docChannel(this.entityId),
        document: this.doc,
        token: 'session',
        onSynced: ({ state }) => {
          if (!state) return;
          if (!settled) {
            settled = true;
            const ytext = this.doc.getText('content');
            const undoManager = new Y.UndoManager(ytext);
            resolve({
              text: ytext.toString(),
              extensions: [
                yCollab(ytext, provider.awareness, { undoManager }),
                Prec.high(keymap.of(yUndoManagerKeymap)),
              ],
            });
          }
          this.refresh();
        },
        onUnsyncedChanges: () => this.refresh(),
        onAuthenticationFailed: () => {
          if (!settled) {
            settled = true;
            reject(new Error('You do not have access to this file, or it was deleted.'));
          } else {
            this.emit('error', 'You no longer have access to this file.');
          }
        },
        onClose: () => this.refresh(),
      });
      provider.attach();
      provider.setAwarenessField('user', this.connection.me);
      this.provider = provider;
      this.unsubscribeState = this.connection.onState(() => this.refresh());
    });
  }

  /** Resolve once every local change has been acknowledged by the server. */
  async flush(): Promise<void> {
    const started = Date.now();
    while (this.provider?.hasUnsyncedChanges && Date.now() - started < 10_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  destroy(): void {
    this.unsubscribeState?.();
    this.provider?.destroy();
    this.doc.destroy();
    this.listeners.clear();
  }

  get currentStatus(): SaveStatus {
    return this.status;
  }
}
