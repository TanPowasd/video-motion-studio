import http from 'node:http';
import {
  httpUrl,
  isLocalEditorOrigin,
  isLoopbackAddress,
  localConnectHost,
  normalizeBindHost,
} from './net-address.js';
import { readFile, stat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Application } from './application.js';
import { VmotionError } from '../core/model.js';
import { safePath } from './project.js';
import { runtimeFile } from '../core/bundled-runtime.js';
import { assertSurfaceMethod, surfaceManifest } from './surfaces.js';
import { withChangeOrigin } from './change-journal.js';
import { remotePresenceInputSchema, withRemotePeer } from './remote-coordinator.js';

export interface ServeHttpOptions {
  host?: string;
  /** Only with an IPv6 bind host such as `::`: refuse IPv4 clients. */
  ipv6Only?: boolean;
  remote?: {
    editorToken?: string;
    viewerToken?: string;
  };
}


function extractBearerToken(req: http.IncomingMessage, url: URL): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+\S+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  const headerToken = req.headers['x-vmotion-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) return headerToken.trim();
  if (req.method === 'GET' && (url.pathname === '/api/remote/events' || url.pathname === '/api/remote/frame')) {
    const q = url.searchParams.get('token');
    if (q?.trim()) return q.trim();
  }
  return undefined;
}

async function readJsonBody(req: http.IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) throw new VmotionError('BODY_LIMIT', `Request exceeds ${maxBytes} bytes`);
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

