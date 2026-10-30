import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import type http from 'node:http';
import os from 'node:os';
import { z } from 'zod';
import { VmotionError } from '../core/model.js';
import type { RemoteLock, RemotePeer, RemoteRole } from '../core/remote-model.js';
import { projectFolder } from '../desktop/projects.js';
import type { Application } from './application.js';
import { serveHttp } from './http.js';
import { isLoopbackAddress, normalizeBindHost, reachableUrls } from './net-address.js';
import {
  normalizeRemoteUrl,
  readRemoteBinding,
  readSavedToken,
  remoteCloneProject,
  remoteRequestJson,
  writeRemoteBinding,
  writeSavedToken,
} from './remote-client.js';
import { generateRemoteToken } from './remote-coordinator.js';

export interface RemoteHostStatus {
  running: boolean;
  host?: string;
  ipv6Only?: boolean;
  port?: number;
  url?: string;
  urls: string[];
  coordinatorId?: string;
  projectRoot?: string;
  projectName?: string;
  revision?: string;
  editorToken?: string;
  viewerToken?: string;
  locks: RemoteLock[];
  peers: RemotePeer[];
  hasSavedClientToken?: boolean;
}

export interface RemoteProbeResult {
  url: string;
  coordinatorId: string;
  project: string;
  kind: 'video' | 'still';
  width: number;
  height: number;
  role: RemoteRole;
  revision: string;
  formatVersion: number;
  fileCount: number;
  assets: number;
  locks: RemoteLock[];
  peers: RemotePeer[];
  suggestedFolderName: string;
}

export const remoteHostStartSchema = z
  .object({
    host: z.string().trim().min(1).max(120).default('::'),
    port: z.number().int().min(0).max(65535).default(4318),
    ipv6Only: z.boolean().default(false),
    editorToken: z.string().trim().max(512).optional(),
    viewerToken: z.string().trim().max(512).optional(),
    enableViewerToken: z.boolean().default(false),
  })
  .strict();

export type RemoteHostStartInput = z.input<typeof remoteHostStartSchema>;

export const remoteProbeSchema = z
  .object({
    url: z.string().trim().min(1).max(512),
    token: z.string().trim().max(512).optional(),
    name: z.string().trim().max(80).optional(),
  })
  .strict();

export type RemoteProbeInput = z.input<typeof remoteProbeSchema>;

export const remoteCloneInputSchema = z
  .object({
    url: z.string().trim().min(1).max(512),
    token: z.string().trim().max(512).optional(),
    saveToken: z.boolean().default(true),
    name: z.string().trim().max(80).optional(),
    peerId: z.string().trim().max(80).optional(),
    directory: z.string().trim().min(1),
    folderName: z.string().trim().max(120).optional(),
  })
  .strict();

export type RemoteCloneInput = z.input<typeof remoteCloneInputSchema>;

export const remoteBindInputSchema = z
  .object({
    url: z.string().trim().min(1).max(512),
    token: z.string().trim().max(512).optional(),
    saveToken: z.boolean().default(true),
    name: z.string().trim().max(80).optional(),
    peerId: z.string().trim().max(80).optional(),
  })
  .strict();

export type RemoteBindInput = z.input<typeof remoteBindInputSchema>;

export function sanitizeRemoteFolderName(rawName: string | undefined): string {
  const cleaned = (rawName ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80);
  if (!cleaned || cleaned === '.' || cleaned === '..') return '远程协同项目';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) {
    return `remote-${cleaned}`;
  }
  return cleaned;
}

function pickPreferredShareUrl(urls: string[]): string | undefined {
  if (!urls.length) return undefined;
  const external = urls.filter((candidate) => {
    try {
      return !isLoopbackAddress(new URL(candidate).hostname);
    } catch {
      return false;
    }
  });
  const externalIpv4 = external.find((u) => !new URL(u).hostname.startsWith('['));
  return externalIpv4 ?? external[0] ?? urls[0];
}

