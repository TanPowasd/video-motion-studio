import type { InboxRequest, SamplingMode } from '../core/inbox-model.js';
import type { CompositionDraft } from '../core/interaction.js';
import type { Snapshot } from '../core/model.js';
import type { RemoteLock, RemotePeer, RemoteRole } from '../core/remote-model.js';
import type { Renderer } from '../core/renderer.js';
import type { RenderJob, RenderManager } from '../media/export.js';
import type { ProxyManager } from '../media/proxy-cache.js';
import type { encoderCapabilities } from '../media/video-encoder.js';
import type { ChangeEntry } from './change-journal.js';
import type { RemoteCoordinator } from './remote-coordinator.js';
import type { ProjectService } from './service.js';

export type EmptyRequest = Record<string, never>;

export interface FrameRequest {
  frame?: number;
  width?: number;
  height?: number;
  sceneId?: string;
  path?: string[];
  contextFrames?: number[];
  output?: string;
  fallback?: boolean;
  draft?: CompositionDraft | CompositionDraft[];
  format?: 'png' | 'rgba';
  mediaQuality?: 'original' | 'auto';
}

export interface FrameResult {
  buffer: Buffer;
  stale: boolean;
  revision: string;
  frame: number;
  format: 'png' | 'rgba';
  width?: number;
  height?: number;
  renderMs?: number;
  encodeMs?: number;
  media?: { quality: string; proxyCount: number; decodePixels: number };
  error?: string;
}

export interface AgentPresenceClient {
  client: string;
  lastSeen: number;
  active: boolean;
  sampling?: SamplingMode;
}

export interface AgentPresenceState {
  hold: boolean;
  clients: AgentPresenceClient[];
}

export interface McpConnectionSpec {
  command: string;
  args: string[];
  env?: {
    ELECTRON_RUN_AS_NODE: string;
    VMOTION_NATIVE: string | undefined;
    VMOTION_SDK_SOURCE: string | undefined;
    ESBUILD_BINARY_PATH: string | undefined;
  };
}

export type ProxyJobSnapshot = ProxyManager['jobs'] extends Map<string, infer J> ? J : never;

export interface ApplicationCapabilities {
  formatVersion: number;
  renderer: string;
  nativeAnimation: boolean;
  gpu: boolean;
  gpuEffects: {
    mode: Renderer['gpu']['mode'];
    status: ReturnType<Renderer['gpu']['report']>['status'];
    scope: string;
    fullSceneGpu: boolean;
  };
  videoEncode: ReturnType<typeof encoderCapabilities>;
  workspaces: string[];
  agentWorkbench: string;
  aiIntegration: false;
  animationTools: string[];
}

export type ApplicationState = ReturnType<ProjectService['state']> & {
  changeLog: ChangeEntry[];
  agents: AgentPresenceState;
  inbox: InboxRequest[];
  mediaEpoch: number;
  proxyJobs: ProxyJobSnapshot[];
  root: string;
  connection: McpConnectionSpec;
  jobs: RenderJob[];
  capabilities: ApplicationCapabilities;
};

/** Narrow preview/render capability slice used by flow & workflow service helpers. */
export interface RenderPreviewHost {
  readonly root: string;
  readonly snapshot: Snapshot;
  readonly renderer: Renderer;
  withMediaTask: <T>(work: () => Promise<T>) => Promise<T>;
}

/** Narrow host interface passed to RemoteCoordinator without importing Application. */
export interface RemoteCoordinatorOwner {
  readonly root: string;
  readonly service: ProjectService;
  readonly renders: RenderManager;
}

/** Narrow host interface used by remote client/plugin handlers without importing Application. */
export interface RemoteWorkspaceHost {
  readonly root: string;
  readonly service: ProjectService;
  readonly remote: RemoteCoordinator;
}

export interface RemoteHostStatus {
  running: boolean;
  host?: string;
  ipv6Only?: boolean;
  port?: number;
  publicUrl?: string;
  publicUrls?: string[];
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

export interface RemoteHostStartInput {
  host?: string;
  port?: number;
  ipv6Only?: boolean;
  publicUrl?: string;
  editorToken?: string;
  viewerToken?: string;
  enableViewerToken?: boolean;
}

export interface RemoteHostPublicUrlInput {
  publicUrl?: string;
}

export interface RemoteProbeInput {
  url: string;
  token?: string;
  name?: string;
}

export interface RemoteCloneInput {
  url: string;
  token?: string;
  saveToken?: boolean;
  name?: string;
  peerId?: string;
  directory: string;
  folderName?: string;
}

export interface RemoteBindInput {
  url: string;
  token?: string;
  saveToken?: boolean;
  name?: string;
  peerId?: string;
}
