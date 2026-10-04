import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { VmotionError } from '../core/model.js';
import type { ToolDefinition } from './catalog.js';

export const categorySchema = z.enum([
  'core',
  'animation',
  'effects',
  'composition',
  'vector',
  'drawing',
  'media',
  'editing',
  'audio',
  '3d',
  'math',
  'render',
  'recovery',
]);
export type ToolCategory = z.infer<typeof categorySchema>;
export const coreTools = new Set([
  'agent_guide',
  'project_context',
  'project_file_read',
  'project_preflight',
  'project_apply',
  'frame_capture',
]);
const memberships: Record<ToolCategory, string[]> = {
  effects: [
    'particles_inspect',
    'particles_plan',
    'visual_repair_plan',
    'effects_guide',
    'effects_inspect',
    'effects_plan',
    'animation_inspect',
    'animation_edit',
    'frame_capture',
    'frame_sample',
    'visual_audit',
    'effect_import_lut',
  ],
  core: [
    'agent_guide',
    'project_context',
    'project_file_read',
    'project_schema',
    'project_preflight',
    'project_apply',
    'project_inspect',
    'project_validate',
    'project_transact',
    'project_save',
    'project_select',
  ],
  animation: [
    'particles_inspect',
    'particles_plan',
    'motion_templates',
    'motion_plan',
    'visual_repair_plan',
    'effects_guide',
    'effects_inspect',
    'effects_plan',
    'animation_guide',
    'animation_inspect',
    'animation_edit',
    'component_describe',
    'component_parameters',
    'component_parameters_edit',
    'time_inspect',
    'time_edit',
    'repeat_describe',
    'repeat_create',
    'frame_capture',
    'frame_sample',
    'visual_audit',
  ],
  composition: [
    'motion_templates',
    'motion_plan',
    'visual_repair_plan',
    'composition_inspect',
    'composition_interactions',
    'composition_edit_layer',
    'composition_edit_layers',
    'composition_structure',
    'composition_structure_batch',
    'scene_precompose',
    'scene_place',
    'scene_references',
    'scene_reset_instance',
  ],
  vector: ['path_geometry', 'vector_bake', 'repeat_describe', 'repeat_create', 'effect_import_lut'],
  drawing: [
    'drawing_list',
    'drawing_get',
    'drawing_create',
    'drawing_edit',
    'drawing_publish',
    'drawing_open_asset',
    'drawing_frame',
    'asset_place',
  ],
  media: [
    'asset_import',
    'asset_probe',
    'asset_thumbnail',
    'asset_proxy',
    'asset_place',
    'media_inspect',
    'media_sample',
    'project_pack',
  ],
  editing: [
    'sequence_plan',
    'sequence_edit',
    'captions_import',
    'captions_inspect',
    'media_inspect',
    'media_sample',
    'asset_place',
    'time_inspect',
    'time_edit',
  ],
  audio: [
    'audio_timeline',
    'audio_preview',
    'audio_waveform',
    'audio_analyze',
    'asset_import',
    'sequence_edit',
  ],
  '3d': [
    'matrix3d',
    'scene3d_render',
    'mesh_generate',
    'mesh_import',
    'mesh_inspect',
    'scene3d_materials',
    'frame_capture',
    'frame_sample',
    'visual_audit',
  ],
  math: ['linear_algebra', 'matrix3d', 'animation_guide'],
  render: [
    'render_start',
    'render_list',
    'render_status',
    'render_cancel',
    'frame_capture',
    'frame_sample',
    'project_pack',
  ],
  recovery: [
    'project_undo',
    'project_redo',
    'project_resolve_conflict',
    'project_context',
    'project_file_read',
    'project_preflight',
    'project_apply',
    'project_validate',
  ],
};
const readOnly = new Set([
  'particles_inspect',
  'particles_plan',
  'motion_templates',
  'motion_plan',
  'visual_repair_plan',
  'effects_guide',
  'effects_inspect',
  'effects_plan',
  'agent_guide',
  'project_context',
  'project_file_read',
  'project_schema',
  'project_preflight',
  'project_inspect',
  'project_validate',
  'animation_guide',
  'animation_inspect',
  'component_describe',
  'component_parameters',
  'time_inspect',
  'repeat_describe',
  'frame_capture',
  'frame_sample',
  'visual_audit',
  'composition_inspect',
  'composition_interactions',
  'scene_references',
  'path_geometry',
  'drawing_list',
  'drawing_get',
  'drawing_frame',
  'asset_probe',
  'asset_thumbnail',
  'media_inspect',
  'media_sample',
  'sequence_plan',
  'captions_inspect',
  'audio_timeline',
  'audio_preview',
  'audio_waveform',
  'audio_analyze',
  'matrix3d',
  'scene3d_render',
  'linear_algebra',
  'render_list',
  'render_status',
  'mesh_generate',
  'mesh_import',
  'mesh_inspect',
  'scene3d_materials',
]);
const destructive = new Set([
  'project_apply',
  'project_transact',
  'project_resolve_conflict',
  'composition_structure',
  'composition_structure_batch',
  'composition_edit_layer',
  'composition_edit_layers',
  'animation_edit',
  'component_parameters_edit',
  'sequence_edit',
  'drawing_edit',
  'scene_reset_instance',
]);
const aliases: Record<ToolCategory, string> = {
  effects: '特效 平面 扭曲 波形 旋转膨胀 色散 RGB 转场 擦除 effect warp wipe transition',
  core: '工程 源码 版本 参数 schema transaction file project',
  animation: '动画 关键帧 曲线 时间 动效 animation keyframe time effect',
  composition: '场景 合成 图层 编组 复制 composition layer group scene',
  vector: '矢量 路径 布尔 裁切 重复器 vector path boolean repeater',
  drawing: '绘画 笔迹 图层 画稿 drawing paint brush stroke',
  media: '素材 图片 视频 导入 媒体 asset media video image import',
  editing: '剪辑 时间轴 片段 字幕 二创 电影 timeline clip caption subtitle remix film',
  audio: '音频 音乐 声音 节拍 波形 audio sound music beat waveform',
  '3d': '三维 矩阵 相机 顶点 深度 网格 光照 3d matrix camera mesh depth lighting',
  math: '数学 线性代数 优化 求解 least squares algebra solve',
  render: '导出 渲染 帧 图像序列 编码 render export frame',
  recovery: '撤销 重做 恢复 错误 冲突 修复 undo redo conflict repair recovery',
};
const keywords: Record<string, string> = {
  particles_inspect: '粒子 发射器 物理 重力 阻力 爆发 轨迹 速度 检查',
  particles_plan: '粒子 发射器 创建 计划 爆发 火花 烟花 光点 拖尾',
  motion_templates: '动作 动画 模板 参数 复用 入场 退场 呼吸 弹性',
  motion_plan: '动画 动作 组合 编排 跨场景 批量 参数 模板 关键帧',
  visual_repair_plan: '画面 修复 计划 文字 高度 排版 定位 批量 移动 越界 轨迹',
  effects_guide: '特效 接口 字段 说明 扭曲 转场',
  effects_inspect: '特效 查询 检查 堆栈 关键帧',
  effects_plan: '平面 特效 计划 批量 修改 复制 排序 转场 扭曲',
  scene3d_render: '三维 深度 遮挡 像素 网格 抗锯齿 对象图 深度图',
  mesh_generate: '三维 网格 生成 球体 圆柱 圆锥 圆环 模型 形体',
  mesh_import: '三维 模型 导入 OBJ 网格 分组 凹多边形',
  mesh_inspect: '三维 网格 检查 边界 体积 面 拓扑',
  matrix3d: '三维 矩阵 顶点 相机 透视 正交 投影 网格',
  linear_algebra: '数学 线性代数 矩阵 求解 优化 最小二乘 拟合',
  frame_capture: '截图 单帧 画面',
  frame_sample: '多帧 画面 动画 采样 接触表',
  visual_audit: '检查 诊断 文字 截断 重叠 遮挡 突跳',
  media_sample: '素材 视频 图片 采样 取证 源画面',
  media_inspect: '素材 元数据 时长 尺寸 音轨',
  sequence_plan: '剪辑 片段 来源 范围 计划 插入 覆盖 拼接 电影 二创',
  sequence_edit: '剪辑 分割 裁切 滑移 移动 波纹 链接 节拍 标记',
  captions_import: '字幕 歌词 导入 时间',
  captions_inspect: '字幕 歌词 文本',
  audio_preview: '声音 音频 试听 混音 电平',
  audio_waveform: '音频 声音 波形',
  animation_edit: '动画 关键帧 复制 移动 曲线 缓动',
  animation_inspect: '动画 关键帧 通道 速度',
  time_edit: '时间 倒放 冻结 重映射 变速 循环',
  time_inspect: '时间 时钟 倒放 重映射',
  project_context: '工程 摘要 文件 hash 版本 选区',
  project_file_read: '源码 文件 阅读 hash',
  project_schema: '格式 定义 schema',
  project_apply: '提交 原子 保存 修改',
  project_preflight: '预检 代码 类型 画面 候选',
  project_undo: '撤销 恢复',
  project_redo: '重做',
  render_start: '导出 渲染 视频 编码',
  render_cancel: '取消 渲染',
  render_status: '进度 渲染 状态',
  drawing_create: '绘画 创建 画稿',
  drawing_edit: '绘画 笔迹 笔刷 图层',
  drawing_publish: '画稿 发布 素材',
  composition_structure: '图层 编组 复制 删除 排序',
  scene_precompose: '场景 预合成 编组 复用',
  scene_place: '场景 引用 复用',
};
export function toolCategories(name: string): ToolCategory[] {
  return (Object.keys(memberships) as ToolCategory[]).filter((category) =>
    memberships[category].includes(name),
  );
}
export function toolAnnotations(name: string) {
  return {
    readOnlyHint: readOnly.has(name),
    destructiveHint: !readOnly.has(name) && destructive.has(name),
    idempotentHint: readOnly.has(name) && name !== 'project_inspect',
    openWorldHint: false,
  };
}
export const toolSearchSchema = z
  .object({
    query: z.string().max(200).default(''),
    category: categorySchema.optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(50).default(12),
  })
  .strict();
