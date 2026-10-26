import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { hash } from './project.js';
import type { Application } from './application.js';
import { VmotionError } from '../core/model.js';
import type { InboxRequest, SamplingMode } from '../core/inbox-model.js';
import { withChangeOrigin } from './change-journal.js';
import { studioOnlyMethods } from './surfaces.js';

export interface McpSubscriptionHello {
  sessionId: string;
  client?: string;
  pid?: number;
  sampling?: SamplingMode;
}
export type McpServerEvent =
  | { event: 'inboxPush'; request: InboxRequest }
  | { event: 'inboxChanged'; requests: InboxRequest[] };
export function pipeName(root: string) {
  const normalized = path.resolve(root);
  const key = hash(process.platform === 'win32' ? normalized.toLowerCase() : normalized).slice(
    0,
    24,
  );
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\vmotion-${key}`
    : path.join(os.tmpdir(), `vmotion-${key}.sock`);
}
export function rpc(root: string, method: string, params: unknown = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName(root));
    let buffer = '';
    socket.setTimeout(30000, () => {
      socket.destroy();
      reject(new VmotionError('RPC_TIMEOUT', 'Project service did not respond'));
    });
    socket.on('connect', () => socket.write(JSON.stringify({ method, params }) + '\n'));
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 64 * 1024 * 1024) {
        socket.destroy();
        reject(new Error('RPC response too large'));
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, end));
        socket.end();
        if (message.error)
          reject(
            Object.assign(
              new VmotionError(message.error.code, message.error.message, message.error.details),
              message.error.example === undefined ? {} : { example: message.error.example },
            ),
          );
        else resolve(message.result);
      } catch (e) {
        socket.destroy();
        reject(e);
      }
    });
  });
}
export async function existingService(root: string) {
  try {
    try {
      await rpc(root, 'ping');
    } catch (e) {
      if (e instanceof VmotionError && e.code === 'METHOD_NOT_FOUND') await rpc(root, 'state');
      else throw e;
    }
    return true;
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code === 'ENOENT' ||
      (e as NodeJS.ErrnoException).code === 'ECONNREFUSED'
    )
      return false;
    throw e;
  }
}
export function subscribePipe(
  root: string,
  hello: McpSubscriptionHello,
  handlers: { onEvent: (event: McpServerEvent) => void; onClose?: () => void },
): Promise<{ origins: boolean; close: () => void }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName(root));
    socket.unref();
    let buffer = '',
      settled = false,
      closed = false;
    const finishClose = () => {
      if (closed) return;
      closed = true;
      if (settled) handlers.onClose?.();
    };
    socket.on('connect', () => {
      socket.setKeepAlive(true, 10_000);
      socket.write(JSON.stringify({ method: 'mcpSubscribe', params: hello }) + '\n');
    });
    socket.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
      finishClose();
    });
    socket.on('close', finishClose);
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 64 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!settled) {
          settled = true;
          if (msg.error) {
            const err = msg.error as { code?: string; message?: string; details?: unknown };
            socket.destroy();
            reject(new VmotionError(err.code ?? 'INTERNAL_ERROR', err.message ?? 'Subscribe failed', err.details));
            return;
          }
          const result = (msg.result ?? {}) as { origins?: boolean };
          resolve({
            origins: result.origins === true,
            close: () => {
              closed = true;
              socket.destroy();
            },
          });
          continue;
        }
        if (typeof msg.event === 'string') handlers.onEvent(msg as unknown as McpServerEvent);
      }
    });
  });
}

export async function servePipe(app: Application) {
  const subscribers = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 16 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        void (async () => {
          try {
            const { method, params } = JSON.parse(line);
            if (method === 'mcpSubscribe') {
              subscribers.add(socket);
              const detach = app.attachMcpSession(params, (event) => {
                if (!socket.destroyed) socket.write(JSON.stringify(event) + '\n');
              });
              const cleanup = () => {
                subscribers.delete(socket);
                detach();
              };
              socket.once('close', cleanup);
              socket.once('error', cleanup);
              socket.write(JSON.stringify({ result: { subscribed: true, origins: true } }) + '\n');
              return;
            }
            if (studioOnlyMethods.has(method))
              throw new VmotionError('SURFACE_METHOD', 'This control belongs to the Studio UI');
            // Pipe callers are local automation (CLI, MCP bridge). agentToolInvoke sets its
            // own MCP origin; everything else is attributed to the CLI.
            const result = await withChangeOrigin({ kind: 'cli', tool: String(method) }, () =>
              app.dispatch(method, params),
            );
            socket.write(JSON.stringify({ result }) + '\n');
          } catch (e) {
            socket.write(
              JSON.stringify({
                error: {
                  code: e instanceof VmotionError ? e.code : 'INTERNAL_ERROR',
                  message: (e as Error).message,
                  details: e instanceof VmotionError ? e.details : undefined,
                  // Argument errors carry a short valid call; keep it across the editor bridge.
                  example: (e as { example?: unknown }).example,
                },
              }) + '\n',
            );
          }
        })();
      }
    });
  });
  const baseClose = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    for (const s of subscribers) s.destroy();
    subscribers.clear();
    return baseClose(cb);
  }) as typeof server.close;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipeName(app.root), () => resolve());
  });
  return server;
}
