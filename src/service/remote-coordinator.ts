import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeBindHost } from './net-address.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';
import { z } from 'zod';
import { VmotionError, type Snapshot } from '../core/model.js';
import {
  applyFilePatch,
  DEFAULT_LOCK_LEASE_MS,
  diffFilePatch,
  fileHashesOf,
  findConflictingLock,
  hashContent,
  MAX_LOCK_LEASE_MS,
  MIN_LOCK_LEASE_MS,
  REMOTE_PEER_TTL_MS,
  remotePeerIdSchema,
  remoteScopeSchema,
  scopesForChangedFiles,
  threeWayMergeFiles,
  verifySecretToken,
  type RemoteAssetEntry,
  type RemoteLock,
  type RemotePeer,
  type RemoteRole,
} from '../core/remote-model.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import { deriveToolEffect } from '../mcp/tool-definition.js';
import type { RenderJob, RenderOptions } from '../media/export.js';
import { videoCodecs } from '../core/video-export-schema.js';
import type { Application } from './application.js';
import { withChangeOrigin } from './change-journal.js';
import { atomicWrite, parseFiles, safePath } from './project.js';
import { studioOnlyMethods } from './surfaces.js';

export interface RemotePeerContext {
  peerId: string;
  name?: string;
  role?: RemoteRole;
}

const remotePeerStorage = new AsyncLocalStorage<RemotePeerContext>();

export function withRemotePeer<T>(peer: RemotePeerContext, fn: () => T): T {
  return remotePeerStorage.run(peer, fn);
}

export function currentRemotePeer(): RemotePeerContext | undefined {
  return remotePeerStorage.getStore();
}

export interface RemoteServerConfig {
  enabled: boolean;
  host: string;
  port: number;
  editorToken: string;
  viewerToken?: string;
  coordinatorId?: string;
}

export const remotePresenceInputSchema = z
  .object({
    peerId: remotePeerIdSchema,
    name: z.string().min(1).max(80).optional(),
    sceneId: z.string().max(120).optional(),
    sequenceId: z.string().max(120).optional(),
    frame: z.number().int().nonnegative().optional(),
    selection: z.array(z.string().max(120)).max(64).optional(),
    client: z.string().max(80).optional(),
  })
  .strict();

export const remoteLockActionSchema = z
  .object({
    action: z.enum(['list', 'acquire', 'renew', 'release']).default('list'),
    peerId: remotePeerIdSchema.optional(),
    name: z.string().min(1).max(80).optional(),
    scopes: z.array(remoteScopeSchema).min(1).max(32).optional(),
    leaseMs: z
      .number()
      .int()
      .min(MIN_LOCK_LEASE_MS)
      .max(MAX_LOCK_LEASE_MS)
      .default(DEFAULT_LOCK_LEASE_MS),
    reason: z.string().max(240).optional(),
    force: z.boolean().optional(),
  })
  .strict();

export const remotePullInputSchema = z
  .object({
    peerId: remotePeerIdSchema.optional(),
    name: z.string().min(1).max(80).optional(),
    knownFileHashes: z.record(z.string().max(128)).optional(),
    includeFiles: z.boolean().default(true),
  })
  .strict();

export const remotePushInputSchema = z
  .object({
    peerId: remotePeerIdSchema,
    name: z.string().min(1).max(80).optional(),
    baseRevision: z.string().regex(/^[a-f0-9]{64}$/),
    files: z.record(z.string().nullable()),
    baseFiles: z.record(z.string()).optional(),
    mode: z.enum(['apply', 'dryRun']).default('apply'),
    message: z.string().max(240).optional(),
  })
  .strict();

