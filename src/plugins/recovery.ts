import { z } from 'zod';
import { VmotionError } from '../core/model.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import {
  remoteLockToolSchema,
  remoteRenderToolSchema,
  remoteStatusToolSchema,
  remoteSyncToolSchema,
  remoteWorkspaceLock,
  remoteWorkspaceRender,
  remoteWorkspaceStatus,
  remoteWorkspaceSync,
} from '../service/remote-client.js';
import { defineRpcHandler, invokeRpcHandler } from './rpc-handler.js';
import type { BuiltinPluginHost, BuiltinPluginModule } from './types.js';

function requireApp(host: BuiltinPluginHost) {
  if (!host.app) {
    throw new VmotionError('HOST_UNAVAILABLE', 'Remote coordination requires an Application host');
  }
  return host.app;
}

export const recoveryPlugin: BuiltinPluginModule = {
  id: 'vmotion.recovery',
  name: '共享历史与冲突恢复',
  version: '1.0.0',
  methods: new Set([
    'undo',
    'redo',
    'resolve',
    'remoteStatus',
    'remoteLock',
    'remoteSync',
    'remoteRender',
  ]),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'project_undo',
        description: 'Undo the last accepted transaction.',
        method: 'undo',
        schema: {},
        categories: ['recovery'],
        keywords: '撤销 恢复',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'project_redo',
        description: 'Redo an undone transaction.',
        method: 'redo',
        schema: {},
        categories: ['recovery'],
        keywords: '重做',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'project_resolve_conflict',
        description: 'Resolve a conflict while preserving both versions until chosen.',
        method: 'resolve',
        schema: { index: z.number().int().nonnegative(), choice: z.enum(['ours', 'theirs']) },
        categories: ['recovery'],
        keywords: '',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'remote_status',
        description:
          'Inspect network remote coordination state: coordinator revision, divergence vs local project, active scoped lease locks, connected peers, and remote render jobs.',
        method: 'remoteStatus',
        schema: remoteStatusToolSchema,
        categories: ['recovery', 'remote'],
        keywords: '远程 状态 协同 在线 节点 版本 锁 remote status coordinator peers locks divergence',
        effect: 'read',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'remote_lock',
        description:
          'List, acquire, renew or release scoped TTL lease locks (project, scene:<id>, sequence:<id>, file:<path>) and publish collaborator presence.',
        method: 'remoteLock',
        schema: remoteLockToolSchema,
        categories: ['recovery', 'remote'],
        keywords: '远程 锁 租约 续期 释放 协同 光标 remote lock lease acquire renew release presence',
        effect: 'write',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'remote_sync',
        description:
          'Pull, push or bidirectionally synchronize project files and binary assets with a remote Vmotion coordinator using deterministic 3-way stable-ID JSON/text merge and explicit conflict staging (supports mode="plan" for candidate review).',
        method: 'remoteSync',
        schema: remoteSyncToolSchema,
        categories: ['recovery', 'remote'],
        keywords: '远程 同步 拉取 推送 合并 冲突 素材 多机协同 remote sync pull push merge conflict',
        effect: 'write',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      {
        name: 'remote_render',
        description:
          'Submit, poll, cancel or download MP4/PNG/WAV exports (including heterogeneous GPU/CPU schedules) executed on a remote Vmotion coordinator.',
        method: 'remoteRender',
        schema: remoteRenderToolSchema,
        categories: ['render', 'remote', 'recovery'],
        keywords: '远程渲染 导出 下载 算力 节点 异构并行 remote render export download mp4',
        effect: 'write',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
    ] as ToolDefinition[];
  },
  dispatch(host, method, params: unknown) {
    return invokeRpcHandler(recoveryRpcHandlers, host, method, params);
  },
};

export const recoveryRpcHandlers = {
  undo: defineRpcHandler(
    z.object({}).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host) => host.coreService.undo(),
  ),
  redo: defineRpcHandler(
    z.object({}).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host) => host.coreService.redo(),
  ),
  resolve: defineRpcHandler(
    z
      .object({ index: z.number().int().nonnegative(), choice: z.enum(['ours', 'theirs']) })
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => host.coreService.resolve(params.index, params.choice),
  ),
  remoteStatus: defineRpcHandler(
    z.object(remoteStatusToolSchema).strict(),
    async (host, params) => remoteWorkspaceStatus(requireApp(host), params),
  ),
  remoteLock: defineRpcHandler(
    z.object(remoteLockToolSchema).strict(),
    async (host, params) => {
      const res = await remoteWorkspaceLock(requireApp(host), params);
      return {
        ...res,
        committed: false,
        next:
          params.action === 'acquire'
            ? 'Renew before lease expiry with remote_lock({action:"renew"}) or release when finished.'
            : 'Inspect locks via remote_lock({action:"list"}) or remote_status.',
      };
    },
  ),
  remoteSync: defineRpcHandler(
    z.object(remoteSyncToolSchema).strict(),
    async (host, params) => remoteWorkspaceSync(requireApp(host), params),
  ),
  remoteRender: defineRpcHandler(
    z.object(remoteRenderToolSchema).strict(),
    async (host, params) => {
      const res = await remoteWorkspaceRender(requireApp(host), params);
      return {
        ...res,
        committed: false,
      };
    },
  ),
};
