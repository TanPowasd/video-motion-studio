import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { z } from 'zod';
import {
  assetSchema,
  newNode,
  nodeSchema,
  sequenceSchema,
  VmotionError,
  type Asset,
  type Operation,
  type Project,
  type Scene,
  type Sequence,
  type Snapshot,
} from '../core/model.js';
import type { FileEdit } from '../core/file-edits.js';
import {
  flowIdSchema,
  flowNodeIdSchema,
  flowNodeSchema,
  type FlowCue,
  type FlowNode,
} from '../core/flow-schema.js';
import {
  compileFlow,
  compileSingleFlowNode,
  isVirtualFlowSceneFile,
  resolveFlowBundle,
  visualExpectationHash,
  voiceExpectationHash,
} from '../core/flow-compiler.js';
import { writeNodeToBundleFiles } from '../core/flow-edit.js';
import {
  alignLatentFrames4n1,
  generativeWorkflowSchema,
  isWorkflowLink,
  VMOTION_BRIDGE_SPECS,
  workflowGraphNodeSchema,
  workflowIdSchema,
  workflowInputValueSchema,
  workflowModalitySchema,
  workflowNodeKeySchema,
  workflowNodeSignatureSchema,
  workflowPinnedInputSchema,
  workflowProviderKindSchema,
  type GenerativeWorkflow,
  type WorkflowGraphNode,
  type WorkflowInputValue,
  type WorkflowModality,
  type WorkflowNodeSignature,
} from '../core/workflow-schema.js';
import {
  autoLayoutWorkflowNodes,
  compileWorkflowToComfyApi,
  extractComfyWorkflowFromPng,
  importAnyWorkflowJson,
  parseComfyObjectInfoEntry,
  type BridgeRuntimeValues,
} from '../core/workflow-convert.js';
import type { InboxContext, InboxMaskStroke } from '../core/inbox-model.js';
import { InboxStore } from './inbox.js';
import { applyOperations } from './operations.js';
import { atomicWrite, hash, json, safePath, validateSnapshot } from './project.js';
import { builtinCandidate } from '../plugins/candidate.js';
import type { BuiltinPluginHost } from '../plugins/types.js';

const PROVIDERS_REL_PATH = '.vmotion/providers.local.json';
const OBJECT_INFO_CACHE_REL_PATH = '.vmotion/comfy-object-info.json';
const GEN_TAKES_REL_DIR = '.vmotion/gen-takes';

export const httpLocalPresetSchema = z.enum([
  'cosyvoice',
  'gpt-sovits',
  'indextts',
  'fish-speech',
  'custom',
]);

export const httpLocalEndpointConfigSchema = z
  .object({
    preset: httpLocalPresetSchema.default('cosyvoice'),
    endpoint: z.string().url().max(500),
    method: z.enum(['POST', 'GET']).default('POST'),
    defaultVoice: z.string().max(200).optional(),
    timeoutMs: z.number().int().min(500).max(600_000).default(120_000),
  })
  .strict();

export const localProvidersConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    comfyui: z
      .object({
        baseUrl: z.string().url().max(500).default('http://127.0.0.1:8188'),
        timeoutMs: z.number().int().min(500).max(1_800_000).default(300_000),
      })
      .strict()
      .default({ baseUrl: 'http://127.0.0.1:8188', timeoutMs: 300_000 }),
    httpLocal: z.record(httpLocalEndpointConfigSchema).default({
      cosyvoice: {
        preset: 'cosyvoice',
        endpoint: 'http://127.0.0.1:9880/tts',
        method: 'POST',
        timeoutMs: 120_000,
      },
    }),
    agentInbox: z
      .object({
        enabled: z.boolean().default(true),
      })
      .strict()
      .default({ enabled: true }),
  })
  .strict();

export type LocalProvidersConfig = z.output<typeof localProvidersConfigSchema>;

function sanitizeUrlForDisplay(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/key|token|secret|auth|password/i.test(key)) {
        parsed.searchParams.set(key, '***');
      }
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return rawUrl;
  }
}

export async function readLocalProvidersConfig(root: string): Promise<LocalProvidersConfig> {
  const full = safePath(root, PROVIDERS_REL_PATH);
  try {
    const raw = JSON.parse(await readFile(full, 'utf8'));
    return localProvidersConfigSchema.parse(raw);
  } catch {
    return localProvidersConfigSchema.parse({});
  }
}

async function writeLocalProvidersConfig(
  root: string,
  config: LocalProvidersConfig,
): Promise<LocalProvidersConfig> {
  const validated = localProvidersConfigSchema.parse(config);
  const full = safePath(root, PROVIDERS_REL_PATH);
  await mkdir(path.dirname(full), { recursive: true });
  await atomicWrite(full, json(validated));
  return validated;
}

// ── 1. workflow_providers ────────────────────────────────────────────────────────────────

export const workflowProvidersSchema = z
  .object({
    action: z.enum(['inspect', 'configure']).default('inspect'),
    probe: z.boolean().default(false),
    comfyui: z
      .object({
        baseUrl: z.string().url().max(500).optional(),
        timeoutMs: z.number().int().min(500).max(1_800_000).optional(),
      })
      .strict()
      .optional(),
    httpLocal: z.record(httpLocalEndpointConfigSchema).optional(),
    agentInbox: z.object({ enabled: z.boolean() }).strict().optional(),
  })
  .strict();

export async function workflowProviders(root: string, raw: unknown) {
  const req = workflowProvidersSchema.parse(raw ?? {});
  let cfg = await readLocalProvidersConfig(root);

  if (req.action === 'configure') {
    cfg = await writeLocalProvidersConfig(root, {
      version: 1,
      comfyui: {
        baseUrl: (req.comfyui?.baseUrl ?? cfg.comfyui.baseUrl).replace(/\/$/, ''),
        timeoutMs: req.comfyui?.timeoutMs ?? cfg.comfyui.timeoutMs,
      },
      httpLocal: req.httpLocal ? { ...cfg.httpLocal, ...req.httpLocal } : cfg.httpLocal,
      agentInbox: req.agentInbox ?? cfg.agentInbox,
    });
  }

  let comfyProbe:
    | { reachable: boolean; latencyMs?: number; devices?: unknown; error?: string }
    | undefined;
  const httpProbes: Record<string, { reachable: boolean; status?: number; error?: string }> = {};

  if (req.probe) {
    const start = Date.now();
    try {
      const res = await fetch(`${cfg.comfyui.baseUrl.replace(/\/$/, '')}/system_stats`, {
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) {
        const body = (await res.json()) as { devices?: unknown };
        comfyProbe = {
          reachable: true,
          latencyMs: Date.now() - start,
          ...(body.devices ? { devices: body.devices } : {}),
        };
      } else {
        comfyProbe = { reachable: false, error: `HTTP ${res.status}` };
      }
    } catch (e) {
      comfyProbe = { reachable: false, error: (e as Error).message };
    }

    for (const [id, entry] of Object.entries(cfg.httpLocal)) {
      try {
        const u = new URL(entry.endpoint);
        const res = await fetch(`${u.origin}/`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(1500),
        });
        httpProbes[id] = { reachable: true, status: res.status };
      } catch (e) {
        httpProbes[id] = { reachable: false, error: (e as Error).message };
      }
    }
  }

  return {
    configFile: PROVIDERS_REL_PATH,
    committed: false,
    aiCloudKeysEmbedded: false,
    comfyui: {
      baseUrl: sanitizeUrlForDisplay(cfg.comfyui.baseUrl),
      timeoutMs: cfg.comfyui.timeoutMs,
      ...(comfyProbe ? { probe: comfyProbe } : {}),
    },
    httpLocal: Object.fromEntries(
      Object.entries(cfg.httpLocal).map(([k, v]) => [
        k,
        {
          preset: v.preset,
          endpoint: sanitizeUrlForDisplay(v.endpoint),
          method: v.method,
          ...(v.defaultVoice ? { defaultVoice: v.defaultVoice } : {}),
          ...(httpProbes[k] ? { probe: httpProbes[k] } : {}),
        },
      ]),
    ),
    agentInbox: cfg.agentInbox,
  };
}

// ── 2. workflow_nodes_query (`/object_info` dynamic discovery + offline cache) ───────────

