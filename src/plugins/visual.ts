import {
  effectGuideSchema,
  effectsInspectSchema,
  effectGuide,
  inspectEffects,
  effectsPlanSchema,
  planEffects,
} from '../service/effects2d.js';
import {
  effectGraphInspectSchema,
  inspectEffectGraph,
  effectGraphPlanSchema,
  planEffectGraph,
} from '../service/effect-graphs.js';
import {
  visualTemplatesSchema,
  visualTemplates,
  visualPlanSchema,
  planVisual,
} from '../service/visual-library.js';
import {
  motionTemplatesSchema,
  motionTemplates,
  motionPlanSchema,
  planMotion,
} from '../service/motion-plan.js';
import {
  particlesInspectSchema,
  particlesPlanSchema,
  inspectParticles,
  planParticles,
} from '../service/particle-field.js';
import { transitionPlanSchema, planTransitions } from '../service/transitions.js';
import { applyOperations } from '../service/operations.js';
import { VmotionError } from '../core/model.js';
import { builtinCandidate } from './candidate.js';
import type { BuiltinPluginModule } from './types.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseCube } from '../sdk/post.js';
import type { ToolDefinition } from '../mcp/catalog.js';

export const visualPlugin: BuiltinPluginModule = {
  id: 'vmotion.effects',
  name: '视觉特效与动作模板',
  version: '1.0.0',
  dependencies: { 'vmotion.design': '^1.0.0' },
  methods: new Set([
    'effectsGuide',
    'effectsInspect',
    'effectGraphInspect',
    'visualTemplates',
    'motionTemplates',
    'effectsPlan',
    'effectGraphPlan',
    'visualPlan',
    'motionPlan',
    'particlesInspect',
    'particlesPlan',
    'transitionPlan',
    'importLut',
  ]),
  tools(): ToolDefinition[] {
    return [
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
        name: 'effects_plan',
        description:
          'Plan an atomic multi-layer effect edit: append/update/copy/move/toggle/remove/clear and numeric keys, with stable effect IDs and automatic animation-index remapping. Fits new spatial effects to current content bounds by default. Generated layers persist overrides; source code stays editable. Returns compact stored planId; preflight images and apply unchanged for one undo.',
        method: 'effectsPlan',
        schema: effectsPlanSchema.shape,
      },
      {
        name: 'effect_graph_plan',
        description:
          'Plan graph resources and multi-scene scoped attachments/updates as one exact candidate. Full JSON or stable-node-ID add/update/replace/remove/output/links/parameters actions support short edits, branch/mix/mask/transform/noise/displacement and nested reusable subgraphs. Hash-check resource edits; bind sibling input layers, materialize numeric parameter keys, preserve generated source. Explicit resetParams/resetKeys handles graph upgrades; native preflight/apply shares one undo and reports coverage.',
        method: 'effectGraphPlan',
        schema: effectGraphPlanSchema.shape,
      },
      {
        name: 'visual_plan',
        method: 'visualPlan',
        schema: visualPlanSchema.shape,
        description:
          'Apply a selected visual template to multi-scene/scoped layers in one stored graph candidate, with parameter animation and optional same-parent map input bindings. Existing edited shared resources are retained; new template graphs are materialized under components/effects. Use native preflight/pictures and render_profile bounded/full field evidence, then unchanged apply for one undo.',
      },
      {
        name: 'motion_plan',
        description:
          'Compose parameterized animation cues (builtin, inline or shared JSON) across multiple scenes/layer scopes in one exact candidate. Supports frame/second clocks, per-target offsets and cue bindings, relative static/evaluated poses, explicit existing-channel collision policies, and atomic template saving. Generated edits persist overrides, source code stays editable. Returns stored preflight/apply plan, channel/timing evidence and sampling coverage; one shared undo.',
        method: 'motionPlan',
        schema: motionPlanSchema.shape,
      },
      {
        name: 'particles_inspect',
        description:
          'Evaluate a seeded analytical particle field at an arbitrary time without creating project files. Returns bounded birth-ID records, age/position/velocity/color, conservative local bounds and explicit scan/live truncation. Supports burst/continuous, point/box/disk/line emission, gravity, drag, fade, size/tint/spin and circle/square/streak sprites.',
        method: 'particlesInspect',
        schema: particlesInspectSchema.shape,
      },
      {
        name: 'particles_plan',
        description:
          'Plan an editable parameterized TypeScript particle component in a scene/group/generated scope, optionally with whole-emitter effects. Code/time evaluation is pure; renderer temporal sampling re-evaluates births. Returns exact stored candidate for native preflight/apply and one undo; all controls remain available through component_parameters.',
        method: 'particlesPlan',
        schema: particlesPlanSchema.shape,
      },
      {
        name: 'transition_plan',
        method: 'transitionPlan',
        schema: transitionPlanSchema.shape,
        description:
          'Create reusable parameterized transition compositions between existing scenes as one exact batch candidate, optionally place clips at explicit timeline frames. Crossfade, slide/push, wipe, iris, zoom, dip and cut share source dimensions/content clocks and declare scene dependencies. Isolated additive compositing preserves transparent crossfade endpoints. Source scenes are preserved; native preflight/apply shares one undo.',
      },
      {
        name: 'effects_guide',
        description:
          'Read concise 2D effect types/fields, units, coordinate spaces and composition workflow. Query individual types with schema=true for exact interfaces.',
        method: 'effectsGuide',
        schema: effectGuideSchema.shape,
        plugin: { id: 'vmotion.effects', version: '1.0.0', origin: 'builtin' as const },
        categories: ['effects'],
        keywords: '特效 平面 扭曲 转场 参数',
      },
      {
        name: 'effects_inspect',
        description:
          'Inspect explicit effect stack IDs/indices, values, enabled flags, numeric channels and current-frame evaluation for selected layers.',
        method: 'effectsInspect',
        schema: effectsInspectSchema.shape,
        plugin: { id: 'vmotion.effects', version: '1.0.0', origin: 'builtin' as const },
        categories: ['effects'],
        keywords: '特效 堆栈 检查 数值 关键帧',
      },
      {
        name: 'effect_graph_inspect',
        description:
          'Inspect a reusable effect graph resource or attached graph with parameters, inputs, topology, resource hashes and bounded surface evidence.',
        method: 'effectGraphInspect',
        schema: effectGraphInspectSchema.shape,
        plugin: { id: 'vmotion.effects', version: '1.0.0', origin: 'builtin' as const },
        categories: ['effects'],
        keywords: '特效 节点 图 拓扑 参数 输入',
      },
      {
        name: 'visual_templates',
        description:
          'Discover procedural texture/light/color/displacement graph presets with short summaries; full graph JSON is opt-in per selected preset.',
        method: 'visualTemplates',
        schema: visualTemplatesSchema.shape,
        plugin: { id: 'vmotion.effects', version: '1.0.0', origin: 'builtin' as const },
        categories: ['effects'],
        keywords: '视觉 纹理 光效 辉光 置换 模板',
      },
      {
        name: 'motion_templates',
        description:
          'List builtin and project JSON motion templates with parameter descriptors, compatible channels and optional normalized key data.',
        method: 'motionTemplates',
        schema: motionTemplatesSchema.shape,
        plugin: { id: 'vmotion.effects', version: '1.0.0', origin: 'builtin' as const },
        categories: ['animation', 'effects'],
        keywords: '动作 动画 模板 入场 退场 复用',
      },
    ];
  },
  async dispatch(host, method, params) {
    if (method === 'importLut') {
      const scene = host.snapshot.scenes.find((s) => s.id === params.sceneId),
        node = scene?.nodes.find((n) => n.id === params.nodeId);
      if (!node) throw new VmotionError('NOT_FOUND', 'Target layer not found');
      const source = await readFile(path.resolve(params.path), 'utf8');
      if (source.length > 8 * 1024 * 1024)
        throw new VmotionError('LUT_SIZE', 'LUT file is too large');
      const effect = parseCube(source, params.intensity ?? 1);
      return host.transact(
        [
          {
            type: 'updateNode',
            sceneId: scene!.id,
            nodeId: node.id,
            patch: { effects: [...node.effects, effect] },
          },
        ],
        params.revision,
      );
    }
    if (method === 'effectsGuide') return effectGuide(params);
    if (method === 'effectsInspect') return inspectEffects(host.renderer, host.snapshot, params);
    if (method === 'effectGraphInspect')
      return inspectEffectGraph(host.renderer, host.snapshot, params);
    if (method === 'visualTemplates') return visualTemplates(params);
    if (method === 'motionTemplates') return motionTemplates(host.snapshot, params);
    if (method === 'particlesInspect') return inspectParticles(params);
    if (method === 'particlesPlan')
      return planParticles(host.root, host.renderer, structuredClone(host.snapshot), params);
    if (method === 'transitionPlan')
      return planTransitions(host.root, structuredClone(host.snapshot), params);
    if (method === 'effectsPlan') {
      const snapshot = host.snapshot,
        planned = await planEffects(host.renderer, snapshot, params),
        p = planned.request,
        operations = await host.edit(snapshot, p.sceneId, p.frame, planned.edits),
        candidate = applyOperations(host.root, snapshot, operations),
        input = {
          revision: snapshot.revision,
          operations,
          samples: planned.samples,
          width: 320,
          determinism: true,
        };
      return builtinCandidate(host.root, input, candidate.revision, p.delivery, {
        layers: planned.layers,
      });
    }
    if (method === 'visualPlan' || method === 'effectGraphPlan') {
      const snapshot = structuredClone(host.snapshot),
        planned = await (method === 'visualPlan' ? planVisual : planEffectGraph)(
          host.root,
          host.renderer,
          snapshot,
          params,
          host.edit,
        ),
        input = {
          revision: snapshot.revision,
          operations: planned.operations,
          samples: planned.samples,
          width: 320,
          visual: true,
          determinism: true,
        };
      return builtinCandidate(
        host.root,
        input,
        planned.candidate.revision,
        planned.request.delivery,
        {
          source: planned.source,
          layers: planned.layers,
          coverage: planned.coverage,
          summary: planned.summary,
        },
      );
    }
    if (method === 'motionPlan') {
      const snapshot = structuredClone(host.snapshot),
        planned = await planMotion(host.root, host.renderer, snapshot, params, host.edit),
        input = {
          revision: snapshot.revision,
          operations: planned.operations,
          samples: planned.samples,
          visual: true,
          determinism: true,
          width: 320,
        };
      return builtinCandidate(
        host.root,
        input,
        planned.candidate.revision,
        planned.request.delivery,
        {
          layers: planned.layers,
          sources: planned.sources,
          savedTemplates: planned.savedTemplates,
          coverage: planned.coverage,
        },
      );
    }
    throw new VmotionError('METHOD_NOT_FOUND', 'Visual module does not handle this method', {
      method,
    });
  },
};
