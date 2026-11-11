import { z } from 'zod';

const finite = z.number().finite();

export const workflowIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
    'Workflow IDs must use ASCII letters, digits, underscores or hyphens',
  );

export const workflowNodeKeySchema = z.string().min(1).max(120);

export const workflowLinkSchema = z
  .object({
    $link: z.tuple([workflowNodeKeySchema, z.number().int().nonnegative().max(128)]),
  })
  .strict();

export type WorkflowLink = z.infer<typeof workflowLinkSchema>;

export function isWorkflowLink(value: unknown): value is WorkflowLink {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as { $link?: unknown }).$link) &&
    (value as { $link: unknown[] }).$link.length === 2 &&
    typeof (value as { $link: unknown[] }).$link[0] === 'string' &&
    typeof (value as { $link: unknown[] }).$link[1] === 'number'
  );
}

const scalarSchema = z.union([z.string(), finite, z.boolean(), z.null()]);

export const workflowInputValueSchema = z.union([
  workflowLinkSchema,
  scalarSchema,
  z.array(scalarSchema).max(500),
  z
    .record(scalarSchema)
    .refine((obj) => !Object.hasOwn(obj, '$link'), 'Reserved $link key must match [nodeId, slot]'),
]);

export type WorkflowInputValue = z.infer<typeof workflowInputValueSchema>;

export const workflowWidgetSpecSchema = z
  .object({
    kind: z.enum(['string', 'int', 'float', 'boolean', 'combo']),
    options: z.array(z.string().max(300)).max(500).optional(),
    min: finite.optional(),
    max: finite.optional(),
    step: finite.positive().optional(),
    multiline: z.boolean().optional(),
    default: scalarSchema.optional(),
  })
  .strict();

export const workflowPortSpecSchema = z
  .object({
    name: z.string().min(1).max(120),
    type: z.string().min(1).max(80),
    optional: z.boolean().default(false),
    widget: workflowWidgetSpecSchema.optional(),
  })
  .strict();

export type WorkflowPortSpec = z.output<typeof workflowPortSpecSchema>;

export const workflowOutputPortSpecSchema = z
  .object({
    name: z.string().min(1).max(120),
    type: z.string().min(1).max(80),
    isList: z.boolean().default(false),
  })
  .strict();

export const workflowNodeSignatureSchema = z
  .object({
    displayName: z.string().max(200).optional(),
    category: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
    inputs: z.array(workflowPortSpecSchema).max(200).default([]),
    outputs: z.array(workflowOutputPortSpecSchema).max(64).default([]),
    outputNode: z.boolean().default(false),
  })
  .strict();

export type WorkflowNodeSignature = z.output<typeof workflowNodeSignatureSchema>;

export const workflowGraphNodeSchema = z
  .object({
    classType: z.string().min(1).max(200),
    title: z.string().max(200).optional(),
    pos: z.tuple([finite, finite]).optional(),
    bypass: z.boolean().default(false),
    mute: z.boolean().default(false),
    inputs: z.record(workflowInputValueSchema).default({}),
  })
  .strict();

export type WorkflowGraphNode = z.output<typeof workflowGraphNodeSchema>;

export const workflowPinnedInputSchema = z
  .object({
    nodeId: workflowNodeKeySchema,
    inputName: z.string().min(1).max(120),
    label: z.string().max(200).optional(),
    type: z.enum(['string', 'number', 'boolean', 'combo', 'asset', 'seed']).default('string'),
    options: z.array(z.string().max(300)).max(200).optional(),
    min: finite.optional(),
    max: finite.optional(),
    default: scalarSchema.optional(),
    description: z.string().max(500).optional(),
  })
  .strict();

export type WorkflowPinnedInput = z.output<typeof workflowPinnedInputSchema>;

export const workflowModalitySchema = z.enum(['image', 'video', 'tts']);
export type WorkflowModality = z.infer<typeof workflowModalitySchema>;

