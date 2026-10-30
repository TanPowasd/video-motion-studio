import { createHash, randomUUID } from 'node:crypto';
import { coerceRemoteUrlInput } from './net-address.js';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { z } from 'zod';
import type { FileEdit } from '../core/file-edits.js';
import { VmotionError, type Conflict, type Snapshot } from '../core/model.js';
import {
  applyFilePatch,
  diffFilePatch,
  fileHashesOf,
  hashContent,
  remoteBindingSchema,
  remotePeerIdSchema,
  remoteScopeSchema,
  threeWayMergeFiles,
  type RemoteAssetEntry,
  type RemoteBinding,
} from '../core/remote-model.js';
import { builtinCandidate } from '../plugins/candidate.js';
import type { Application } from './application.js';
import { withChangeOrigin } from './change-journal.js';
import { atomicWrite, hash, parseFiles, safePath, saveFiles } from './project.js';
import {
  DEFAULT_LOCK_LEASE_MS,
  MAX_LOCK_LEASE_MS,
  MIN_LOCK_LEASE_MS,
} from '../core/remote-model.js';
import { videoCodecs } from '../core/video-export-schema.js';
import { withRemotePeer } from './remote-coordinator.js';

const compress = promisify(gzip);
const decompress = promisify(gunzip);

const BINDING_FILE = '.vmotion/remote/binding.json';
const AUTH_FILE = '.vmotion/remote/auth.json';
const BASE_SNAPSHOT_FILE = '.vmotion/remote/base.json.gz';
const MAX_BASE_BYTES = 64 * 1024 * 1024;

export interface RemoteRequestAuth {
  url: string;
  token?: string;
  peerId?: string;
  name?: string;
  timeoutMs?: number;
}

/** Accepts full URLs plus `host:port`, `[v6]:port` and bare IPv6 literals. */
const remoteUrlInputSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() ? normalizeRemoteUrl(value) : value),
  z.string().url().max(512),
);

export function normalizeRemoteUrl(url: string): string {
  const raw = coerceRemoteUrlInput(url);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new VmotionError(
      'REMOTE_URL',
      /\[[^\]]*%/.test(raw)
        ? 'IPv6 link-local addresses with a zone id (fe80::…%eth0) are not supported in URLs; use a global or ULA IPv6 address, or an IPv4 address'
        : `Invalid remote URL: ${url}`,
      { url },
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new VmotionError('REMOTE_URL', 'Remote URL must use http:// or https://');
  }
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/+$/, '');
}

function buildHeaders(auth: RemoteRequestAuth, extra: Record<string, string> = {}) {
  const token = auth.token?.trim() || process.env.VMOTION_REMOTE_TOKEN?.trim();
  const headers: Record<string, string> = { ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (auth.peerId) headers['X-Vmotion-Peer'] = auth.peerId;
  if (auth.name) headers['X-Vmotion-Peer-Name'] = encodeURIComponent(auth.name);
  return headers;
}

async function parseErrorResponse(res: Response): Promise<never> {
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    payload = undefined;
  }
  const errObj =
    payload &&
    typeof payload === 'object' &&
    'error' in payload &&
    typeof (payload as { error?: unknown }).error === 'object' &&
    (payload as { error: Record<string, unknown> }).error
      ? (payload as { error: Record<string, unknown> }).error
      : undefined;
  const code =
    typeof errObj?.code === 'string'
      ? errObj.code
      : res.status === 401
        ? 'REMOTE_UNAUTHORIZED'
        : res.status === 403
          ? 'REMOTE_FORBIDDEN'
          : `REMOTE_HTTP_${res.status}`;
  const message =
    typeof errObj?.message === 'string'
      ? errObj.message
      : `Remote coordinator HTTP ${res.status} ${res.statusText}`;
  throw new VmotionError(code, message, errObj?.details);
}