export function searchTools(
  definitions: ToolDefinition[],
  raw: unknown = {},
  enabled?: Set<string>,
) {
  const request = toolSearchSchema.parse(raw),
    query = request.query.toLowerCase().trim(),
    terms = query.split(/\s+/).filter(Boolean),
    ranked = definitions
      .map((tool) => {
        const categories = toolCategories(tool.name),
          name = tool.name.toLowerCase(),
          own = (name + ' ' + tool.description + ' ' + (keywords[tool.name] ?? '')).toLowerCase(),
          text = (own + ' ' + categories.map((c) => aliases[c]).join(' ')).toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (!text.includes(term)) return { tool, categories, score: -1 };
          score += name === term ? 100 : name.includes(term) ? 60 : own.includes(term) ? 30 : 1;
        }
        return { tool, categories, score };
      })
      .filter(
        (item) =>
          item.score >= 0 && (!request.category || item.categories.includes(request.category)),
      )
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name, 'en')),
    items = ranked
      .slice(request.offset, request.offset + request.limit)
      .map(({ tool, categories }) => ({
        name: tool.name,
        summary: tool.description.split(/\.\s/)[0],
        categories,
        annotations: toolAnnotations(tool.name),
        ...(enabled ? { enabled: enabled.has(tool.name) } : {}),
        arguments: Object.keys(tool.schema),
      }));
  return {
    query: request.query,
    category: request.category,
    total: ranked.length,
    offset: request.offset,
    items,
    truncated: request.offset + request.limit < ranked.length,
    nextOffset:
      request.offset + request.limit < ranked.length ? request.offset + request.limit : undefined,
    categories: (Object.keys(memberships) as ToolCategory[]).map((category) => ({
      category,
      count: definitions.filter((t) => toolCategories(t.name).includes(category)).length,
    })),
    next: 'Read tool_schema for a selected name. Use tool_call without loading more definitions, or tools_load to enable named/category tools in this MCP connection.',
  };
}
export function findTool(definitions: ToolDefinition[], name: string) {
  const tool = definitions.find((t) => t.name === name);
  if (!tool)
    throw new VmotionError('TOOL_NOT_FOUND', `Unknown Vmotion tool ${name}; use tools_search`);
  return tool;
}
export function toolSchema(definitions: ToolDefinition[], name: string) {
  const tool = findTool(definitions, name);
  return {
    name,
    description: tool.description,
    categories: toolCategories(name),
    annotations: toolAnnotations(name),
    inputSchema: zodToJsonSchema(z.object(tool.schema).strict(), { $refStrategy: 'none' }),
    call: { tool: 'tool_call', arguments: { name, arguments: {} } },
    response:
      'Compact state for edits, structured results and native media for inspection. response=full preserves the legacy snapshot result.',
  };
}
export const toolLoadSchema = z
  .object({
    names: z.array(z.string()).max(1000).default([]),
    categories: z.array(categorySchema).max(32).default([]),
    mode: z.enum(['add', 'replace']).default('add'),
  })
  .strict();
export function selectTools(definitions: ToolDefinition[], raw: unknown, current: Set<string>) {
  const request = toolLoadSchema.parse(raw);
  request.names.forEach((name) => findTool(definitions, name));
  const selected = request.mode === 'add' ? new Set(current) : new Set(coreTools);
  for (const tool of definitions)
    if (
      request.names.includes(tool.name) ||
      toolCategories(tool.name).some((c) => request.categories.includes(c))
    )
      selected.add(tool.name);
  coreTools.forEach((name) => selected.add(name));
  return selected;
}