export const workflowProviderKindSchema = z.enum(['comfyui', 'http-local', 'agent-inbox']);
export type WorkflowProviderKind = z.infer<typeof workflowProviderKindSchema>;

export function detectWorkflowCycle(nodes: Record<string, WorkflowGraphNode>): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const dfs = (id: string): string[] | null => {
    visiting.add(id);
    stack.push(id);
    const node = nodes[id];
    if (node) {
      for (const val of Object.values(node.inputs)) {
        if (!isWorkflowLink(val)) continue;
        const upstream = val.$link[0];
        if (!Object.hasOwn(nodes, upstream)) continue;
        if (visiting.has(upstream)) {
          const idx = stack.indexOf(upstream);
          return [...stack.slice(idx), upstream];
        }
        if (!visited.has(upstream)) {
          const found = dfs(upstream);
          if (found) return found;
        }
      }
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };

  for (const id of Object.keys(nodes)) {
    if (!visited.has(id)) {
      const cycle = dfs(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

export const generativeWorkflowSchema = z
  .object({
    kind: z.literal('generative-workflow'),
    version: z.literal(1),
    id: workflowIdSchema,
    name: z.string().min(1).max(240),
    description: z.string().max(2000).optional(),
    modality: workflowModalitySchema.default('image'),
    provider: workflowProviderKindSchema.default('comfyui'),
    pinnedInputs: z.record(workflowPinnedInputSchema).default({}),
    nodes: z.record(workflowGraphNodeSchema),
    /** Cached port signatures for offline viewing/editing when ComfyUI is not running. */
    portSignatures: z.record(workflowNodeSignatureSchema).default({}),
  })
  .strict()
  .superRefine((doc, ctx) => {
    for (const [nodeId, node] of Object.entries(doc.nodes)) {
      for (const [inputName, value] of Object.entries(node.inputs)) {
        if (!isWorkflowLink(value)) continue;
        const [sourceId] = value.$link;
        if (sourceId === nodeId) {
          ctx.addIssue({
            code: 'custom',
            message: `Node "${nodeId}" input "${inputName}" cannot link to itself`,
            path: ['nodes', nodeId, 'inputs', inputName],
          });
        } else if (!Object.hasOwn(doc.nodes, sourceId)) {
          ctx.addIssue({
            code: 'custom',
            message: `Node "${nodeId}" input "${inputName}" links to missing node "${sourceId}"`,
            path: ['nodes', nodeId, 'inputs', inputName],
          });
        }
      }
    }

    const cycle = detectWorkflowCycle(doc.nodes);
    if (cycle) {
      ctx.addIssue({
        code: 'custom',
        message: `Workflow graph contains a cycle: ${cycle.join(' -> ')}`,
        path: ['nodes'],
      });
    }

    for (const [pinKey, pin] of Object.entries(doc.pinnedInputs)) {
      if (!Object.hasOwn(doc.nodes, pin.nodeId)) {
        ctx.addIssue({
          code: 'custom',
          message: `Pinned input "${pinKey}" references missing node "${pin.nodeId}"`,
          path: ['pinnedInputs', pinKey, 'nodeId'],
        });
      }
    }
  });

export type GenerativeWorkflow = z.output<typeof generativeWorkflowSchema>;

/**
 * Aligns raw frame counts to `4n + 1` as required by modern 3D causal-VAE video diffusion models
 * (Wan 2.1, HunyuanVideo, LTX-Video, Mochi). E.g. 1 -> 1, 80 -> 81, 90 -> 89.
 */
export function alignLatentFrames4n1(frames: number): number {
  const clamped = Math.max(1, Math.round(frames));
  if (clamped <= 1) return 1;
  return Math.max(5, Math.round((clamped - 1) / 4) * 4 + 1);
}

/**
 * Built-in Vmotion project bridge & local inference node specifications.
 * Always available offline without requiring a live ComfyUI connection.
 */
export const VMOTION_BRIDGE_SPECS: Record<string, WorkflowNodeSignature> = {
  'vmotion.CanvasFrame': {
    displayName: 'Vmotion 画布实时渲染帧',
    category: 'vmotion/bridge',
    description: '渲染当前场景或镜头在指定时刻的合成画面，作为图生图/ControlNet/首帧输入。',
    inputs: [
      {
        name: 'sceneId',
        type: 'STRING',
        optional: true,
        widget: { kind: 'string', default: '' },
      },
      {
        name: 'localSeconds',
        type: 'FLOAT',
        optional: true,
        widget: { kind: 'float', min: 0, max: 600, step: 0.1, default: 0 },
      },
    ],
    outputs: [{ name: 'image', type: 'IMAGE', isList: false }],
    outputNode: false,
  },
  'vmotion.InpaintMask': {
    displayName: 'Vmotion 画布涂抹遮罩',
    category: 'vmotion/bridge',
    description: '读取画布指令 (Canvas Inbox) 涂抹遮罩或手绘矢量图层，输出局部重绘 MASK。',
    inputs: [
      {
        name: 'inboxRequestId',
        type: 'STRING',
        optional: true,
        widget: { kind: 'string', default: '' },
      },
      {
        name: 'invert',
        type: 'BOOLEAN',
        optional: true,
        widget: { kind: 'boolean', default: false },
      },
    ],
    outputs: [
      { name: 'mask', type: 'MASK', isList: false },
      { name: 'image', type: 'IMAGE', isList: false },
    ],
    outputNode: false,
  },
  'vmotion.ShotContext': {
    displayName: 'Vmotion 上下镜上下文与 4n+1 帧长',
    category: 'vmotion/bridge',
    description: '自动提取前镜尾帧、后镜首帧、工程宽高以及符合生视频模型的 4n+1 对齐帧数。',
    inputs: [
      {
        name: 'nodeId',
        type: 'STRING',
        optional: true,
        widget: { kind: 'string', default: '' },
      },
    ],
    outputs: [
      { name: 'prev_end_frame', type: 'IMAGE', isList: false },
      { name: 'next_start_frame', type: 'IMAGE', isList: false },
      { name: 'aligned_frames_4n1', type: 'INT', isList: false },
      { name: 'duration_seconds', type: 'FLOAT', isList: false },
      { name: 'width', type: 'INT', isList: false },
      { name: 'height', type: 'INT', isList: false },
    ],
    outputNode: false,
  },
  'vmotion.ScriptText': {
    displayName: 'Vmotion 胶囊台词与分镜意图',
    category: 'vmotion/bridge',
    description: '读取当前场景流胶囊的 voice.text 台词或 intent 分镜提示词。',
    inputs: [
      {
        name: 'source',
        type: 'COMBO',
        optional: true,
        widget: { kind: 'combo', options: ['voice', 'intent', 'custom'], default: 'voice' },
      },
      {
        name: 'fallbackText',
        type: 'STRING',
        optional: true,
        widget: { kind: 'string', multiline: true, default: '' },
      },
    ],
    outputs: [{ name: 'text', type: 'STRING', isList: false }],
    outputNode: false,
  },
  'vmotion.AssetInput': {
    displayName: 'Vmotion 工程素材输入',
    category: 'vmotion/bridge',
    description: '引用 Vmotion 工程内已注册的图片、音频参考或视频素材并自动上传。',
    inputs: [
      {
        name: 'assetId',
        type: 'STRING',
        optional: false,
        widget: { kind: 'string', default: '' },
      },
    ],
    outputs: [
      { name: 'image', type: 'IMAGE', isList: false },
      { name: 'audio', type: 'AUDIO', isList: false },
    ],
    outputNode: false,
  },
  'vmotion.ProjectSpec': {
    displayName: 'Vmotion 工程画幅与帧率',
    category: 'vmotion/bridge',
    description: '输出当前工程的宽度、高度与帧率，避免硬编码分辨率。',
    inputs: [],
    outputs: [
      { name: 'width', type: 'INT', isList: false },
      { name: 'height', type: 'INT', isList: false },
      { name: 'fps', type: 'FLOAT', isList: false },
    ],
    outputNode: false,
  },
  'vmotion.ImageOut': {
    displayName: 'Vmotion 生图抽卡输出',
    category: 'vmotion/output',
    description: '将生成的图像写入 .vmotion/gen-takes 暂存区，等待对点采纳。',
    inputs: [
      { name: 'images', type: 'IMAGE', optional: false },
      {
        name: 'prefix',
        type: 'STRING',
        optional: true,
        widget: { kind: 'string', default: 'vmotion_img' },
      },
    ],
    outputs: [],
    outputNode: true,
  },
  'vmotion.VideoOut': {
    displayName: 'Vmotion 生视频抽卡输出',
    category: 'vmotion/output',
    description: '将生成的视频写入 .vmotion/gen-takes 暂存区，采纳后可自动对齐镜头时长。',
    inputs: [
      { name: 'images', type: 'IMAGE', optional: false },
      {
        name: 'fps',
        type: 'FLOAT',
        optional: true,
        widget: { kind: 'float', min: 1, max: 120, step: 1, default: 24 },
      },
    ],
    outputs: [],
    outputNode: true,
  },
  'vmotion.SpeechOut': {
    displayName: 'Vmotion 配音 TTS 输出',
    category: 'vmotion/output',
    description: '接收生成的语音与可选词句时间戳，采纳后自动驱动镜头伸缩与流绑定字幕。',
    inputs: [{ name: 'audio', type: 'AUDIO', optional: false }],
    outputs: [],
    outputNode: true,
  },
  'http.LocalModel': {
    displayName: '本地 HTTP 推理服务 (TTS / 图像)',
    category: 'vmotion/local-http',
    description: '直连本机 GPT-SoVITS / CosyVoice / IndexTTS / Fish Speech 等独立 HTTP 端点。',
    inputs: [
      {
        name: 'preset',
        type: 'COMBO',
        optional: false,
        widget: {
          kind: 'combo',
          options: ['cosyvoice', 'gpt-sovits', 'indextts', 'fish-speech', 'custom'],
          default: 'cosyvoice',
        },
      },
      {
        name: 'text',
        type: 'STRING',
        optional: false,
        widget: { kind: 'string', multiline: true, default: '' },
      },
      {
        name: 'voice',
        type: 'STRING',
        optional: true,
        widget: { kind: 'string', default: 'default' },
      },
      {
        name: 'speed',
        type: 'FLOAT',
        optional: true,
        widget: { kind: 'float', min: 0.25, max: 4, step: 0.05, default: 1 },
      },
      {
        name: 'endpoint',
        type: 'STRING',
        optional: true,
        widget: { kind: 'string', default: '' },
      },
    ],
    outputs: [{ name: 'audio', type: 'AUDIO', isList: false }],
    outputNode: true,
  },
  'inbox.AgentGen': {
    displayName: '外部 Agent 生成桥接请求',
    category: 'vmotion/agent-inbox',
    description: '将生成意图、参考帧与遮罩写入 .vmotion/requests 队列交由外部 Agent 完成，不存任何云端 Key。',
    inputs: [
      {
        name: 'prompt',
        type: 'STRING',
        optional: false,
        widget: { kind: 'string', multiline: true, default: '' },
      },
      {
        name: 'modality',
        type: 'COMBO',
        optional: false,
        widget: { kind: 'combo', options: ['image', 'video', 'tts'], default: 'image' },
      },
      { name: 'referenceImage', type: 'IMAGE', optional: true },
      { name: 'mask', type: 'MASK', optional: true },
    ],
    outputs: [],
    outputNode: true,
  },
};