export const workflowNodesQuerySchema = z
  .object({
    search: z.string().max(200).optional(),
    category: z.string().max(200).optional(),
    inputType: z.string().max(80).optional(),
    outputType: z.string().max(80).optional(),
    classTypes: z.array(z.string().min(1).max(200)).min(1).max(30).optional(),
    workflowPath: z.string().max(300).optional(),
    refresh: z.boolean().default(false),
    detail: z.boolean().default(false),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();

export async function loadObjectInfoCatalog(
  root: string,
  options: {
    refresh?: boolean;
    snapshotFiles?: Record<string, string>;
    workflowPath?: string;
  } = {},
): Promise<{
  source: 'live' | 'cached' | 'builtin-only';
  signatures: Record<string, WorkflowNodeSignature>;
}> {
  const cacheFull = safePath(root, OBJECT_INFO_CACHE_REL_PATH);
  let comfySigs: Record<string, WorkflowNodeSignature> = {};
  let source: 'live' | 'cached' | 'builtin-only' = 'builtin-only';

  const tryReadCache = async () => {
    try {
      const raw = JSON.parse(await readFile(cacheFull, 'utf8')) as {
        signatures?: Record<string, WorkflowNodeSignature>;
      };
      if (raw?.signatures && typeof raw.signatures === 'object') {
        comfySigs = raw.signatures;
        source = 'cached';
        return true;
      }
    } catch {}
    return false;
  };

  const tryFetchLive = async () => {
    const cfg = await readLocalProvidersConfig(root);
    const baseUrl = cfg.comfyui.baseUrl.replace(/\/$/, '');
    try {
      const res = await fetch(`${baseUrl}/object_info`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return false;
      const rawObj = (await res.json()) as Record<string, unknown>;
      const parsed: Record<string, WorkflowNodeSignature> = {};
      for (const [classType, spec] of Object.entries(rawObj)) {
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue;
        parsed[classType] = parseComfyObjectInfoEntry(
          classType,
          spec as Record<string, unknown>,
        );
      }
      comfySigs = parsed;
      source = 'live';
      await mkdir(path.dirname(cacheFull), { recursive: true });
      await atomicWrite(
        cacheFull,
        json({ fetchedAt: new Date().toISOString(), baseUrl: sanitizeUrlForDisplay(baseUrl), signatures: parsed }),
      );
      return true;
    } catch {
      return false;
    }
  };

  if (options.refresh) {
    const ok = await tryFetchLive();
    if (!ok) await tryReadCache();
  } else {
    const cached = await tryReadCache();
    if (!cached) await tryFetchLive();
  }

  // Merge embedded workflow portSignatures if requested
  const workflowEmbedded: Record<string, WorkflowNodeSignature> = {};
  if (options.workflowPath && options.snapshotFiles?.[options.workflowPath]) {
    try {
      const wf = generativeWorkflowSchema.parse(
        JSON.parse(options.snapshotFiles[options.workflowPath]),
      );
      Object.assign(workflowEmbedded, wf.portSignatures);
    } catch {}
  }

  return {
    source,
    signatures: {
      ...workflowEmbedded,
      ...comfySigs,
      ...VMOTION_BRIDGE_SPECS,
    },
  };
}

export async function workflowNodesQuery(
  root: string,
  snapshotFiles: Record<string, string>,
  raw: unknown,
) {
  const req = workflowNodesQuerySchema.parse(raw ?? {});
  const { source, signatures } = await loadObjectInfoCatalog(root, {
    refresh: req.refresh,
    snapshotFiles,
    workflowPath: req.workflowPath,
  });

  let entries = Object.entries(signatures);

  if (req.classTypes?.length) {
    const set = new Set(req.classTypes);
    entries = entries.filter(([ct]) => set.has(ct));
  }
  if (req.category) {
    const catLower = req.category.toLowerCase();
    entries = entries.filter(([, sig]) => (sig.category ?? '').toLowerCase().includes(catLower));
  }
  if (req.inputType) {
    const tUpper = req.inputType.toUpperCase();
    entries = entries.filter(([, sig]) =>
      sig.inputs.some((p) => p.type.toUpperCase() === tUpper || p.type === 'ANY' || p.type === '*'),
    );
  }
  if (req.outputType) {
    const tUpper = req.outputType.toUpperCase();
    entries = entries.filter(([, sig]) =>
      sig.outputs.some((p) => p.type.toUpperCase() === tUpper || p.type === 'ANY' || p.type === '*'),
    );
  }
  if (req.search?.trim()) {
    const q = req.search.trim().toLowerCase();
    entries = entries.filter(
      ([ct, sig]) =>
        ct.toLowerCase().includes(q) ||
        (sig.displayName ?? '').toLowerCase().includes(q) ||
        (sig.category ?? '').toLowerCase().includes(q) ||
        (sig.description ?? '').toLowerCase().includes(q),
    );
  }

  entries.sort(([a, sa], [b, sb]) => {
    const aBridge = a.startsWith('vmotion.') ? 0 : 1;
    const bBridge = b.startsWith('vmotion.') ? 0 : 1;
    if (aBridge !== bBridge) return aBridge - bBridge;
    return (sa.category ?? '').localeCompare(sb.category ?? '', 'en') || a.localeCompare(b, 'en');
  });

  const categories = [...new Set(entries.map(([, s]) => s.category ?? 'comfyui'))].slice(0, 40);
  const total = entries.length;
  const page = entries.slice(req.offset, req.offset + req.limit);
  const includeFullPorts = req.detail || Boolean(req.classTypes?.length);

  return {
    source,
    total,
    offset: req.offset,
    hasMore: req.offset + page.length < total,
    categories,
    items: page.map(([classType, sig]) =>
      includeFullPorts
        ? {
            classType,
            displayName: sig.displayName ?? classType,
            category: sig.category ?? 'comfyui',
            ...(sig.description ? { description: sig.description } : {}),
            outputNode: sig.outputNode,
            inputs: sig.inputs,
            outputs: sig.outputs,
          }
        : {
            classType,
            displayName: sig.displayName ?? classType,
            category: sig.category ?? 'comfyui',
            outputNode: sig.outputNode,
            inputTypes: [...new Set(sig.inputs.map((i) => i.type))],
            outputTypes: [...new Set(sig.outputs.map((o) => o.type))],
          },
    ),
  };
}

// ── 3. workflow_inspect ──────────────────────────────────────────────────────────────────

export const workflowInspectSchema = z
  .object({
    workflowPath: z.string().min(1).max(300).optional(),
    detail: z.boolean().default(false),
  })
  .strict();

export function discoverWorkflows(snapshot: Snapshot) {
  const list: Array<{
    workflowPath: string;
    id: string;
    name: string;
    modality: WorkflowModality;
    provider: string;
    nodeCount: number;
    pinnedInputs: string[];
  }> = [];

  for (const [file, content] of Object.entries(snapshot.files).sort(([a], [b]) =>
    a.localeCompare(b, 'en'),
  )) {
    if (!file.startsWith('components/') || !file.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(content);
      if (parsed?.kind !== 'generative-workflow') continue;
      const wf = generativeWorkflowSchema.parse(parsed);
      list.push({
        workflowPath: file,
        id: wf.id,
        name: wf.name,
        modality: wf.modality,
        provider: wf.provider,
        nodeCount: Object.keys(wf.nodes).length,
        pinnedInputs: Object.keys(wf.pinnedInputs),
      });
    } catch {}
  }
  return list;
}

export function workflowInspect(snapshot: Snapshot, raw: unknown) {
  const req = workflowInspectSchema.parse(raw ?? {});
  if (!req.workflowPath) {
    return {
      revision: snapshot.revision,
      workflows: discoverWorkflows(snapshot),
    };
  }
  const text = snapshot.files[req.workflowPath];
  if (text === undefined) {
    throw new VmotionError(
      'WORKFLOW_NOT_FOUND',
      `Workflow file "${req.workflowPath}" does not exist in project`,
      { workflowPath: req.workflowPath },
    );
  }
  const wf = generativeWorkflowSchema.parse(JSON.parse(text));
  const edges: Array<{ fromNode: string; fromSlot: number; toNode: string; toInput: string }> = [];
  const bridgeNodes: Array<{ nodeId: string; classType: string }> = [];

  for (const [nodeId, node] of Object.entries(wf.nodes)) {
    if (
      node.classType.startsWith('vmotion.') ||
      node.classType === 'http.LocalModel' ||
      node.classType === 'inbox.AgentGen'
    ) {
      bridgeNodes.push({ nodeId, classType: node.classType });
    }
    for (const [inputName, val] of Object.entries(node.inputs)) {
      if (isWorkflowLink(val)) {
        edges.push({
          fromNode: val.$link[0],
          fromSlot: val.$link[1],
          toNode: nodeId,
          toInput: inputName,
        });
      }
    }
  }

  return {
    revision: snapshot.revision,
    workflowPath: req.workflowPath,
    fileHash: hash(text),
    id: wf.id,
    name: wf.name,
    ...(wf.description ? { description: wf.description } : {}),
    modality: wf.modality,
    provider: wf.provider,
    pinnedInputs: wf.pinnedInputs,
    nodeCount: Object.keys(wf.nodes).length,
    edgeCount: edges.length,
    bridgeNodes,
    edges,
    nodes: wf.nodes,
    ...(req.detail ? { portSignatures: wf.portSignatures } : {}),
  };
}

// ── 4. workflow_plan (Starter templates, JSON/PNG import, graph editing & capsule binding) ─

function buildStarterWorkflow(
  template:
    | 'empty'
    | 'comfy-txt2img'
    | 'comfy-inpaint-canvas'
    | 'comfy-i2v-4n1'
    | 'local-tts'
    | 'inbox-gen',
  id: string,
  name: string,
  modality?: WorkflowModality,
): GenerativeWorkflow {
  if (template === 'local-tts') {
    return generativeWorkflowSchema.parse({
      kind: 'generative-workflow',
      version: 1,
      id,
      name,
      modality: 'tts',
      provider: 'http-local',
      pinnedInputs: {
        preset: {
          nodeId: 'tts_model',
          inputName: 'preset',
          label: '本地 TTS 引擎',
          type: 'combo',
          options: ['cosyvoice', 'gpt-sovits', 'indextts', 'fish-speech', 'custom'],
          default: 'cosyvoice',
        },
        voice: {
          nodeId: 'tts_model',
          inputName: 'voice',
          label: '音色 / 说话人',
          type: 'string',
          default: 'narrator',
        },
        speed: {
          nodeId: 'tts_model',
          inputName: 'speed',
          label: '语速倍率',
          type: 'number',
          min: 0.4,
          max: 2.5,
          default: 1.0,
        },
      },
      nodes: autoLayoutWorkflowNodes({
        script_in: {
          classType: 'vmotion.ScriptText',
          title: '胶囊台词输入',
          bypass: false,
          mute: false,
          inputs: { source: 'voice', fallbackText: '' },
        },
        tts_model: {
          classType: 'http.LocalModel',
          title: '本地语音合成 (HTTP)',
          bypass: false,
          mute: false,
          inputs: {
            preset: 'cosyvoice',
            endpoint: '',
            text: { $link: ['script_in', 0] },
            voice: 'narrator',
            speed: 1.0,
          },
        },
        speech_out: {
          classType: 'vmotion.SpeechOut',
          title: '烘焙配音与字幕输出',
          bypass: false,
          mute: false,
          inputs: { audio: { $link: ['tts_model', 0] }, alignCues: true },
        },
      }),
      portSignatures: {
        'vmotion.ScriptText': VMOTION_BRIDGE_SPECS['vmotion.ScriptText'],
        'http.LocalModel': VMOTION_BRIDGE_SPECS['http.LocalModel'],
        'vmotion.SpeechOut': VMOTION_BRIDGE_SPECS['vmotion.SpeechOut'],
      },
    });
  }

  if (template === 'inbox-gen') {
    const mod = modality ?? 'image';
    return generativeWorkflowSchema.parse({
      kind: 'generative-workflow',
      version: 1,
      id,
      name,
      modality: mod,
      provider: 'agent-inbox',
      pinnedInputs: {
        prompt: {
          nodeId: 'agent_gen',
          inputName: 'prompt',
          label: '生成提示词',
          type: 'string',
          default: '',
        },
      },
      nodes: autoLayoutWorkflowNodes({
        canvas_ref: {
          classType: 'vmotion.CanvasFrame',
          title: '当前画布参考帧',
          bypass: false,
          mute: false,
          inputs: { sceneId: '', localSeconds: 0 },
        },
        agent_gen: {
          classType: 'inbox.AgentGen',
          title: '外部 Agent 委托生成',
          bypass: false,
          mute: false,
          inputs: {
            prompt: '',
            modality: mod,
            referenceImage: { $link: ['canvas_ref', 0] },
          },
        },
      }),
      portSignatures: {
        'vmotion.CanvasFrame': VMOTION_BRIDGE_SPECS['vmotion.CanvasFrame'],
        'inbox.AgentGen': VMOTION_BRIDGE_SPECS['inbox.AgentGen'],
      },
    });
  }

  if (template === 'comfy-inpaint-canvas') {
    return generativeWorkflowSchema.parse({
      kind: 'generative-workflow',
      version: 1,
      id,
      name,
      modality: 'image',
      provider: 'comfyui',
      pinnedInputs: {
        prompt: {
          nodeId: 'pos_prompt',
          inputName: 'text',
          label: '局部重绘提示词',
          type: 'string',
          default: 'clean cinematic studio background, high detail',
        },
        denoise: {
          nodeId: 'sampler',
          inputName: 'denoise',
          label: '重绘幅度 (Denoise)',
          type: 'number',
          min: 0,
          max: 1,
          default: 0.75,
        },
        seed: {
          nodeId: 'sampler',
          inputName: 'seed',
          label: '随机种子 (Seed)',
          type: 'seed',
          default: 42,
        },
      },
      nodes: autoLayoutWorkflowNodes({
        ckpt: {
          classType: 'CheckpointLoaderSimple',
          title: '加载大模型',
          bypass: false,
          mute: false,
          inputs: { ckpt_name: 'v1-5-pruned-emaonly.safetensors' },
        },
        canvas_frame: {
          classType: 'vmotion.CanvasFrame',
          title: '画布当前帧',
          bypass: false,
          mute: false,
          inputs: { sceneId: '', localSeconds: 0 },
        },
        inpaint_mask: {
          classType: 'vmotion.InpaintMask',
          title: '画布涂抹遮罩',
          bypass: false,
          mute: false,
          inputs: { inboxRequestId: '', invert: false },
        },
        encode_inpaint: {
          classType: 'VAEEncodeForInpaint',
          title: '遮罩潜空间编码',
          bypass: false,
          mute: false,
          inputs: {
            pixels: { $link: ['canvas_frame', 0] },
            vae: { $link: ['ckpt', 2] },
            mask: { $link: ['inpaint_mask', 0] },
            grow_mask_by: 6,
          },
        },
        pos_prompt: {
          classType: 'CLIPTextEncode',
          title: '正向提示词',
          bypass: false,
          mute: false,
          inputs: {
            text: 'clean cinematic studio background, high detail',
            clip: { $link: ['ckpt', 1] },
          },
        },
        neg_prompt: {
          classType: 'CLIPTextEncode',
          title: '反向提示词',
          bypass: false,
          mute: false,
          inputs: { text: 'blurry, artifacts, watermark', clip: { $link: ['ckpt', 1] } },
        },
        sampler: {
          classType: 'KSampler',
          title: '采样器',
          bypass: false,
          mute: false,
          inputs: {
            model: { $link: ['ckpt', 0] },
            positive: { $link: ['pos_prompt', 0] },
            negative: { $link: ['neg_prompt', 0] },
            latent_image: { $link: ['encode_inpaint', 0] },
            seed: 42,
            steps: 20,
            cfg: 7.0,
            sampler_name: 'euler',
            scheduler: 'normal',
            denoise: 0.75,
          },
        },
        decode: {
          classType: 'VAEDecode',
          title: 'VAE 解码',
          bypass: false,
          mute: false,
          inputs: { samples: { $link: ['sampler', 0] }, vae: { $link: ['ckpt', 2] } },
        },
        img_out: {
          classType: 'vmotion.ImageOut',
          title: '烘焙图片输出',
          bypass: false,
          mute: false,
          inputs: { images: { $link: ['decode', 0] }, prefix: 'vmotion_inpaint' },
        },
      }),
      portSignatures: {
        'vmotion.CanvasFrame': VMOTION_BRIDGE_SPECS['vmotion.CanvasFrame'],
        'vmotion.InpaintMask': VMOTION_BRIDGE_SPECS['vmotion.InpaintMask'],
        'vmotion.ImageOut': VMOTION_BRIDGE_SPECS['vmotion.ImageOut'],
      },
    });
  }

  if (template === 'comfy-i2v-4n1') {
    return generativeWorkflowSchema.parse({
      kind: 'generative-workflow',
      version: 1,
      id,
      name,
      modality: 'video',
      provider: 'comfyui',
      pinnedInputs: {
        prompt: {
          nodeId: 'pos_prompt',
          inputName: 'text',
          label: '运动与镜头提示词',
          type: 'string',
          default: 'smooth cinematic camera push-in, subtle lighting motion',
        },
        seed: {
          nodeId: 'sampler',
          inputName: 'seed',
          label: '随机种子 (Seed)',
          type: 'seed',
          default: 1024,
        },
      },
      nodes: autoLayoutWorkflowNodes({
        shot_ctx: {
          classType: 'vmotion.ShotContext',
          title: '镜头上下文 (4n+1 帧长)',
          bypass: false,
          mute: false,
          inputs: { nodeId: '' },
        },
        canvas_first: {
          classType: 'vmotion.CanvasFrame',
          title: '首帧参考画面',
          bypass: false,
          mute: false,
          inputs: { sceneId: '', localSeconds: 0 },
        },
        ckpt: {
          classType: 'CheckpointLoaderSimple',
          title: '视频模型加载',
          bypass: false,
          mute: false,
          inputs: { ckpt_name: 'wan2.1_i2v_480p.safetensors' },
        },
        pos_prompt: {
          classType: 'CLIPTextEncode',
          title: '正向运动描述',
          bypass: false,
          mute: false,
          inputs: {
            text: 'smooth cinematic camera push-in, subtle lighting motion',
            clip: { $link: ['ckpt', 1] },
          },
        },
        neg_prompt: {
          classType: 'CLIPTextEncode',
          title: '反向提示词',
          bypass: false,
          mute: false,
          inputs: { text: 'flicker, warping, low quality', clip: { $link: ['ckpt', 1] } },
        },
        i2v_latent: {
          classType: 'WanImageToVideo',
          title: '图生视频潜空间 (4n+1)',
          bypass: false,
          mute: false,
          inputs: {
            positive: { $link: ['pos_prompt', 0] },
            negative: { $link: ['neg_prompt', 0] },
            vae: { $link: ['ckpt', 2] },
            start_image: { $link: ['canvas_first', 0] },
            width: { $link: ['shot_ctx', 4] },
            height: { $link: ['shot_ctx', 5] },
            length: { $link: ['shot_ctx', 2] },
            batch_size: 1,
          },
        },
        sampler: {
          classType: 'KSampler',
          title: '视频采样器',
          bypass: false,
          mute: false,
          inputs: {
            model: { $link: ['ckpt', 0] },
            positive: { $link: ['i2v_latent', 0] },
            negative: { $link: ['i2v_latent', 1] },
            latent_image: { $link: ['i2v_latent', 2] },
            seed: 1024,
            steps: 20,
            cfg: 6.0,
            sampler_name: 'uni_pc',
            scheduler: 'simple',
            denoise: 1.0,
          },
        },
        decode: {
          classType: 'VAEDecode',
          title: 'VAE 解码帧序列',
          bypass: false,
          mute: false,
          inputs: { samples: { $link: ['sampler', 0] }, vae: { $link: ['ckpt', 2] } },
        },
        vid_out: {
          classType: 'vmotion.VideoOut',
          title: '烘焙视频输出',
          bypass: false,
          mute: false,
          inputs: { images: { $link: ['decode', 0] }, fps: 24 },
        },
      }),
      portSignatures: {
        'vmotion.ShotContext': VMOTION_BRIDGE_SPECS['vmotion.ShotContext'],
        'vmotion.CanvasFrame': VMOTION_BRIDGE_SPECS['vmotion.CanvasFrame'],
        'vmotion.VideoOut': VMOTION_BRIDGE_SPECS['vmotion.VideoOut'],
      },
    });
  }

  if (template === 'comfy-txt2img') {
    return generativeWorkflowSchema.parse({
      kind: 'generative-workflow',
      version: 1,
      id,
      name,
      modality: 'image',
      provider: 'comfyui',
      pinnedInputs: {
        prompt: {
          nodeId: 'pos_prompt',
          inputName: 'text',
          label: '画面提示词 (Prompt)',
          type: 'string',
          default: 'cinematic keyframe illustration, dramatic rim lighting',
        },
        negativePrompt: {
          nodeId: 'neg_prompt',
          inputName: 'text',
          label: '反向提示词 (Negative)',
          type: 'string',
          default: 'blurry, deformed, watermark, text',
        },
        seed: {
          nodeId: 'sampler',
          inputName: 'seed',
          label: '随机种子 (Seed)',
          type: 'seed',
          default: 42,
        },
        steps: {
          nodeId: 'sampler',
          inputName: 'steps',
          label: '采样步数 (Steps)',
          type: 'number',
          min: 1,
          max: 100,
          default: 20,
        },
      },
      nodes: autoLayoutWorkflowNodes({
        proj_spec: {
          classType: 'vmotion.ProjectSpec',
          title: '工程画幅规格',
          bypass: false,
          mute: false,
          inputs: {},
        },
        ckpt: {
          classType: 'CheckpointLoaderSimple',
          title: '加载大模型',
          bypass: false,
          mute: false,
          inputs: { ckpt_name: 'v1-5-pruned-emaonly.safetensors' },
        },
        empty_latent: {
          classType: 'EmptyLatentImage',
          title: '潜空间画幅',
          bypass: false,
          mute: false,
          inputs: {
            width: { $link: ['proj_spec', 0] },
            height: { $link: ['proj_spec', 1] },
            batch_size: 1,
          },
        },
        pos_prompt: {
          classType: 'CLIPTextEncode',
          title: '正向提示词',
          bypass: false,
          mute: false,
          inputs: {
            text: 'cinematic keyframe illustration, dramatic rim lighting',
            clip: { $link: ['ckpt', 1] },
          },
        },
        neg_prompt: {
          classType: 'CLIPTextEncode',
          title: '反向提示词',
          bypass: false,
          mute: false,
          inputs: { text: 'blurry, deformed, watermark, text', clip: { $link: ['ckpt', 1] } },
        },
        sampler: {
          classType: 'KSampler',
          title: '采样器',
          bypass: false,
          mute: false,
          inputs: {
            model: { $link: ['ckpt', 0] },
            positive: { $link: ['pos_prompt', 0] },
            negative: { $link: ['neg_prompt', 0] },
            latent_image: { $link: ['empty_latent', 0] },
            seed: 42,
            steps: 20,
            cfg: 7.5,
            sampler_name: 'euler',
            scheduler: 'normal',
            denoise: 1.0,
          },
        },
        decode: {
          classType: 'VAEDecode',
          title: 'VAE 解码',
          bypass: false,
          mute: false,
          inputs: { samples: { $link: ['sampler', 0] }, vae: { $link: ['ckpt', 2] } },
        },
        img_out: {
          classType: 'vmotion.ImageOut',
          title: '烘焙图片输出',
          bypass: false,
          mute: false,
          inputs: { images: { $link: ['decode', 0] }, prefix: 'vmotion_shot' },
        },
      }),
      portSignatures: {
        'vmotion.ProjectSpec': VMOTION_BRIDGE_SPECS['vmotion.ProjectSpec'],
        'vmotion.ImageOut': VMOTION_BRIDGE_SPECS['vmotion.ImageOut'],
      },
    });
  }

  return generativeWorkflowSchema.parse({
    kind: 'generative-workflow',
    version: 1,
    id,
    name,
    modality: modality ?? 'image',
    provider: 'comfyui',
    pinnedInputs: {},
    nodes: {},
    portSignatures: {},
  });
}

const workflowPlanActionOptions = [
  z
    .object({
      op: z.literal('create'),
      id: workflowIdSchema,
      name: z.string().min(1).max(240).optional(),
      template: z
        .enum([
          'empty',
          'comfy-txt2img',
          'comfy-inpaint-canvas',
          'comfy-i2v-4n1',
          'local-tts',
          'inbox-gen',
        ])
        .default('comfy-txt2img'),
      modality: workflowModalitySchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('importJson'),
      id: workflowIdSchema.optional(),
      name: z.string().min(1).max(240).optional(),
      modality: workflowModalitySchema.optional(),
      workflowJson: z.record(z.unknown()),
    })
    .strict(),
  z
    .object({
      op: z.literal('importPng'),
      id: workflowIdSchema.optional(),
      name: z.string().min(1).max(240).optional(),
      modality: workflowModalitySchema.optional(),
      pngPath: z.string().min(1).max(300).optional(),
      pngBase64: z.string().min(16).max(30_000_000).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('upsertNode'),
      nodeId: workflowNodeKeySchema,
      node: workflowGraphNodeSchema,
      signature: workflowNodeSignatureSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('removeNode'),
      nodeId: workflowNodeKeySchema,
    })
    .strict(),
  z
    .object({
      op: z.literal('connect'),
      fromNode: workflowNodeKeySchema,
      fromSlot: z.number().int().nonnegative().max(128).default(0),
      toNode: workflowNodeKeySchema,
      toInput: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      op: z.literal('disconnect'),
      nodeId: workflowNodeKeySchema,
      inputName: z.string().min(1).max(120),
      fallbackValue: workflowInputValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('setInputs'),
      nodeId: workflowNodeKeySchema.optional(),
      inputs: z.record(workflowInputValueSchema).optional(),
      params: z.record(workflowInputValueSchema).optional(),
      name: z.string().min(1).max(240).optional(),
      modality: workflowModalitySchema.optional(),
      provider: workflowProviderKindSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('pinInput'),
      pinKey: z.string().min(1).max(80),
      pin: workflowPinnedInputSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal('unpinInput'),
      pinKey: z.string().min(1).max(80),
    })
    .strict(),
  z
    .object({
      op: z.literal('replaceGraph'),
      workflow: generativeWorkflowSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal('bindToFlowNode'),
      flowPath: z.string().min(1).max(300),
      nodeId: flowNodeIdSchema,
      slot: z.enum(['visual', 'voice']).default('visual'),
      params: z.record(z.unknown()).optional(),
      fitPolicy: z.enum(['trim', 'fit-speed', 'extend-shot', 'freeze-frame']).optional(),
    })
    .strict(),
] as const;

export const workflowPlanSchema = z
  .object({
    workflowPath: z.string().min(1).max(300).optional(),
    action: z.discriminatedUnion('op', workflowPlanActionOptions),
    inline: z.boolean().default(false),
  })
  .strict();

function resolveExistingWorkflow(
  snapshot: Snapshot,
  workflowPath: string | undefined,
): { path: string; text: string; doc: GenerativeWorkflow } {
  if (!workflowPath) {
    throw new VmotionError(
      'WORKFLOW_REQUIRED',
      'Pass workflowPath (e.g. "components/workflows/shot-gen.workflow.json")',
    );
  }
  const text = snapshot.files[workflowPath];
  if (text === undefined) {
    throw new VmotionError(
      'WORKFLOW_NOT_FOUND',
      `Workflow "${workflowPath}" does not exist`,
      { workflowPath },
    );
  }
  return {
    path: workflowPath,
    text,
    doc: generativeWorkflowSchema.parse(JSON.parse(text)),
  };
}

export async function workflowPlan(root: string, snapshot: Snapshot, raw: unknown) {
  const req = workflowPlanSchema.parse(raw ?? {});
  const { action } = req;
  const edits: FileEdit[] = [];
  let targetPath = req.workflowPath;
  let resultDoc: GenerativeWorkflow | undefined;

  const { signatures: catalogSigs } = await loadObjectInfoCatalog(root, {
    snapshotFiles: snapshot.files,
    workflowPath: req.workflowPath,
  });

  if (action.op === 'create') {
    targetPath = targetPath ?? `components/workflows/${action.id}.workflow.json`;
    const existing = snapshot.files[targetPath];
    resultDoc = buildStarterWorkflow(
      action.template,
      action.id,
      action.name ?? action.id,
      action.modality,
    );
    for (const n of Object.values(resultDoc.nodes)) {
      if (catalogSigs[n.classType]) resultDoc.portSignatures[n.classType] = catalogSigs[n.classType];
    }
    edits.push({
      type: 'replace',
      path: targetPath,
      expectedHash: existing === undefined ? null : hash(existing),
      content: json(resultDoc),
    });
  } else if (action.op === 'importJson') {
    resultDoc = importAnyWorkflowJson(action.workflowJson, {
      id: action.id,
      name: action.name,
      modality: action.modality,
      objectInfo: catalogSigs,
    });
    targetPath = targetPath ?? `components/workflows/${resultDoc.id}.workflow.json`;
    const existing = snapshot.files[targetPath];
    edits.push({
      type: 'replace',
      path: targetPath,
      expectedHash: existing === undefined ? null : hash(existing),
      content: json(resultDoc),
    });
  } else if (action.op === 'importPng') {
    let bytes: Uint8Array;
    if (action.pngBase64) {
      bytes = new Uint8Array(Buffer.from(action.pngBase64, 'base64'));
    } else if (action.pngPath) {
      bytes = new Uint8Array(await readFile(safePath(root, action.pngPath)));
    } else {
      throw new VmotionError(
        'WORKFLOW_PNG_INPUT',
        'importPng requires either pngPath (relative to project root) or pngBase64',
      );
    }
    resultDoc = extractComfyWorkflowFromPng(bytes, {
      id: action.id,
      name: action.name,
      modality: action.modality,
      objectInfo: catalogSigs,
    });
    targetPath = targetPath ?? `components/workflows/${resultDoc.id}.workflow.json`;
    const existing = snapshot.files[targetPath];
    edits.push({
      type: 'replace',
      path: targetPath,
      expectedHash: existing === undefined ? null : hash(existing),
      content: json(resultDoc),
    });
  } else if (action.op === 'bindToFlowNode') {
    const wfCheck = resolveExistingWorkflow(snapshot, targetPath);
    resultDoc = wfCheck.doc;
    const baseScenes = snapshot.scenes.filter(
      (_, i) => !isVirtualFlowSceneFile(snapshot.project.scenes[i]),
    );
    const bundle = resolveFlowBundle(
      snapshot.files,
      action.flowPath,
      snapshot.project,
      baseScenes,
    );
    const entry = bundle.entries.get(action.nodeId);
    if (!entry) {
      throw new VmotionError(
        'FLOW_MISSING_NODE',
        `Flow node "${action.nodeId}" not found in "${action.flowPath}"`,
      );
    }
    const updatedNode = structuredClone(entry.rawNode);
    if (action.slot === 'voice') {
      if (updatedNode.type !== 'shot') {
        throw new VmotionError(
          'FLOW_NODE_KIND',
          `Only "shot" nodes support voice workflow binding (got "${updatedNode.type}")`,
        );
      }
      const existingText =
        updatedNode.voice?.kind === 'tts' ? updatedNode.voice.text : (updatedNode.intent ?? '请填写台词');
      updatedNode.voice = {
        kind: 'tts',
        text: existingText,
        provider: wfCheck.doc.provider === 'comfyui' ? 'comfyui' : wfCheck.doc.provider === 'agent-inbox' ? 'agent-inbox' : 'http-local',
        workflow: wfCheck.path,
        speed: updatedNode.voice?.kind === 'tts' ? updatedNode.voice.speed : 1,
      };
    } else {
      if (updatedNode.type !== 'shot' && updatedNode.type !== 'broll-overlay') {
        throw new VmotionError(
          'FLOW_NODE_KIND',
          `Only "shot" or "broll-overlay" nodes support visual workflow binding`,
        );
      }
      updatedNode.visual = {
        kind: 'workflow',
        workflow: wfCheck.path,
        modality: wfCheck.doc.modality === 'video' ? 'video' : 'image',
        params: action.params ?? {},
        fitPolicy: action.fitPolicy ?? 'trim',
        fallbackColor: '#1a2234',
      };
    }
    const validatedNode = flowNodeSchema.parse(updatedNode);
    const nextFiles = writeNodeToBundleFiles(
      snapshot.files,
      bundle,
      validatedNode,
      entry.role === 'draft' ? 'draft' : entry.role,
    );
    for (const [f, content] of Object.entries(nextFiles)) {
      if (snapshot.files[f] !== content) {
        const orig = snapshot.files[f];
        edits.push({
          type: 'replace',
          path: f,
          expectedHash: orig === undefined ? null : hash(orig),
          content,
        });
      }
    }
  } else {
    const cur = resolveExistingWorkflow(snapshot, targetPath);
    targetPath = cur.path;
    let draft = structuredClone(cur.doc);

    if (action.op === 'replaceGraph') {
      draft = structuredClone(action.workflow);
    } else if (action.op === 'upsertNode') {
      draft.nodes[action.nodeId] = action.node;
      const sig = action.signature ?? catalogSigs[action.node.classType];
      if (sig) draft.portSignatures[action.node.classType] = sig;
      draft.nodes = autoLayoutWorkflowNodes(draft.nodes);
    } else if (action.op === 'removeNode') {
      delete draft.nodes[action.nodeId];
      for (const node of Object.values(draft.nodes)) {
        for (const [inKey, inVal] of Object.entries(node.inputs)) {
          if (isWorkflowLink(inVal) && inVal.$link[0] === action.nodeId) {
            delete node.inputs[inKey];
          }
        }
      }
      for (const [pinKey, pin] of Object.entries(draft.pinnedInputs)) {
        if (pin.nodeId === action.nodeId) delete draft.pinnedInputs[pinKey];
      }
    } else if (action.op === 'connect') {
      if (!Object.hasOwn(draft.nodes, action.fromNode)) {
        throw new VmotionError('WORKFLOW_MISSING_NODE', `Source node "${action.fromNode}" not found`);
      }
      if (!Object.hasOwn(draft.nodes, action.toNode)) {
        throw new VmotionError('WORKFLOW_MISSING_NODE', `Target node "${action.toNode}" not found`);
      }
      draft.nodes[action.toNode].inputs[action.toInput] = {
        $link: [action.fromNode, action.fromSlot],
      };
    } else if (action.op === 'disconnect') {
      const target = draft.nodes[action.nodeId];
      if (!target) {
        throw new VmotionError('WORKFLOW_MISSING_NODE', `Node "${action.nodeId}" not found`);
      }
      if (action.fallbackValue !== undefined) {
        target.inputs[action.inputName] = action.fallbackValue;
      } else {
        delete target.inputs[action.inputName];
      }
    } else if (action.op === 'setInputs') {
      if (action.name) draft.name = action.name;
      if (action.modality) draft.modality = action.modality;
      if (action.provider) draft.provider = action.provider;
      if (action.nodeId && action.inputs) {
        const target = draft.nodes[action.nodeId];
        if (!target) {
          throw new VmotionError('WORKFLOW_MISSING_NODE', `Node "${action.nodeId}" not found`);
        }
        target.inputs = { ...target.inputs, ...action.inputs };
      }
      if (action.params) {
        for (const [pinKey, val] of Object.entries(action.params)) {
          const pin = draft.pinnedInputs[pinKey];
          if (pin && draft.nodes[pin.nodeId]) {
            draft.nodes[pin.nodeId].inputs[pin.inputName] = val;
          }
        }
      }
    } else if (action.op === 'pinInput') {
      draft.pinnedInputs[action.pinKey] = action.pin;
    } else if (action.op === 'unpinInput') {
      delete draft.pinnedInputs[action.pinKey];
    }

    resultDoc = generativeWorkflowSchema.parse(draft);
    edits.push({
      type: 'replace',
      path: cur.path,
      expectedHash: hash(cur.text),
      content: json(resultDoc),
    });
  }

  if (edits.length === 0) {
    throw new VmotionError('NO_CHANGES', 'Workflow plan produced no file changes');
  }
  const operations: Operation[] = [{ type: 'editFiles', edits }];
  const candidateSnapshot = applyOperations(root, snapshot, operations);
  const diagnostics = await validateSnapshot(root, candidateSnapshot);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    throw new VmotionError(
      'VALIDATION_FAILED',
      `Workflow candidate failed validation: ${errors.map((d) => `${d.code}: ${d.message}`).join('; ')}`,
      errors,
    );
  }

  const candidateInput = {
    revision: snapshot.revision,
    operations,
    assetChecks: [],
    samples: [],
    width: 320,
    visual: false,
    determinism: true,
  };

  return builtinCandidate(
    root,
    candidateInput,
    candidateSnapshot.revision,
    req.inline ? 'inline' : 'stored',
    {
      action: action.op,
      workflowPath: targetPath,
      summary: `Workflow ${action.op}: ${targetPath}`,
      ...(resultDoc
        ? {
            workflowId: resultDoc.id,
            modality: resultDoc.modality,
            provider: resultDoc.provider,
            nodeCount: Object.keys(resultDoc.nodes).length,
            pinnedInputs: Object.keys(resultDoc.pinnedInputs),
          }
        : {}),
      changedFiles: edits.map((e) => e.path),
    },
  );
}

// ── 5. WAV Header Parser + Smart Proportional Subtitle Cue Splitter ──────────────────────

export function parseWavDurationSeconds(bytes: Uint8Array): {
  durationSeconds?: number;
  sampleRate?: number;
  channels?: number;
} {
  if (bytes.length < 44) return {};
  const ascii = (start: number, len: number) =>
    String.fromCharCode(...bytes.subarray(start, start + len));
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') return {};

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let byteRate = 0;
  let sampleRate = 0;
  let channels = 0;
  let dataBytes = 0;

  while (offset + 8 <= bytes.length) {
    const chunkId = ascii(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;
    if (chunkId === 'fmt ' && bodyStart + 16 <= bytes.length) {
      channels = view.getUint16(bodyStart + 2, true);
      sampleRate = view.getUint32(bodyStart + 4, true);
      byteRate = view.getUint32(bodyStart + 8, true);
    } else if (chunkId === 'data') {
      dataBytes = Math.min(chunkSize, bytes.length - bodyStart);
      break;
    }
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (byteRate > 0 && dataBytes > 0) {
    return {
      durationSeconds: Number((dataBytes / byteRate).toFixed(4)),
      sampleRate,
      channels,
    };
  }
  return {};
}

export function parsePngDimensions(bytes: Uint8Array): { width?: number; height?: number } {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return {};
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint32(16, false),
    height: view.getUint32(20, false),
  };
}

export function synthesizeProportionalCues(text: string, totalSeconds: number): FlowCue[] {
  const clean = text.trim();
  if (!clean || totalSeconds <= 0) return [];
  const rawClauses = clean
    .split(/(?<=[。！？!?；;\n，,、])/)
    .map((s) => s.trim().replace(/[，,、。；;]$/, ''))
    .filter(Boolean);
  if (rawClauses.length <= 1) {
    return [{ text: clean, start: 0, end: Number(totalSeconds.toFixed(3)) }];
  }
  const weights = rawClauses.map((c) => Math.max(1, [...c].length));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let cursor = 0;
  return rawClauses.map((clause, idx) => {
    const start = Number(cursor.toFixed(3));
    const span = (weights[idx] / totalWeight) * totalSeconds;
    cursor += span;
    const end =
      idx === rawClauses.length - 1
        ? Number(totalSeconds.toFixed(3))
        : Number(Math.min(totalSeconds, cursor).toFixed(3));
    return { text: clause, start, end: Math.max(Number((start + 0.04).toFixed(3)), end) };
  });
}

// ── 6. Active Run Registry & Staged Take Metadata ────────────────────────────────────────

export interface StagedTakeRecord {
  takeId: string;
  runId: string;
  scope: string;
  workflowPath?: string;
  workflowId: string;
  modality: WorkflowModality;
  provider: 'comfyui' | 'http-local' | 'agent-inbox';
  flowPath?: string;
  nodeId?: string;
  sceneId?: string;
  seed?: number;
  params: Record<string, unknown>;
  file: string;
  ext: string;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  sampleRate?: number;
  cues?: FlowCue[];
  createdAt: string;
}

interface ActiveWorkflowRun {
  runId: string;
  root: string;
  provider: 'comfyui' | 'http-local' | 'agent-inbox';
  workflowId: string;
  scope: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  currentNode?: string;
  step?: number;
  maxSteps?: number;
  startedAt: string;
  abort: AbortController;
  comfyBaseUrl?: string;
}

const activeRuns = new Map<string, ActiveWorkflowRun>();

function sanitizeScopePart(raw: string | undefined): string {
  return (raw ?? 'general').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'general';
}

// ── 7. Runtime Bridge Evaluation (`CanvasFrame`, `InpaintMask`, `ShotContext`, `ScriptText`)

async function renderSceneOrNodeFramePng(
  host: BuiltinPluginHost,
  options: {
    flowPath?: string;
    nodeId?: string;
    sceneId?: string;
    localSeconds?: number;
  },
): Promise<Buffer> {
  const snapshot = host.snapshot;
  const fps = snapshot.project.fps;
  const baseScenes = snapshot.scenes.filter(
    (_, i) => !isVirtualFlowSceneFile(snapshot.project.scenes[i]),
  );

  if (options.flowPath && options.nodeId) {
    const bundle = resolveFlowBundle(
      snapshot.files,
      options.flowPath,
      snapshot.project,
      baseScenes,
    );
    const single = compileSingleFlowNode(bundle, options.nodeId, {
      project: snapshot.project,
      scenes: baseScenes,
      files: snapshot.files,
    });
    const targetFrame = Math.min(
      Math.max(0, single.durationFrames - 1),
      Math.max(0, Math.round(((options.localSeconds ?? 0) * fps.num) / fps.den)),
    );
    const previewSeqId = '__wf_bridge_preview__';
    const isolatedProject: Project = {
      ...snapshot.project,
      activeSequence: previewSeqId,
      scenes: [
        ...snapshot.project.scenes.filter((f) => !isVirtualFlowSceneFile(f)),
        ...single.virtualScenes.map((vs) => vs.file),
      ],
      sequences: [...snapshot.project.sequences, '__virtual/flow/wf-bridge-seq.json'],
    };
    const isolatedSeq: Sequence = sequenceSchema.parse({
      id: previewSeqId,
      name: 'Bridge Preview',
      duration: single.durationFrames,
      tracks: single.tracks,
      markers: single.markers,
    });
    const isolatedSnap: Snapshot = {
      project: isolatedProject,
      scenes: [...baseScenes, ...single.virtualScenes.map((vs) => vs.scene)],
      sequences: [...snapshot.sequences, isolatedSeq],
      files: snapshot.files,
      revision: `${snapshot.revision}:wf-bridge:${options.nodeId}:${bundle.bundleHash}`,
    };
    return host.withMediaTask(async () => {
      const canvas = await host.renderer.render(isolatedSnap, targetFrame, {
        sequenceId: previewSeqId,
      });
      return canvas.encode('png');
    });
  }

  const targetSceneId = options.sceneId || snapshot.scenes[0]?.id;
  const frame = Math.max(0, Math.round(((options.localSeconds ?? 0) * fps.num) / fps.den));
  return host.withMediaTask(async () => {
    const canvas = await host.renderer.render(
      snapshot,
      frame,
      targetSceneId ? { sceneId: targetSceneId } : undefined,
    );
    return canvas.encode('png');
  });
}

async function buildComfyInpaintRgbaPng(
  root: string,
  projectWidth: number,
  projectHeight: number,
  baseFramePng: Buffer | undefined,
  inboxRequestId: string | undefined,
  invert: boolean,
): Promise<Buffer> {
  const w = Math.max(16, projectWidth);
  const h = Math.max(16, projectHeight);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  if (baseFramePng) {
    try {
      const img = await loadImage(baseFramePng);
      ctx.drawImage(img, 0, 0, w, h);
    } catch {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, w, h);
    }
  } else {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);
  }

  let strokes: InboxMaskStroke[] | undefined;
  let maskBounds: { x: number; y: number; width: number; height: number } | undefined;

  if (inboxRequestId) {
    try {
      const reqPath = safePath(root, `.vmotion/requests/${inboxRequestId}.json`);
      const parsed = JSON.parse(await readFile(reqPath, 'utf8')) as {
        context?: { mask?: { strokes?: InboxMaskStroke[]; bounds?: typeof maskBounds } };
      };
      strokes = parsed.context?.mask?.strokes;
      maskBounds = parsed.context?.mask?.bounds;
    } catch {}
  }

  // ComfyUI LoadImage MASK output = 1.0 - alpha!
  // So painted mask areas must have alpha = 0 (transparent) when invert=false.
  const maskCanvas = createCanvas(w, h);
  const mctx = maskCanvas.getContext('2d');
  mctx.lineCap = 'round';
  mctx.lineJoin = 'round';

  if (strokes && strokes.length > 0) {
    for (const s of strokes) {
      if (!s.points.length) continue;
      mctx.save();
      mctx.globalCompositeOperation = s.mode === 'erase' ? 'destination-out' : 'source-over';
      mctx.strokeStyle = '#ffffff';
      mctx.fillStyle = '#ffffff';
      mctx.lineWidth = Math.max(1, s.radius * 2);
      if (s.points.length === 1) {
        mctx.beginPath();
        mctx.arc(s.points[0].x, s.points[0].y, Math.max(1, s.radius), 0, Math.PI * 2);
        mctx.fill();
      } else {
        mctx.beginPath();
        mctx.moveTo(s.points[0].x, s.points[0].y);
        for (let i = 1; i < s.points.length; i++) {
          mctx.lineTo(s.points[i].x, s.points[i].y);
        }
        mctx.stroke();
      }
      mctx.restore();
    }
  } else if (maskBounds) {
    mctx.fillStyle = '#ffffff';
    mctx.fillRect(maskBounds.x, maskBounds.y, maskBounds.width, maskBounds.height);
  } else {
    // Center 50% fallback region if no inbox request strokes exist
    mctx.fillStyle = '#ffffff';
    mctx.fillRect(Math.round(w * 0.25), Math.round(h * 0.25), Math.round(w * 0.5), Math.round(h * 0.5));
  }

  ctx.save();
  ctx.globalCompositeOperation = invert ? 'destination-in' : 'destination-out';
  ctx.drawImage(maskCanvas, 0, 0);
  ctx.restore();

  return canvas.encode('png');
}

async function uploadToComfyUi(
  baseUrl: string,
  filename: string,
  bytes: Uint8Array,
  mimeType: string,
  signal: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: mimeType }), filename);
  form.append('overwrite', 'true');
  const res = await fetch(`${baseUrl}/upload/image`, {
    method: 'POST',
    body: form,
    signal,
  });
  if (!res.ok) {
    throw new VmotionError(
      'COMFYUI_UPLOAD_FAILED',
      `ComfyUI /upload/image failed with HTTP ${res.status}`,
      { status: res.status, filename },
    );
  }
  const data = (await res.json()) as { name?: string; subfolder?: string };
  if (data.subfolder && data.name) return `${data.subfolder}/${data.name}`;
  return data.name ?? filename;
}