async function readRawBody(req: http.IncomingMessage, maxBytes = 512 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) throw new VmotionError('BODY_LIMIT', `Upload exceeds ${maxBytes} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function errorStatusForCode(code: string | undefined, isRemoteRoute: boolean): number {
  if (!isRemoteRoute) return 400;
  switch (code) {
    case 'REMOTE_UNAUTHORIZED':
      return 401;
    case 'REMOTE_FORBIDDEN':
    case 'REMOTE_DISABLED':
    case 'SURFACE_METHOD':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'REMOTE_CONFLICT':
    case 'REVISION_CONFLICT':
    case 'UNRESOLVED_CONFLICTS':
      return 409;
    case 'REMOTE_LOCKED':
      return 423;
    default:
      return 400;
  }
}

async function serveClient(url: URL, res: http.ServerResponse, clientDirectory: string) {
  let file = path.resolve(clientDirectory, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(path.resolve(clientDirectory) + path.sep))
    file = path.join(clientDirectory, 'index.html');
  try {
    if (!(await stat(file)).isFile()) file = path.join(clientDirectory, 'index.html');
  } catch {
    file = path.join(clientDirectory, 'index.html');
  }
  const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  };
  res.writeHead(200, {
    'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(await readFile(file));
}
async function handleRemoteRoute(
  app: Application,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  send: (value: unknown, status?: number) => void,
) {
  const token = extractBearerToken(req, url);
  const role = app.remote.authenticate(token);
  const peerIdHeader =
    typeof req.headers['x-vmotion-peer'] === 'string' && req.headers['x-vmotion-peer'].trim()
      ? req.headers['x-vmotion-peer'].trim()
      : undefined;
  const peerNameHeader =
    typeof req.headers['x-vmotion-peer-name'] === 'string' && req.headers['x-vmotion-peer-name'].trim()
      ? decodeURIComponent(req.headers['x-vmotion-peer-name'].trim())
      : undefined;

  const withHeaderPeer = (body: unknown) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
    const obj = body as Record<string, unknown>;
    return {
      ...(peerIdHeader && obj.peerId === undefined ? { peerId: peerIdHeader } : {}),
      ...(peerNameHeader && obj.name === undefined ? { name: peerNameHeader } : {}),
      ...obj,
    };
  };

  if (req.method === 'GET' && url.pathname === '/api/remote/status') {
    send(await app.remote.status(role, { peerId: peerIdHeader, name: peerNameHeader }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/remote/presence') {
    const body = remotePresenceInputSchema.parse(withHeaderPeer(await readJsonBody(req, 64 * 1024)));
    send({ peer: app.remote.notePeer(body, role), peers: app.remote.listPeers() });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/remote/locks') {
    const body = withHeaderPeer(await readJsonBody(req, 128 * 1024));
    send(app.remote.manageLocks(body, role));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/remote/pull') {
    const body = withHeaderPeer(await readJsonBody(req, 8 * 1024 * 1024));
    send(await app.remote.pull(body, role));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/remote/push') {
    const body = withHeaderPeer(await readJsonBody(req, 64 * 1024 * 1024));
    send(await app.remote.push(body, role));
    return;
  }
  if (url.pathname === '/api/remote/asset') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const id = url.searchParams.get('id') ?? '';
      const { file, entry } = await app.remote.resolveAssetFile(id);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': entry.size,
        'Cache-Control': 'no-store',
        'X-Vmotion-Asset-Sha256': entry.sha256,
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = createReadStream(file);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }
    if (req.method === 'PUT') {
      app.remote.requireEditor(role, 'asset.upload');
      const relPath = url.searchParams.get('path') ?? '';
      const sha256 = url.searchParams.get('sha256') ?? '';
      const content = await readRawBody(req);
      send(await app.remote.storeUploadedAsset(relPath, sha256, content));
      return;
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/remote/frame') {
    if (peerIdHeader) {
      app.remote.notePeer(
        {
          peerId: peerIdHeader,
          name: peerNameHeader,
          sceneId: url.searchParams.get('scene') ?? undefined,
          frame: Number(url.searchParams.get('frame') ?? 0),
        },
        role,
      );
    }
    const rendered = await app.frame({
      frame: Number(url.searchParams.get('frame') ?? 0),
      width: Number(url.searchParams.get('width') ?? 960),
      height: Number(url.searchParams.get('height') ?? 540),
      sceneId: url.searchParams.get('scene') ?? undefined,
      path: url.searchParams.get('path') ? JSON.parse(url.searchParams.get('path')!) : undefined,
      fallback: true,
      format: url.searchParams.get('format') === 'rgba' ? 'rgba' : 'png',
      mediaQuality: url.searchParams.get('media') === 'auto' ? 'auto' : 'original',
    });
    res.writeHead(200, {
      'Content-Type': rendered.format === 'rgba' ? 'application/x-vmotion-rgba' : 'image/png',
      'Cache-Control': 'no-store',
      'X-Vmotion-Revision': rendered.revision,
      'X-Vmotion-Frame': String(rendered.frame),
      'X-Vmotion-Format': rendered.format,
      ...(rendered.width
        ? {
            'X-Vmotion-Width': String(rendered.width),
            'X-Vmotion-Height': String(rendered.height),
          }
        : {}),
      ...(rendered.renderMs !== undefined
        ? {
            'X-Vmotion-Render-Ms': String(rendered.renderMs),
            'X-Vmotion-Encode-Ms': String(rendered.encodeMs),
          }
        : {}),
    });
    res.end(rendered.buffer);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/remote/render') {
    const body = await readJsonBody(req, 512 * 1024);
    send(await app.remote.renderAction(body, role));
    return;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/remote/render/download') {
    const id = url.searchParams.get('id') ?? '';
    const artifact = await app.remote.resolveRenderArtifact(id);
    res.writeHead(200, {
      'Content-Type': artifact.mimeType,
      'Content-Length': artifact.size,
      'Cache-Control': 'no-store',
      'X-Vmotion-Sha256': artifact.sha256,
      'X-Vmotion-Filename': artifact.filename,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    if (artifact.kind === 'buffer') {
      res.end(artifact.buffer);
      return;
    }
    const stream = createReadStream(artifact.file);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/remote/rpc') {
    const body = (await readJsonBody(req, 16 * 1024 * 1024)) as {
      method?: unknown;
      params?: unknown;
    };
    if (typeof body.method !== 'string' || !body.method) {
      throw new VmotionError('METHOD_NOT_FOUND', 'RPC method must be a non-empty string');
    }
    app.remote.assertRemoteRpcAllowed(role, body.method, body.params, app.allToolDefinitions());
    if (peerIdHeader) {
      app.remote.notePeer({ peerId: peerIdHeader, name: peerNameHeader }, role);
    }
    const runDispatch = () =>
      withChangeOrigin(
        {
          kind: 'mcp',
          client: peerNameHeader ? `remote:${peerNameHeader}` : peerIdHeader ? `remote:${peerIdHeader}` : 'remote-rpc',
          tool: body.method as string,
        },
        () => app.dispatch(body.method as string, body.params),
      );
    const result = peerIdHeader
      ? await withRemotePeer({ peerId: peerIdHeader, name: peerNameHeader, role }, runDispatch)
      : await runDispatch();
    send({ result });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/remote/events') {
    if (peerIdHeader) {
      app.remote.notePeer({ peerId: peerIdHeader, name: peerNameHeader }, role);
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(
      `data: ${JSON.stringify({
        kind: 'ready',
        coordinatorId: app.remote.coordinatorId,
        revision: app.service.snapshot.revision,
        locks: app.remote.listLocks(),
        peers: app.remote.listPeers(),
      })}\n\n`,
    );
    const onChange = (state: { snapshot?: { revision?: string }; inbox?: unknown }) =>
      res.write(
        `data: ${JSON.stringify({
          kind: 'change',
          revision: state?.snapshot?.revision ?? app.service.snapshot.revision,
          ...(state?.inbox ? { inbox: state.inbox } : {}),
        })}\n\n`,
      );
    const onLocks = (locks: unknown) =>
      res.write(`data: ${JSON.stringify({ kind: 'locks', locks })}\n\n`);
    const onPeers = (peers: unknown) =>
      res.write(`data: ${JSON.stringify({ kind: 'peers', peers })}\n\n`);
    const onRender = (jobs: unknown) =>
      res.write(`data: ${JSON.stringify({ kind: 'render', jobs })}\n\n`);
    app.on('change', onChange);
    app.remote.on('locks', onLocks);
    app.remote.on('peers', onPeers);
    app.on('render', onRender);
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
    heartbeat.unref();
    req.on('close', () => {
      clearInterval(heartbeat);
      app.off('change', onChange);
      app.remote.off('locks', onLocks);
      app.remote.off('peers', onPeers);
      app.off('render', onRender);
    });
    return;
  }
  send({ error: { code: 'NOT_FOUND', message: 'Remote route not found' } }, 404);
}

export async function serveHttp(
  app: Application | undefined,
  port = 4318,
  clientDirectory = path.resolve('dist/client'),
  options: ServeHttpOptions = {},
) {
  const bindHost = normalizeBindHost(options.host);
  if (app && options.remote) {
    app.remote.configureServer({
      host: bindHost,
      port,
      editorToken: options.remote.editorToken,
      viewerToken: options.remote.viewerToken,
    });
  }
  const server = http.createServer(async (req, res) => {
    let isRemoteRoute = false;
    try {
      const url = new URL(req.url ?? '/', httpUrl(localConnectHost(bindHost), port));
      isRemoteRoute = url.pathname === '/api/remote' || url.pathname.startsWith('/api/remote/');
      const send = (value: unknown, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(value));
      };
      if (isRemoteRoute) {
        if (!app) {
          send({ error: { code: 'NO_PROJECT', message: '请先新建或打开项目' } }, 409);
          return;
        }
        await handleRemoteRoute(app, req, res, url, send);
        return;
      }
      // Non-loopback clients may only use /api/health or authenticated /api/remote/* endpoints.
      if (!isLoopbackAddress(req.socket.remoteAddress) && url.pathname !== '/api/health') {
        isRemoteRoute = true;
        throw new VmotionError(
          'REMOTE_UNAUTHORIZED',
          'Non-local connections must use authenticated /api/remote/* endpoints',
        );
      }
      if (url.pathname === '/api/surfaces') {
        send(surfaceManifest);
        return;
      }
      if (url.pathname === '/agent' || url.pathname.startsWith('/agent/')) {
        const agentUrl = new URL(url);
        agentUrl.pathname = url.pathname.slice('/agent'.length) || '/';
        await serveClient(agentUrl, res, path.resolve(clientDirectory, '../agent'));
        return;
      }
      if (url.pathname === '/runtime/font.otf' || url.pathname === '/runtime/font-bold.otf') {
        const file = runtimeFile(
          url.pathname.includes('bold')
            ? 'fonts/NotoSansSC-Bold.otf'
            : 'fonts/NotoSansSC-Regular.otf',
        );
        if (!file) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'font/otf',
          'Cache-Control': 'public, max-age=86400',
        });
        createReadStream(file)
          .on('error', () => res.destroy())
          .pipe(res);
        return;
      }
      if (!app) {
        if (url.pathname.startsWith('/api/'))
          send({ error: { code: 'NO_PROJECT', message: '请先新建或打开项目' } }, 409);
        else await serveClient(url, res, clientDirectory);
        return;
      }
      if (url.pathname === '/watch') {
        const files = await readdir(path.join(app.root, 'exports')),
          name = url.searchParams.get('file') ?? files.find((f) => f.endsWith('.mp4'));
        if (!name) throw new VmotionError('NO_VIDEO', 'This project has no exported video');
        const esc = (s: string) =>
          s.replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
          );
        const title = esc(app.service.snapshot.project.name),
          duration =
            (app.service.snapshot.sequences.find(
              (s) => s.id === app.service.snapshot.project.activeSequence,
            )!.duration *
              app.service.snapshot.project.fps.den) /
            app.service.snapshot.project.fps.num;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title} · Vmotion</title><style>*{box-sizing:border-box}body{margin:0;background:#12151c;color:#e5e7ef;font-family:"Segoe UI","Microsoft YaHei",sans-serif}main{max-width:1200px;margin:36px auto;padding:0 30px}.brand{color:#b9affb;font-size:13px;letter-spacing:3px}h1{font-size:28px;font-weight:500;margin:18px 0 10px}p{color:#8592a9;font-size:13px}video{width:100%;margin-top:24px;border-radius:8px;box-shadow:0 10px 60px #0007;background:#faf8f3}.links{display:flex;gap:22px;margin-top:22px;font-size:13px}a{color:#b9affb;text-decoration:none}.meta{color:#77849b}</style></head><body><main><div class="brand">VMOTION / 本地播放</div><h1>${title}</h1><p>本地成片 · ${Math.floor(duration / 60)} 分 ${Math.round(duration % 60)} 秒 · ${app.service.snapshot.project.width} × ${app.service.snapshot.project.height} / ${(app.service.snapshot.project.fps.num / app.service.snapshot.project.fps.den).toFixed(2)} fps</p><video controls preload="metadata" poster="/api/frame?frame=90&width=1280&height=720" src="/api/export?file=${encodeURIComponent(name)}"></video><div class="links"><a href="/">打开可编辑工程 →</a><a href="/api/export?file=${encodeURIComponent(name)}" download>下载 MP4</a><span class="meta">本片通过 Vmotion 原生渲染核心制作</span></div></main></body></html>`,
        );
        return;
      }
      if (url.pathname === '/api/export') {
        const name = url.searchParams.get('file') ?? '';
        if (path.basename(name) !== name || !name.endsWith('.mp4'))
          throw new VmotionError('EXPORT_FILE', 'Expected an exported MP4 filename');
        const file = safePath(app.root, `exports/${name}`),
          info = await stat(file);
        const headers = {
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
        };
        const range = req.headers.range;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match) {
            res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
            res.end();
            return;
          }
          let begin = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2])),
            end = match[1] ? (match[2] ? Number(match[2]) : info.size - 1) : info.size - 1;
          end = Math.min(end, info.size - 1);
          if (
            !Number.isSafeInteger(begin) ||
            !Number.isSafeInteger(end) ||
            begin < 0 ||
            begin > end ||
            begin >= info.size
          ) {
            res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
            res.end();
            return;
          }
          res.writeHead(206, {
            ...headers,
            'Content-Length': end - begin + 1,
            'Content-Range': `bytes ${begin}-${end}/${info.size}`,
          });
          if (req.method === 'HEAD') {
            res.end();
            return;
          }
          const stream = createReadStream(file, { start: begin, end });
          stream.on('error', () => res.destroy());
          res.on('close', () => stream.destroy());
          stream.pipe(res);
          return;
        }
        res.writeHead(200, { ...headers, 'Content-Length': info.size });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        const stream = createReadStream(file);
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
        return;
      }
      if (url.pathname === '/api/sound-audio') {
        const key = url.searchParams.get('key') ?? '';
        if (!/^[a-f0-9]{64}$/.test(key))
          throw new VmotionError('SOUND_AUDIO', 'Expected a rendered sound cache key');
        const file = safePath(app.root, `.vmotion/sound-cache/${key}.wav`),
          info = await stat(file);
        let start = 0,
          end = info.size - 1;
        const range = req.headers.range;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (match && (match[1] || match[2])) {
            start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
            end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
          } else start = -1;
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            start > end ||
            start >= info.size
          ) {
            res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
            res.end();
            return;
          }
        }
        res.writeHead(range ? 206 : 200, {
          'Content-Type': 'audio/wav',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=86400',
          'Content-Length': end - start + 1,
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        const stream = createReadStream(file, { start, end });
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
        return;
      }
      if (
        req.method === 'POST' &&
        ['/api/rpc', '/api/studio/rpc', '/api/agent/rpc', '/api/agent/discovery'].includes(
          url.pathname,
        )
      ) {
        const origin = req.headers.origin;
        if (!isLocalEditorOrigin(origin))
          throw new VmotionError('ORIGIN', 'Only the local editor may call the HTTP API');
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 16 * 1024 * 1024)
            throw new VmotionError('BODY_LIMIT', 'Request exceeds 16MB');
        }
        if (url.pathname === '/api/agent/discovery') {
          send({ result: app.agentDiscovery(JSON.parse(body)) });
          return;
        }
        const { method, params } = JSON.parse(body);
        assertSurfaceMethod(
          url.pathname === '/api/studio/rpc'
            ? 'studio'
            : url.pathname === '/api/agent/rpc'
              ? 'agent'
              : 'legacy',
          method,
        );
        // The agent surface is automation, not the person in the Studio: attribute its direct
        // (non-tool) writes to an agent so the change feed shows AI, and AI hold applies.
        // agentToolInvoke sets its own, more specific MCP origin inside this one.
        const agentClient = req.headers['x-vmotion-agent'];
        send({
          result:
            url.pathname === '/api/agent/rpc'
              ? await withChangeOrigin(
                  {
                    kind: 'mcp',
                    client: typeof agentClient === 'string' && agentClient ? agentClient : 'agent-web',
                    tool: String(method),
                  },
                  () => app.dispatch(method, params),
                )
              : await app.dispatch(method, params),
        });
        return;
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/music-live/')) {
        const origin = req.headers.origin;
        if (!isLocalEditorOrigin(origin))
          throw new VmotionError('ORIGIN', 'Only the local music editor may stream audio');
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 128 * 1024)
            throw new VmotionError('BODY_LIMIT', 'Live audio request exceeds 128 KiB');
        }
        const pcm = await app.audioLive.block(
          url.pathname.slice('/api/music-live/'.length),
          JSON.parse(body),
        );
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store',
          'X-Vmotion-Audio-Format': 'f32le-stereo',
        });
        res.end(pcm);
        return;
      }
      if (url.pathname === '/api/drawing-frame') {
        let params: any = {
          id: url.searchParams.get('id'),
          width: Number(url.searchParams.get('width') ?? 960),
          height: url.searchParams.has('height')
            ? Number(url.searchParams.get('height'))
            : undefined,
        };
        if (req.method === 'POST') {
          const origin = req.headers.origin;
          if (!isLocalEditorOrigin(origin))
            throw new VmotionError('ORIGIN', 'Only the local editor may call the HTTP API');
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 16 * 1024 * 1024)
              throw new VmotionError('BODY_LIMIT', 'Request exceeds 16MB');
          }
          params = JSON.parse(body);
        }
        const { buffer, revision } = await app.drawingFrame(params);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
          'X-Vmotion-Revision': revision,
        });
        res.end(buffer);
        return;
      }
      if (url.pathname === '/api/asset-thumbnail') {
        const buffer = await app.assetThumbnail(
          url.searchParams.get('id') ?? '',
          Number(url.searchParams.get('width') ?? 160),
          Number(url.searchParams.get('height') ?? 100),
        );
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(buffer);
        return;
      }
      if (url.pathname === '/api/frame') {
        const frame = Number(url.searchParams.get('frame') ?? 0),
          width = Number(url.searchParams.get('width') ?? 960),
          height = Number(url.searchParams.get('height') ?? 540),
          sceneId = url.searchParams.get('scene') ?? undefined;
        const focusPath = url.searchParams.get('path')
          ? JSON.parse(url.searchParams.get('path')!)
          : undefined;
        const {
          buffer,
          stale,
          error,
          revision,
          frame: renderedFrame,
          format,
          width: renderedWidth,
          height: renderedHeight,
          renderMs,
          encodeMs,
          media,
        } = await app.frame({
          frame,
          width,
          height,
          sceneId,
          path: focusPath,
          contextFrames: url.searchParams.get('context')
            ? JSON.parse(url.searchParams.get('context')!)
            : undefined,
          draft: url.searchParams.get('draft')
            ? JSON.parse(url.searchParams.get('draft')!)
            : undefined,
          fallback: true,
          format: url.searchParams.get('format') === 'rgba' ? 'rgba' : 'png',
          mediaQuality: url.searchParams.get('media') === 'auto' ? 'auto' : 'original',
        });
        res.writeHead(200, {
          'Content-Type': format === 'rgba' ? 'application/x-vmotion-rgba' : 'image/png',
          'Cache-Control': 'no-store',
          'X-Vmotion-Stale': String(stale),
          'X-Vmotion-Revision': revision,
          'X-Vmotion-Frame': String(renderedFrame),
          'X-Vmotion-Format': format,
          'X-Vmotion-Media-Quality': media?.quality ?? 'original',
          'X-Vmotion-Proxy-Count': String(media?.proxyCount ?? 0),
          'X-Vmotion-Decode-Pixels': String(media?.decodePixels ?? 0),
          ...(renderedWidth
            ? {
                'X-Vmotion-Width': String(renderedWidth),
                'X-Vmotion-Height': String(renderedHeight),
              }
            : {}),
          ...(renderMs !== undefined
            ? { 'X-Vmotion-Render-Ms': String(renderMs), 'X-Vmotion-Encode-Ms': String(encodeMs) }
            : {}),
          ...(error ? { 'X-Vmotion-Error': encodeURIComponent(error) } : {}),
        });
        res.end(buffer);
        return;
      }
      if (url.pathname === '/api/audio-chunk') {
        const controller = new AbortController(),
          disconnect = () => {
            if (!res.writableEnded) controller.abort();
          };
        res.on('close', disconnect);
        try {
          const result = await app.audioRange(
            app.service.snapshot,
            {
              sequenceId: url.searchParams.get('sequence') ?? undefined,
              revision: url.searchParams.get('revision') ?? undefined,
              startSample: Number(url.searchParams.get('start') ?? 0),
              sampleCount: Number(url.searchParams.get('samples') ?? 192000),
            },
            controller.signal,
          );
          if (controller.signal.aborted) return;
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'no-store',
            'X-Vmotion-Revision': result.revision,
            'X-Vmotion-Start-Sample': String(result.startSample),
            'X-Vmotion-Sample-Count': String(result.sampleCount),
            'X-Vmotion-Sample-Rate': String(result.sampleRate),
            'X-Vmotion-Audio-Clips': String(result.clipCount),
          });
          res.end(result.buffer);
        } finally {
          res.off('close', disconnect);
        }
        return;
      }
      if (url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(
          `data: ${JSON.stringify({ kind: 'change', state: { ...app.service.state(), changeLog: app.changeLog(), agents: app.agentState(), inbox: app.inboxState() } })}\n\n`,
        );
        const change = (state: unknown) =>
            res.write(`data: ${JSON.stringify({ kind: 'change', state })}\n\n`),
          render = (jobs: unknown) =>
            res.write(`data: ${JSON.stringify({ kind: 'render', jobs })}\n\n`),
          agents = (state: unknown) =>
            res.write(`data: ${JSON.stringify({ kind: 'agents', agents: state })}\n\n`);
        app.on('change', change);
        app.on('render', render);
        app.on('agents', agents);
        const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
        req.on('close', () => {
          clearInterval(heartbeat);
          app.off('change', change);
          app.off('render', render);
          app.off('agents', agents);
        });
        return;
      }
      if (url.pathname === '/api/health') {
        send({ ok: true, project: app.service.snapshot.project.name });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404);
        return;
      }
      await serveClient(url, res, clientDirectory);
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const code = e instanceof VmotionError ? e.code : 'INTERNAL_ERROR';
      res.writeHead(errorStatusForCode(code, isRemoteRoute), {
        'Content-Type': 'application/json',
      });
      res.end(
        JSON.stringify({
          error: {
            code,
            message: (e as Error).message,
            details: e instanceof VmotionError ? e.details : undefined,
          },
        }),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: bindHost, ipv6Only: options.ipv6Only === true }, resolve);
  });
  return server;
}
