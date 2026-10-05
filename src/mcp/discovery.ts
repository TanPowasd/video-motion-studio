import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { VmotionError } from '../core/model.js';
import type { ToolDefinition } from './catalog.js';
import { createHash } from 'node:crypto';

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
    'effect_graph_query',
    'theme_inspect',
    'theme_plan',
    'template_inspect',
    'template_plan',
    'visual_templates',
    'visual_plan',
    'transition_plan',
    'render_profile',
    'effect_graph_inspect',
    'effect_graph_plan',
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
    'plugins_inspect',
    'plugins_plan',
    'plugins_package',
    'theme_inspect',
    'theme_plan',
    'template_inspect',
    'template_plan',
    'agent_guide',
    'project_context',
    'project_file_read',
    'project_schema',
    'project_diagnostics',
    'project_preflight',
    'project_apply',
    'project_inspect',
    'project_validate',
    'project_transact',
    'project_save',
    'project_select',
  ],
  animation: [
    'component_query',
    'theme_inspect',
    'theme_plan',
    'template_inspect',
    'template_plan',
    'tracking_analyze',
    'tracking_inspect',
    'tracking_plan',
    'tracking_evidence',
    'graphics_inspect',
    'graphics_plan',
    'drivers_inspect',
    'drivers_plan',
    'curve_path',
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
    'effect_graph_query',
    'component_query',
    'plugins_inspect',
    'plugins_plan',
    'theme_inspect',
    'theme_plan',
    'template_inspect',
    'template_plan',
    'tracking_analyze',
    'tracking_inspect',
    'tracking_plan',
    'tracking_evidence',
    'graphics_inspect',
    'graphics_plan',
    'transition_plan',
    'render_profile',
    'drivers_inspect',
    'drivers_plan',
    'effect_graph_inspect',
    'effect_graph_plan',
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
  vector: [
    'graphics_inspect',
    'graphics_plan',
    'curve_path',
    'path_geometry',
    'vector_bake',
    'repeat_describe',
    'repeat_create',
    'effect_import_lut',
  ],
  drawing: [
    'drawing_query',
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
    'assets_query',
    'tracking_analyze',
    'tracking_inspect',
    'tracking_plan',
    'tracking_evidence',
    'media_status',
    'media_relink_plan',
    'media_proxy',
    'cache_inspect',
    'cache_plan',
    'cache_apply',
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
    'tracking_analyze',
    'tracking_inspect',
    'tracking_plan',
    'tracking_evidence',
    'storyboard_plan',
    'storyboard_inspect',
    'sequence_audit',
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
    'audio_mix_inspect',
    'audio_mix_plan',
    'audio_audit',
    'sound_library',
    'sound_inspect',
    'sound_plan',
    'sound_preview',
    'sound_midi',
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
    'render_query',
    'cache_inspect',
    'cache_plan',
    'cache_apply',
    'sequence_audit',
    'render_profile',
    'render_start',
    'render_list',
    'render_status',
    'render_cancel',
    'frame_capture',
    'frame_sample',
    'project_pack',
  ],
  recovery: [
    'plugins_plan',
    'media_status',
    'media_relink_plan',
    'cache_inspect',
    'project_undo',
    'project_redo',
    'project_resolve_conflict',
    'project_diagnostics',
    'project_context',
    'project_file_read',
    'project_preflight',
    'project_apply',
    'project_validate',
  ],
};
const readOnly = new Set([
  'effect_graph_query',
  'project_diagnostics',
  'assets_query',
  'drawing_query',
  'component_query',
  'render_query',
  'plugins_inspect',
  'plugins_package',
  'theme_inspect',
  'theme_plan',
  'template_inspect',
  'template_plan',
  'tracking_inspect',
  'tracking_plan',
  'tracking_evidence',
  'graphics_inspect',
  'graphics_plan',
  'media_status',
  'media_relink_plan',
  'cache_inspect',
  'cache_plan',
  'visual_templates',
  'visual_plan',
  'storyboard_plan',
  'storyboard_inspect',
  'sequence_audit',
  'render_profile',
  'transition_plan',
  'audio_mix_inspect',
  'audio_mix_plan',
  'audio_audit',
  'sound_library',
  'sound_inspect',
  'sound_plan',
  'sound_preview',
  'drivers_inspect',
  'drivers_plan',
  'curve_path',
  'effect_graph_inspect',
  'effect_graph_plan',
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
  theme_inspect: '主题 品牌 颜色 字体 排版 令牌 alias token 检查',
  theme_plan: '主题 品牌 配色 字体 别名 继承 绑定 参数 统一 调整 批量 候选',
  template_inspect: '模板 版本 实例 自定义 参数 覆盖 原型 查询',
  template_plan: '模板 创建 捕获 源码 固定 实例 发布 升级 迁移 脱离 私有 拷贝 复用 批量',
  tracking_analyze: '跟踪 运动 视频 分析 点 特征 worker 任务 取消 tracking motion feature',
  tracking_inspect: '跟踪 轨迹 失跟 置信度 分页 点 查询',
  tracking_plan: '跟踪 贴附 稳定 防抖 四角 透视 角点 合成 绑定 矩阵 批量 计划',
  tracking_evidence: '跟踪 视频 证据 截图 标注 置信度 失跟',
  graphics_inspect:
    '文字 排版 字素 单词 行 范围 路径文字 形状 算子 几何 查询 检查 typography glyph selector shape',
  graphics_plan:
    '文字 动画 字词行 范围选择器 路径文字 形状 算子 堆栈 圆角 偏移 虚线 轮廓 布尔 批量 计划 typography shape operator',
  drivers_inspect: '属性 表达式 依赖 布局 约束 路径 曲线 朝向 求值 检查',
  drivers_plan: '属性 表达式 联动 依赖 布局 锚点 宽高比 留边 路径 曲线 组合 计划',
  curve_path: '曲线 路径 运动 弧长 切线 朝向 SVG 贝塞尔',
  effect_graph_inspect: '特效 节点 图 管线 拓扑 分支 参数 输入 检查',
  effect_graph_plan: '特效 节点 图 管线 分支 混合 遮罩 置换 子图 复用 计划',
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
  render_profile: '性能 优化 帧 渲染 测量 缓存 热 冷 内存 开销 速度',
  media_status: '素材 媒体 缺失 状态 代理 元数据 文件',
  media_relink_plan: '素材 媒体 重新链接 修复 丢失 文件 路径 替换 批量',
  media_proxy: '素材 代理 视频 性能 预览 生成 取消 进度',
  cache_inspect: '缓存 空间 磁盘 大小 检查 性能',
  cache_plan: '缓存 空间 配额 计划 清理 保护 磁盘',
  cache_apply: '缓存 空间 清理 回收 磁盘 保护',
  visual_templates: '视觉 特效 纹理 贴图 置换 光束 辉光 渐变 烟雾 模板',
  visual_plan: '视觉 平面 制作 纹理 光效 置换 映射 参数 模板 批量',
  storyboard_plan: '分镜 编排 章节 镜头 配音 时间轴 批量 长片 候选',
  storyboard_inspect: '分镜 章节 镜头 检查 稳定 ID 查询',
  sequence_audit: '全片 序列 检查 质量 边界 画面 取样 覆盖 素材 越界',
  transition_plan: '转场 镜头 动画 合成 叠化 推拉 擦除 遮罩 复用 模板 批量',
  audio_mix_inspect: '声音 混音 总线 路由 检查 参数 侧链',
  audio_mix_plan: '声音 音频 混音 侧链 配音 压低 背景 总线 响度 标准化 候选',
  audio_audit: '声音 质量 检查 LUFS 峰值 true peak 响度 证据',
  sound_library: '音乐 音效 乐器 合成器 采样 鼓组 FM 混响 EQ 压缩',
  sound_inspect: '音乐 音符 编曲 节拍 音效 参数 检查 总线',
  sound_plan: '音乐 制作 作曲 编曲 音效 合成 采样 混音 母带 批量 转调 量化',
  sound_preview: '音乐 音效 制作 试听 候选 波形 电平 削波',
  sound_midi: '音乐 MIDI 导入 导出 音符 速度 力度 延音',
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
export function toolCategories(name: string, tool?: ToolDefinition): ToolCategory[] {
  if (tool?.categories) return tool.categories;
  return (Object.keys(memberships) as ToolCategory[]).filter((category) =>
    memberships[category].includes(name),
  );
}
export function toolAnnotations(name: string, tool?: ToolDefinition) {
  if (tool?.annotations) return tool.annotations;
  if (name === 'plugins_inspect' || name === 'plugins_plan' || name === 'plugins_package')
    return {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
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
    pluginId: z.string().max(80).optional(),
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
        const categories = toolCategories(tool.name, tool),
          name = tool.name.toLowerCase(),
          own = (
            name +
            ' ' +
            tool.description +
            ' ' +
            (tool.keywords ?? keywords[tool.name] ?? '')
          ).toLowerCase(),
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
          item.score >= 0 &&
          (!request.category || item.categories.includes(request.category)) &&
          (!request.pluginId || item.tool.plugin?.id === request.pluginId),
      )
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name, 'en')),
    items = ranked
      .slice(request.offset, request.offset + request.limit)
      .map(({ tool, categories }) => ({
        name: tool.name,
        summary: tool.description.split(/\.\s/)[0],
        categories,
        annotations: toolAnnotations(tool.name, tool),
        ...(tool.plugin ? { plugin: tool.plugin } : {}),
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
      count: definitions.filter((t) => toolCategories(t.name, t).includes(category)).length,
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
export const toolSchemaRequestSchema = z
  .object({
    name: z.string().min(1),
    format: z.enum(['compact', 'expanded']).default('compact'),
    ifHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    paths: z
      .array(
        z
          .string()
          .min(1)
          .max(200)
          .regex(/^[a-zA-Z_][\w-]*(?:\.[a-zA-Z_][\w-]*)*$/),
      )
      .min(1)
      .max(32)
      .optional(),
  })
  .strict();
const schemaCache = new WeakMap<
  ToolDefinition,
  { compact: Record<string, unknown>; expanded: Record<string, unknown>; hash: string }
>();
type ToolSchemaView = {
  plugin?: ToolDefinition['plugin'];
  projection?: { paths: string[]; partial: true; validation: 'full-tool-schema' };
  name: string;
  schemaHash: string;
  format: 'compact' | 'expanded';
  description: string;
  categories: ToolCategory[];
  annotations: ReturnType<typeof toolAnnotations>;
  inputSchema: Record<string, unknown>;
  call: { tool: string; arguments: { name: string; arguments: Record<string, unknown> } };
  response: string;
};
type ToolSchemaCached = { name: string; schemaHash: string; notModified: true };
export function toolSchema(definitions: ToolDefinition[], name: string): ToolSchemaView;
export function toolSchema(
  definitions: ToolDefinition[],
  name: string,
  options: { format?: 'compact' | 'expanded'; ifHash?: string; paths?: string[] },
): ToolSchemaView | ToolSchemaCached;
export function toolSchema(
  definitions: ToolDefinition[],
  name: string,
  options: { format?: 'compact' | 'expanded'; ifHash?: string; paths?: string[] } = {},
): ToolSchemaView | ToolSchemaCached {
  const tool = findTool(definitions, name);
  let entry = schemaCache.get(tool);
  if (!entry) {
    const object = z.object(tool.schema).strict(),
      expanded = zodToJsonSchema(object, { $refStrategy: 'none' }) as Record<string, unknown>,
      references = zodToJsonSchema(object, { $refStrategy: 'root' }) as Record<string, unknown>,
      compact =
        JSON.stringify(references).length < JSON.stringify(expanded).length ? references : expanded,
      hash = createHash('sha256')
        .update(JSON.stringify([name, tool.description, expanded]))
        .digest('hex');
    entry = { compact, expanded, hash };
    schemaCache.set(tool, entry);
  }
  let schemaHash = entry.hash,
    inputSchema = options.format === 'expanded' ? entry.expanded : entry.compact;
  const paths = options.paths ? [...new Set(options.paths)].sort() : undefined;
  if (paths) {
    const select = (schema: z.ZodTypeAny, chosen: string[], prefix: string): z.ZodTypeAny => {
      if (chosen.includes('')) return schema;
      if (schema instanceof z.ZodOptional)
        return select(schema.unwrap(), chosen, prefix).optional();
      if (schema instanceof z.ZodNullable)
        return select(schema.unwrap(), chosen, prefix).nullable();
      if (schema instanceof z.ZodDefault)
        return select(schema._def.innerType, chosen, prefix).default(schema._def.defaultValue);
      if (!(schema instanceof z.ZodObject))
        throw new VmotionError(
          'TOOL_SCHEMA_PATH',
          'Select a whole non-object field instead of descending into it',
          { path: prefix },
        );
      const shape: z.ZodRawShape = {};
      for (const head of new Set(chosen.map((p) => p.split('.')[0]))) {
        if (!Object.hasOwn(schema.shape, head))
          throw new VmotionError('TOOL_SCHEMA_PATH', 'Schema path is missing', {
            path: prefix ? prefix + '.' + head : head,
          });
        shape[head] = select(
          schema.shape[head],
          chosen
            .filter((p) => p === head || p.startsWith(head + '.'))
            .map((p) => (p === head ? '' : p.slice(head.length + 1))),
          prefix ? prefix + '.' + head : head,
        );
      }
      return z.object(shape).strict();
    };
    const object = select(z.object(tool.schema).strict(), paths, '');
    inputSchema = zodToJsonSchema(object, {
      $refStrategy: options.format === 'expanded' ? 'none' : 'root',
    }) as Record<string, unknown>;
    schemaHash = createHash('sha256')
      .update(JSON.stringify([entry.hash, paths]))
      .digest('hex');
  }
  if (options.ifHash === schemaHash) return { name, schemaHash, notModified: true };
  return {
    name,
    schemaHash,
    format: options.format ?? 'compact',
    description: tool.description,
    categories: toolCategories(name, tool),
    annotations: toolAnnotations(name, tool),
    ...(tool.plugin ? { plugin: tool.plugin } : {}),
    inputSchema,
    ...(paths
      ? { projection: { paths, partial: true as const, validation: 'full-tool-schema' as const } }
      : {}),
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
      toolCategories(tool.name, tool).some((c) => request.categories.includes(c))
    )
      selected.add(tool.name);
  coreTools.forEach((name) => selected.add(name));
  return selected;
}