// ── 8. workflow_run ──────────────────────────────────────────────────────────────────────

export const workflowRunSchema = z
  .object({
    workflowPath: z.string().min(1).max(300).optional(),
    workflow: generativeWorkflowSchema.optional(),
    flowPath: z.string().min(1).max(300).optional(),
    sequenceId: z.string().min(1).max(200).optional(),
    nodeId: flowNodeIdSchema.optional(),
    sceneId: z.string().min(1).max(200).optional(),
    inboxRequestId: z.string().min(1).max(200).optional(),
    params: z.record(workflowInputValueSchema).default({}),
    seed: z.number().int().nonnegative().optional(),
    takes: z.number().int().min(1).max(4).default(1),
  })
  .strict();

function resolveFlowContextForRun(
  snapshot: Snapshot,
  flowPathArg?: string,
  sequenceIdArg?: string,
  nodeIdArg?: string,
) {
  let flowPath = flowPathArg;
  if (!flowPath && sequenceIdArg) {
    flowPath = snapshot.sequences.find((s) => s.id === sequenceIdArg)?.flowSource;
  }
  if (!flowPath) {
    flowPath = snapshot.sequences.find((s) => s.id === snapshot.project.activeSequence)?.flowSource;
  }
  if (!flowPath) return undefined;
  const baseScenes = snapshot.scenes.filter(
    (_, i) => !isVirtualFlowSceneFile(snapshot.project.scenes[i]),
  );
  try {
    const bundle = resolveFlowBundle(snapshot.files, flowPath, snapshot.project, baseScenes);
    const compiled = compileFlow(bundle, {
      project: snapshot.project,
      scenes: baseScenes,
      files: snapshot.files,
    });
    const entry = nodeIdArg ? bundle.entries.get(nodeIdArg) : undefined;
    return { flowPath, bundle, compiled, entry, baseScenes };
  } catch {
    return undefined;
  }
}

