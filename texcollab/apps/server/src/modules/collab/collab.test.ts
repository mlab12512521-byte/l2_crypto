import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { type AwarenessUser, docChannel, type ProjectDetails, projectChannel } from '@texcollab/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import {
  addMember,
  type Client,
  createProject,
  createTestEnv,
  createUser,
  listen,
  login,
  PUBLIC_URL,
  request,
  STRONG_PASSWORD,
  type TestEnv,
  upload,
  waitFor,
} from '../../test/helpers.js';
import { applyTextDiff } from './hub.js';

let env: TestEnv;
let port: number;
let alice: Client;
let bob: Client;
let bobId: string;
let carol: Client;
let carolId: string;
let p: ProjectDetails;
const open: Array<{ destroy: () => void }> = [];

/** A browser-like WebSocket that sends the session cookie and a chosen Origin. */
function wsFor(cookie: string | null, origin = PUBLIC_URL) {
  return class extends WebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, { headers: { ...(cookie ? { cookie } : {}), origin } });
    }
  };
}

interface Peer {
  provider: HocuspocusProvider;
  socket: HocuspocusProviderWebsocket;
  doc: Y.Doc;
  text: Y.Text;
  authFailed: () => boolean;
  closeCodes: number[];
  stateless: string[];
}

function connect(client: Client | null, name: string, opts: { origin?: string; noRetry?: boolean } = {}): Peer {
  const doc = new Y.Doc();
  let failed = false;
  const closeCodes: number[] = [];
  const stateless: string[] = [];
  const socket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${port}/collab`,
    WebSocketPolyfill: wsFor(client?.cookie ?? null, opts.origin),
    minDelay: 50,
    maxDelay: 200,
    delay: 50,
    ...(opts.noRetry ? { maxAttempts: 1 } : {}),
    onClose: ({ event }) => {
      closeCodes.push(event.code);
    },
  });
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name,
    document: doc,
    token: 'session',
    onAuthenticationFailed: () => {
      failed = true;
    },
    onStateless: ({ payload }) => {
      stateless.push(payload);
    },
    // Per-document closes arrive as protocol messages, not socket closes.
    onClose: ({ event }) => {
      closeCodes.push(event.code);
    },
  });
  provider.attach();
  const peer = { provider, socket, doc, text: doc.getText('content'), authFailed: () => failed, closeCodes, stateless };
  open.push({
    destroy: () => {
      socket.disconnect();
      provider.destroy();
      socket.destroy();
    },
  });
  return peer;
}

const synced = (peer: Peer) => waitFor(() => peer.provider.isSynced, 5000, 'sync');

async function dbText(entityId: string) {
  const row = await env.ctx.db
    .selectFrom('doc_contents')
    .select('text')
    .where('entity_id', '=', entityId)
    .executeTakeFirst();
  return row?.text;
}

beforeAll(async () => {
  env = await createTestEnv();
  port = await listen(env);
  const a = await createUser(env.ctx);
  alice = await login(env.app, a.username, STRONG_PASSWORD);
  const b = await createUser(env.ctx);
  bobId = b.user.id;
  bob = await login(env.app, b.username, STRONG_PASSWORD);
  const c = await createUser(env.ctx);
  carolId = c.user.id;
  carol = await login(env.app, c.username, STRONG_PASSWORD);
  p = await createProject(env.app, alice, 'Collab');
  await addMember(env.ctx, p.id, bobId, 'editor');
});

afterEach(() => {
  while (open.length) open.pop()!.destroy();
});

afterAll(async () => {
  await env.close();
});

describe('connection security', () => {
  it('rejects connections without a session', async () => {
    const peer = connect(null, docChannel(p.mainFileId!), { noRetry: true });
    await waitFor(() => peer.closeCodes.includes(4401), 5000, 'close 4401');
    expect(peer.provider.isSynced).toBe(false);
  });

  it('rejects cross-site WebSocket hijacking (foreign Origin)', async () => {
    const peer = connect(alice, docChannel(p.mainFileId!), { origin: 'https://evil.example', noRetry: true });
    await waitFor(() => peer.closeCodes.includes(4403), 5000, 'close 4403');
  });

  it('refuses documents of projects the user is not a member of', async () => {
    const peer = connect(carol, docChannel(p.mainFileId!));
    await waitFor(() => peer.authFailed(), 5000, 'auth failure');
    const proj = connect(carol, projectChannel(p.id));
    await waitFor(() => proj.authFailed(), 5000, 'auth failure');
    expect(peer.text.toString()).toBe('');
  });

  it('refuses malformed and non-document channel names', async () => {
    for (const name of ['doc:../../etc', 'doc:not-a-uuid', 'something', `doc:${p.rootFolderId}`]) {
      const peer = connect(alice, name);
      await waitFor(() => peer.authFailed(), 5000, `auth failure for ${name}`);
    }
  });
});

describe('collaborative editing', () => {
  it('synchronises the stored text and converges under concurrent edits', async () => {
    const a = connect(alice, docChannel(p.mainFileId!));
    const b = connect(bob, docChannel(p.mainFileId!));
    await synced(a);
    await synced(b);
    expect(a.text.toString()).toContain('\\documentclass');
    expect(a.text.toString()).toBe(b.text.toString());

    // Interleaved edits at the same position from both users.
    for (let i = 0; i < 20; i++) {
      a.text.insert(0, `A${i};`);
      b.text.insert(0, `B${i};`);
    }
    b.text.insert(b.text.length, '\n% end by bob');
    await waitFor(
      () => a.text.toString() === b.text.toString() && a.text.toString().includes('end by bob'),
      5000,
      'convergence',
    );
    const final = a.text.toString();
    for (let i = 0; i < 20; i++) {
      expect(final).toContain(`A${i};`);
      expect(final).toContain(`B${i};`);
    }

    // Persisted (debounced) to the database mirror; compile/export read the live copy immediately.
    const snapshot = await env.ctx.files.readDoc(p.id, p.mainFileId!);
    expect(snapshot.text).toBe(final);
    await env.ctx.collab.flush();
    expect(await dbText(p.mainFileId!)).toBe(final);
    const changes = await env.ctx.db
      .selectFrom('project_changes')
      .select('user_id')
      .where('project_id', '=', p.id)
      .execute();
    expect(changes.map((c) => c.user_id)).toEqual(expect.arrayContaining([alice.me.user.id, bobId]));
  });

  it('merges edits made while disconnected after reconnection', async () => {
    const doc = (
      await request(env.app, alice, 'POST', `/api/projects/${p.id}/entities`, {
        payload: { parentId: p.rootFolderId, kind: 'doc', name: 'offline.tex', content: 'line1\nline2\n' },
      })
    ).json();
    const a = connect(alice, docChannel(doc.id));
    const b = connect(bob, docChannel(doc.id));
    await synced(a);
    await synced(b);

    // Alice loses her connection and keeps typing.
    a.socket.disconnect();
    await waitFor(() => a.socket.status === 'disconnected', 5000, 'disconnect');
    a.text.insert(0, 'alice-offline\n');
    b.text.insert(b.text.length, 'bob-online\n');
    await waitFor(() => false || true, 100);
    expect(a.text.toString()).not.toContain('bob-online');

    await a.socket.connect();
    await waitFor(
      () => a.text.toString() === b.text.toString() && b.text.toString().includes('alice-offline'),
      8000,
      'reconnect convergence',
    );
    expect(b.text.toString()).toBe('alice-offline\nline1\nline2\nbob-online\n');
  });

  it('keeps viewers read-only', async () => {
    await addMember(env.ctx, p.id, carolId, 'viewer');
    const doc = (
      await request(env.app, alice, 'POST', `/api/projects/${p.id}/entities`, {
        payload: { parentId: p.rootFolderId, kind: 'doc', name: 'readonly.tex', content: 'original' },
      })
    ).json();
    const viewer = connect(carol, docChannel(doc.id));
    const editor = connect(alice, docChannel(doc.id));
    await synced(viewer);
    await synced(editor);
    viewer.text.insert(0, 'HACKED ');
    editor.text.insert(editor.text.length, ' +edit');
    await waitFor(() => viewer.text.toString().includes('+edit'), 5000, 'viewer receives edits');
    await new Promise((r) => setTimeout(r, 300));
    expect(editor.text.toString()).toBe('original +edit');
    await env.ctx.collab.flush();
    expect(await dbText(doc.id)).toBe('original +edit');
    await env.ctx.db.deleteFrom('project_members').where('user_id', '=', carolId).execute();
  });
});

describe('presence and identity', () => {
  it('stamps the authenticated identity on awareness states (no impersonation)', async () => {
    const a = connect(alice, projectChannel(p.id));
    const b = connect(bob, projectChannel(p.id));
    await synced(a);
    await synced(b);
    // Bob pretends to be Alice.
    b.provider.setAwarenessField('user', { id: alice.me.user.id, name: alice.me.user.displayName, color: '#000' });
    b.provider.setAwarenessField('openFile', p.mainFileId);
    const bobState = await waitFor(
      () =>
        [...a.provider.awareness!.getStates().values()].find(
          (s) => (s as { openFile?: string }).openFile === p.mainFileId,
        ) as { user: AwarenessUser } | undefined,
      5000,
      'awareness',
    );
    expect(bobState!.user.id).toBe(bobId);
    expect(bobState!.user.name).toBe(bob.me.user.displayName);
    expect(bobState!.user).not.toHaveProperty('email');
  });
});

describe('server-side changes', () => {
  it('pushes uploads and REST writes into live documents', async () => {
    const doc = (
      await request(env.app, alice, 'POST', `/api/projects/${p.id}/entities`, {
        payload: { parentId: p.rootFolderId, kind: 'doc', name: 'server.tex', content: 'hello world' },
      })
    ).json();
    const a = connect(bob, docChannel(doc.id));
    await synced(a);
    const cur = await request(env.app, alice, 'GET', `/api/projects/${p.id}/entities/${doc.id}/text`);
    await request(env.app, alice, 'PUT', `/api/projects/${p.id}/entities/${doc.id}/text`, {
      payload: { text: 'hello brave world', baseHash: cur.json().contentHash },
    });
    await waitFor(() => a.text.toString() === 'hello brave world', 5000, 'REST write');
    await upload(env.app, alice, `/api/projects/${p.id}/upload`, 'replaced by upload', {
      parentId: p.rootFolderId,
      path: 'server.tex',
    });
    await waitFor(() => a.text.toString() === 'replaced by upload', 5000, 'upload');
  });

  it('notifies project members of tree changes and closes deleted documents', async () => {
    const doc = (
      await request(env.app, alice, 'POST', `/api/projects/${p.id}/entities`, {
        payload: { parentId: p.rootFolderId, kind: 'doc', name: 'doomed.tex', content: 'x' },
      })
    ).json();
    const proj = connect(bob, projectChannel(p.id));
    const d = connect(bob, docChannel(doc.id));
    await synced(proj);
    await synced(d);
    await request(env.app, alice, 'DELETE', `/api/projects/${p.id}/entities/${doc.id}`);
    await waitFor(() => proj.stateless.some((s) => JSON.parse(s).type === 'tree'), 5000, 'tree event');
    await waitFor(() => d.authFailed() || d.closeCodes.length > 0, 5000, 'doc closed');
  });

  it('disconnects users who are disabled or log out', async () => {
    const u = await createUser(env.ctx);
    const c = await login(env.app, u.username, STRONG_PASSWORD);
    await addMember(env.ctx, p.id, u.user.id, 'editor');
    const peer = connect(c, projectChannel(p.id));
    await synced(peer);
    await request(env.app, c, 'POST', '/api/auth/logout');
    await waitFor(() => peer.closeCodes.length > 0, 5000, 'logout disconnect');
    // Reconnection attempts are refused once the session is gone.
    await waitFor(() => peer.closeCodes.includes(4401), 5000, 'refused after logout');
  });
});

describe('applyTextDiff', () => {
  it('produces minimal edits', () => {
    const doc = new Y.Doc();
    const t = doc.getText('content');
    t.insert(0, 'The quick brown fox');
    const ops: unknown[][] = [];
    t.observe((e) => ops.push(e.delta));
    applyTextDiff(t, 'The quick red fox');
    expect(t.toString()).toBe('The quick red fox');
    // One atomic change: only "brown" is replaced by "red".
    expect(ops[0]).toEqual([{ retain: 10 }, { delete: 5 }, { insert: 'red' }]);
    expect(ops).toHaveLength(1);
    applyTextDiff(t, '');
    expect(t.toString()).toBe('');
    applyTextDiff(t, 'new');
    expect(t.toString()).toBe('new');
  });
});
