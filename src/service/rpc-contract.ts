import type { CompositionDraft } from '../core/interaction.js';
import type { ProjectService } from './service.js';

export type EmptyRequest = Record<string, never>;

export interface FrameRequest {
  frame?: number;
  width?: number;
  height?: number;
  sceneId?: string;
  path?: string[];
  contextFrames?: number[];
  output?: string;
  fallback?: boolean;
  draft?: CompositionDraft | CompositionDraft[];
  format?: 'png' | 'rgba';
  mediaQuality?: 'original' | 'auto';
}

export interface FrameResult {
  buffer: Buffer;
  stale: boolean;
  revision: string;
  frame: number;
  format: 'png' | 'rgba';
  width?: number;
  height?: number;
  renderMs?: number;
  encodeMs?: number;
  media?: { quality: string; proxyCount: number; decodePixels: number };
  error?: string;
}

export type ApplicationState = ReturnType<ProjectService['state']>;

export interface RpcMethodMap {
  state: { input: EmptyRequest; output: ApplicationState };
  ping: {
    input: EmptyRequest;
    output: { revision: string; formatVersion: number; aiIntegration: false };
  };
  frame: { input: FrameRequest; output: FrameResult };
}

export type RpcMethod = keyof RpcMethodMap;
export type RpcInput<M extends RpcMethod> = RpcMethodMap[M]['input'];
export type RpcOutput<M extends RpcMethod> = RpcMethodMap[M]['output'];