export async function workflowRun(host: BuiltinPluginHost, raw: unknown) {
  const req = workflowRunSchema.parse(raw ?? {});
  const snapshot = host.snapshot;
  const flowCtx = resolveFlowContextForRun(snapshot, req.flowPath, req.sequenceId, req.nodeId);

  // Auto-resolve workflowPath from capsule if omitted
  let workflowPath = req.workflowPath;
  if (!workflowPath && !req.workflow && flowCtx?.entry) {
    const n = flowCtx.entry.node;
    if ((n.type === 'shot' || n.type === 'broll-overlay') && n.visual.kind === 'workflow') {
      workflowPath = n.visual.workflow;
    } else if (n.type === 'shot' && n.voice?.kind === 'tts' && n.voice.workflow) {
      workflowPath = n.voice.workflow;
    }
  }

  let wf: GenerativeWorkflow;
  if (req.workflow) {
    wf = req.workflow;
  } else if (workflowPath) {
    const text = snapshot.files[workflowPath];
    if (text === undefined) {
      throw new VmotionError(
        'WORKFLOW_NOT_FOUND',
        `Workflow "${workflowPath}" not found in project`,
        { workflowPath },
      );
    }
    wf = generativeWorkflowSchema.parse(JSON.parse(text));
  } else {
    throw new VmotionError(
      'WORKFLOW_REQUIRED',
      'Pass workflowPath, inline workflow, or a nodeId bound to a workflow',
    );
  }

  // Merge capsule-level visual.params with explicit req.params
  const mergedParams: Record<string, WorkflowInputValue> = {};
  if (flowCtx?.entry) {
    const n = flowCtx.entry.node;
    if ((n.type === 'shot' || n.type === 'broll-overlay') && n.visual.kind === 'workflow') {
      for (const [k, v] of Object.entries(n.visual.params ?? {})) {
        if (
          typeof v === 'string' ||
          typeof v === 'number' ||
          typeof v === 'boolean' ||
          v === null
        ) {
          mergedParams[k] = v;
        }
      }
    }
  }
  Object.assign(mergedParams, req.params);

  const cfg = await readLocalProvidersConfig(host.root);
  const runId = randomUUID();
  const scope = sanitizeScopePart(req.nodeId ?? req.sceneId ?? wf.id);
  const abort = new AbortController();

  const runEntry: ActiveWorkflowRun = {
    runId,
    root: host.root,
    provider: wf.provider,
    workflowId: wf.id,
    scope,
    status: 'running',
    startedAt: new Date().toISOString(),
    abort,
    ...(wf.provider === 'comfyui' ? { comfyBaseUrl: cfg.comfyui.baseUrl.replace(/\/$/, '') } : {}),
  };
  activeRuns.set(runId, runEntry);

  try {
    const fpsNum = snapshot.project.fps.num;
    const fpsDen = snapshot.project.fps.den;
    const projectFps = Math.round((fpsNum / fpsDen) * 1000) / 1000;

    // Resolve capsule text & shot duration for bridge nodes
    let scriptText = '';
    let shotDurationSeconds = 3;
    let shotFrames = Math.round(3 * projectFps);
    if (flowCtx?.entry) {
      const n = flowCtx.entry.node;
      if (n.type === 'shot') {
        scriptText = n.voice?.kind === 'tts' ? n.voice.text : (n.intent ?? '');
      } else if (n.type === 'broll-overlay') {
        scriptText = n.intent ?? '';
      }
      const placement = flowCtx.compiled.placements.find((p) => p.nodeId === n.id);
      if (placement) {
        shotDurationSeconds = Number((placement.endSeconds - placement.startSeconds).toFixed(4));
        shotFrames = placement.durationFrames;
      }
    }
    const shotAlignedFrames4n1 = alignLatentFrames4n1(shotFrames);

    // ── Provider A: `agent-inbox` (External Agent Handoff, Zero Cloud Keys) ──
    if (wf.provider === 'agent-inbox') {
      const agentNode = Object.values(wf.nodes).find((n) => n.classType === 'inbox.AgentGen');
      const promptVal =
        typeof mergedParams.prompt === 'string'
          ? mergedParams.prompt
          : typeof agentNode?.inputs.prompt === 'string' && agentNode.inputs.prompt
            ? agentNode.inputs.prompt
            : scriptText || wf.name;

      let snapshotPng: Buffer | undefined;
      if (Object.values(wf.nodes).some((n) => n.classType === 'vmotion.CanvasFrame')) {
        snapshotPng = await renderSceneOrNodeFramePng(host, {
          flowPath: flowCtx?.flowPath,
          nodeId: req.nodeId,
          sceneId: req.sceneId,
          localSeconds: 0,
        });
      }

      const inboxStore = new InboxStore(host.root);
      const inboxCtx: InboxContext = {
        workspace: flowCtx ? 'flow' : 'canvas',
        ...(req.sceneId ? { sceneId: req.sceneId } : {}),
        ...(req.sequenceId ? { sequenceId: req.sequenceId } : {}),
        frame: 0,
        fps: projectFps,
        seconds: 0,
        canvas: { width: snapshot.project.width, height: snapshot.project.height },
        revision: snapshot.revision,
        selection: [],
        ...(flowCtx?.entry
          ? {
              flowNode: {
                flowId: flowCtx.bundle.document.id,
                flowPath: flowCtx.flowPath,
                nodeId: flowCtx.entry.node.id,
                nodeFile: flowCtx.entry.file,
                role: flowCtx.entry.role === 'overlay' ? 'overlay' : 'spine',
                nodeType: flowCtx.entry.node.type,
                localSeconds: 0,
                durationSeconds: shotDurationSeconds,
              },
            }
          : {}),
      };

      const ticketText = [
        `[生成工作流委托 · ${wf.modality.toUpperCase()}] ${wf.name}`,
        `提示词/台词: ${promptVal}`,
        `目标画幅: ${snapshot.project.width}x${snapshot.project.height} @ ${projectFps}fps` +
          (wf.modality === 'video' ? ` (建议 4n+1 帧数: ${shotAlignedFrames4n1})` : ''),
        `完成后请将生成产物写入 .vmotion/gen-takes/${scope}/ 并调用 workflow_accept 原子烘焙回工程。`,
      ].join('\n');

      const created = await inboxStore.create(inboxCtx, ticketText, snapshotPng);
      runEntry.status = 'completed';
      return {
        runId,
        status: 'queued-inbox' as const,
        provider: 'agent-inbox' as const,
        modality: wf.modality,
        inboxRequestId: created.id,
        takes: [],
      };
    }

    // ── Provider B: `http-local` (Local CosyVoice / GPT-SoVITS / IndexTTS / Fish-Speech) ──
    if (wf.provider === 'http-local') {
      const modelNode = Object.values(wf.nodes).find((n) => n.classType === 'http.LocalModel');
      const preset =
        typeof mergedParams.preset === 'string'
          ? mergedParams.preset
          : typeof modelNode?.inputs.preset === 'string'
            ? modelNode.inputs.preset
            : 'cosyvoice';
      const presetCfg = cfg.httpLocal[preset] ?? Object.values(cfg.httpLocal)[0];
      const endpoint =
        typeof mergedParams.endpoint === 'string' && mergedParams.endpoint
          ? mergedParams.endpoint
          : typeof modelNode?.inputs.endpoint === 'string' && modelNode.inputs.endpoint
            ? modelNode.inputs.endpoint
            : presetCfg?.endpoint;
      if (!endpoint) {
        throw new VmotionError(
          'WORKFLOW_PROVIDER_CONFIG',
          `No local HTTP endpoint configured for preset "${preset}". Configure via workflow_providers.`,
        );
      }

      const ttsText =
        typeof mergedParams.text === 'string' && mergedParams.text
          ? mergedParams.text
          : modelNode && typeof modelNode.inputs.text === 'string' && modelNode.inputs.text
            ? modelNode.inputs.text
            : scriptText;
      if (!ttsText.trim()) {
        throw new VmotionError(
          'WORKFLOW_EMPTY_TEXT',
          'TTS workflow requires non-empty text (via capsule voice.text, ScriptText fallback, or params.text)',
        );
      }

      const voice =
        typeof mergedParams.voice === 'string'
          ? mergedParams.voice
          : typeof modelNode?.inputs.voice === 'string'
            ? modelNode.inputs.voice
            : (presetCfg?.defaultVoice ?? 'default');
      const speed =
        typeof mergedParams.speed === 'number'
          ? mergedParams.speed
          : typeof modelNode?.inputs.speed === 'number'
            ? modelNode.inputs.speed
            : flowCtx?.entry?.node.type === 'shot' && flowCtx.entry.node.voice?.kind === 'tts'
              ? flowCtx.entry.node.voice.speed
              : 1.0;

      // Optional voice clone reference audio asset
      let refAudioBase64: string | undefined;
      const refAssetId =
        flowCtx?.entry?.node.type === 'shot' && flowCtx.entry.node.voice?.kind === 'tts'
          ? flowCtx.entry.node.voice.voiceRefAssetId
          : undefined;
      if (refAssetId) {
        const refAsset = snapshot.project.assets.find((a) => a.id === refAssetId);
        if (refAsset) {
          try {
            const refBytes = await readFile(safePath(host.root, refAsset.path));
            refAudioBase64 = refBytes.toString('base64');
          } catch {}
        }
      }

      const stagedTakes: StagedTakeRecord[] = [];
      for (let tIdx = 0; tIdx < req.takes; tIdx++) {
        const takeSeed = req.seed !== undefined ? req.seed + tIdx : undefined;
        const timeoutSignal = AbortSignal.timeout(presetCfg?.timeoutMs ?? 120_000);
        const combinedSignal = AbortSignal.any([abort.signal, timeoutSignal]);

        const payload = {
          preset,
          text: ttsText,
          voice,
          speaker: voice,
          speed,
          ...(takeSeed !== undefined ? { seed: takeSeed } : {}),
          ...(refAudioBase64 ? { reference_audio_base64: refAudioBase64 } : {}),
        };

        const res = await fetch(endpoint, {
          method: presetCfg?.method ?? 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: combinedSignal,
        });
        if (!res.ok) {
          throw new VmotionError(
            'HTTP_LOCAL_ERROR',
            `Local model endpoint returned HTTP ${res.status}`,
            { status: res.status, endpoint: sanitizeUrlForDisplay(endpoint) },
          );
        }

        const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
        let mediaBytes: Uint8Array;
        let ext = wf.modality === 'tts' ? 'wav' : wf.modality === 'video' ? 'webm' : 'png';
        let serverCues: FlowCue[] | undefined;

        if (contentType.includes('application/json')) {
          const body = (await res.json()) as {
            audio_base64?: string;
            data_base64?: string;
            audio_url?: string;
            format?: string;
            cues?: Array<{ text: string; start: number; end: number }>;
          };
          if (typeof body.format === 'string' && /^[a-z0-9]{2,5}$/i.test(body.format)) {
            ext = body.format.toLowerCase();
          }
          if (body.audio_base64 || body.data_base64) {
            mediaBytes = new Uint8Array(
              Buffer.from((body.audio_base64 ?? body.data_base64)!, 'base64'),
            );
          } else if (body.audio_url) {
            const dl = await fetch(body.audio_url, { signal: combinedSignal });
            if (!dl.ok) throw new VmotionError('HTTP_LOCAL_DOWNLOAD', `Failed to download audio_url`);
            mediaBytes = new Uint8Array(await dl.arrayBuffer());
          } else {
            throw new VmotionError(
              'HTTP_LOCAL_FORMAT',
              'JSON response from local model must include audio_base64, data_base64 or audio_url',
            );
          }
          if (Array.isArray(body.cues)) {
            serverCues = body.cues
              .filter(
                (c) =>
                  typeof c?.text === 'string' &&
                  typeof c?.start === 'number' &&
                  typeof c?.end === 'number' &&
                  c.end > c.start,
              )
              .map((c) => ({
                text: c.text,
                start: Number(c.start.toFixed(3)),
                end: Number(c.end.toFixed(3)),
              }));
          }
        } else {
          if (contentType.includes('mpeg') || contentType.includes('mp3')) ext = 'mp3';
          else if (contentType.includes('ogg')) ext = 'ogg';
          else if (contentType.includes('mp4')) ext = 'mp4';
          else if (contentType.includes('webm')) ext = 'webm';
          else if (contentType.includes('png')) ext = 'png';
          mediaBytes = new Uint8Array(await res.arrayBuffer());
        }

        const wavInfo = ext === 'wav' ? parseWavDurationSeconds(mediaBytes) : {};
        const pngInfo = ext === 'png' ? parsePngDimensions(mediaBytes) : {};
        const durationSeconds =
          wavInfo.durationSeconds ??
          (serverCues?.length ? Math.max(...serverCues.map((c) => c.end)) : undefined);
        const speechOutNode = Object.values(wf.nodes).find(
          (n) => n.classType === 'vmotion.SpeechOut',
        );
        const wantCues = speechOutNode ? speechOutNode.inputs.alignCues !== false : true;
        const cues =
          wf.modality === 'tts' && wantCues
            ? serverCues && serverCues.length > 0
              ? serverCues
              : durationSeconds
                ? synthesizeProportionalCues(ttsText, durationSeconds)
                : undefined
            : undefined;

        const takeId = `take_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
        const takeRelDir = `${GEN_TAKES_REL_DIR}/${scope}/${takeId}`;
        const takeMediaRel = `${takeRelDir}/output.${ext}`;
        const takeMetaRel = `${takeRelDir}/take.json`;
        const fullDir = safePath(host.root, takeRelDir);
        await mkdir(fullDir, { recursive: true });
        await atomicWrite(safePath(host.root, takeMediaRel), Buffer.from(mediaBytes));

        const sha256 = createHash('sha256').update(mediaBytes).digest('hex');
        const record: StagedTakeRecord = {
          takeId,
          runId,
          scope,
          ...(workflowPath ? { workflowPath } : {}),
          workflowId: wf.id,
          modality: wf.modality,
          provider: 'http-local',
          ...(flowCtx?.flowPath ? { flowPath: flowCtx.flowPath } : {}),
          ...(req.nodeId ? { nodeId: req.nodeId } : {}),
          ...(req.sceneId ? { sceneId: req.sceneId } : {}),
          ...(takeSeed !== undefined ? { seed: takeSeed } : {}),
          params: { ...mergedParams, preset, voice, speed, text: ttsText },
          file: takeMediaRel,
          ext,
          bytes: mediaBytes.byteLength,
          sha256,
          ...(pngInfo.width ? { width: pngInfo.width, height: pngInfo.height } : {}),
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
          ...(wavInfo.sampleRate ? { sampleRate: wavInfo.sampleRate } : {}),
          ...(cues ? { cues } : {}),
          createdAt: new Date().toISOString(),
        };
        await atomicWrite(safePath(host.root, takeMetaRel), json(record));
        stagedTakes.push(record);
      }

      runEntry.status = 'completed';
      return {
        runId,
        status: 'completed' as const,
        provider: 'http-local' as const,
        modality: wf.modality,
        takes: stagedTakes.map(summarizeTake),
      };
    }

    // ── Provider C: `comfyui` (HTTP + WebSocket live progress + `/upload/image` + `/view`) ──
    const baseUrl = cfg.comfyui.baseUrl.replace(/\/$/, '');
    const timeoutSignal = AbortSignal.timeout(cfg.comfyui.timeoutMs);
    const combinedSignal = AbortSignal.any([abort.signal, timeoutSignal]);

    // Upload any required Vmotion runtime bridge media once before running takes
    const uploadedFiles: NonNullable<BridgeRuntimeValues['uploadedFiles']> = {};
    let cachedCanvasFramePng: Buffer | undefined;

    for (const [bNodeId, bNode] of Object.entries(wf.nodes)) {
      if (bNode.mute || bNode.bypass) continue;

      if (bNode.classType === 'vmotion.CanvasFrame') {
        const nodeSceneId =
          typeof bNode.inputs.sceneId === 'string' && bNode.inputs.sceneId
            ? bNode.inputs.sceneId
            : req.sceneId;
        const localSeconds =
          typeof bNode.inputs.localSeconds === 'number' ? bNode.inputs.localSeconds : 0;
        const png = await renderSceneOrNodeFramePng(host, {
          flowPath: nodeSceneId ? undefined : flowCtx?.flowPath,
          nodeId: nodeSceneId ? undefined : req.nodeId,
          sceneId: nodeSceneId,
          localSeconds,
        });
        cachedCanvasFramePng = png;
        const uploadedName = await uploadToComfyUi(
          baseUrl,
          `vmotion_canvas_${scope}_${bNodeId}.png`,
          png,
          'image/png',
          combinedSignal,
        );
        uploadedFiles[bNodeId] = { ...uploadedFiles[bNodeId], image: uploadedName };
      } else if (bNode.classType === 'vmotion.InpaintMask') {
        const reqId =
          typeof bNode.inputs.inboxRequestId === 'string' && bNode.inputs.inboxRequestId
            ? bNode.inputs.inboxRequestId
            : req.inboxRequestId;
        const invert = Boolean(bNode.inputs.invert);
        const basePng =
          cachedCanvasFramePng ??
          (await renderSceneOrNodeFramePng(host, {
            flowPath: flowCtx?.flowPath,
            nodeId: req.nodeId,
            sceneId: req.sceneId,
            localSeconds: 0,
          }));
        const rgbaMaskPng = await buildComfyInpaintRgbaPng(
          host.root,
          snapshot.project.width,
          snapshot.project.height,
          basePng,
          reqId,
          invert,
        );
        const uploadedMask = await uploadToComfyUi(
          baseUrl,
          `vmotion_mask_${scope}_${bNodeId}.png`,
          rgbaMaskPng,
          'image/png',
          combinedSignal,
        );
        uploadedFiles[bNodeId] = { ...uploadedFiles[bNodeId], mask: uploadedMask };
      } else if (bNode.classType === 'vmotion.AssetInput') {
        const aid = typeof bNode.inputs.assetId === 'string' ? bNode.inputs.assetId.trim() : '';
        const asset = snapshot.project.assets.find((a) => a.id === aid);
        if (!asset) {
          throw new VmotionError(
            'WORKFLOW_MISSING_ASSET',
            `Workflow AssetInput node "${bNodeId}" references missing asset "${aid}"`,
          );
        }
        const bytes = await readFile(safePath(host.root, asset.path));
        const ext = path.extname(asset.path).toLowerCase() || '.png';
        const mime =
          asset.type === 'audio' ? 'audio/wav' : asset.type === 'video' ? 'video/mp4' : 'image/png';
        const uploaded = await uploadToComfyUi(
          baseUrl,
          `vmotion_asset_${asset.id}${ext}`,
          bytes,
          mime,
          combinedSignal,
        );
        uploadedFiles[bNodeId] =
          asset.type === 'audio' ? { audio: uploaded } : { image: uploaded };
      } else if (bNode.classType === 'vmotion.ShotContext' && flowCtx) {
        const targetNodeId =
          typeof bNode.inputs.nodeId === 'string' && bNode.inputs.nodeId
            ? bNode.inputs.nodeId
            : req.nodeId;
        if (targetNodeId) {
          const spine = flowCtx.bundle.document.spine;
          const idx = spine.indexOf(targetNodeId);
          // Check if any downstream node links to slot 0 (prev_end_frame) or slot 1 (next_start_frame)
          const needsPrev = Object.values(wf.nodes).some((dn) =>
            Object.values(dn.inputs).some(
              (iv) => isWorkflowLink(iv) && iv.$link[0] === bNodeId && iv.$link[1] === 0,
            ),
          );
          const needsNext = Object.values(wf.nodes).some((dn) =>
            Object.values(dn.inputs).some(
              (iv) => isWorkflowLink(iv) && iv.$link[0] === bNodeId && iv.$link[1] === 1,
            ),
          );
          if (needsPrev && idx > 0) {
            const prevId = spine[idx - 1];
            const prevPlacement = flowCtx.compiled.placements.find((p) => p.nodeId === prevId);
            const prevEndSec = prevPlacement
              ? Math.max(0, prevPlacement.endSeconds - prevPlacement.startSeconds - 0.04)
              : 0;
            const prevPng = await renderSceneOrNodeFramePng(host, {
              flowPath: flowCtx.flowPath,
              nodeId: prevId,
              localSeconds: prevEndSec,
            });
            const upPrev = await uploadToComfyUi(
              baseUrl,
              `vmotion_prev_${prevId}.png`,
              prevPng,
              'image/png',
              combinedSignal,
            );
            uploadedFiles[bNodeId] = { ...uploadedFiles[bNodeId], prevEndImage: upPrev };
          }
          if (needsNext && idx >= 0 && idx + 1 < spine.length) {
            const nextId = spine[idx + 1];
            const nextPng = await renderSceneOrNodeFramePng(host, {
              flowPath: flowCtx.flowPath,
              nodeId: nextId,
              localSeconds: 0,
            });
            const upNext = await uploadToComfyUi(
              baseUrl,
              `vmotion_next_${nextId}.png`,
              nextPng,
              'image/png',
              combinedSignal,
            );
            uploadedFiles[bNodeId] = { ...uploadedFiles[bNodeId], nextStartImage: upNext };
          }
        }
      }
    }

    const stagedTakes: StagedTakeRecord[] = [];

    for (let tIdx = 0; tIdx < req.takes; tIdx++) {
      const seedOverride =
        req.seed !== undefined
          ? req.seed + tIdx
          : tIdx > 0
            ? Math.floor(Math.random() * 2_000_000_000)
            : undefined;

      const compiledPrompt = compileWorkflowToComfyApi(wf, {
        params: mergedParams,
        seedOverride,
        bridge: {
          uploadedFiles,
          projectWidth: snapshot.project.width,
          projectHeight: snapshot.project.height,
          projectFps,
          shotAlignedFrames4n1,
          shotDurationSeconds,
          scriptText,
        },
      });

      const clientId = randomUUID();
      const wsUrl = baseUrl.replace(/^http/i, 'ws') + `/ws?clientId=${encodeURIComponent(clientId)}`;

      // Connect WebSocket BEFORE POST /prompt so fast local runs never miss completion messages
      let targetPromptId: string | undefined;
      let wsDoneResolve: (() => void) | undefined;
      let wsDoneReject: ((err: Error) => void) | undefined;
      const wsDonePromise = new Promise<void>((resolve, reject) => {
        wsDoneResolve = resolve;
        wsDoneReject = reject;
      });

      let ws: WebSocket | undefined;
      try {
        ws = new WebSocket(wsUrl);
        ws.addEventListener('message', (ev) => {
          if (typeof ev.data !== 'string') return;
          try {
            const msg = JSON.parse(ev.data) as {
              type?: string;
              data?: {
                prompt_id?: string;
                node?: string | null;
                value?: number;
                max?: number;
                exception_message?: string;
              };
            };
            if (msg.data?.prompt_id && targetPromptId && msg.data.prompt_id !== targetPromptId) {
              return;
            }
            if (msg.type === 'executing') {
              if (msg.data?.node === null) {
                wsDoneResolve?.();
              } else if (typeof msg.data?.node === 'string') {
                runEntry.currentNode = msg.data.node;
              }
            } else if (msg.type === 'progress') {
              runEntry.step = msg.data?.value;
              runEntry.maxSteps = msg.data?.max;
            } else if (msg.type === 'execution_success') {
              wsDoneResolve?.();
            } else if (msg.type === 'execution_error') {
              wsDoneReject?.(
                new VmotionError(
                  'COMFYUI_EXECUTION_ERROR',
                  msg.data?.exception_message ?? 'ComfyUI execution_error',
                ),
              );
            }
          } catch {}
        });
        // Wait up to 350ms for WS open (non-fatal if ComfyUI HTTP-only proxy doesn't upgrade WS)
        await Promise.race([
          new Promise<void>((res) => ws!.addEventListener('open', () => res(), { once: true })),
          new Promise<void>((res) => setTimeout(res, 350)),
        ]);
      } catch {
        ws = undefined;
      }

      try {
        const promptRes = await fetch(`${baseUrl}/prompt`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: compiledPrompt.apiPrompt,
            client_id: clientId,
          }),
          signal: combinedSignal,
        });
        if (!promptRes.ok) {
          const errText = await promptRes.text().catch(() => '');
          throw new VmotionError(
            'COMFYUI_PROMPT_ERROR',
            `ComfyUI POST /prompt failed with HTTP ${promptRes.status}: ${errText.slice(0, 300)}`,
            { status: promptRes.status },
          );
        }
        const promptBody = (await promptRes.json()) as { prompt_id?: string };
        if (!promptBody.prompt_id) {
          throw new VmotionError('COMFYUI_PROMPT_ID', 'ComfyUI /prompt did not return prompt_id');
        }
        targetPromptId = promptBody.prompt_id;

        // Race WebSocket completion + lightweight `/history/<promptId>` polling
        let historyEntry: Record<string, unknown> | undefined;
        while (!historyEntry) {
          combinedSignal.throwIfAborted();
          const histRes = await fetch(`${baseUrl}/history/${encodeURIComponent(targetPromptId)}`, {
            signal: combinedSignal,
          });
          if (histRes.ok) {
            const histJson = (await histRes.json()) as Record<string, unknown>;
            const found = histJson[targetPromptId] as Record<string, unknown> | undefined;
            if (found && found.outputs && typeof found.outputs === 'object') {
              historyEntry = found;
              break;
            }
          }
          await Promise.race([
            wsDonePromise,
            new Promise<void>((res) => setTimeout(res, 120)),
          ]);
          // One immediate check after wsDonePromise resolves
          const histRes2 = await fetch(`${baseUrl}/history/${encodeURIComponent(targetPromptId)}`, {
            signal: combinedSignal,
          });
          if (histRes2.ok) {
            const histJson2 = (await histRes2.json()) as Record<string, unknown>;
            const found2 = histJson2[targetPromptId] as Record<string, unknown> | undefined;
            if (found2 && found2.outputs && typeof found2.outputs === 'object') {
              historyEntry = found2;
              break;
            }
          }
        }

        // Extract output media descriptor from historyEntry.outputs
        const outputs = historyEntry.outputs as Record<string, Record<string, unknown>>;
        let chosenFile:
          | { filename: string; subfolder?: string; type?: string }
          | undefined;
        for (const nodeOut of Object.values(outputs)) {
          for (const key of ['videos', 'gifs', 'audio', 'images']) {
            const arr = nodeOut?.[key];
            if (Array.isArray(arr) && arr.length > 0 && typeof arr[0]?.filename === 'string') {
              chosenFile = {
                filename: String(arr[0].filename),
                subfolder: typeof arr[0].subfolder === 'string' ? arr[0].subfolder : '',
                type: typeof arr[0].type === 'string' ? arr[0].type : 'output',
              };
              break;
            }
          }
          if (chosenFile) break;
        }
        if (!chosenFile) {
          throw new VmotionError(
            'COMFYUI_NO_OUTPUT',
            `ComfyUI prompt "${targetPromptId}" finished without media outputs`,
          );
        }

        const viewParams = new URLSearchParams({
          filename: chosenFile.filename,
          subfolder: chosenFile.subfolder ?? '',
          type: chosenFile.type ?? 'output',
        });
        const viewRes = await fetch(`${baseUrl}/view?${viewParams.toString()}`, {
          signal: combinedSignal,
        });
        if (!viewRes.ok) {
          throw new VmotionError(
            'COMFYUI_VIEW_ERROR',
            `ComfyUI GET /view failed with HTTP ${viewRes.status}`,
          );
        }
        const mediaBytes = new Uint8Array(await viewRes.arrayBuffer());
        const ext = (path.extname(chosenFile.filename).slice(1) || 'png').toLowerCase();
        const pngInfo = ext === 'png' ? parsePngDimensions(mediaBytes) : {};
        const wavInfo = ext === 'wav' ? parseWavDurationSeconds(mediaBytes) : {};
        const durationSeconds =
          wavInfo.durationSeconds ??
          (wf.modality === 'video'
            ? Number((shotAlignedFrames4n1 / (projectFps || 24)).toFixed(4))
            : undefined);
        const cues =
          wf.modality === 'tts' && durationSeconds && scriptText
            ? synthesizeProportionalCues(scriptText, durationSeconds)
            : undefined;

        const takeId = `take_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
        const takeRelDir = `${GEN_TAKES_REL_DIR}/${scope}/${takeId}`;
        const takeMediaRel = `${takeRelDir}/output.${ext}`;
        const takeMetaRel = `${takeRelDir}/take.json`;
        await mkdir(safePath(host.root, takeRelDir), { recursive: true });
        await atomicWrite(safePath(host.root, takeMediaRel), Buffer.from(mediaBytes));

        const sha256 = createHash('sha256').update(mediaBytes).digest('hex');
        const record: StagedTakeRecord = {
          takeId,
          runId,
          scope,
          ...(workflowPath ? { workflowPath } : {}),
          workflowId: wf.id,
          modality: wf.modality,
          provider: 'comfyui',
          ...(flowCtx?.flowPath ? { flowPath: flowCtx.flowPath } : {}),
          ...(req.nodeId ? { nodeId: req.nodeId } : {}),
          ...(req.sceneId ? { sceneId: req.sceneId } : {}),
          ...(compiledPrompt.effectiveSeed !== undefined
            ? { seed: compiledPrompt.effectiveSeed }
            : {}),
          params: compiledPrompt.effectiveParams,
          file: takeMediaRel,
          ext,
          bytes: mediaBytes.byteLength,
          sha256,
          ...(pngInfo.width ? { width: pngInfo.width, height: pngInfo.height } : {}),
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
          ...(wavInfo.sampleRate ? { sampleRate: wavInfo.sampleRate } : {}),
          ...(cues ? { cues } : {}),
          createdAt: new Date().toISOString(),
        };
        await atomicWrite(safePath(host.root, takeMetaRel), json(record));
        stagedTakes.push(record);
      } finally {
        try {
          ws?.close();
        } catch {}
      }
    }

    runEntry.status = 'completed';
    return {
      runId,
      status: 'completed' as const,
      provider: 'comfyui' as const,
      modality: wf.modality,
      takes: stagedTakes.map(summarizeTake),
    };
  } catch (err) {
    runEntry.status = abort.signal.aborted ? 'cancelled' : 'failed';
    throw err;
  } finally {
    // Keep completed/failed run summary briefly, prune beyond 32 entries
    if (activeRuns.size > 32) {
      const oldest = activeRuns.keys().next().value;
      if (oldest) activeRuns.delete(oldest);
    }
  }
}