export async function remoteRequestJson<T = any>(
  auth: RemoteRequestAuth,
  route: string,
  options: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown } = {},
): Promise<T> {
  const baseUrl = normalizeRemoteUrl(auth.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), auth.timeoutMs ?? 30_000);
  timer.unref();
  try {
    const method = options.method ?? (options.body !== undefined ? 'POST' : 'GET');
    const res = await fetch(`${baseUrl}${route}`, {
      method,
      headers: buildHeaders(
        auth,
        options.body !== undefined ? { 'Content-Type': 'application/json' } : {},
      ),
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) return await parseErrorResponse(res);
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof VmotionError) throw e;
    throw new VmotionError(
      'REMOTE_UNREACHABLE',
      `Failed to reach remote coordinator at ${baseUrl}: ${(e as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function remoteRequestBuffer(
  auth: RemoteRequestAuth,
  route: string,
  options: { method?: 'GET' | 'PUT'; body?: Buffer; contentType?: string } = {},
): Promise<{ buffer: Buffer; headers: Headers }> {
  const baseUrl = normalizeRemoteUrl(auth.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), auth.timeoutMs ?? 120_000);
  timer.unref();
  try {
    const res = await fetch(`${baseUrl}${route}`, {
      method: options.method ?? (options.body ? 'PUT' : 'GET'),
      headers: buildHeaders(
        auth,
        options.body
          ? { 'Content-Type': options.contentType ?? 'application/octet-stream' }
          : {},
      ),
      body: options.body ? new Uint8Array(options.body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) return await parseErrorResponse(res);
    const ab = await res.arrayBuffer();
    return { buffer: Buffer.from(ab), headers: res.headers };
  } catch (e) {
    if (e instanceof VmotionError) throw e;
    throw new VmotionError(
      'REMOTE_UNREACHABLE',
      `Failed to transfer binary asset with ${baseUrl}: ${(e as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function remoteRpc<T = any>(
  auth: RemoteRequestAuth,
  method: string,
  params: unknown = {},
): Promise<T> {
  const response = await remoteRequestJson<{ result: T }>(
    { ...auth, timeoutMs: auth.timeoutMs ?? 60_000 },
    '/api/remote/rpc',
    {
      method: 'POST',
      body: { method, params },
    },
  );
  return response.result;
}

export async function subscribeRemoteEvents(
  auth: RemoteRequestAuth,
  handlers: {
    onEvent: (event: Record<string, unknown>) => void;
    onClose?: () => void;
  },
): Promise<{ close: () => void }> {
  const baseUrl = normalizeRemoteUrl(auth.url);
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/remote/events`, {
    method: 'GET',
    headers: buildHeaders(auth, { Accept: 'text/event-stream' }),
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    await parseErrorResponse(res);
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const rawBlock = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of rawBlock.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                handlers.onEvent(JSON.parse(line.slice(6)) as Record<string, unknown>);
              } catch {
                /* ignore malformed SSE payload */
              }
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch {
      /* stream closed */
    } finally {
      handlers.onClose?.();
    }
  })();
  return {
    close: () => {
      controller.abort();
      void reader.cancel().catch(() => {});
    },
  };
}

export async function readRemoteBinding(root: string): Promise<RemoteBinding | undefined> {
  try {
    const raw = await readFile(safePath(root, BINDING_FILE), 'utf8');
    return remoteBindingSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export async function writeRemoteBinding(root: string, binding: RemoteBinding): Promise<void> {
  const validated = remoteBindingSchema.parse(binding);
  const target = safePath(root, BINDING_FILE);
  await mkdir(path.dirname(target), { recursive: true });
  await atomicWrite(target, JSON.stringify(validated, null, 2) + '\n');
}

export async function readSavedToken(root: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(safePath(root, AUTH_FILE), 'utf8')) as {
      token?: unknown;
    };
    return typeof raw.token === 'string' && raw.token.trim() ? raw.token.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function writeSavedToken(root: string, token: string): Promise<void> {
  const target = safePath(root, AUTH_FILE);
  await mkdir(path.dirname(target), { recursive: true });
  await atomicWrite(target, JSON.stringify({ token }, null, 2) + '\n');
  await chmod(target, 0o600).catch(() => {});
}

async function readBaseSnapshotFiles(
  root: string,
  expectedRevision?: string,
): Promise<Record<string, string> | undefined> {
  try {
    const compressed = await readFile(safePath(root, BASE_SNAPSHOT_FILE));
    const bytes = await decompress(compressed, { maxOutputLength: MAX_BASE_BYTES });
    const files = z.record(z.string()).parse(JSON.parse(bytes.toString('utf8')));
    if (expectedRevision) {
      const parsed = parseFiles(files);
      if (parsed.revision !== expectedRevision) return undefined;
    }
    return files;
  } catch {
    return undefined;
  }
}

async function writeBaseSnapshotFiles(root: string, files: Record<string, string>): Promise<void> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) {
    if (!k.startsWith('.vmotion/')) clean[k] = v;
  }
  const target = safePath(root, BASE_SNAPSHOT_FILE);
  await mkdir(path.dirname(target), { recursive: true });
  const compressed = await compress(Buffer.from(JSON.stringify(clean)));
  await atomicWrite(target, compressed);
}

function defaultPeerIdentity() {
  const host = os.hostname().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 32) || 'peer';
  return {
    peerId: `${host}-${randomUUID().slice(0, 8)}`,
    name: host,
  };
}

async function resolveClientAuth(
  root: string,
  input: {
    url?: string;
    token?: string;
    peerId?: string;
    name?: string;
    saveToken?: boolean;
  },
): Promise<{ auth: RemoteRequestAuth; binding?: RemoteBinding }> {
  const existing = await readRemoteBinding(root);
  const url = input.url ? normalizeRemoteUrl(input.url) : existing?.url;
  if (!url) {
    throw new VmotionError(
      'REMOTE_NOT_CONFIGURED',
      'No remote coordinator URL configured; pass url or run remote_sync once with url',
    );
  }
  const fallback = defaultPeerIdentity();
  const peerId = input.peerId ?? existing?.peerId ?? fallback.peerId;
  const name = input.name ?? existing?.name ?? fallback.name;
  const token =
    input.token?.trim() ||
    process.env.VMOTION_REMOTE_TOKEN?.trim() ||
    (await readSavedToken(root));
  if (input.saveToken && token) {
    await writeSavedToken(root, token);
  }
  const nextBinding: RemoteBinding = {
    version: 1,
    url,
    peerId,
    name,
    ...(existing?.baseRevision ? { baseRevision: existing.baseRevision } : {}),
    ...(existing?.lastSyncAt ? { lastSyncAt: existing.lastSyncAt } : {}),
  };
  if (input.url || !existing || existing.peerId !== peerId || existing.name !== name) {
    await writeRemoteBinding(root, nextBinding);
  }
  return {
    auth: { url, token, peerId, name },
    binding: nextBinding,
  };
}

async function downloadMissingAssets(
  root: string,
  auth: RemoteRequestAuth,
  remoteAssets: RemoteAssetEntry[],
): Promise<string[]> {
  const downloaded: string[] = [];
  for (const entry of remoteAssets) {
    let target: string;
    try {
      target = safePath(root, entry.path);
    } catch {
      continue;
    }
    let upToDate = false;
    try {
      const info = await stat(target);
      if (info.isFile() && info.size === entry.size) {
        const localSha = await hashFile(target);
        if (localSha === entry.sha256) upToDate = true;
      }
    } catch {
      upToDate = false;
    }
    if (upToDate) continue;
    const { buffer } = await remoteRequestBuffer(
      auth,
      `/api/remote/asset?id=${encodeURIComponent(entry.id)}`,
    );
    const actualSha = hashContent(buffer);
    if (actualSha !== entry.sha256) {
      throw new VmotionError('REMOTE_ASSET_HASH', `Downloaded asset hash mismatch for ${entry.path}`, {
        assetId: entry.id,
        expected: entry.sha256,
        actual: actualSha,
      });
    }
    await mkdir(path.dirname(target), { recursive: true });
    await atomicWrite(target, buffer);
    downloaded.push(entry.path);
  }
  return downloaded;
}

async function uploadMissingAssets(
  root: string,
  auth: RemoteRequestAuth,
  snapshot: Snapshot,
  remoteAssets: RemoteAssetEntry[],
): Promise<string[]> {
  const remoteByPath = new Map(remoteAssets.map((a) => [a.path, a.sha256]));
  const uploaded: string[] = [];
  for (const asset of snapshot.project.assets) {
    const normalized = asset.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized.startsWith('assets/')) continue;
    let fullPath: string;
    try {
      fullPath = safePath(root, normalized);
    } catch {
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(fullPath);
    } catch {
      continue;
    }
    const sha256 = hashContent(bytes);
    if (remoteByPath.get(normalized) === sha256) continue;
    await remoteRequestBuffer(
      auth,
      `/api/remote/asset?path=${encodeURIComponent(normalized)}&sha256=${sha256}`,
      {
        method: 'PUT',
        body: bytes,
      },
    );
    uploaded.push(normalized);
  }
  return uploaded;
}

export const remoteStatusToolSchema = {
  url: remoteUrlInputSchema.optional(),
  token: z.string().min(1).max(512).optional(),
  peerId: remotePeerIdSchema.optional(),
  name: z.string().min(1).max(80).optional(),
  localOnly: z.boolean().optional(),
};

export async function remoteWorkspaceStatus(
  app: Application,
  raw: z.infer<z.ZodObject<typeof remoteStatusToolSchema>>,
) {
  const existing = await readRemoteBinding(app.root);
  const targetUrl = raw.url ?? existing?.url;
  if (raw.localOnly || !targetUrl) {
    const coordinatorStatus = await app.remote.status('editor', {
      peerId: raw.peerId,
      name: raw.name,
    });
    return {
      mode: 'coordinator' as const,
      server: app.remote.serverConfig
        ? {
            enabled: true,
            host: app.remote.serverConfig.host,
            port: app.remote.serverConfig.port,
          }
        : { enabled: false },
      ...(existing ? { binding: existing } : {}),
      ...coordinatorStatus,
    };
  }

  const { auth, binding } = await resolveClientAuth(app.root, raw);
  const remote = await remoteRequestJson<Awaited<ReturnType<Application['remote']['status']>>>(
    auth,
    '/api/remote/status',
  );
  const localSnapshot = app.service.snapshot;
  const localHashes = fileHashesOf(localSnapshot.files);
  const baseRevision = binding?.baseRevision;

  let relationship: 'in-sync' | 'ahead' | 'behind' | 'diverged' | 'uninitialized';
  if (localSnapshot.revision === remote.revision) {
    relationship = 'in-sync';
  } else if (!baseRevision) {
    const remoteInLocalHistory = Boolean(await app.service.snapshotFilesAt(remote.revision));
    relationship = remoteInLocalHistory ? 'ahead' : 'uninitialized';
  } else if (baseRevision === remote.revision) {
    relationship = 'ahead';
  } else if (baseRevision === localSnapshot.revision) {
    relationship = 'behind';
  } else {
    relationship = 'diverged';
  }

  const changedVsRemote = [
    ...new Set([...Object.keys(localHashes), ...Object.keys(remote.fileHashes)]),
  ]
    .filter((f) => localHashes[f] !== remote.fileHashes[f])
    .sort();

  return {
    mode: 'client' as const,
    binding,
    relationship,
    local: {
      revision: localSnapshot.revision,
      pendingFiles: !!app.service.pendingFiles,
      conflicts: app.service.conflicts.length,
    },
    changedFilesVsRemote: changedVsRemote,
    remote,
  };
}

export const remoteLockToolSchema = {
  action: z.enum(['list', 'acquire', 'renew', 'release']).default('list'),
  scopes: z.array(remoteScopeSchema).min(1).max(32).optional(),
  leaseMs: z
    .number()
    .int()
    .min(MIN_LOCK_LEASE_MS)
    .max(MAX_LOCK_LEASE_MS)
    .optional(),
  reason: z.string().max(240).optional(),
  force: z.boolean().optional(),
  peerId: remotePeerIdSchema.optional(),
  name: z.string().min(1).max(80).optional(),
  presence: z
    .object({
      sceneId: z.string().max(120).optional(),
      sequenceId: z.string().max(120).optional(),
      frame: z.number().int().nonnegative().optional(),
      selection: z.array(z.string().max(120)).max(64).optional(),
    })
    .strict()
    .optional(),
  url: remoteUrlInputSchema.optional(),
  token: z.string().min(1).max(512).optional(),
  localOnly: z.boolean().optional(),
};

export async function remoteWorkspaceLock(
  app: Application,
  raw: z.infer<z.ZodObject<typeof remoteLockToolSchema>>,
) {
  const existing = await readRemoteBinding(app.root);
  const targetUrl = raw.url ?? existing?.url;

  if (raw.localOnly || !targetUrl) {
    const fallback = defaultPeerIdentity();
    const peerId = raw.peerId ?? existing?.peerId ?? fallback.peerId;
    const name = raw.name ?? existing?.name ?? fallback.name;
    if (raw.presence) {
      app.remote.notePeer({
        peerId,
        name,
        ...raw.presence,
      });
    }
    return {
      mode: 'coordinator' as const,
      ...app.remote.manageLocks({
        action: raw.action,
        scopes: raw.scopes,
        ...(raw.leaseMs !== undefined ? { leaseMs: raw.leaseMs } : {}),
        reason: raw.reason,
        force: raw.force,
        peerId,
        name,
      }),
      peers: app.remote.listPeers(),
    };
  }

  const { auth } = await resolveClientAuth(app.root, raw);
  if (raw.presence) {
    await remoteRequestJson(auth, '/api/remote/presence', {
      method: 'POST',
      body: {
        peerId: auth.peerId,
        name: auth.name,
        ...raw.presence,
      },
    });
  }
  const result = await remoteRequestJson<Record<string, unknown>>(auth, '/api/remote/locks', {
    method: 'POST',
    body: {
      action: raw.action,
      scopes: raw.scopes,
      leaseMs: raw.leaseMs ?? DEFAULT_LOCK_LEASE_MS,
      ...(raw.reason ? { reason: raw.reason } : {}),
      ...(raw.force !== undefined ? { force: raw.force } : {}),
      peerId: auth.peerId,
      name: auth.name,
    },
  });
  return {
    mode: 'client' as const,
    url: auth.url,
    peerId: auth.peerId,
    ...result,
  };
}

export const remoteSyncToolSchema = {
  direction: z.enum(['sync', 'pull', 'push']).default('sync'),
  mode: z.enum(['apply', 'plan']).default('apply'),
  strategy: z.enum(['merge', 'theirs', 'ours']).default('merge'),
  onConflict: z.enum(['stage', 'abort']).optional(),
  url: remoteUrlInputSchema.optional(),
  token: z.string().min(1).max(512).optional(),
  saveToken: z.boolean().optional(),
  peerId: remotePeerIdSchema.optional(),
  name: z.string().min(1).max(80).optional(),
  message: z.string().max(240).optional(),
};

function buildFileEditsFromSnapshots(
  currentFiles: Record<string, string>,
  nextFiles: Record<string, string>,
): FileEdit[] {
  const edits: FileEdit[] = [];
  const all = new Set([...Object.keys(currentFiles), ...Object.keys(nextFiles)]);
  for (const file of [...all].sort()) {
    if (file.startsWith('.vmotion/')) continue;
    const prev = currentFiles[file];
    const next = nextFiles[file];
    if (prev === next) continue;
    if (next === undefined) {
      edits.push({ path: file, expectedHash: hash(prev!), type: 'delete' });
    } else {
      const expectedHash = prev === undefined ? null : hash(prev);
      edits.push({ path: file, expectedHash, type: 'replace', content: next });
    }
  }
  return edits;
}

export async function remoteWorkspaceSync(
  app: Application,
  raw: z.infer<z.ZodObject<typeof remoteSyncToolSchema>>,
) {
  const { auth, binding } = await resolveClientAuth(app.root, raw);
  await app.service.exclusive(() => app.service.reload());
  const local = app.service.snapshot;
  const conflictPolicy =
    raw.onConflict ?? (raw.mode === 'plan' || raw.direction === 'push' ? 'abort' : 'stage');

  // 1. Pull incremental state from coordinator
  const pulled = await remoteRequestJson<{
    coordinatorId: string;
    revision: string;
    fileList: string[];
    fileHashes: Record<string, string>;
    files: Record<string, string>;
    assets: RemoteAssetEntry[];
  }>(auth, '/api/remote/pull', {
    method: 'POST',
    body: {
      peerId: auth.peerId,
      name: auth.name,
      knownFileHashes: fileHashesOf(local.files),
      includeFiles: true,
    },
  });

  const remoteFileSet = new Set(pulled.fileList);
  const remoteFiles: Record<string, string> = {};
  for (const name of pulled.fileList) {
    if (Object.hasOwn(pulled.files, name)) {
      remoteFiles[name] = pulled.files[name];
    } else if (Object.hasOwn(local.files, name)) {
      remoteFiles[name] = local.files[name];
    }
  }
  void remoteFileSet;

  // Resolve 3-way merge base
  let baseRevision = binding?.baseRevision;
  let baseFiles = baseRevision ? await readBaseSnapshotFiles(app.root, baseRevision) : undefined;
  if (!baseFiles && baseRevision) {
    baseFiles = await app.service.snapshotFilesAt(baseRevision);
  }
  if (!baseFiles) {
    if (local.revision === pulled.revision) {
      baseRevision = local.revision;
      baseFiles = { ...local.files };
    } else {
      const remoteInLocal = await app.service.snapshotFilesAt(pulled.revision);
      if (remoteInLocal) {
        baseRevision = pulled.revision;
        baseFiles = remoteInLocal;
      }
    }
  }

  // Handle pure push first
  if (raw.direction === 'push') {
    const pushBaseRev =
      raw.strategy === 'ours'
        ? pulled.revision
        : (baseRevision ?? local.revision);
    const pushBaseFiles =
      raw.strategy === 'ours'
        ? remoteFiles
        : (baseFiles ?? { ...local.files });
    const patch = diffFilePatch(pushBaseFiles, local.files);

    if (raw.mode === 'plan') {
      const dry = await remoteRequestJson<Record<string, unknown>>(auth, '/api/remote/push', {
        method: 'POST',
        body: {
          peerId: auth.peerId,
          name: auth.name,
          baseRevision: pushBaseRev,
          files: patch,
          baseFiles: pushBaseFiles,
          mode: 'dryRun',
          message: raw.message,
        },
      });
      return {
        unchanged: true,
        direction: 'push' as const,
        dryRun: dry,
        next: 'Call remote_sync with direction="push" and mode="apply" to push changes to the coordinator.',
      };
    }

    const uploadedAssets = await uploadMissingAssets(app.root, auth, local, pulled.assets);
    const pushed = await remoteRequestJson<{
      committed: boolean;
      fastForward: boolean;
      merged: boolean;
      revision: string;
      changedFiles: string[];
      deltaForClient: Record<string, string | null>;
      assets: RemoteAssetEntry[];
    }>(auth, '/api/remote/push', {
      method: 'POST',
      body: {
        peerId: auth.peerId,
        name: auth.name,
        baseRevision: pushBaseRev,
        files: patch,
        baseFiles: pushBaseFiles,
        mode: 'apply',
        message: raw.message,
      },
    });

    const downloadedAssets = await downloadMissingAssets(app.root, auth, pushed.assets);
    let finalSnapshot = local;
    if (Object.keys(pushed.deltaForClient).length > 0) {
      const convergedFiles = applyFilePatch(local.files, pushed.deltaForClient);
      const convergedCandidate = parseFiles(convergedFiles);
      const state = await withRemotePeer({ peerId: auth.peerId!, name: auth.name }, () =>
        withChangeOrigin(
          { kind: 'mcp', client: 'remote-sync', tool: 'remote_sync', intent: raw.message },
          () => app.service.commitSnapshot(convergedCandidate, { skipLockGuard: true }),
        ),
      );
      finalSnapshot = state.snapshot;
    }

    await writeBaseSnapshotFiles(app.root, finalSnapshot.files);
    await writeRemoteBinding(app.root, {
      version: 1,
      url: auth.url,
      peerId: auth.peerId!,
      name: auth.name!,
      baseRevision: finalSnapshot.revision,
      lastSyncAt: new Date().toISOString(),
    });

    return {
      snapshot: finalSnapshot,
      direction: 'push' as const,
      fastForward: pushed.fastForward,
      merged: pushed.merged,
      revision: finalSnapshot.revision,
      remoteRevision: pushed.revision,
      changedFiles: pushed.changedFiles,
      uploadedAssets,
      downloadedAssets,
    };
  }

  // Pull or bidirectional Sync: download remote assets first so validation sees them
  const downloadedAssets = await downloadMissingAssets(app.root, auth, pulled.assets);

  let targetFiles: Record<string, string>;
  let conflicts: Conflict[] = [];
  let merged = false;

  if (raw.strategy === 'theirs' || (!baseFiles && raw.direction === 'pull')) {
    targetFiles = remoteFiles;
  } else if (raw.strategy === 'ours') {
    targetFiles = { ...local.files };
  } else if (local.revision === pulled.revision) {
    targetFiles = { ...local.files };
  } else if (baseRevision === local.revision) {
    // Local untouched since last sync -> fast-forward to remote!
    targetFiles = remoteFiles;
  } else if (baseRevision === pulled.revision) {
    // Remote untouched since last sync -> keep local (and push if direction === 'sync')!
    targetFiles = { ...local.files };
  } else {
    if (!baseFiles) {
      throw new VmotionError(
        'REMOTE_BASE_MISSING',
        'Local and remote projects have diverged with no recorded common base; pass strategy="theirs" or strategy="ours" once to establish a shared baseline',
        { localRevision: local.revision, remoteRevision: pulled.revision },
      );
    }
    const mergeResult = threeWayMergeFiles(baseFiles, local.files, remoteFiles);
    targetFiles = mergeResult.files;
    conflicts = mergeResult.conflicts;
    merged = true;
  }

  if (conflicts.length > 0 && conflictPolicy === 'abort') {
    throw new VmotionError(
      'REMOTE_CONFLICT',
      'Remote sync detected conflicting concurrent edits',
      {
        localRevision: local.revision,
        remoteRevision: pulled.revision,
        baseRevision,
        conflicts,
      },
    );
  }

  const candidateSnapshot = parseFiles(targetFiles);
  const fileEdits = buildFileEditsFromSnapshots(local.files, candidateSnapshot.files);

  if (raw.mode === 'plan') {
    if (!fileEdits.length) {
      return {
        unchanged: true,
        direction: raw.direction,
        revision: local.revision,
        remoteRevision: pulled.revision,
        downloadedAssets,
      };
    }
    const firstScene = candidateSnapshot.scenes[0]?.id;
    return builtinCandidate(
      app.root,
      {
        revision: local.revision,
        files: fileEdits,
        samples: firstScene ? [{ sceneId: firstScene, frame: 0 }] : [],
        width: 320,
      },
      candidateSnapshot.revision,
      'stored',
      {
        direction: raw.direction,
        remoteRevision: pulled.revision,
        merged,
        downloadedAssets,
        summary: {
          direction: raw.direction,
          changedFiles: fileEdits.map((e) => e.path),
          downloadedAssets: downloadedAssets.length,
        },
      },
    );
  }

  // Apply locally (commits cleanly or stages conflicts if conflicts.length > 0)
  const localState = await withRemotePeer({ peerId: auth.peerId!, name: auth.name }, () =>
    withChangeOrigin(
      { kind: 'mcp', client: 'remote-sync', tool: 'remote_sync', intent: raw.message },
      () =>
        app.service.commitSnapshot(candidateSnapshot, {
          conflicts,
          action: conflicts.length ? 'external' : 'edit',
          skipLockGuard: true,
        }),
    ),
  );

  if (conflicts.length > 0) {
    // Staged in ProjectService.conflicts for project_resolve_conflict! Do not push conflicted state.
    return {
      snapshot: localState.snapshot,
      committed: false,
      stagedConflicts: conflicts.length,
      conflicts,
      direction: raw.direction,
      revision: localState.snapshot.revision,
      remoteRevision: pulled.revision,
      downloadedAssets,
      next: 'Inspect conflicts via project_diagnostics({section:"conflicts",detail:true}) and resolve with project_resolve_conflict, then run remote_sync again.',
    };
  }

  let remoteRevision = pulled.revision;
  let uploadedAssets: string[] = [];
  if (raw.direction === 'sync' && localState.snapshot.revision !== pulled.revision) {
    uploadedAssets = await uploadMissingAssets(app.root, auth, localState.snapshot, pulled.assets);
    const pushPatch = diffFilePatch(remoteFiles, localState.snapshot.files);
    const pushed = await remoteRequestJson<{
      revision: string;
      deltaForClient: Record<string, string | null>;
    }>(auth, '/api/remote/push', {
      method: 'POST',
      body: {
        peerId: auth.peerId,
        name: auth.name,
        baseRevision: pulled.revision,
        files: pushPatch,
        baseFiles: remoteFiles,
        mode: 'apply',
        message: raw.message,
      },
    });
    remoteRevision = pushed.revision;
    if (Object.keys(pushed.deltaForClient).length > 0) {
      const converged = parseFiles(applyFilePatch(localState.snapshot.files, pushed.deltaForClient));
      await withRemotePeer({ peerId: auth.peerId!, name: auth.name }, () =>
        app.service.commitSnapshot(converged, { skipLockGuard: true }),
      );
    }
  }

  const finalSnapshot = app.service.snapshot;
  await writeBaseSnapshotFiles(app.root, finalSnapshot.files);
  await writeRemoteBinding(app.root, {
    version: 1,
    url: auth.url,
    peerId: auth.peerId!,
    name: auth.name!,
    baseRevision:
      raw.direction === 'pull' ? pulled.revision : remoteRevision,
    lastSyncAt: new Date().toISOString(),
  });

  return {
    snapshot: finalSnapshot,
    direction: raw.direction,
    merged,
    revision: finalSnapshot.revision,
    remoteRevision,
    changedFiles: fileEdits.map((e) => e.path),
    downloadedAssets,
    uploadedAssets,
  };
}

export const remoteRenderToolSchema = {
  action: z.enum(['start', 'status', 'cancel', 'list', 'download']).default('list'),
  id: z.string().max(120).optional(),
  wait: z.boolean().default(true),
  waitMs: z.number().int().min(100).max(120_000).default(60_000),
  downloadTo: z.string().max(260).optional(),
  options: z
    .object({
      filename: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[A-Za-z0-9._-]+$/)
        .optional(),
      format: z.enum(['mp4', 'png', 'wav']).default('mp4'),
      sequenceId: z.string().max(120).optional(),
      start: z.number().int().nonnegative().optional(),
      end: z.number().int().positive().optional(),
      width: z.number().int().min(16).max(8192).optional(),
      height: z.number().int().min(16).max(8192).optional(),
      encoder: z.string().max(64).optional(),
      codec: z.enum(videoCodecs).optional(),
      gpu: z.enum(['cpu', 'auto', 'gpu']).optional(),
      schedule: z.enum(['serial', 'auto', 'split-tracks', 'split-scenes']).optional(),
      revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    })
    .strict()
    .optional(),
  url: remoteUrlInputSchema.optional(),
  token: z.string().min(1).max(512).optional(),
  peerId: remotePeerIdSchema.optional(),
  name: z.string().min(1).max(80).optional(),
};

export async function remoteWorkspaceRender(
  app: Application,
  raw: z.infer<z.ZodObject<typeof remoteRenderToolSchema>>,
) {
  const { auth } = await resolveClientAuth(app.root, raw);

  const downloadArtifact = async (jobId: string, destinationRel?: string) => {
    const { buffer, headers } = await remoteRequestBuffer(
      auth,
      `/api/remote/render/download?id=${encodeURIComponent(jobId)}`,
    );
    const expectedSha = headers.get('x-vmotion-sha256');
    const actualSha = hashContent(buffer);
    if (expectedSha && expectedSha !== actualSha) {
      throw new VmotionError('REMOTE_ASSET_HASH', 'Downloaded render output SHA-256 mismatch', {
        expected: expectedSha,
        actual: actualSha,
      });
    }
    const remoteFilename = headers.get('x-vmotion-filename') || `remote-${jobId}.mp4`;
    const relOut = destinationRel
      ? destinationRel.replace(/\\/g, '/').replace(/^\/+/, '')
      : `exports/${remoteFilename}`;
    if (!relOut.startsWith('exports/') || relOut.includes('..')) {
      throw new VmotionError(
        'REMOTE_PATH',
        'Downloaded remote render output must be written under exports/',
        { downloadTo: destinationRel },
      );
    }
    const target = safePath(app.root, relOut);
    await mkdir(path.dirname(target), { recursive: true });
    await atomicWrite(target, buffer);
    return {
      localOutput: relOut,
      bytes: buffer.byteLength,
      sha256: actualSha,
    };
  };

  if (raw.action === 'download') {
    if (!raw.id) throw new VmotionError('TOOL_ARGUMENTS', 'id is required for action="download"');
    const downloaded = await downloadArtifact(raw.id, raw.downloadTo);
    return {
      action: 'download' as const,
      id: raw.id,
      ...downloaded,
      next: `Rendered artifact saved to ${downloaded.localOutput}.`,
    };
  }

  interface RemoteRenderJobSummary {
    id: string;
    status: string;
    format: string;
    output: string;
    revision: string;
    progress: number;
    frame?: number;
    totalFrames?: number;
    stage?: string;
    startedAt?: string;
    finishedAt?: string;
    gpu?: unknown;
    heterogeneous?: unknown;
    encoder?: unknown;
    error?: string;
  }

  const res = await remoteRequestJson<{
    job?: RemoteRenderJobSummary;
    jobs?: RemoteRenderJobSummary[];
  }>(
    { ...auth, timeoutMs: Math.max(30_000, (raw.waitMs ?? 60_000) + 10_000) },
    '/api/remote/render',
    {
      method: 'POST',
      body: {
        action: raw.action,
        ...(raw.id ? { id: raw.id } : {}),
        peerId: auth.peerId,
        name: auth.name,
        wait: raw.wait,
        waitMs: raw.waitMs,
        ...(raw.options ? { options: raw.options } : {}),
      },
    },
  );

  // Poll if wait === true and server chunked wait returned still running within waitMs budget
  let job: RemoteRenderJobSummary | undefined = res.job;
  if (raw.action === 'start' && raw.wait && job) {
    const deadline = Date.now() + (raw.waitMs ?? 60_000);
    while (job && (job.status === 'queued' || job.status === 'running') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      const jobId = job.id;
      const polled: { job: RemoteRenderJobSummary } = await remoteRequestJson<{
        job: RemoteRenderJobSummary;
      }>(auth, '/api/remote/render', {
        method: 'POST',
        body: { action: 'status', id: jobId, peerId: auth.peerId, name: auth.name },
      });
      job = polled.job;
    }
  }

  let downloaded: Awaited<ReturnType<typeof downloadArtifact>> | undefined;
  if (raw.downloadTo && job?.status === 'completed') {
    downloaded = await downloadArtifact(job.id, raw.downloadTo);
  }

  return {
    action: raw.action,
    url: auth.url,
    ...(job ? { job } : {}),
    ...(res.jobs ? { jobs: res.jobs } : {}),
    ...(downloaded ? { downloaded } : {}),
    next:
      job?.status === 'completed'
        ? downloaded
          ? `Remote render completed and saved to ${downloaded.localOutput}.`
          : `Call remote_render({action:"download",id:"${job.id}"}) to pull the rendered file into exports/.`
        : 'Poll remote_render({action:"status",id}) for completion.',
  };
}

/** Standalone CLI helper: clone a remote coordinator's project into a local directory. */
export async function remoteCloneProject(input: {
  root: string;
  url: string;
  token?: string;
  saveToken?: boolean;
  peerId?: string;
  name?: string;
}) {
  const root = path.resolve(input.root);
  await mkdir(root, { recursive: true });
  const fallback = defaultPeerIdentity();
  const peerId = input.peerId ?? fallback.peerId;
  const name = input.name ?? fallback.name;
  const url = normalizeRemoteUrl(input.url);
  const auth: RemoteRequestAuth = {
    url,
    token: input.token?.trim() || process.env.VMOTION_REMOTE_TOKEN?.trim(),
    peerId,
    name,
  };
  const pulled = await remoteRequestJson<{
    coordinatorId: string;
    revision: string;
    files: Record<string, string>;
    assets: RemoteAssetEntry[];
  }>(auth, '/api/remote/pull', {
    method: 'POST',
    body: { peerId, name, includeFiles: true },
  });
  const downloadedAssets = await downloadMissingAssets(root, auth, pulled.assets);
  const snapshot = parseFiles(pulled.files);
  await saveFiles(root, snapshot.files, {});
  await writeBaseSnapshotFiles(root, snapshot.files);
  await writeRemoteBinding(root, {
    version: 1,
    url,
    peerId,
    name,
    baseRevision: snapshot.revision,
    lastSyncAt: new Date().toISOString(),
  });
  if (input.saveToken && auth.token) {
    await writeSavedToken(root, auth.token);
  }
  return {
    path: root,
    url,
    peerId,
    project: snapshot.project.name,
    revision: snapshot.revision,
    files: Object.keys(snapshot.files).length,
    downloadedAssets: downloadedAssets.length,
  };
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(digest.digest('hex')));
  });
}
