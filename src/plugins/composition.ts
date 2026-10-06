import { z } from 'zod';
import { nodeSchema, VmotionError } from '../core/model.js';
import { contextFramesSchema } from '../core/content-time.js';
import { structureActionSchema } from '../core/structure.js';
import { compositionStructure } from '../service/structure.js';
import {
  precomposeSchema,
  scenePlaceSchema,
  sceneResetSchema,
  inspectSceneReferences,
  resetSceneInstance,
  precompose,
  placeScene,
} from '../service/shared-scenes.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import type { BuiltinPluginModule } from './types.js';
import { applyOperations } from '../service/operations.js';
import { builtinCandidate } from './candidate.js';
export const compositionPlugin: BuiltinPluginModule = {
  id: 'vmotion.composition',
  name: '合成、图层与场景实例',
  version: '1.0.0',
  dependencies: { 'vmotion.animation': '^1.0.0' },
  methods: new Set([
    'sceneReferences',
    'sceneReset',
    'scenePrecompose',
    'scenePlace',
    'compositionInspect',
    'compositionInteractions',
    'compositionTransact',
    'compositionTransactBatch',
    'compositionStructure',
    'compositionStructureBatch',
  ]),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'scene_references',
        description:
          'Inspect a source scene size/duration and all declared incoming/outgoing layer, structural, override and sequence-clip references before a shared edit or removal. Dynamic TypeScript-generated references require sampled graph inspection.',
        method: 'sceneReferences',
        schema: { sourceId: z.string() },
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
          'Edit stable native/generated layers across nested scopes in one history step. mode=plan returns an exact stored candidate for shared preflight/apply without saving; default mode=apply retains direct editing. Preserves source, ancestor clocks and revision checks. Camera/material/layout edits use the same overrides.',
        method: 'compositionTransactBatch',
        schema: {
          mode: z.enum(['apply', 'plan']).default('apply'),
          delivery: z.enum(['stored', 'inline']).default('stored'),
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
    ];
  },
  async dispatch(host, method, params) {
    const snapshot = host.snapshot;
    switch (method) {
      case 'sceneReferences':
        return inspectSceneReferences(snapshot, params.sourceId);
      case 'sceneReset': {
        const reset = await resetSceneInstance(host.renderer, snapshot, params);
        return host.transact([reset.operation], reset.request.revision ?? snapshot.revision);
      }
      case 'scenePrecompose': {
        const created = await precompose(host.root, host.renderer, snapshot, params);
        await host.transact(created.operations, created.request.revision ?? snapshot.revision);
        return {
          ...host.select(created.selection),
          sharedScene: {
            sourceId: created.sourceId,
            sourceFile: created.sourceFile,
            captureMode: created.captureMode,
            reordered: created.reordered,
            warnings: created.warnings,
          },
        };
      }
      case 'scenePlace': {
        const edit = await placeScene(host.renderer, snapshot, params);
        await host.transact(edit.operations, edit.request.revision ?? snapshot.revision);
        return host.select(edit.selection);
      }
      case 'compositionInspect':
        return host.renderer.inspectComposition(
          snapshot,
          params.sceneId,
          params.frame ?? 0,
          params.path ?? [],
          params.contextFrames ?? [],
        );
      case 'compositionInteractions': {
        const graph = await host.renderer.inspectInteractions(
          snapshot,
          params.sceneId,
          params.frame ?? 0,
          params.path ?? [],
          { contextFrames: params.contextFrames ?? [] },
        );
        return params.nodeIds
          ? {
              ...graph,
              layers: graph.layers.filter((layer) => params.nodeIds.includes(layer.node.id)),
            }
          : graph;
      }
      case 'compositionTransact':
        return host.transact(
          await host.edit(snapshot, params.sceneId, params.frame ?? 0, [
            {
              path: params.path ?? [],
              contextFrames: params.contextFrames ?? [],
              nodeId: params.nodeId,
              patch: params.patch,
            },
          ]),
          params.revision ?? snapshot.revision,
        );
      case 'compositionTransactBatch': {
        if (params.delivery !== undefined && !['stored', 'inline'].includes(params.delivery))
          throw new VmotionError('TOOL_ARGUMENTS', 'Unknown candidate delivery');
        if (params.mode !== undefined && !['apply', 'plan'].includes(params.mode))
          throw new VmotionError('TOOL_ARGUMENTS', 'Unknown composition edit mode');
        if (params.revision && params.revision !== snapshot.revision)
          throw new VmotionError('REVISION_CONFLICT', 'Project changed before composition editing');
        const operations = await host.edit(
          snapshot,
          params.sceneId,
          params.frame ?? 0,
          params.edits,
        );
        if (params.mode !== 'plan')
          return host.transact(operations, params.revision ?? snapshot.revision);
        const candidate = applyOperations(host.root, snapshot, operations),
          samples = params.edits.slice(0, 12).map((e: any) => ({
            sceneId: params.sceneId,
            path: e.path ?? [],
            contextFrames: e.contextFrames ?? [],
            frame: e.frame ?? params.frame ?? 0,
          }));
        return builtinCandidate(
          host.root,
          { revision: snapshot.revision, operations, samples, width: 320, determinism: true },
          candidate.revision,
          params.delivery ?? 'stored',
          {
            selection: params.edits.map((e: any) => e.nodeId),
            edited: params.edits.length,
            coverage: {
              sampled: samples.length,
              omitted: Math.max(0, params.edits.length - samples.length),
            },
          },
        );
      }
      case 'compositionStructure': {
        const edit = await compositionStructure(
          host.renderer,
          snapshot,
          params.sceneId,
          params.frame ?? 0,
          params.path ?? [],
          params.action,
          params.contextFrames ?? [],
        );
        await host.transact(edit.operations, params.revision ?? snapshot.revision);
        return host.select(edit.selection);
      }
      case 'compositionStructureBatch': {
        if (!Array.isArray(params.actions) || !params.actions.length || params.actions.length > 100)
          throw new VmotionError('OPERATIONS', 'Expected 1–100 structure actions');
        const base = structuredClone(snapshot),
          scene = base.scenes.find((s) => s.id === params.sceneId);
        if (!scene) throw new VmotionError('NOT_FOUND', 'Scene not found');
        const selection: string[] = [];
        for (const action of params.actions) {
          const edit = await compositionStructure(
            host.renderer,
            base,
            params.sceneId,
            action.frame ?? params.frame ?? 0,
            action.path ?? [],
            action.action,
            action.contextFrames ?? params.contextFrames ?? [],
          );
          for (const op of edit.operations) {
            if (op.type === 'updateScene') scene.nodes = op.patch.nodes!;
            else if (op.type === 'updateNode') {
              const index = scene.nodes.findIndex((n) => n.id === op.nodeId);
              scene.nodes[index] = nodeSchema.parse({ ...scene.nodes[index], ...op.patch });
            }
          }
          selection.push(...edit.selection);
        }
        await host.transact(
          [{ type: 'updateScene', sceneId: scene.id, patch: { nodes: scene.nodes } }],
          params.revision ?? base.revision,
        );
        return host.select([...new Set(selection)]);
      }
      default:
        throw new VmotionError(
          'METHOD_NOT_FOUND',
          'Composition module does not handle this method',
          { method },
        );
    }
  },
};