function summarizeTake(t: StagedTakeRecord) {
  return {
    takeId: t.takeId,
    scope: t.scope,
    modality: t.modality,
    provider: t.provider,
    ...(t.workflowPath ? { workflowPath: t.workflowPath } : {}),
    ...(t.nodeId ? { nodeId: t.nodeId } : {}),
    ...(t.sceneId ? { sceneId: t.sceneId } : {}),
    ...(t.seed !== undefined ? { seed: t.seed } : {}),
    file: t.file,
    ext: t.ext,
    bytes: t.bytes,
    sha256: t.sha256.slice(0, 16),
    ...(t.width ? { width: t.width, height: t.height } : {}),
    ...(t.durationSeconds !== undefined ? { durationSeconds: t.durationSeconds } : {}),
    ...(t.cues ? { cuesCount: t.cues.length } : {}),
    createdAt: t.createdAt,
  };
}

// ── 9. workflow_takes (List staged takes, inspect take details, or cancel active run) ───

export const workflowTakesSchema = z
  .object({
    action: z.enum(['list', 'inspect', 'cancel']).default('list'),
    scope: z.string().max(100).optional(),
    takeId: z.string().max(120).optional(),
    runId: z.string().max(120).optional(),
    limit: z.number().int().min(1).max(100).default(24),
  })
  .strict();