export async function probeRemoteCoordinator(raw: unknown): Promise<RemoteProbeResult> {
  const input = remoteProbeSchema.parse(raw ?? {});
  const url = normalizeRemoteUrl(input.url);
  const status = await remoteRequestJson<{
    coordinatorId: string;
    project: {
      name: string;
      kind: 'video' | 'still';
      width: number;
      height: number;
    };
    role: RemoteRole;
    revision: string;
    formatVersion: number;
    fileCount: number;
    assets: unknown[];
    locks: RemoteLock[];
    peers: RemotePeer[];
  }>(
    {
      url,
      token: input.token,
      name: input.name,
      timeoutMs: 12_000,
    },
    '/api/remote/status',
  );
  return {
    url,
    coordinatorId: status.coordinatorId,
    project: status.project.name,
    kind: status.project.kind,
    width: status.project.width,
    height: status.project.height,
    role: status.role,
    revision: status.revision,
    formatVersion: status.formatVersion,
    fileCount: status.fileCount,
    assets: Array.isArray(status.assets) ? status.assets.length : 0,
    locks: status.locks,
    peers: status.peers,
    suggestedFolderName: sanitizeRemoteFolderName(status.project.name),
  };
}

export async function cloneRemoteProjectToDirectory(raw: unknown) {
  const input = remoteCloneInputSchema.parse(raw ?? {});
  const url = normalizeRemoteUrl(input.url);
  let targetFolder = input.folderName?.trim();
  if (!targetFolder) {
    const probed = await probeRemoteCoordinator({
      url,
      token: input.token,
      name: input.name,
    });
    targetFolder = probed.suggestedFolderName;
  }
  const root = projectFolder(input.directory, targetFolder);
  const existingEntries = await readdir(root).catch(() => undefined);
  if (existingEntries && existingEntries.length > 0) {
    throw new VmotionError(
      'FOLDER_NOT_EMPTY',
      `目标文件夹已存在且不为空：${root}。请修改本地文件夹名称或选择其他保存目录。`,
      { root },
    );
  }
  const cloned = await remoteCloneProject({
    root,
    url,
    token: input.token,
    saveToken: input.saveToken,
    name: input.name || undefined,
    peerId: input.peerId || undefined,
  });
  return {
    ...cloned,
    root,
  };
}

export async function bindRemoteProject(app: Application, raw: unknown) {
  const input = remoteBindInputSchema.parse(raw ?? {});
  const url = normalizeRemoteUrl(input.url);
  const existing = await readRemoteBinding(app.root);
  const token = input.token?.trim() || (await readSavedToken(app.root));
  const probed = await probeRemoteCoordinator({
    url,
    token,
    name: input.name || existing?.name,
  });
  const hostLabel = os.hostname().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 32) || 'peer';
  const peerId = input.peerId?.trim() || existing?.peerId || `${hostLabel}-${randomUUID().slice(0, 8)}`;
  const name = input.name?.trim() || existing?.name || hostLabel;
  const sameCoordinatorUrl = existing?.url === url;
  await writeRemoteBinding(app.root, {
    version: 1,
    url,
    peerId,
    name,
    ...(sameCoordinatorUrl && existing?.baseRevision ? { baseRevision: existing.baseRevision } : {}),
    ...(sameCoordinatorUrl && existing?.lastSyncAt ? { lastSyncAt: existing.lastSyncAt } : {}),
  });
  if (input.saveToken && token) {
    await writeSavedToken(app.root, token);
  }
  return {
    binding: await readRemoteBinding(app.root),
    probed,
    savedToken: Boolean(input.saveToken && token),
  };
}

export class RemoteHostController {
  private server?: http.Server;
  private activeApp?: Application;
  private activeHost?: string;
  private activeIpv6Only = false;
  private activePort?: number;

