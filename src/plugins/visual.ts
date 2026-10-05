import {
  effectGuideSchema,
  effectsInspectSchema,
  effectGuide,
  inspectEffects,
} from '../service/effects2d.js';
import { effectGraphInspectSchema, inspectEffectGraph } from '../service/effect-graphs.js';
import { visualTemplatesSchema, visualTemplates } from '../service/visual-library.js';
import { motionTemplatesSchema, motionTemplates } from '../service/motion-plan.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import type { Renderer } from '../core/renderer.js';
import type { Snapshot } from '../core/model.js';

export const visualPlugin = {
  id: 'vmotion.effects',
  name: '视觉特效与动作模板',
  version: '1.0.0',
  methods: new Set([
    'effectsGuide',
    'effectsInspect',
    'effectGraphInspect',
    'visualTemplates',
    'motionTemplates',
  ]),
  tools(): ToolDefinition[] {
    return [
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
  dispatch(host: { renderer: Renderer; snapshot: Snapshot }, method: string, params: unknown) {
    if (method === 'effectsGuide') return effectGuide(params);
    if (method === 'effectsInspect') return inspectEffects(host.renderer, host.snapshot, params);
    if (method === 'effectGraphInspect')
      return inspectEffectGraph(host.renderer, host.snapshot, params);
    if (method === 'visualTemplates') return visualTemplates(params);
    return motionTemplates(host.snapshot, params);
  },
};