async function scanStagedTakes(root: string, filterScope?: string): Promise<StagedTakeRecord[]> {
  const baseDir = safePath(root, GEN_TAKES_REL_DIR);
  const found: StagedTakeRecord[] = [];
  let scopes: string[] = [];
  try {
    scopes = await readdir(baseDir);
  } catch {
    return [];
  }

  for (const sc of scopes) {
    if (filterScope && sc !== sanitizeScopePart(filterScope)) continue;
    const scDir = path.join(baseDir, sc);
    let takeDirs: string[] = [];
    try {
      takeDirs = await readdir(scDir);
    } catch {
      continue;
    }
    for (const td of takeDirs) {
      try {
        const raw = JSON.parse(
          await readFile(path.join(scDir, td, 'take.json'), 'utf8'),
        ) as StagedTakeRecord;
        if (raw && typeof raw.takeId === 'string') found.push(raw);
      } catch {}
    }
  }
  found.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return found;
}

export async function workflowTakes(root: string, raw: unknown) {
  const req = workflowTakesSchema.parse(raw ?? {});

  if (req.action === 'cancel') {
    if (!req.runId) {
      throw new VmotionError('WORKFLOW_RUN_ID', 'cancel requires runId');
    }
    const active = activeRuns.get(req.runId);
    if (!active || active.root !== root) {
      return { cancelled: false, runId: req.runId, note: 'Run not active' };
    }
    active.abort.abort();
    active.status = 'cancelled';
    if (active.comfyBaseUrl) {
      await fetch(`${active.comfyBaseUrl}/interrupt`, {
        method: 'POST',
        signal: AbortSignal.timeout(2000),
      }).catch(() => {});
    }
    return { cancelled: true, runId: req.runId };
  }

  const all = await scanStagedTakes(root, req.scope);

  if (req.action === 'inspect') {
    const found = all.find((t) => t.takeId === req.takeId);
    if (!found) {
      throw new VmotionError('WORKFLOW_TAKE_NOT_FOUND', `Take "${req.takeId}" not found`, {
        takeId: req.takeId,
      });
    }
    return { take: found };
  }

  const runs = [...activeRuns.values()]
    .filter((r) => r.root === root && r.status === 'running')
    .map((r) => ({
      runId: r.runId,
      provider: r.provider,
      workflowId: r.workflowId,
      scope: r.scope,
      status: r.status,
      ...(r.currentNode ? { currentNode: r.currentNode } : {}),
      ...(r.step !== undefined ? { step: r.step, maxSteps: r.maxSteps } : {}),
      startedAt: r.startedAt,
    }));

  return {
    activeRuns: runs,
    total: all.length,
    takes: all.slice(0, req.limit).map(summarizeTake),
  };
}