  async start(
    app: Application | undefined,
    clientDirectory: string,
    rawOptions: unknown = {},
  ): Promise<RemoteHostStatus> {
    if (!app) {
      throw new VmotionError('NO_PROJECT', '请先新建或打开一个本地项目，再启动远程协作主机。');
    }
    const parsed = remoteHostStartSchema.parse(rawOptions ?? {});
    const bindHost = normalizeBindHost(parsed.host, '::');
    const editorToken = parsed.editorToken?.trim() || undefined;
    const viewerToken =
      parsed.viewerToken?.trim() ||
      (parsed.enableViewerToken ? generateRemoteToken() : undefined);

    await this.stop();

    let nextServer: http.Server;
    try {
      nextServer = await serveHttp(app, parsed.port, clientDirectory, {
        host: bindHost,
        ipv6Only: parsed.ipv6Only,
        remote: {
          editorToken,
          viewerToken,
        },
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'EADDRINUSE') {
        throw new VmotionError(
          'PORT_IN_USE',
          `端口 ${parsed.port} 已被占用，请更换端口（或设为 0 自动分配空闲端口）。`,
          { port: parsed.port, host: bindHost },
        );
      }
      if (code === 'EACCES') {
        throw new VmotionError(
          'PORT_FORBIDDEN',
          `无权限监听 ${bindHost}:${parsed.port}，请改用 1024 以上端口（如 4318）。`,
          { port: parsed.port, host: bindHost },
        );
      }
      if (code === 'EADDRNOTAVAIL') {
        throw new VmotionError(
          'ADDR_NOT_AVAILABLE',
          `本机不存在网卡地址 ${bindHost}，请选择双栈 (::)、全部 IPv4 (0.0.0.0) 或正确的本机 IP。`,
          { host: bindHost },
        );
      }
      throw error;
    }

    const addr = nextServer.address();
    if (!addr || typeof addr === 'string') {
      nextServer.close();
      app.remote.disableServer();
      throw new VmotionError('REMOTE_SERVER', '无法获取远程协作主机的监听端口');
    }

    this.server = nextServer;
    this.activeApp = app;
    this.activeHost = bindHost;
    this.activeIpv6Only = parsed.ipv6Only;
    this.activePort = addr.port;
    return this.status(app);
  }

  async stop(currentApp?: Application): Promise<RemoteHostStatus> {
    const prevServer = this.server;
    const prevApp = this.activeApp;
    this.server = undefined;
    this.activeApp = undefined;
    this.activeHost = undefined;
    this.activeIpv6Only = false;
    this.activePort = undefined;

    if (prevApp) {
      prevApp.remote.disableServer();
    }
    if (prevServer) {
      prevServer.closeAllConnections();
      await new Promise<void>((resolve) => prevServer.close(() => resolve()));
    }
    return this.status(currentApp ?? prevApp);
  }

  async status(currentApp?: Application): Promise<RemoteHostStatus> {
    const app = currentApp ?? this.activeApp;
    const savedToken = app ? Boolean(await readSavedToken(app.root)) : false;
    if (
      !this.server ||
      !this.activeApp ||
      this.activePort === undefined ||
      !this.activeHost ||
      (currentApp && currentApp !== this.activeApp)
    ) {
      return {
        running: false,
        urls: [],
        ...(app
          ? {
              projectRoot: app.root,
              projectName: app.service.snapshot.project.name,
              revision: app.service.snapshot.revision,
              locks: app.remote.listLocks(),
              peers: app.remote.listPeers(),
              hasSavedClientToken: savedToken,
            }
          : {
              locks: [],
              peers: [],
            }),
      };
    }

    const cfg = this.activeApp.remote.serverConfig;
    const urls = reachableUrls(this.activeHost, this.activePort, {
      ipv6Only: this.activeIpv6Only,
    });
    return {
      running: true,
      host: this.activeHost,
      ipv6Only: this.activeIpv6Only,
      port: this.activePort,
      url: pickPreferredShareUrl(urls),
      urls,
      coordinatorId: cfg?.coordinatorId ?? this.activeApp.remote.coordinatorId,
      projectRoot: this.activeApp.root,
      projectName: this.activeApp.service.snapshot.project.name,
      revision: this.activeApp.service.snapshot.revision,
      editorToken: cfg?.editorToken,
      viewerToken: cfg?.viewerToken,
      locks: this.activeApp.remote.listLocks(),
      peers: this.activeApp.remote.listPeers(),
      hasSavedClientToken: savedToken,
    };
  }
}
