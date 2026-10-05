import type { Snapshot, Operation, Diagnostic } from '../core/model.js';
import type { Renderer } from '../core/renderer.js';
import type { CompositionDraft } from '../core/interaction.js';
import type { AudioPreview } from '../media/audio-preview.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import type { RenderManager } from '../media/export.js';
import type { ProjectService } from '../service/service.js';
import type { ProxyManager } from '../media/proxy-cache.js';
import type { TrackingManager } from '../service/tracking-jobs.js';
import type { PluginRegistry } from '../core/plugins.js';
import type { BuiltinPluginRegistry } from './registry.js';

/** Services owned by the application; builtin modules neither own nor close them. */
export interface BuiltinPluginHost {
  root: string;
  renderer: Renderer;
  snapshot: Snapshot;
  audioPreview: AudioPreview;
  renders: RenderManager;
  exportState: () => { pendingFiles: boolean; diagnostics: Diagnostic[] };
  transact: ProjectService['transact'];
  select: (ids: string[]) => ReturnType<ProjectService['state']>;
  state: ProjectService['state'];
  drawingService: Pick<ProjectService, 'snapshot' | 'transact'>;
  importAsset: ProjectService['importAsset'];
  reportDiagnostics: (diagnostics: Diagnostic[]) => void;
  thumbnail: (id: string, width?: number, height?: number) => Promise<Buffer>;
  proxies: ProxyManager;
  tracking: TrackingManager;
  releaseMedia: () => Promise<{ released: boolean; projectChanged: boolean }>;
  coreService: Pick<
    ProjectService,
    | 'snapshot'
    | 'pendingFiles'
    | 'diagnostics'
    | 'conflicts'
    | 'selection'
    | 'state'
    | 'exclusive'
    | 'reload'
    | 'validate'
    | 'transact'
    | 'save'
    | 'undo'
    | 'redo'
    | 'resolve'
  >;
  plugins: PluginRegistry;
  definitions: () => ToolDefinition[];
  registry: BuiltinPluginRegistry;
  applicationState: () => unknown;
  notifyState: () => void;
  applyCache: (params: unknown) => Promise<unknown>;
  frame: (params: any) => Promise<{ buffer: Buffer; revision: string; frame: number }>;
  candidateSnapshot: (params: { planId?: string; revision?: string }) => Promise<Snapshot>;
  withMediaTask: <T>(work: () => Promise<T>) => Promise<T>;
  edit: (
    snapshot: Snapshot,
    sceneId: string,
    frame: number,
    edits: CompositionDraft[],
  ) => Promise<Operation[]>;
}

export interface BuiltinPluginModule {
  id: string;
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  methods: ReadonlySet<string>;
  tools: () => ToolDefinition[];
  dispatch: (host: BuiltinPluginHost, method: string, params: any) => unknown;
}
