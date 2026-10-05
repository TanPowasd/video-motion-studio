import type { Snapshot, Operation, Diagnostic } from '../core/model.js';
import type { Renderer } from '../core/renderer.js';
import type { CompositionDraft } from '../core/interaction.js';
import type { AudioPreview } from '../media/audio-preview.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import type { RenderManager } from '../media/export.js';
import type { ProjectService } from '../service/service.js';

/** Services owned by the application; builtin modules neither own nor close them. */
export interface BuiltinPluginHost {
  root: string;
  renderer: Renderer;
  snapshot: Snapshot;
  audioPreview: AudioPreview;
  renders: RenderManager;
  exportState: () => { pendingFiles: boolean; diagnostics: Diagnostic[] };
  transact: ProjectService['transact'];
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