// ── 10. workflow_accept (Atomic 1-step Undoable Bake across Image / Video / TTS) ────────

export const workflowAcceptSchema = z
  .object({
    takeId: z.string().min(1).max(120).optional(),
    sourceFile: z.string().min(1).max(400).optional(),
    modality: workflowModalitySchema.optional(),
    assetId: flowIdSchema.optional(),
    flowPath: z.string().min(1).max(300).optional(),
    sequenceId: z.string().min(1).max(200).optional(),
    nodeId: flowNodeIdSchema.optional(),
    slot: z.enum(['visual', 'voice']).optional(),
    fitPolicy: z.enum(['trim', 'fit-speed', 'extend-shot', 'freeze-frame']).optional(),
    durationSeconds: z.number().finite().positive().optional(),
    cues: z
      .array(
        z.object({
          text: z.string().min(1).max(500),
          start: z.number().finite().nonnegative(),
          end: z.number().finite().positive(),
        }),
      )
      .max(500)
      .optional(),
    sceneId: z.string().min(1).max(200).optional(),
    layerId: z.string().min(1).max(120).optional(),
    layerName: z.string().min(1).max(200).optional(),
    inline: z.boolean().default(false),
  })
  .strict();

export async function workflowAccept(root: string, snapshot: Snapshot, raw: unknown) {
  const req = workflowAcceptSchema.parse(raw ?? {});

  let take: StagedTakeRecord | undefined;
  if (req.takeId) {
    const all = await scanStagedTakes(root);
    take = all.find((t) => t.takeId === req.takeId);
    if (!take) {
      throw new VmotionError(
        'WORKFLOW_TAKE_NOT_FOUND',
        `Staged take "${req.takeId}" not found in ${GEN_TAKES_REL_DIR}`,
        { takeId: req.takeId },
      );
    }
  } else if (!req.sourceFile) {
    throw new VmotionError(
      'WORKFLOW_ACCEPT_SOURCE',
      'workflow_accept requires either takeId (from workflow_run) or sourceFile',
    );
  }

  const srcRel = take ? take.file : req.sourceFile!;
  const srcFull = safePath(root, srcRel);
  const srcBytes = new Uint8Array(await readFile(srcFull));
  const sha256 = take?.sha256 ?? createHash('sha256').update(srcBytes).digest('hex');
  const ext = (take?.ext ?? path.extname(srcFull).slice(1) ?? 'png').toLowerCase();

  const modality: WorkflowModality =
    req.modality ??
    take?.modality ??
    (/^(wav|mp3|ogg|flac|m4a)$/.test(ext)
      ? 'tts'
      : /^(mp4|webm|mov|mkv)$/.test(ext)
        ? 'video'
        : 'image');

  const assetType: Asset['type'] =
    modality === 'tts' ? 'audio' : modality === 'video' ? 'video' : 'image';

  const cleanSuffix = (take?.takeId ?? sha256.slice(0, 12)).replace(/[^a-zA-Z0-9_-]/g, '_');
  const assetId = req.assetId ?? `gen_${cleanSuffix}`;
  const destRel = `assets/gen/${assetId}.${ext}`;
  const destFull = safePath(root, destRel);
  await mkdir(path.dirname(destFull), { recursive: true });
  await copyFile(srcFull, destFull);

  const wavInfo = ext === 'wav' ? parseWavDurationSeconds(srcBytes) : {};
  const pngInfo = ext === 'png' ? parsePngDimensions(srcBytes) : {};
  const measuredDuration =
    req.durationSeconds ?? take?.durationSeconds ?? wavInfo.durationSeconds;

  const assetMetadata: Record<string, unknown> = {
    ...(measuredDuration !== undefined ? { duration: measuredDuration } : {}),
    ...(take?.width ?? pngInfo.width
      ? { width: take?.width ?? pngInfo.width, height: take?.height ?? pngInfo.height }
      : {}),
    ...(take?.sampleRate ?? wavInfo.sampleRate
      ? { sampleRate: take?.sampleRate ?? wavInfo.sampleRate }
      : {}),
    generativeProvenance: {
      ...(take
        ? {
            takeId: take.takeId,
            workflowId: take.workflowId,
            ...(take.workflowPath ? { workflowPath: take.workflowPath } : {}),
            provider: take.provider,
            ...(take.seed !== undefined ? { seed: take.seed } : {}),
            params: take.params,
          }
        : { provider: 'external', sourceFile: srcRel }),
      modality,
      acceptedAt: new Date().toISOString(),
    },
  };

  const newAsset = assetSchema.parse({
    id: assetId,
    name: `${modality.toUpperCase()} · ${req.nodeId ?? req.sceneId ?? assetId}`,
    path: destRel,
    type: assetType,
    managed: true,
    fingerprint: sha256,
    metadata: assetMetadata,
  });

  const operations: Operation[] = [];
  const existingAssetIdx = snapshot.project.assets.findIndex((a) => a.id === assetId);
  if (existingAssetIdx >= 0) {
    const nextAssets = structuredClone(snapshot.project.assets);
    nextAssets[existingAssetIdx] = newAsset;
    operations.push({ type: 'updateProject', patch: { assets: nextAssets } });
  } else {
    operations.push({ type: 'addAsset', asset: newAsset });
  }

  // Target 1: Flow Node Capsule (`flowPath` / `sequenceId` + `nodeId`)
  const targetNodeId = req.nodeId ?? take?.nodeId;
  let targetFlowPath = req.flowPath ?? take?.flowPath;
  if (!targetFlowPath && req.sequenceId) {
    targetFlowPath = snapshot.sequences.find((s) => s.id === req.sequenceId)?.flowSource;
  }
  if (!targetFlowPath && targetNodeId) {
    targetFlowPath = snapshot.sequences.find(
      (s) => s.id === snapshot.project.activeSequence,
    )?.flowSource;
  }

  const targetSceneId = req.sceneId ?? (!targetNodeId ? take?.sceneId : undefined);
  let targetSummary = '';

  if (targetFlowPath && targetNodeId) {
    const baseScenes = snapshot.scenes.filter(
      (_, i) => !isVirtualFlowSceneFile(snapshot.project.scenes[i]),
    );
    const bundle = resolveFlowBundle(snapshot.files, targetFlowPath, snapshot.project, baseScenes);
    const entry = bundle.entries.get(targetNodeId);
    if (!entry) {
      throw new VmotionError(
        'FLOW_MISSING_NODE',
        `Flow node "${targetNodeId}" not found in "${targetFlowPath}"`,
      );
    }

    const slot = req.slot ?? (modality === 'tts' ? 'voice' : 'visual');
    const updatedNode = structuredClone(entry.rawNode);

    if (slot === 'voice') {
      if (updatedNode.type !== 'shot') {
        throw new VmotionError(
          'FLOW_NODE_KIND',
          `Cannot bake TTS voice onto "${updatedNode.type}" node "${targetNodeId}"`,
        );
      }
      const cues = req.cues ?? take?.cues;
      const existingVoice = updatedNode.voice;
      const text =
        existingVoice?.kind === 'tts' ? existingVoice.text : (updatedNode.intent ?? assetId);
      updatedNode.voice = {
        kind: 'tts',
        text,
        provider:
          take?.provider === 'comfyui'
            ? 'comfyui'
            : take?.provider === 'agent-inbox'
              ? 'agent-inbox'
              : 'http-local',
        ...(take?.workflowPath
          ? { workflow: take.workflowPath }
          : existingVoice?.kind === 'tts' && existingVoice.workflow
            ? { workflow: existingVoice.workflow }
            : {}),
        ...(existingVoice?.kind === 'tts' && existingVoice.voiceRefAssetId
          ? { voiceRefAssetId: existingVoice.voiceRefAssetId }
          : {}),
        ...(existingVoice?.kind === 'tts' && existingVoice.voicePreset
          ? { voicePreset: existingVoice.voicePreset }
          : {}),
        speed: existingVoice?.kind === 'tts' ? existingVoice.speed : 1,
        bakedAssetId: assetId,
        ...(cues?.length ? { cues } : {}),
      };
      // Compute exact voiceExpectationHash so unbaked.voice turns false!
      const parsedDraft = flowNodeSchema.parse(updatedNode);
      if (parsedDraft.type === 'shot' && parsedDraft.voice?.kind === 'tts') {
        parsedDraft.voice.bakedHash = voiceExpectationHash(parsedDraft);
      }
      const nextFiles = writeNodeToBundleFiles(
        snapshot.files,
        bundle,
        parsedDraft,
        entry.role === 'draft' ? 'draft' : entry.role,
      );
      const edits: FileEdit[] = [];
      for (const [f, content] of Object.entries(nextFiles)) {
        if (snapshot.files[f] !== content) {
          const orig = snapshot.files[f];
          edits.push({
            type: 'replace',
            path: f,
            expectedHash: orig === undefined ? null : hash(orig),
            content,
          });
        }
      }
      if (edits.length > 0) operations.push({ type: 'editFiles', edits });
      targetSummary = `flow:${targetFlowPath}#${targetNodeId}.voice`;
    } else {
      if (updatedNode.type !== 'shot' && updatedNode.type !== 'broll-overlay') {
        throw new VmotionError(
          'FLOW_NODE_KIND',
          `Cannot bake visual onto "${updatedNode.type}" node "${targetNodeId}"`,
        );
      }
      const existingVis = updatedNode.visual;
      const wfRel =
        take?.workflowPath ??
        (existingVis.kind === 'workflow'
          ? existingVis.workflow
          : `components/workflows/${take?.workflowId ?? 'imported'}.workflow.json`);
      const fitPolicy =
        req.fitPolicy ?? (existingVis.kind === 'workflow' ? existingVis.fitPolicy : 'trim');

      updatedNode.visual = {
        kind: 'workflow',
        workflow: wfRel,
        modality: modality === 'video' ? 'video' : 'image',
        params: existingVis.kind === 'workflow' ? existingVis.params : (take?.params ?? {}),
        bakedAssetId: assetId,
        fitPolicy,
        ...(existingVis.kind === 'workflow' && existingVis.fallbackSceneId
          ? { fallbackSceneId: existingVis.fallbackSceneId }
          : {}),
        fallbackColor: existingVis.kind === 'workflow' ? existingVis.fallbackColor : '#1a2234',
      };
      const parsedDraft = flowNodeSchema.parse(updatedNode);
      if (
        (parsedDraft.type === 'shot' || parsedDraft.type === 'broll-overlay') &&
        parsedDraft.visual.kind === 'workflow'
      ) {
        parsedDraft.visual.bakedHash = visualExpectationHash(parsedDraft, snapshot.files);
      }
      const nextFiles = writeNodeToBundleFiles(
        snapshot.files,
        bundle,
        parsedDraft,
        entry.role === 'draft' ? 'draft' : entry.role,
      );
      const edits: FileEdit[] = [];
      for (const [f, content] of Object.entries(nextFiles)) {
        if (snapshot.files[f] !== content) {
          const orig = snapshot.files[f];
          edits.push({
            type: 'replace',
            path: f,
            expectedHash: orig === undefined ? null : hash(orig),
            content,
          });
        }
      }
      if (edits.length > 0) operations.push({ type: 'editFiles', edits });
      targetSummary = `flow:${targetFlowPath}#${targetNodeId}.visual`;
    }
  } else if (targetSceneId) {
    // Target 2: Traditional Scene or Still Artboard Layer
    const scene = snapshot.scenes.find((s) => s.id === targetSceneId);
    if (!scene) {
      throw new VmotionError('NOT_FOUND', `Scene "${targetSceneId}" not found`);
    }
    const layerType = modality === 'video' ? 'video' : 'image';
    if (req.layerId && scene.nodes.some((n) => n.id === req.layerId)) {
      operations.push({
        type: 'updateNode',
        sceneId: targetSceneId,
        nodeId: req.layerId,
        patch: {
          type: layerType,
          assetId,
          fit: 'cover',
        },
      });
      targetSummary = `scene:${targetSceneId}#${req.layerId}`;
    } else {
      const lid = req.layerId ?? `layer_${assetId}`;
      operations.push({
        type: 'addNode',
        sceneId: targetSceneId,
        node: nodeSchema.parse(
          newNode({
            id: lid,
            type: layerType,
            name: req.layerName ?? newAsset.name,
            x: 0,
            y: 0,
            width: snapshot.project.width,
            height: snapshot.project.height,
            assetId,
            fit: 'cover',
          }),
        ),
      });
      targetSummary = `scene:${targetSceneId}#${lid}`;
    }
  } else {
    targetSummary = `asset:${assetId}`;
  }

  const candidateSnapshot = applyOperations(root, snapshot, operations);
  const diagnostics = await validateSnapshot(root, candidateSnapshot);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    throw new VmotionError(
      'VALIDATION_FAILED',
      `Workflow accept candidate failed validation: ${errors.map((d) => `${d.code}: ${d.message}`).join('; ')}`,
      errors,
    );
  }

  const candidateInput = {
    revision: snapshot.revision,
    operations,
    assetChecks: [],
    samples: [],
    width: 320,
    visual: false,
    determinism: true,
  };

  return builtinCandidate(
    root,
    candidateInput,
    candidateSnapshot.revision,
    req.inline ? 'inline' : 'stored',
    {
      accepted: true,
      summary: `Accept ${modality} take -> ${targetSummary} (${assetId})`,
      modality,
      assetId,
      assetPath: destRel,
      ...(measuredDuration !== undefined ? { durationSeconds: measuredDuration } : {}),
      target: targetSummary,
    },
  );
}
