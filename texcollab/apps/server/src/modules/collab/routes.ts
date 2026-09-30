import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';

const MAX_SOCKETS_PER_USER = 30;

/**
 * WebSocket endpoint for real-time collaboration (/collab).
 *
 * The upgrade request carries the session cookie; it is authenticated like
 * any API request (session + enabled user + no pending password change) and
 * the Origin must match PUBLIC_URL, which prevents cross-site WebSocket
 * hijacking. Per-document authorisation happens in the hub.
 */
export async function collabRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/collab', { websocket: true }, (socket, req) => {
    const user = req.user;
    if (req.headers.origin !== ctx.config.publicOrigin) {
      socket.close(4403, 'origin not allowed');
      return;
    }
    if (!user || !req.sessionId || user.must_change_password) {
      socket.close(4401, 'authentication required');
      return;
    }
    if (ctx.collab.socketCount(user.id) >= MAX_SOCKETS_PER_USER) {
      socket.close(4429, 'too many connections');
      return;
    }
    // Hocuspocus expects a Fetch API Request; the cookie is not forwarded to hooks.
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'cookie' || v === undefined) continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    const request = new Request(`${ctx.config.publicOrigin}${req.url}`, { headers });
    const connection = ctx.collab.hocuspocus.handleConnection(socket, request, {
      user: { id: user.id, displayName: user.display_name },
      sessionId: req.sessionId,
    });
    const unregister = ctx.collab.registerSocket(user.id, req.sessionId, socket);
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      connection.handleMessage(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    });
    socket.on('close', (code: number, reason: Buffer) => {
      unregister();
      connection.handleClose({ code, reason: reason.toString() });
    });
    socket.on('error', () => socket.terminate());
  });
}
