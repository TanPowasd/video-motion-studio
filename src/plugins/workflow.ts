import { z } from 'zod';
import type { ToolDefinition } from '../mcp/catalog.js';
import {
  flowFocus,
  flowFocusSchema,
  flowOutline,
  flowOutlineSchema,
  flowPlan,
  flowPlanSchema,
  flowPreviewNode,
  flowPreviewNodeSchema,
} from '../service/flow.js';
import {
  workflowAccept,
  workflowAcceptSchema,
  workflowInspect,
  workflowInspectSchema,
  workflowNodesQuery,
  workflowNodesQuerySchema,
  workflowPlan,
  workflowPlanSchema,
  workflowProviders,
  workflowProvidersSchema,
  workflowRun,
  workflowRunSchema,
  workflowTakes,
  workflowTakesSchema,
} from '../service/workflow-runner.js';
import { defineRpcHandler, invokeRpcHandler } from './rpc-handler.js';
import type { BuiltinPluginModule } from './types.js';

export const workflowPlugin: BuiltinPluginModule = {
  id: 'vmotion.workflow',
  name: '场景流编排与生成工作流',
  version: '1.0.0',
  dependencies: { 'vmotion.editing': '^1.0.0', 'vmotion.media': '^1.0.0' },
  methods: new Set([
    'flowOutline',
    'flowFocus',
    'flowPlan',
    'flowPreviewNode',
    'workflowProviders',
    'workflowNodesQuery',
    'workflowInspect',
    'workflowPlan',
    'workflowRun',
    'workflowTakes',
    'workflowAccept',
  ]),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'flow_outline',
        method: 'flowOutline',
        schema: flowOutlineSchema.shape,
        description:
          'Read compact scene-flow topology (spine, anchored B-roll overlays, drafts, contentHash, unbaked status, duration and variables) without full capsule bodies. Works 100% locally without AI models.',
        categories: ['workflow', 'editing'],
        keywords: '场景流 编排 大纲 拓扑 镜头 拆分 flow outline graph spine shot',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'flow_focus',
        method: 'flowFocus',
        schema: flowFocusSchema.shape,
        description:
          'Inspect one split or inline flow node capsule by nodeId, atSeconds or atFrame, returning its exact file path/hash, compiled span, neighbor boundaries and anchored B-roll.',
        categories: ['workflow', 'editing'],
        keywords: '对点修改 单镜头 聚焦 胶囊 定位 flow focus shot node capsule',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'flow_plan',
        method: 'flowPlan',
        schema: flowPlanSchema.omit({ inline: true }).shape,
        description:
          'Plan atomic scene-flow edits: init, fromSequence, upsertNode, patchNode, removeNode, reorder, setVariables, setSoundBed, mountSequence, timelineEdit, split, pack or bakeSequence. Computes dirtyNodes vs shiftedNodes and samples only dirty frames.',
        categories: ['workflow', 'editing'],
        keywords: '场景流 计划 拆分 打包 转换 增删 排序 对点修改 flow plan split pack shot',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'flow_preview_node',
        method: 'flowPreviewNode',
        schema: flowPreviewNodeSchema.omit({ inline: true }).shape,
        description:
          'Render one isolated flow node capsule (0..nodeDuration) to PNG without evaluating unrelated timeline shots. Returns compact timing/hash metadata plus optional inline PNG media.',
        categories: ['workflow', 'render'],
        keywords: '单节点 预览 隔离 渲染 取样 flow preview node isolated frame',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'workflow_providers',
        method: 'workflowProviders',
        schema: workflowProvidersSchema.shape,
        description:
          'Inspect, probe or configure local generative providers (.vmotion/providers.local.json): local/LAN ComfyUI URL, local HTTP TTS presets (CosyVoice, GPT-SoVITS, IndexTTS, Fish-Speech) and Agent Inbox handoff. Never stores cloud API keys.',
        categories: ['workflow'],
        keywords: '生成引擎 提供商 本地 ComfyUI TTS CosyVoice SoVITS IndexTTS providers local',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'workflow_nodes_query',
        method: 'workflowNodesQuery',
        schema: workflowNodesQuerySchema.shape,
        description:
          'Search ComfyUI /object_info dynamic node catalog (with offline .vmotion cache) plus built-in vmotion.* project bridge nodes by keyword, category, inputType, outputType or classTypes.',
        categories: ['workflow'],
        keywords: '节点目录 动态搜索 端口 类型 ComfyUI object_info vmotion bridge nodes query',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'workflow_inspect',
        method: 'workflowInspect',
        schema: workflowInspectSchema.shape,
        description:
          'List .workflow.json files in the project or inspect one generative workflow graph (nodes, $link edges, pinnedInputs and vmotion.* bridge bindings).',
        categories: ['workflow'],
        keywords: '查看 工作流 子图 连线 暴露参数 workflow inspect comfyui graph',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'workflow_plan',
        method: 'workflowPlan',
        schema: workflowPlanSchema.omit({ inline: true }).shape,
        description:
          'Plan atomic .workflow.json edits: starter templates (txt2img, canvas inpaint, 4n+1 video, local TTS, inbox-gen), import ComfyUI API/Web JSON or PNG metadata chunks, upsert/remove/connect nodes, pin inputs or bind to a flow capsule.',
        categories: ['workflow', 'editing'],
        keywords: '创建 导入 编辑 工作流 PNG ComfyUI 连线 绑定 workflow plan import connect pin',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'workflow_run',
        method: 'workflowRun',
        schema: workflowRunSchema.shape,
        description:
          'Execute a generative workflow (Image, Video or TTS) via local ComfyUI HTTP+WS, local HTTP model endpoint or Agent Inbox handoff, staging takes in .vmotion/gen-takes/ without mutating project commits.',
        categories: ['workflow', 'media'],
        keywords: '运行 执行 生图 生视频 配音 TTS 抽卡 Takes workflow run comfyui generate',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      {
        name: 'workflow_takes',
        method: 'workflowTakes',
        schema: workflowTakesSchema.shape,
        description:
          'List or inspect staged generation takes in .vmotion/gen-takes/, check live ComfyUI step progress, or cancel/interrupt an active run.',
        categories: ['workflow', 'media'],
        keywords: '候选 抽卡 进度 取消 中断 workflow takes progress interrupt cancel',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'workflow_accept',
        method: 'workflowAccept',
        effect: 'plan',
        schema: workflowAcceptSchema.omit({ inline: true }).shape,
        description:
          'Promote a staged take (Image, Video with trim/fit-speed/extend-shot, or TTS WAV with subtitle cues & follow-voice ripple) into assets/gen/ and return an atomic 1-step undoable candidate for a flow capsule or scene layer.',
        categories: ['workflow', 'editing', 'media'],
        keywords: '采纳 烘焙 写回 镜头 涟漪 字幕 对齐 workflow accept bake asset shot ripple',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ];
  },
  dispatch(host, method, params) {
    return invokeRpcHandler(workflowRpcHandlers, host, method, params);
  },
};

