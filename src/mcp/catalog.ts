import { z } from 'zod';
import { builtinPlugins } from '../plugins/index.js';
import { toolCategories, type ToolCategory } from './discovery.js';
import { pluginInspectSchema, pluginPackageSchema, pluginPlanSchema } from '../service/plugins.js';
import { trackingAnalyzeSchema } from '../service/tracking-jobs.js';
import {
  trackingInspectSchema,
  trackingPlanSchema,
  trackingEvidenceSchema,
} from '../service/tracking.js';
import { mediaProxySchema, mediaRelinkSchema } from '../service/media-management.js';
import {
  cacheInspectSchema,
  cachePlanSchema,
  cacheApplySchema,
} from '../service/cache-management.js';
import { structureActionSchema } from '../core/structure.js';
import { drawingOperationSchema } from '../core/drawing-model.js';
import { contextOptionsSchema, fileReadSchema } from '../service/agent.js';
import { preflightSchema } from '../service/preflight.js';
import { visualAuditSchema } from '../service/visual-audit.js';
import { visualRepairSchema } from '../service/visual-repair.js';
import { precomposeSchema, scenePlaceSchema, sceneResetSchema } from '../service/shared-scenes.js';
import { contextFramesSchema } from '../core/content-time.js';
import { agentGuideSchema } from '../service/agent-guide.js';

export interface ToolDefinition {
  name: string;
  description: string;
  method: string;
  schema: Record<string, z.ZodTypeAny>;
  plugin?: { id: string; version: string; origin: 'builtin' | 'project'; hash?: string };
  categories?: ToolCategory[];
  keywords?: string;
  annotations?: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}
