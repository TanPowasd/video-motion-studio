import type { InboxRequest } from '../core/inbox-model.js';
import type { invokeTool } from '../mcp/invoke.js';
import type { RpcHandler } from '../plugins/rpc-handler.js';
import type { builtinRpcHandlers } from '../plugins/rpc-handlers.js';
import type { ChangeEntry } from './change-journal.js';
import type {
  AgentPresenceState,
  ApplicationState,
  EmptyRequest,
  FrameRequest,
  FrameResult,
} from './host-types.js';
import type { pluginCatalog } from './plugins.js';
import type { ProjectService } from './service.js';

export type {
  AgentPresenceState,
  ApplicationState,
  EmptyRequest,
  FrameRequest,
  FrameResult,
};

type BuiltinRpcMethodMap = {
  [M in keyof typeof builtinRpcHandlers]: (typeof builtinRpcHandlers)[M] extends RpcHandler<
    infer I,
    infer R
  >
    ? { input: I; output: R }
    : never;
};

export interface HostRpcMethodMap {
  drawingStroke: {
    input: {
      sceneId: string;
      points: unknown;
      color: string;
      width: number;
      start: number;
      end: number;
    };
    output: ReturnType<ProjectService['state']>;
  };
  pluginCatalog: { input: { ifHash?: string }; output: ReturnType<typeof pluginCatalog> };
  agentDefinitions: { input: { ifHash?: string }; output: ReturnType<typeof pluginCatalog> };
  agentToolInvoke: {
    input: Record<string, unknown>;
    output: Awaited<ReturnType<typeof invokeTool>>;
  };
  ping: {
    input: EmptyRequest;
    output: { revision: string; formatVersion: number; aiIntegration: false; origins?: true };
  };
  /** Studio-only: pause or resume edits coming from external MCP clients. */
  agentHold: {
    input: { hold: boolean };
    output: AgentPresenceState;
  };
  /** Studio-only: canvas request (画布指令) with its context pack and frame snapshot. */
  inboxCreate: {
    input: import('./inbox.js').InboxCreateInput;
    output: { request: InboxRequest; inbox: InboxRequest[] };
  };
  inboxReply: {
    input: import('./inbox.js').InboxReplyInput;
    output: { request: InboxRequest; inbox: InboxRequest[] };
  };
  inboxCancel: {
    input: { id: string; reason?: string };
    output: { request: InboxRequest; inbox: InboxRequest[] };
  };
  inboxRequeue: {
    input: { id: string };
    output: { request: InboxRequest; inbox: InboxRequest[] };
  };
  inboxState: { input: EmptyRequest; output: { inbox: InboxRequest[] } };
  mcpSamplingFinish: {
    input: {
      sessionId: string;
      requestId: string;
      outcome: 'completed' | 'requeue' | 'aborted';
      note?: string;
    };
    output: { ok: true };
  };
  /** Studio-only: history panel proxy to the bound remote coordinator. */
  historyRemote: {
    input: {
      method: 'historyLog' | 'historyRestore' | 'resolve' | 'state';
      params?: Record<string, unknown>;
    };
    output: unknown;
  };
  agentStatus: {
    input: EmptyRequest;
    output: AgentPresenceState & {
      changeLog: ChangeEntry[];
    };
  };
}
export type RpcMethodMap = BuiltinRpcMethodMap & HostRpcMethodMap;

export type RpcMethod = keyof RpcMethodMap;
export type RpcInput<M extends RpcMethod> = RpcMethodMap[M]['input'];
export type RpcOutput<M extends RpcMethod> = RpcMethodMap[M]['output'];