export const workflowRpcHandlers = {
  flowOutline: defineRpcHandler(
    z.object(flowOutlineSchema.shape).passthrough(),
    async (host, params) => flowOutline(host.snapshot, params),
  ),
  flowFocus: defineRpcHandler(
    z.object(flowFocusSchema.shape).passthrough(),
    async (host, params) => flowFocus(host.snapshot, params),
  ),
  flowPlan: defineRpcHandler(
    z.object(flowPlanSchema.shape).passthrough(),
    async (host, params) => flowPlan(host.root, structuredClone(host.snapshot), params),
  ),
  flowPreviewNode: defineRpcHandler(
    z.object(flowPreviewNodeSchema.shape).passthrough(),
    async (host, params) => flowPreviewNode(host, params),
  ),
  workflowProviders: defineRpcHandler(
    z.object(workflowProvidersSchema.shape).passthrough(),
    async (host, params) => workflowProviders(host.root, params),
  ),
  workflowNodesQuery: defineRpcHandler(
    z.object(workflowNodesQuerySchema.shape).passthrough(),
    async (host, params) => workflowNodesQuery(host.root, host.snapshot.files, params),
  ),
  workflowInspect: defineRpcHandler(
    z.object(workflowInspectSchema.shape).passthrough(),
    async (host, params) => workflowInspect(host.snapshot, params),
  ),
  workflowPlan: defineRpcHandler(
    z.object(workflowPlanSchema.shape).passthrough(),
    async (host, params) => workflowPlan(host.root, structuredClone(host.snapshot), params),
  ),
  workflowRun: defineRpcHandler(
    z.object(workflowRunSchema.shape).passthrough(),
    async (host, params) => workflowRun(host, params),
  ),
  workflowTakes: defineRpcHandler(
    z.object(workflowTakesSchema.shape).passthrough(),
    async (host, params) => workflowTakes(host.root, params),
  ),
  workflowAccept: defineRpcHandler(
    z.object(workflowAcceptSchema.shape).passthrough(),
    async (host, params) => workflowAccept(host.root, structuredClone(host.snapshot), params),
  ),
};