export function toolDefinitions(): ToolDefinition[] {
  const candidateInput = {
    ...Object.fromEntries(
      Object.entries(preflightSchema.omit({ inline: true }).shape).map(([name, schema]) => [
        name,
        schema instanceof z.ZodDefault ? schema.removeDefault().optional() : schema,
      ]),
    ),
    operations: z.array(z.record(z.unknown())).max(1000).optional(),
  };
  const tools: ToolDefinition[] = [
    ...builtinPlugins.tools,
    {
      name: 'plugins_inspect',
      description:
        'Inspect paged builtin/project plugins, versions, dependencies, contribution sources and namespaced tools. Full manifests are opt-in. Existing ordinary resource references survive library disable/removal.',
      method: 'pluginsInspect',
      schema: pluginInspectSchema.shape,
      categories: ['core', 'composition'],
      keywords: '插件 注册 依赖 版本 plugin module',
    },
    {
      name: 'plugins_plan',
      description:
        'Plan project-local plugin registration, enabling/disabling/removal, hash-checked source files and component placements in one exact candidate. Dependencies/API/duplicate IDs are checked; preflight loads typed tool exports and sampled native frames. No source is deleted on removal unless explicitly requested.',
      method: 'pluginsPlan',
      schema: pluginPlanSchema.shape,
      categories: ['core', 'composition', 'recovery'],
      keywords: '插件 安装 注册 创建 更新 禁用 移除 候选 plugin register dependency',
    },
    {
      name: 'plugins_package',
      description:
        'Read a paginated plugin package index with manifest/content hashes, dependencies and bounded file sizes. Source text is never duplicated by default; use project_file_read only for selected ranges.',
      method: 'pluginsPackage',
      schema: pluginPackageSchema.shape,
      categories: ['core'],
      keywords: '插件 包 指纹 hash 依赖 文件 package integrity bundle',
    },
    {
      name: 'media_relink_plan',
      method: 'mediaRelinkPlan',
      schema: mediaRelinkSchema.shape,
      description:
        'Relink image/video/audio assets to explicit existing files by reference while preserving stable IDs, scene/clip references and one atomic undo. Compatible policy checks registered dimensions/streams/duration; replace is explicit and rejects shorter existing timeline uses. Returns stored exact preflight/apply candidate with freshly probed metadata and new-file fingerprints; no files are moved or overwritten.',
    },
    {
      name: 'media_proxy',
      method: 'mediaProxy',
      schema: mediaProxySchema.shape,
      description:
        'Start/query/cancel bounded background proxy tasks or inspect cached readiness. Proxies are lossless FFV1, intra frames, project rational FPS, no audio, and source-fingerprint checked before atomic publication. Preview auto mode uses matching proxies and screen-sized decode; exports/native evidence use originals. Eight pending tasks and source/version limits are explicit.',
    },
    {
      name: 'cache_inspect',
      method: 'cacheInspect',
      schema: cacheInspectSchema.shape,
      description:
        'Inspect named regenerable project-cache groups with byte totals, leased/project-reference protection and optional file paging. Does not scan/delete source/assets/history/candidate plans/render checkpoints or loaded component bundles. Links are skipped and scan work is bounded.',
    },
    {
      name: 'cache_plan',
      method: 'cachePlan',
      schema: cachePlanSchema.shape,
      description:
        'Plan oldest eligible regenerable-cache files toward an explicit byte budget and minimum age without deleting. Fixed SHA-256 plan includes exact paths/size/mtime, excludes live leases and registered project media, and reports incomplete quotas. Stored candidates, source/history, render checkpoints and compiled modules stay protected.',
    },
    {
      name: 'cache_apply',
      method: 'cacheApply',
      schema: cacheApplySchema.shape,
      description:
        'Apply a reviewed fixed cache-cleanup plan. Rejects active media/render/proxy work, revalidates resolved paths against named cache roots and skips changed/leased/newly referenced targets. Clears inactive preview readers first; returns actual reclaimed bytes and omissions. Only regenerable caches are removed, with no source/history/candidate/checkpoint deletion.',
    },
    {
      name: 'visual_repair_plan',
      description:
        'Plan explicit batch layout repairs from inspected stable layer IDs: fit full text height using native layout, move in canvas/parent coordinates, or place inside a padded canvas. Preserves entire key trajectories by default; currentKey edits a pose. Resolves generated layer scopes automatically, keeps component source intact, audits before/after and returns an exact stored candidate for preflight/apply and one undo. Does not guess artistic fixes for overlap, clipping or motion.',
      method: 'visualRepairPlan',
      schema: visualRepairSchema.shape,
    },
    {
      name: 'agent_guide',
      description:
        'Concise workflow routing for external agents: overview, animation, editing, 3d, math or recovery. Tool names, units, evidence/commit steps and retry guidance; no source or large schemas dumped. Start here, then project_context.',
      method: 'agentGuide',
      schema: agentGuideSchema.shape,
    },
    {
      name: 'scene_reset_instance',
      description:
        'Remove this scene-reference instance internal property/structure overrides in one undo step, keeping source scene and outer reference placement. Generated references clear edits stored on their owning instance; source-provided defaults remain. Revision-checked and supports nested component/reference paths.',
      method: 'sceneReset',
      schema: sceneResetSchema.shape,
    },
    {
      name: 'scene_precompose',
      description:
        'Create a reusable JSON scene from selected adjacent sibling layers and descendants, replacing them with one editable reference at the original stacking slot. Native keyframes/hierarchies/masks are preserved; generated leaf content is captured at the chosen frame and source TypeScript stays intact. Instance edits use overrides, source-scene edits affect all references. One revision-checked undo step restores originals. allowReorder explicitly permits a selection that crosses unselected siblings.',
      method: 'scenePrecompose',
      schema: precomposeSchema.shape,
    },
    {
      name: 'scene_place',
      description:
        'Insert an existing scene as a scaled/positioned reusable reference into a scene/group/component. Returns selection; rejects declared cyclic references before saving. Enter the reference via composition_inspect and edit its instance overrides with ordinary composition/animation tools.',
      method: 'scenePlace',
      schema: scenePlaceSchema.shape,
    },
    {
      name: 'scene_references',
      description:
        'Inspect a source scene size/duration and all declared incoming/outgoing layer, structural, override and sequence-clip references before a shared edit or removal. Dynamic TypeScript-generated references require sampled graph inspection.',
      method: 'sceneReferences',
      schema: { sourceId: z.string() },
    },
    {
      name: 'tracking_analyze',
      description:
        'Run deterministic sparse point tracking on a video asset with original pixels, source-frame range, manual seeds/reseeds or automatic corners. Independent worker uses pyramidal Lucas–Kanade with photometric/forward-backward checks. Start returns a background job; poll status or cancel. Completed SHA analysisId is immutable; default replies omit trajectories. Lost points stay lost until explicit reseed. Does not modify project/history.',
      method: 'trackingAnalyze',
      schema: trackingAnalyzeSchema.shape,
    },
    {
      name: 'tracking_inspect',
      description:
        'Read a tracking analysisId or editable project tracking JSON. Paginated point/gap summaries and chosen source-frame positions; full matching evidence is opt-in. Report confidence as a heuristic. Read before binding or repairing samples.',
      method: 'trackingInspect',
      schema: trackingInspectSchema.shape,
    },
    {
      name: 'tracking_plan',
      description:
        'Plan editable tracking resource/manual sample edits and batch point/translation/similarity/affine attachment, video stabilization or four-point corner pin. Uses actual source video fit/clock and target parent/TRS. Generates ordinary matrix/effect keys, preserves TypeScript, protects existing channels, rejects loss by default; explicit hold reports held samples. Fingerprint-pinned short planId for unchanged preflight/apply and one undo. Smoothing/zoom are explicit; transparent borders remain possible.',
      method: 'trackingPlan',
      schema: trackingPlanSchema.shape,
    },
    {
      name: 'tracking_evidence',
      description:
        'Capture annotated original video frames with tracked/manual point crosses and confidence/loss counts, using recorded source FPS and pinned source fingerprint. Native PNG evidence contains no duplicated media Base64 in metadata.',
      method: 'trackingEvidence',
      schema: trackingEvidenceSchema.omit({ inline: true }).shape,
    },
    {
      name: 'visual_audit',
      description:
        'Inspect a scene/group/component across sampled frames for definite text truncation and review hints: text canvas overflow, clipping, overlap, opaque-rectangle coverage and fast/jumping motion. Returns stable IDs, owner paths, times, thresholds, limitations and annotated native frame evidence. Geometry hints require visual judgement and do not modify project/history.',
      method: 'visualAudit',
      schema: visualAuditSchema.omit({ inline: true }).shape,
    },
    {
      name: 'project_schema',
      description:
        'Read one authoritative JSON schema only when needed. Query operationType to get the schema of a specific semantic operation rather than the full operation catalog.',
      method: 'projectSchema',
      schema: {
        name: z.enum([
          'project',
          'scene',
          'sequence',
          'node',
          'operation',
          'drawing',
          'drawingOperation',
          'fileEdit',
          'scene3d',
          'mesh',
          'material3d',
          'effect',
          'motionTemplate',
          'effectGraph',
          'expressions',
          'layout',
          'motionPath',
          'pathText',
          'textAnimator',
          'shapeOperator',
          'tracking',
          'trackingSettings',
          'theme',
          'themeBinding',
          'sceneTemplate',
          'templateAuthor',
        ]),
        operationType: z.string().optional(),
      },
    },
    {
      name: 'project_context',
      description:
        'Start here for concise project metadata, revision, stable IDs, source-file hashes, diagnostics and selection. Paginate files/assets/layers; request a scene or sequence without reading all source code.',
      method: 'projectContext',
      schema: contextOptionsSchema.shape,
    },
    {
      name: 'project_file_read',
      description:
        'Read a bounded line range of a tracked project source file with its exact content hash and revision. Use version=pending to inspect invalid external edits; active returns the last usable source.',
      method: 'projectFileRead',
      schema: fileReadSchema.shape,
    },
    {
      name: 'project_preflight',
      description:
        'Check a candidate batch of semantic operations and hash-checked file edits without replacing active project files or undo history. Includes JSON/type/component checks and optional native sample frames; determinism repeats sampled frames. Returns diagnostics and a contact-sheet image for requested frames.',
      method: 'projectPreflight',
      schema: candidateInput,
    },
    {
      name: 'project_apply',
      description:
        'Validate and atomically commit candidate operations and hash-checked file edits with one undo step. Use revision plus expectedCandidateRevision from project_preflight to commit exactly the inspected candidate. File edits support replace/create, unique exact-text substitutions and delete. New JSON scene/sequence/drawing files must be referenced in the manifest.',
      method: 'projectApply',
      schema: { ...candidateInput, expectedCandidateRevision: z.string().optional() },
    },
    {
      name: 'project_inspect',
      description:
        'Read project files, scene nodes, sequence tracks, selection, diagnostics, conflicts and current revision.',
      method: 'state',
      schema: {},
    },
    {
      name: 'project_validate',
      description: 'Validate references, format and TypeScript component compilation.',
      method: 'validate',
      schema: {},
    },
    {
      name: 'project_transact',
      description:
        'Apply an atomic undoable batch. Supports native node/scene/track/clip operations, writeSource, editFiles, writeDrawing and removeDrawing. Use current revision for optimistic concurrency; project_apply also offers runtime preflight and compact results.',
      method: 'transact',
      schema: {
        operations: z.array(z.record(z.unknown())).min(1).max(1000),
        revision: z.string().optional(),
        save: z.boolean().optional(),
      },
    },
    {
      name: 'project_save',
      description: 'Save valid staged edits atomically.',
      method: 'save',
      schema: {},
    },
    {
      name: 'project_undo',
      description: 'Undo the last accepted transaction.',
      method: 'undo',
      schema: {},
    },
    {
      name: 'project_redo',
      description: 'Redo an undone transaction.',
      method: 'redo',
      schema: {},
    },
    {
      name: 'project_resolve_conflict',
      description: 'Resolve a conflict while preserving both versions until chosen.',
      method: 'resolve',
      schema: { index: z.number().int().nonnegative(), choice: z.enum(['ours', 'theirs']) },
    },
    {
      name: 'project_select',
      description: 'Set selected node IDs in the shared edit session.',
      method: 'selection',
      schema: { ids: z.array(z.string()) },
    },
    {
      name: 'composition_inspect',
      description:
        'Open an isolated scene/group/component/reference instance graph. path contains stable layer IDs at each navigation level, including scene reference layers. Reports local source coordinates, dimensions, breadcrumbs and edit targets. With path, frame is the isolated content clock; contextFrames pins ancestor clocks. Use frame/contentFrame/contextFrames from composition_interactions when entering or editing a retimed descendant.',
      method: 'compositionInspect',
      schema: {
        sceneId: z.string(),
        frame: z.number().nonnegative().default(0),
        path: z.array(z.string()).max(32).default([]),
        contextFrames: contextFramesSchema.default([]),
      },
    },
    {
      name: 'composition_edit_layer',
      description:
        'Edit a layer inside an isolated group/component/scene-reference instance. Native layers update their scene data; generated or referenced layers persist overrides on the owning instance, preserving shared source JSON/TypeScript and undo history.',
      method: 'compositionTransact',
      schema: {
        sceneId: z.string(),
        frame: z.number().nonnegative().default(0),
        path: z.array(z.string()).max(32).default([]),
        contextFrames: contextFramesSchema.default([]),
        nodeId: z.string(),
        patch: z.record(z.unknown()),
        revision: z.string().optional(),
      },
    },
    {
      name: 'composition_edit_layers',
      description:
        'Atomically edit multiple native or generated layers across groups in one scene. Preserves all component overrides and creates one undo step.',
      method: 'compositionTransactBatch',
      schema: {
        sceneId: z.string(),
        frame: z.number().nonnegative().default(0),
        revision: z.string().optional(),
        edits: z
          .array(
            z.object({
              path: z.array(z.string()).max(32).default([]),
              contextFrames: contextFramesSchema.default([]),
              nodeId: z.string(),
              frame: z.number().finite().nonnegative().optional(),
              patch: z.record(z.unknown()),
            }),
          )
          .min(1)
          .max(1000),
      },
    },
    {
      name: 'composition_structure',
      description:
        'Add, duplicate, delete, group, ungroup or reorder layers in a scene/group/component. Generated structure edits persist on the owning component without rewriting source. Grouping requires a shared parent. Ungrouping preserves appearance and rejects groups with applied transforms/effects.',
      method: 'compositionStructure',
      schema: {
        sceneId: z.string(),
        frame: z.number().nonnegative().default(0),
        path: z.array(z.string()).max(32).default([]),
        contextFrames: contextFramesSchema.default([]),
        action: structureActionSchema,
        revision: z.string().optional(),
      },
    },
    {
      name: 'composition_structure_batch',
      description:
        'Apply structural edits across multiple group/component scopes atomically with one undo step.',
      method: 'compositionStructureBatch',
      schema: {
        sceneId: z.string(),
        frame: z.number().nonnegative().default(0),
        revision: z.string().optional(),
        actions: z
          .array(
            z.object({
              path: z.array(z.string()).max(32).default([]),
              contextFrames: contextFramesSchema.default([]),
              action: structureActionSchema,
              frame: z.number().finite().nonnegative().optional(),
            }),
          )
          .min(1)
          .max(100),
      },
    },
    {
      name: 'composition_interactions',
      description:
        'Inspect actual current-frame geometry and parent transforms for native/generated layers, including group content bounds. Filter nodeIds to inspect selection or drag coordinates.',
      method: 'compositionInteractions',
      schema: {
        sceneId: z.string(),
        frame: z.number().nonnegative().default(0),
        path: z.array(z.string()).max(32).default([]),
        contextFrames: contextFramesSchema.default([]),
        nodeIds: z.array(z.string()).max(1000).optional(),
      },
    },
    {
      name: 'asset_thumbnail',
      description:
        'Get a visual thumbnail of an image, video or drawing asset, including legacy drawings. Returns an image for direct agent inspection.',
      method: 'assetThumbnail',
      schema: {
        assetId: z.string(),
        width: z.number().int().min(16).max(512).default(160),
        height: z.number().int().min(16).max(512).default(100),
        output: z.string().optional(),
      },
    },
    {
      name: 'drawing_list',
      description:
        'List independent drawing documents. Documents are separate from scene layers until published and placed.',
      method: 'drawingList',
      schema: {},
    },
    {
      name: 'drawing_get',
      description:
        'Read editable layers, brush strokes and document size for an independent drawing document.',
      method: 'drawingGet',
      schema: { id: z.string() },
    },
    {
      name: 'drawing_create',
      description:
        'Create a transparent layered drawing document without adding scene layers or publishing assets.',
      method: 'drawingCreate',
      schema: {
        id: z.string().optional(),
        name: z.string().optional(),
        width: z.number().int().min(16).max(8192).optional(),
        height: z.number().int().min(16).max(8192).optional(),
        revision: z.string().optional(),
      },
    },
    {
      name: 'drawing_edit',
      description:
        'Apply brush/eraser strokes, create/edit/delete/copy/order layers, or update document dimensions atomically. Uses the shared undo history and revision checks.',
      method: 'drawingEdit',
      schema: {
        id: z.string(),
        operations: z.array(drawingOperationSchema).min(1).max(1000),
        revision: z.string().optional(),
      },
    },
    {
      name: 'drawing_publish',
      description:
        'Publish the whole drawing or selected layers as an immutable visual asset. The source document remains editable.',
      method: 'drawingPublish',
      schema: {
        id: z.string(),
        layerIds: z.array(z.string()).optional(),
        name: z.string().optional(),
        revision: z.string().optional(),
      },
    },
    {
      name: 'drawing_open_asset',
      description: 'Create an editable drawing document from a published or legacy drawing asset.',
      method: 'drawingOpenAsset',
      schema: { assetId: z.string(), revision: z.string().optional() },
    },
    {
      name: 'drawing_frame',
      description: 'Get the native rendered image of a drawing document for visual checks.',
      method: 'drawingFrame',
      schema: {
        id: z.string(),
        width: z.number().int().min(16).max(2048).optional(),
        height: z.number().int().min(16).max(2048).optional(),
        output: z.string().optional(),
        inline: z.boolean().default(true),
      },
    },
    {
      name: 'asset_place',
      description:
        'Place a visual asset in a scene/group/component, or place visual/audio assets on sequence tracks. Shares the editor command and atomic undo history.',
      method: 'assetPlace',
      schema: {
        assetId: z.string(),
        sceneId: z.string().optional(),
        path: z.array(z.string()).max(32).optional(),
        contextFrames: contextFramesSchema.optional(),
        sequenceId: z.string().optional(),
        trackId: z.string().optional(),
        frame: z.number().nonnegative().optional(),
        duration: z.number().int().positive().optional(),
        x: z.number().finite().optional(),
        y: z.number().finite().optional(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        anchor: z.enum(['top-left', 'center']).optional(),
        revision: z.string().optional(),
      },
    },
    {
      name: 'animation_guide',
      description:
        'Read composable animation/effect helpers, frame/second units, examples and current limits before authoring TypeScript animation.',
      method: 'guide',
      schema: {},
    },
    {
      name: 'frame_sample',
      description:
        'Capture 1–12 pinned-revision animation frames as one labeled contact sheet. Use entrance, middle, transition and exit times to check motion, overlap and effect quality.',
      method: 'sample',
      schema: {
        frames: z.array(z.number().nonnegative()).min(1).max(12),
        sceneId: z.string().optional(),
        path: z.array(z.string()).max(32).optional(),
        contextFrames: contextFramesSchema.optional(),
        width: z.number().int().min(160).max(800).default(640),
        output: z.string().optional(),
      },
    },
    {
      name: 'frame_capture',
      description:
        'Render a deterministic frame using the same native core as export; returns an inline image.',
      method: 'frame',
      schema: {
        frame: z.number().nonnegative().default(0),
        width: z.number().int().min(16).max(3840).optional(),
        height: z.number().int().min(16).max(2160).optional(),
        sceneId: z.string().optional(),
        path: z.array(z.string()).max(32).optional(),
        contextFrames: contextFramesSchema.optional(),
        output: z.string().optional(),
      },
    },
    {
      name: 'effect_import_lut',
      description:
        'Parse a local 3D .cube LUT (size 2–33) and append it to a layer effect stack. LUT data is embedded in project JSON so renders remain pinned and portable.',
      method: 'importLut',
      schema: {
        sceneId: z.string(),
        nodeId: z.string(),
        path: z.string(),
        intensity: z.number().min(0).max(1).default(1),
        revision: z.string().optional(),
      },
    },
    {
      name: 'asset_import',
      description: 'Import a local asset by reference or copy.',
      method: 'import',
      schema: {
        path: z.string(),
        type: z.enum(['image', 'video', 'audio', 'font', 'drawing']),
        copy: z.boolean().default(false),
      },
    },
    {
      name: 'asset_probe',
      description: 'Inspect media streams and duration.',
      method: 'probe',
      schema: { assetId: z.string() },
    },
    {
      name: 'asset_proxy',
      description:
        'Legacy synchronous 960px lossless FFV1 proxy generation/reuse with registered source/FPS checks. For background progress/cancellation, use media_proxy. Proxy preview is explicit; native evidence and export keep originals.',
      method: 'proxy',
      schema: { assetId: z.string() },
    },
    {
      name: 'project_pack',
      description: 'Collect project source, assets and fonts into another directory.',
      method: 'pack',
      schema: { output: z.string() },
    },
  ];
  return tools.map((tool) => ({
    ...tool,
    plugin: tool.plugin ?? {
      id: 'vmotion.' + (tool.categories?.[0] ?? toolCategories(tool.name)[0] ?? 'core'),
      version: '1.0.0',
      origin: 'builtin',
    },
  }));
}
