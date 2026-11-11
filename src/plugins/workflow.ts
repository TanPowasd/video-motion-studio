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
import { defineRpcHandler, invokeRpcHandler } from './rpc-handler.js';
import type { BuiltinPluginModule } from './types.js';

export const workflowPlugin: BuiltinPluginModule = {
  id: 'vmotion.workflow',
  name: '场景流编排与生成工作流',
  version: '1.0.0',
  dependencies: { 'vmotion.editing': '^1.0.0', 'vmotion.media': '^1.0.0' },
  methods: new Set(['flowOutline', 'flowFocus', 'flowPlan', 'flowPreviewNode']),
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
    ];
  },
  dispatch(host, method, params) {
    return invokeRpcHandler(workflowRpcHandlers, method, host, params);
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
};