export const remoteRenderRequestSchema = z
  .object({
    action: z.enum(['start', 'status', 'cancel', 'list']).default('list'),
    id: z.string().max(120).optional(),
    peerId: remotePeerIdSchema.optional(),
    name: z.string().min(1).max(80).optional(),
    wait: z.boolean().default(false),
    waitMs: z.number().int().min(100).max(120_000).default(30_000),
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
        quality: z
          .object({
            crf: z.number().min(0).max(51).optional(),
            bitrateKbps: z.number().positive().optional(),
            preset: z.enum(['speed', 'balanced', 'quality']).optional(),
            keyframeInterval: z.number().int().positive().optional(),
            bitDepth: z.union([z.literal(8), z.literal(10)]).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const MAX_REVISION_CACHE = 64;
const MAX_PEERS = 128;
const MAX_ASSET_HASH_CACHE = 512;

export function generateRemoteToken(): string {
  return randomBytes(24).toString('base64url');
}

export class RemoteCoordinator extends EventEmitter {
  readonly coordinatorId = randomUUID();
  private config?: RemoteServerConfig;
  private locks = new Map<string, RemoteLock>();
  private peers = new Map<string, RemotePeer>();
  private revisionCache = new Map<string, Record<string, string>>();
  private assetHashCache = new Map<string, { fingerprint: string; size: number; sha256: string }>();

  constructor(private readonly app: Application) {
    super();
  }

  attach() {
    this.rememberSnapshot(this.app.service.snapshot);
    this.app.service.on('change', () => {
      if (this.app.service.snapshot) this.rememberSnapshot(this.app.service.snapshot);
    });
    this.app.service.lockGuard = (beforeFiles, afterFiles) => {
      const peer = currentRemotePeer();
      this.assertLocksAllow(beforeFiles, afterFiles, peer?.peerId);
    };
  }

  configureServer(input: {
    host?: string;
    port: number;
    editorToken?: string;
    viewerToken?: string;
  }): RemoteServerConfig {
    const editorToken = input.editorToken?.trim() || generateRemoteToken();
    const viewerToken = input.viewerToken?.trim() || undefined;
    if (viewerToken && verifySecretToken(viewerToken, editorToken)) {
      throw new VmotionError(
        'REMOTE_CONFIG',
        'Viewer token must differ from editor token',
      );
    }
    this.config = {
      enabled: true,
      host: normalizeBindHost(input.host),
      port: input.port,
      editorToken,
      viewerToken,
      coordinatorId: this.coordinatorId,
    };
    return this.config;
  }

  disableServer() {
    this.config = undefined;
  }

  restoreServerConfig(previous: RemoteServerConfig | undefined) {
    this.config = previous ? { ...previous } : undefined;
  }

  get serverConfig(): RemoteServerConfig | undefined {
    return this.config;
  }

  authenticate(tokenCandidate: string | undefined): RemoteRole {
    if (!this.config?.enabled) {
      throw new VmotionError(
        'REMOTE_DISABLED',
        'Remote coordination is not enabled on this server',
      );
    }
    if (verifySecretToken(tokenCandidate, this.config.editorToken)) return 'editor';
    if (this.config.viewerToken && verifySecretToken(tokenCandidate, this.config.viewerToken)) {
      return 'viewer';
    }
    throw new VmotionError(
      'REMOTE_UNAUTHORIZED',
      'Missing or invalid remote coordination bearer token',
    );
  }

  requireEditor(role: RemoteRole, operation: string) {
    if (role !== 'editor') {
      throw new VmotionError(
        'REMOTE_FORBIDDEN',
        `Remote viewer role cannot perform ${operation}; use an editor token`,
        { role, operation },
      );
    }
  }

  rememberSnapshot(snapshot: Snapshot | undefined) {
    if (!snapshot) return;
    if (this.revisionCache.has(snapshot.revision)) return;
    if (this.revisionCache.size >= MAX_REVISION_CACHE) {
      const oldest = this.revisionCache.keys().next().value;
      if (oldest) this.revisionCache.delete(oldest);
    }
    this.revisionCache.set(snapshot.revision, { ...snapshot.files });
  }

  private pruneExpired(now = Date.now()) {
    let locksChanged = false;
    for (const [scope, lock] of this.locks) {
      if (lock.expiresAt <= now) {
        this.locks.delete(scope);
        locksChanged = true;
      }
    }
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeenAt > REMOTE_PEER_TTL_MS * 4) {
        this.peers.delete(id);
      }
    }
    if (locksChanged) this.emit('locks', this.listLocks(now));
  }

  listLocks(now = Date.now()): RemoteLock[] {
    this.pruneExpired(now);
    return [...this.locks.values()].sort((a, b) => a.scope.localeCompare(b.scope));
  }

  listPeers(now = Date.now()): RemotePeer[] {
    this.pruneExpired(now);
    return [...this.peers.values()]
      .map((p) => ({
        ...p,
        active: now - p.lastSeenAt <= REMOTE_PEER_TTL_MS,
      }))
      .sort((a, b) => a.peerId.localeCompare(b.peerId));
  }

  notePeer(
    raw: z.infer<typeof remotePresenceInputSchema>,
    role: RemoteRole = 'editor',
  ): RemotePeer {
    const now = Date.now();
    this.pruneExpired(now);
    const prev = this.peers.get(raw.peerId);
    if (!prev && this.peers.size >= MAX_PEERS) {
      const oldest = this.peers.keys().next().value;
      if (oldest) this.peers.delete(oldest);
    }
    const next: RemotePeer = {
      peerId: raw.peerId,
      name: raw.name?.trim() || prev?.name || raw.peerId,
      role,
      ...(raw.sceneId !== undefined
        ? { sceneId: raw.sceneId }
        : prev?.sceneId
          ? { sceneId: prev.sceneId }
          : {}),
      ...(raw.sequenceId !== undefined
        ? { sequenceId: raw.sequenceId }
        : prev?.sequenceId
          ? { sequenceId: prev.sequenceId }
          : {}),
      ...(raw.frame !== undefined
        ? { frame: raw.frame }
        : prev?.frame !== undefined
          ? { frame: prev.frame }
          : {}),
      ...(raw.selection !== undefined
        ? { selection: raw.selection }
        : prev?.selection
          ? { selection: prev.selection }
          : {}),
      ...(raw.client !== undefined
        ? { client: raw.client }
        : prev?.client
          ? { client: prev.client }
          : {}),
      connectedAt: prev?.connectedAt ?? now,
      lastSeenAt: now,
      active: true,
    };
    this.peers.set(next.peerId, next);
    this.emit('peers', this.listPeers(now));
    return next;
  }

  assertLocksAllow(
    beforeFiles: Record<string, string>,
    afterFiles: Record<string, string>,
    peerId: string | undefined,
  ) {
    const now = Date.now();
    this.pruneExpired(now);
    if (!this.locks.size) return;
    const touchedScopes = scopesForChangedFiles(beforeFiles, afterFiles);
    const conflict = findConflictingLock(this.locks.values(), touchedScopes, peerId, now);
    if (conflict) {
      throw new VmotionError(
        'REMOTE_LOCKED',
        `Scope "${conflict.scope}" is locked by ${conflict.name} (${conflict.peerId}) until ${new Date(conflict.expiresAt).toISOString()}`,
        {
          scope: conflict.scope,
          holderPeerId: conflict.peerId,
          holderName: conflict.name,
          reason: conflict.reason,
          expiresAt: conflict.expiresAt,
          touchedScopes,
        },
      );
    }
  }

  manageLocks(raw: unknown, role: RemoteRole = 'editor') {
    const input = remoteLockActionSchema.parse(raw);
    const now = Date.now();
    this.pruneExpired(now);
    if (input.action === 'list') {
      return { locks: this.listLocks(now), serverTime: now };
    }
    this.requireEditor(role, `lock.${input.action}`);
    if (!input.peerId) {
      throw new VmotionError('TOOL_ARGUMENTS', `peerId is required for lock action "${input.action}"`);
    }
    const peerName = input.name?.trim() || this.peers.get(input.peerId)?.name || input.peerId;
    this.notePeer({ peerId: input.peerId, name: peerName }, role);

    if (input.action === 'acquire') {
      const scopes = [...new Set(input.scopes ?? ['project'])];
      const conflict = findConflictingLock(this.locks.values(), scopes, input.peerId, now);
      if (conflict) {
        throw new VmotionError(
          'REMOTE_LOCKED',
          `Cannot acquire lock: "${conflict.scope}" is held by ${conflict.name} (${conflict.peerId})`,
          {
            scope: conflict.scope,
            holderPeerId: conflict.peerId,
            holderName: conflict.name,
            reason: conflict.reason,
            expiresAt: conflict.expiresAt,
            requestedScopes: scopes,
          },
        );
      }
      const acquired: RemoteLock[] = [];
      for (const scope of scopes) {
        const existing = this.locks.get(scope);
        const lock: RemoteLock = {
          scope,
          peerId: input.peerId,
          name: peerName,
          ...(input.reason ? { reason: input.reason } : existing?.reason ? { reason: existing.reason } : {}),
          acquiredAt: existing?.peerId === input.peerId ? existing.acquiredAt : now,
          expiresAt: now + input.leaseMs,
          leaseMs: input.leaseMs,
        };
        this.locks.set(scope, lock);
        acquired.push(lock);
      }
      const locks = this.listLocks(now);
      this.emit('locks', locks);
      return { action: 'acquire' as const, acquired, locks, serverTime: now };
    }

    if (input.action === 'renew') {
      const targetScopes = input.scopes ? new Set(input.scopes) : undefined;
      const renewed: RemoteLock[] = [];
      for (const [scope, lock] of this.locks) {
        if (targetScopes && !targetScopes.has(scope)) continue;
        if (lock.peerId !== input.peerId) {
          if (targetScopes) {
            throw new VmotionError(
              'REMOTE_LOCKED',
              `Cannot renew lock "${scope}" owned by ${lock.name} (${lock.peerId})`,
              { scope, holderPeerId: lock.peerId, holderName: lock.name },
            );
          }
          continue;
        }
        const updated: RemoteLock = {
          ...lock,
          name: peerName,
          expiresAt: now + input.leaseMs,
          leaseMs: input.leaseMs,
        };
        this.locks.set(scope, updated);
        renewed.push(updated);
      }
      if (targetScopes) {
        for (const s of targetScopes) {
          if (!this.locks.has(s)) {
            throw new VmotionError('NOT_FOUND', `Active lock not found for scope "${s}"`, {
              scope: s,
            });
          }
        }
      }
      const locks = this.listLocks(now);
      this.emit('locks', locks);
      return { action: 'renew' as const, renewed, locks, serverTime: now };
    }

    // release
    const targetScopes = input.scopes ? new Set(input.scopes) : undefined;
    const released: string[] = [];
    for (const [scope, lock] of this.locks) {
      if (targetScopes && !targetScopes.has(scope)) continue;
      if (lock.peerId !== input.peerId && !input.force) {
        if (targetScopes) {
          throw new VmotionError(
            'REMOTE_LOCKED',
            `Cannot release lock "${scope}" owned by ${lock.name} (${lock.peerId}) without force=true`,
            { scope, holderPeerId: lock.peerId, holderName: lock.name },
          );
        }
        continue;
      }
      this.locks.delete(scope);
      released.push(scope);
    }
    const locks = this.listLocks(now);
    this.emit('locks', locks);
    return { action: 'release' as const, released, locks, serverTime: now };
  }

  async buildAssetManifest(snapshot = this.app.service.snapshot): Promise<RemoteAssetEntry[]> {
    const entries: RemoteAssetEntry[] = [];
    for (const asset of snapshot.project.assets) {
      let fullPath: string;
      try {
        fullPath = safePath(this.app.root, asset.path);
      } catch {
        continue;
      }
      let info;
      try {
        info = await stat(fullPath);
        if (!info.isFile()) continue;
      } catch {
        continue;
      }
      const fp = `${asset.path}:${info.size}:${info.mtimeMs}`;
      let cached = this.assetHashCache.get(asset.path);
      if (!cached || cached.fingerprint !== fp) {
        const sha256 = await hashFileStream(fullPath);
        if (this.assetHashCache.size >= MAX_ASSET_HASH_CACHE) {
          const oldest = this.assetHashCache.keys().next().value;
          if (oldest) this.assetHashCache.delete(oldest);
        }
        cached = { fingerprint: fp, size: info.size, sha256 };
        this.assetHashCache.set(asset.path, cached);
      }
      entries.push({
        id: asset.id,
        name: asset.name,
        path: asset.path.replace(/\\/g, '/'),
        type: asset.type,
        managed: asset.managed,
        size: cached.size,
        sha256: cached.sha256,
        ...(asset.metadata && Object.keys(asset.metadata).length ? { metadata: asset.metadata } : {}),
      });
    }
    return entries;
  }

  async status(role: RemoteRole = 'editor', peerHeader?: { peerId?: string; name?: string }) {
    if (peerHeader?.peerId && remotePeerIdSchema.safeParse(peerHeader.peerId).success) {
      this.notePeer({ peerId: peerHeader.peerId, name: peerHeader.name }, role);
    }
    const snapshot = this.app.service.snapshot;
    const assets = await this.buildAssetManifest(snapshot);
    const renderJobs = [...this.app.renders.jobs.values()]
      .slice(-20)
      .map((job) => summarizeRenderJob(job, this.app.root));
    return {
      coordinatorId: this.coordinatorId,
      role,
      project: {
        name: snapshot.project.name,
        kind: snapshot.project.kind ?? 'video',
        width: snapshot.project.width,
        height: snapshot.project.height,
        fps: snapshot.project.fps,
        activeSequence: snapshot.project.activeSequence,
      },
      revision: snapshot.revision,
      formatVersion: snapshot.project.formatVersion,
      fileCount: Object.keys(snapshot.files).filter((f) => !f.startsWith('.vmotion/')).length,
      fileHashes: fileHashesOf(snapshot.files),
      assets,
      locks: this.listLocks(),
      peers: this.listPeers(),
      renderJobs,
      pendingFiles: !!this.app.service.pendingFiles,
      conflicts: this.app.service.conflicts.length,
      holdingAgents: this.app.service.holdingAgents,
      serverTime: Date.now(),
    };
  }

  async pull(raw: unknown, role: RemoteRole = 'editor') {
    const input = remotePullInputSchema.parse(raw ?? {});
    if (input.peerId) this.notePeer({ peerId: input.peerId, name: input.name }, role);
    await this.app.service.exclusive(() => this.app.service.reload());
    const snapshot = this.app.service.snapshot;
    this.rememberSnapshot(snapshot);
    const hashes = fileHashesOf(snapshot.files);
    const files: Record<string, string> = {};
    if (input.includeFiles) {
      for (const [name, hash] of Object.entries(hashes)) {
        if (input.knownFileHashes?.[name] === hash) continue;
        files[name] = snapshot.files[name];
      }
    }
    return {
      coordinatorId: this.coordinatorId,
      revision: snapshot.revision,
      formatVersion: snapshot.project.formatVersion,
      fileList: Object.keys(hashes),
      fileHashes: hashes,
      files,
      assets: await this.buildAssetManifest(snapshot),
      locks: this.listLocks(),
      peers: this.listPeers(),
    };
  }

  async storeUploadedAsset(relPath: string, expectedSha256: string, content: Buffer) {
    const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (
      !normalized.startsWith('assets/') ||
      normalized.includes('..') ||
      normalized.endsWith('/')
    ) {
      throw new VmotionError(
        'REMOTE_PATH',
        'Uploaded remote assets must reside inside assets/<filename>',
        { path: relPath },
      );
    }
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new VmotionError('REMOTE_ASSET_HASH', 'Expected a 64-char hex SHA-256 digest');
    }
    const actualSha256 = hashContent(content);
    if (actualSha256 !== expectedSha256) {
      throw new VmotionError('REMOTE_ASSET_HASH', 'Uploaded asset SHA-256 mismatch', {
        expected: expectedSha256,
        actual: actualSha256,
        path: normalized,
      });
    }
    const target = safePath(this.app.root, normalized);
    await mkdir(path.dirname(target), { recursive: true });
    await atomicWrite(target, content);
    return { path: normalized, size: content.byteLength, sha256: actualSha256 };
  }

  async resolveAssetFile(assetId: string): Promise<{ file: string; entry: RemoteAssetEntry }> {
    const manifest = await this.buildAssetManifest(this.app.service.snapshot);
    const entry = manifest.find((a) => a.id === assetId);
    if (!entry) {
      throw new VmotionError('NOT_FOUND', `Remote asset not found: ${assetId}`, { assetId });
    }
    return { file: safePath(this.app.root, entry.path), entry };
  }

  async push(raw: unknown, role: RemoteRole = 'editor') {
    this.requireEditor(role, 'push');
    const input = remotePushInputSchema.parse(raw);
    const peerName = input.name?.trim() || input.peerId;
    this.notePeer({ peerId: input.peerId, name: peerName }, role);

    await this.app.service.exclusive(() => this.app.service.reload());
    const current = this.app.service.snapshot;
    this.rememberSnapshot(current);

    let baseFiles: Record<string, string> | undefined;
    if (input.baseRevision === current.revision) {
      baseFiles = { ...current.files };
    } else if (input.baseFiles) {
      const parsedBase = parseFiles(input.baseFiles);
      if (parsedBase.revision !== input.baseRevision) {
        throw new VmotionError(
          'REMOTE_BASE_MISMATCH',
          'Supplied baseFiles do not match baseRevision',
          { expected: input.baseRevision, actual: parsedBase.revision },
        );
      }
      baseFiles = parsedBase.files;
    } else {
      baseFiles =
        this.revisionCache.get(input.baseRevision) ??
        (await this.app.service.snapshotFilesAt(input.baseRevision));
    }

    if (!baseFiles) {
      throw new VmotionError(
        'REMOTE_BASE_MISSING',
        'Base revision snapshot is unavailable on coordinator; pull or supply baseFiles to merge',
        { baseRevision: input.baseRevision, remoteRevision: current.revision },
      );
    }

    const theirsFiles = applyFilePatch(baseFiles, input.files);
    const fastForward = input.baseRevision === current.revision;
    let finalFiles: Record<string, string>;
    let changedFiles: string[];
    let merged = false;

    if (fastForward) {
      finalFiles = theirsFiles;
      changedFiles = Object.keys(diffFilePatch(current.files, finalFiles));
    } else {
      const mergeResult = threeWayMergeFiles(baseFiles, current.files, theirsFiles);
      if (mergeResult.conflicts.length > 0) {
        throw new VmotionError(
          'REMOTE_CONFLICT',
          'Concurrent edits conflict with remote coordinator; pull/sync to inspect and resolve conflicts',
          {
            baseRevision: input.baseRevision,
            remoteRevision: current.revision,
            conflicts: mergeResult.conflicts,
          },
        );
      }
      finalFiles = mergeResult.files;
      changedFiles = mergeResult.changedFromOurs;
      merged = true;
    }

    this.assertLocksAllow(current.files, finalFiles, input.peerId);
    const candidate = parseFiles(finalFiles);
    const diagnostics = await this.app.service.validate(candidate);
    if (diagnostics.some((d) => d.severity === 'error')) {
      throw new VmotionError(
        'VALIDATION_FAILED',
        'Pushed changes failed validation on coordinator; no changes committed',
        diagnostics,
      );
    }

    const deltaForClient = diffFilePatch(theirsFiles, candidate.files);
    if (input.mode === 'dryRun') {
      return {
        committed: false,
        fastForward,
        merged,
        baseRevision: input.baseRevision,
        previousRevision: current.revision,
        revision: candidate.revision,
        changedFiles,
        deltaForClient,
      };
    }

    const state = await withRemotePeer(
      { peerId: input.peerId, name: peerName, role },
      () =>
        withChangeOrigin(
          {
            kind: 'mcp',
            client: `remote:${peerName}`,
            tool: 'remote_sync',
            intent: input.message,
          },
          () =>
            this.app.service.commitSnapshot(candidate, {
              expectedRevision: current.revision,
              action: 'edit',
            }),
        ),
    );
    this.rememberSnapshot(state.snapshot);
    return {
      committed: true,
      fastForward,
      merged,
      baseRevision: input.baseRevision,
      previousRevision: current.revision,
      revision: state.snapshot.revision,
      changedFiles,
      deltaForClient,
      assets: await this.buildAssetManifest(state.snapshot),
    };
  }

  async renderAction(raw: unknown, role: RemoteRole = 'editor') {
    const input = remoteRenderRequestSchema.parse(raw ?? {});
    if (input.peerId) this.notePeer({ peerId: input.peerId, name: input.name }, role);

    if (input.action === 'list') {
      return {
        jobs: [...this.app.renders.jobs.values()]
          .slice(-20)
          .map((job) => summarizeRenderJob(job, this.app.root)),
      };
    }
    if (input.action === 'status') {
      if (!input.id) throw new VmotionError('TOOL_ARGUMENTS', 'Render job id is required');
      const job = this.app.renders.jobs.get(input.id);
      if (!job) throw new VmotionError('NOT_FOUND', `Render job not found: ${input.id}`);
      return { job: summarizeRenderJob(job, this.app.root) };
    }
    if (input.action === 'cancel') {
      this.requireEditor(role, 'render.cancel');
      if (!input.id) throw new VmotionError('TOOL_ARGUMENTS', 'Render job id is required');
      return { job: summarizeRenderJob(this.app.renders.cancel(input.id), this.app.root) };
    }

    // start
    this.requireEditor(role, 'render.start');
    if (this.app.service.pendingFiles) {
      throw new VmotionError(
        'INVALID_ON_DISK',
        'Remote project has invalid pending files; repair before rendering',
        this.app.service.diagnostics,
      );
    }
    if (this.app.service.conflicts.length) {
      throw new VmotionError(
        'UNRESOLVED_CONFLICTS',
        'Remote project has unresolved conflicts; resolve before rendering',
      );
    }
    const opts = input.options ?? { format: 'mp4' as const };
    const snapshot = this.app.service.snapshot;
    if (opts.revision && opts.revision !== snapshot.revision) {
      throw new VmotionError('REVISION_CONFLICT', 'Remote project revision changed before render', {
        expected: opts.revision,
        actual: snapshot.revision,
      });
    }
    const renderSnapshot = structuredClone(snapshot);
    if (opts.sequenceId) {
      if (!renderSnapshot.sequences.some((s) => s.id === opts.sequenceId)) {
        throw new VmotionError('NOT_FOUND', `Sequence not found: ${opts.sequenceId}`);
      }
      renderSnapshot.project.activeSequence = opts.sequenceId;
    }
    const ext = opts.format === 'mp4' ? '.mp4' : opts.format === 'wav' ? '.wav' : '';
    const baseName = opts.filename
      ? opts.filename.replace(/\.(mp4|wav|png|zip)$/i, '')
      : `remote-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const relativeOutput = `exports/remote/${baseName}${ext}`;
    const safeOutput = safePath(this.app.root, relativeOutput);
    await mkdir(path.dirname(safeOutput), { recursive: true });

    const renderOptions: RenderOptions = {
      output: safeOutput,
      format: opts.format,
      ...(opts.start !== undefined ? { start: opts.start } : {}),
      ...(opts.end !== undefined ? { end: opts.end } : {}),
      ...(opts.width !== undefined ? { width: opts.width } : {}),
      ...(opts.height !== undefined ? { height: opts.height } : {}),
      ...(opts.encoder ? { encoder: opts.encoder } : {}),
      ...(opts.codec ? { codec: opts.codec } : {}),
      ...(opts.gpu ? { gpu: opts.gpu } : {}),
      ...(opts.schedule ? { schedule: opts.schedule } : {}),
      ...(opts.quality ? { quality: opts.quality } : {}),
    };
    const started = this.app.renders.start(renderSnapshot, renderOptions);
    if (!input.wait) {
      return { job: summarizeRenderJob(started, this.app.root) };
    }
    const finalJob = await Promise.race([
      this.app.renders.wait(started.id),
      new Promise<RenderJob>((resolve) =>
        setTimeout(() => resolve(this.app.renders.jobs.get(started.id) ?? started), input.waitMs),
      ),
    ]);
    return { job: summarizeRenderJob(finalJob, this.app.root) };
  }

  async resolveRenderArtifact(jobId: string): Promise<
    | { kind: 'file'; file: string; filename: string; mimeType: string; size: number; sha256: string }
    | { kind: 'buffer'; buffer: Buffer; filename: string; mimeType: string; size: number; sha256: string }
  > {
    const job = this.app.renders.jobs.get(jobId);
    if (!job) throw new VmotionError('NOT_FOUND', `Render job not found: ${jobId}`);
    if (job.status !== 'completed') {
      throw new VmotionError(
        'RENDER_NOT_READY',
        `Render job ${jobId} is ${job.status}, not completed`,
        { id: job.id, status: job.status, error: job.error },
      );
    }
    const fullPath = safePath(this.app.root, job.output);
    const info = await stat(fullPath);
    if (info.isDirectory()) {
      const names = (await readdir(fullPath)).filter((n) => n.endsWith('.png')).sort();
      const entries: Record<string, Uint8Array> = {};
      for (const name of names) {
        entries[name] = await readFile(path.join(fullPath, name));
      }
      const zipped = Buffer.from(zipSync(entries, { level: 6 }));
      return {
        kind: 'buffer',
        buffer: zipped,
        filename: `${path.basename(fullPath)}.zip`,
        mimeType: 'application/zip',
        size: zipped.byteLength,
        sha256: hashContent(zipped),
      };
    }
    const sha256 = await hashFileStream(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    const mimeType =
      ext === '.mp4' ? 'video/mp4' : ext === '.wav' ? 'audio/wav' : 'application/octet-stream';
    return {
      kind: 'file',
      file: fullPath,
      filename: path.basename(fullPath),
      mimeType,
      size: info.size,
      sha256,
    };
  }

  assertRemoteRpcAllowed(
    role: RemoteRole,
    method: string,
    params: unknown,
    definitions: ToolDefinition[],
  ) {
    if (studioOnlyMethods.has(method)) {
      throw new VmotionError(
        'SURFACE_METHOD',
        `Studio-only control "${method}" cannot be invoked over remote RPC`,
      );
    }
    if (role === 'editor') return;
    const readHostMethods = new Set([
      'ping',
      'pluginCatalog',
      'agentDefinitions',
      'agentStatus',
      'inboxState',
    ]);
    if (readHostMethods.has(method)) return;
    if (method === 'agentToolInvoke') {
      const name =
        params && typeof params === 'object' && !Array.isArray(params)
          ? (params as { name?: unknown }).name
          : undefined;
      if (name === 'tools_search' || name === 'tool_schema') return;
      const tool = typeof name === 'string' ? definitions.find((t) => t.name === name) : undefined;
      if (tool && (tool.effect ?? deriveToolEffect(tool)) === 'read') return;
      throw new VmotionError(
        'REMOTE_FORBIDDEN',
        `Remote viewer role cannot invoke non-read capability "${String(name)}"`,
      );
    }
    const matchingTools = definitions.filter((t) => t.method === method);
    if (
      matchingTools.length > 0 &&
      matchingTools.every((t) => (t.effect ?? deriveToolEffect(t)) === 'read')
    ) {
      return;
    }
    throw new VmotionError(
      'REMOTE_FORBIDDEN',
      `Remote viewer role cannot invoke RPC method "${method}"`,
    );
  }
}

export function summarizeRenderJob(job: RenderJob, root?: string) {
  const lower = job.output.toLowerCase();
  const format: 'mp4' | 'png' | 'wav' = lower.endsWith('.mp4')
    ? 'mp4'
    : lower.endsWith('.wav')
      ? 'wav'
      : 'png';
  let output = job.output;
  if (root) {
    const base = path.resolve(root);
    const resolved = path.resolve(job.output);
    if (resolved.startsWith(base + path.sep)) {
      output = path.relative(base, resolved).replace(/\\/g, '/');
    }
  }
  return {
    id: job.id,
    status: job.status,
    format,
    output,
    revision: job.revision,
    progress: job.progress,
    frame: job.frame,
    totalFrames: job.totalFrames,
    stage: job.stage,
    startedAt: job.startedAt,
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.gpu ? { gpu: job.gpu } : {}),
    ...(job.heterogeneous ? { heterogeneous: job.heterogeneous } : {}),
    ...(job.encoder ? { encoder: job.encoder } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function hashFileStream(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
