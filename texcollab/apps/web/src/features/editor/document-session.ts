import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ApiError } from '../../api/client';
import { projectsApi } from '../../api/projects';

export type SaveStatus = 'loading' | 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'offline';

/**
 * Connects one editor to the server copy of one document. Implementations:
 *  - RestDocumentSession: debounced autosave with optimistic concurrency;
 *  - the collaborative (Yjs) session added in phase 5.
 */
export interface DocumentSession {
  /** True when the document is bound through a CRDT (undo history is then per-user and managed by the binding). */
  readonly collaborative: boolean;
  /** Resolve with the initial text and the extensions that bind the editor to the document. */
  open(): Promise<{ text: string; extensions: Extension[] }>;
  /** Push pending local edits to the server now. */
  flush(): Promise<void>;
  onStatus(fn: (s: SaveStatus, message?: string) => void): () => void;
  destroy(): void;
}

const SAVE_DELAY_MS = 800;

/**
 * Single-user fallback: REST autosave with optimistic concurrency. Used when
 * real-time collaboration is not available.
 */
export class RestDocumentSession implements DocumentSession {
  readonly collaborative = false;
  private baseHash: string | null = null;
  private pendingText: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | null = null;
  private listeners = new Set<(s: SaveStatus, m?: string) => void>();
  private destroyed = false;

  constructor(
    private readonly projectId: string,
    private readonly entityId: string,
  ) {}

  private emit(s: SaveStatus, m?: string) {
    for (const fn of this.listeners) fn(s, m);
  }

  onStatus(fn: (s: SaveStatus, m?: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async open() {
    this.emit('loading');
    const doc = await projectsApi.readText(this.projectId, this.entityId);
    this.baseHash = doc.contentHash;
    this.emit('saved');
    const listener = EditorView.updateListener.of((u) => {
      if (!u.docChanged || this.destroyed) return;
      this.pendingText = u.state.doc.toString();
      this.emit('dirty');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
    });
    return { text: doc.text, extensions: [listener] };
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.saving) await this.saving;
    if (this.pendingText === null) return;
    const text = this.pendingText;
    this.pendingText = null;
    this.emit('saving');
    this.saving = (async () => {
      try {
        const res = await projectsApi.writeText(this.projectId, this.entityId, text, this.baseHash);
        this.baseHash = res.contentHash;
        this.emit(this.pendingText === null ? 'saved' : 'dirty');
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          this.emit('conflict', 'This file was changed elsewhere. Reload it to continue editing.');
        } else if (err instanceof ApiError && err.status === 0) {
          this.pendingText ??= text;
          this.emit('offline', 'Connection lost; changes will be saved when it returns.');
          this.timer = setTimeout(() => void this.flush(), 5000);
        } else {
          this.pendingText ??= text;
          this.emit('error', err instanceof Error ? err.message : 'Save failed');
        }
      } finally {
        this.saving = null;
      }
    })();
    await this.saving;
  }

  destroy(): void {
    // Best effort: save anything outstanding before the editor goes away.
    if (this.pendingText !== null) void this.flush();
    this.destroyed = true;
    clearTimeout(this.timer);
    this.listeners.clear();
  }
}
