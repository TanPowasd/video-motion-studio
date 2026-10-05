import { z } from 'zod';
import { builtinPlugins } from '../plugins/index.js';
import { toolCategories, type ToolCategory } from './discovery.js';
import { pluginInspectSchema, pluginPackageSchema, pluginPlanSchema } from '../service/plugins.js';
import {
  cacheInspectSchema,
  cachePlanSchema,
  cacheApplySchema,
} from '../service/cache-management.js';
import { contextOptionsSchema, fileReadSchema } from '../service/agent.js';
import { preflightSchema } from '../service/preflight.js';
import { visualAuditSchema } from '../service/visual-audit.js';
import { visualRepairSchema } from '../service/visual-repair.js';
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
