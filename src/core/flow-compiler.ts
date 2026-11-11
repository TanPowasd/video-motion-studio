import path from 'node:path';
import { hash } from '../platform/project-files.js';
import {
  clipSchema,
  newNode,
  sceneSchema,
  VmotionError,
  type Asset,
  type Clip,
  type Project,
  type Scene,
  type Sequence,
  type Track,
} from './model.js';
import { audioMixSchema, type AudioMix } from './audio-mix-schema.js';
import {
  estimateSpeechSeconds,
  flowCueSchema,
  flowDocumentSchema,
  flowNodeSchema,
  flowSubtitleSchema,
  flowVisualSchema,
  type FlowDocument,
  type FlowNode,
  type FlowShotNode,
} from './flow-schema.js';
import type { z } from 'zod';

type FlowVisual = z.output<typeof flowVisualSchema>;
type FlowSubtitle = z.output<typeof flowSubtitleSchema>;
type FlowCue = z.output<typeof flowCueSchema>;

export const VIRTUAL_FLOW_SCENE_PREFIX = '__virtual/flow/';
export const FLOW_TRACK_PREFIX = 'flow/';

export interface ResolvedFlowNodeEntry {
  node: FlowNode;
  /** Un-interpolated node data as stored on disk, preserving `$var.*` expressions across split/pack/edits. */
  rawNode: FlowNode;
  /** Authoritative file where this node lives (`nodes/<id>.json` or `flow.json`). */
  file: string;
  role: 'spine' | 'overlay' | 'draft';
  contentHash: string;
  unbaked: { visual: boolean; voice: boolean };
}

export interface ResolvedFlowBundle {
  flowPath: string;
  nodesDir: string;
  split: boolean;
  document: FlowDocument;
  entries: Map<string, ResolvedFlowNodeEntry>;
  draftNodeIds: string[];
  bundleHash: string;
}

export interface CompiledNodePlacement {
  nodeId: string;
  file: string;
  role: 'spine' | 'overlay';
  startSeconds: number;
  endSeconds: number;
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  contentHash: string;
  unbaked: { visual: boolean; voice: boolean };
  segmentSpans?: Record<string, { startSeconds: number; endSeconds: number; startFrame: number; endFrame: number }>;
}

export interface CompiledFlowResult {
  flowId: string;
  flowPath: string;
  durationFrames: number;
  durationSeconds: number;
  tracks: Track[];
  markers: Sequence['markers'];
  virtualScenes: Array<{ file: string; originFile: string; scene: Scene }>;
  mix?: AudioMix;
  placements: CompiledNodePlacement[];
  draftNodeIds: string[];
}

export interface FlowDiffSummary {
  dirtyNodes: string[];
  shiftedNodes: string[];
  addedNodes: string[];
  removedNodes: string[];
  unbakedNodes: string[];
  dirtyFrameRanges: Array<{ nodeId: string; startFrame: number; endFrame: number }>;
}

export function flowNodesDir(flowPath: string): string {
  const normalized = flowPath.replace(/\\/g, '/');
  if (normalized.endsWith('/flow.json')) {
    return path.posix.join(path.posix.dirname(normalized), 'nodes');
  }
  const base = normalized.replace(/\.flow\.json$/, '').replace(/\.json$/, '');
  return `${base}/nodes`;
}

export function isVirtualFlowSceneFile(file: string | undefined): boolean {
  return typeof file === 'string' && file.startsWith(VIRTUAL_FLOW_SCENE_PREFIX);
}

export function virtualSceneOriginFile(virtualFile: string): string {
  // Format: __virtual/flow/<encodedOrigin>::<virtualSceneId>.json
  const rest = virtualFile.slice(VIRTUAL_FLOW_SCENE_PREFIX.length).replace(/\.json$/, '');
  const sep = rest.indexOf('::');
  return sep >= 0 ? decodeURIComponent(rest.slice(0, sep)) : 'project.vmotion.json';
}

function makeVirtualSceneFile(originFile: string, virtualSceneId: string): string {
  return `${VIRTUAL_FLOW_SCENE_PREFIX}${encodeURIComponent(originFile)}::${virtualSceneId}.json`;
}

function interpolateVariables<T>(value: T, variables: FlowDocument['variables']): T {
  if (typeof value === 'string') {
    if (value.startsWith('$var.')) {
      const pathParts = value.slice(5).split('.');
      let cur: unknown = variables;
      for (const p of pathParts) {
        if (cur && typeof cur === 'object' && Object.hasOwn(cur, p)) {
          cur = (cur as Record<string, unknown>)[p];
        } else {
          cur = undefined;
          break;
        }
      }
      if (cur !== undefined) return structuredClone(cur) as T;
    }
    return value.replace(/\$\{var\.([a-zA-Z0-9_.-]+)\}/g, (match, keyPath: string) => {
      let cur: unknown = variables;
      for (const p of keyPath.split('.')) {
        if (cur && typeof cur === 'object' && Object.hasOwn(cur, p)) {
          cur = (cur as Record<string, unknown>)[p];
        } else {
          return match;
        }
      }
      return typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean'
        ? String(cur)
        : match;
    }) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateVariables(item, variables)) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolateVariables(v, variables);
    }
    return out as T;
  }
  return value;
}

function parseJsonWithError<T>(
  file: string,
  raw: string,
  parser: (data: unknown) => T,
  code = 'FLOW_DOCUMENT',
): T {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new VmotionError('INVALID_JSON', `Cannot parse ${file}: ${(e as Error).message}`, {
      file,
    });
  }
  try {
    return parser(data);
  } catch (e) {
    throw new VmotionError(code, `Invalid flow data in ${file}: ${(e as Error).message}`, {
      file,
    });
  }
}

export function voiceExpectationHash(node: FlowNode): string | undefined {
  if (node.type !== 'shot' || !node.voice || node.voice.kind !== 'tts') return undefined;
  return hash(
    JSON.stringify({
      text: node.voice.text,
      provider: node.voice.provider,
      workflow: node.voice.workflow ?? null,
      voiceRefAssetId: node.voice.voiceRefAssetId ?? null,
      voicePreset: node.voice.voicePreset ?? null,
      speed: node.voice.speed,
    }),
  ).slice(0, 16);
}

export function visualExpectationHash(
  node: FlowNode,
  files: Record<string, string>,
): string | undefined {
  const vis =
    node.type === 'shot' ? node.visual : node.type === 'broll-overlay' ? node.visual : undefined;
  if (!vis || vis.kind !== 'workflow') return undefined;
  const wfText = files[vis.workflow] ?? '';
  return hash(
    JSON.stringify({
      workflow: vis.workflow,
      workflowHash: wfText ? hash(wfText).slice(0, 16) : null,
      modality: vis.modality,
      params: vis.params,
    }),
  ).slice(0, 16);
}

function computeNodeUnbaked(
  node: FlowNode,
  files: Record<string, string>,
  assetsById: Map<string, Asset>,
): { visual: boolean; voice: boolean } {
  let visual = false;
  let voice = false;
  const vis =
    node.type === 'shot' ? node.visual : node.type === 'broll-overlay' ? node.visual : undefined;
  if (vis && vis.kind === 'workflow') {
    if (!vis.bakedAssetId || !assetsById.has(vis.bakedAssetId)) visual = true;
    else if (vis.bakedHash && vis.bakedHash !== visualExpectationHash(node, files)) visual = true;
  }
  if (node.type === 'shot' && node.voice?.kind === 'tts') {
    if (!node.voice.bakedAssetId || !assetsById.has(node.voice.bakedAssetId)) voice = true;
    else if (node.voice.bakedHash && node.voice.bakedHash !== voiceExpectationHash(node))
      voice = true;
  }
  return { visual, voice };
}

function computeNodeContentHash(
  node: FlowNode,
  files: Record<string, string>,
  project?: Project,
  scenes?: Scene[],
): string {
  const deps: Record<string, unknown> = {};
  const assetsById = new Map((project?.assets ?? []).map((a) => [a.id, a]));
  const scenesById = new Map((scenes ?? []).map((s) => [s.id, s]));
  const recordAsset = (id?: string) => {
    if (!id) return;
    const asset = assetsById.get(id);
    deps[`asset:${id}`] = asset
      ? {
          path: asset.path,
          fingerprint: asset.fingerprint ?? null,
          metadata: asset.metadata,
          soundHash: asset.soundSource && files[asset.soundSource] ? hash(files[asset.soundSource]) : null,
        }
      : null;
  };
  const recordVisual = (vis: FlowVisual) => {
    if (vis.kind === 'scene') {
      const s = scenesById.get(vis.sceneId);
      deps[`scene:${vis.sceneId}`] = s ? hash(JSON.stringify(s)) : null;
    } else if (vis.kind === 'component') {
      deps[`comp:${vis.source}`] = files[vis.source] ? hash(files[vis.source]) : null;
    } else if (vis.kind === 'asset') {
      recordAsset(vis.assetId);
    } else if (vis.kind === 'workflow') {
      recordAsset(vis.bakedAssetId);
      deps[`wf:${vis.workflow}`] = files[vis.workflow] ? hash(files[vis.workflow]) : null;
    }
  };
  if (node.type === 'shot') {
    recordVisual(node.visual);
    if (node.voice?.kind === 'asset') recordAsset(node.voice.assetId);
    else if (node.voice?.kind === 'tts') {
      recordAsset(node.voice.bakedAssetId);
      recordAsset(node.voice.voiceRefAssetId);
    }
    for (const ov of node.overlays) {
      recordAsset(ov.sfxAssetId);
      recordAsset(ov.assetId);
      if (ov.sceneId) {
        const s = scenesById.get(ov.sceneId);
        deps[`scene:${ov.sceneId}`] = s ? hash(JSON.stringify(s)) : null;
      }
    }
  } else if (node.type === 'transcript-cut') {
    recordAsset(node.assetId);
  } else if (node.type === 'beat-cut') {
    recordAsset(node.soundAssetId);
    for (const item of node.items) {
      if (item.kind === 'asset') recordAsset(item.refId);
      else {
        const s = scenesById.get(item.refId);
        deps[`scene:${item.refId}`] = s ? hash(JSON.stringify(s)) : null;
      }
    }
  } else if (node.type === 'broll-overlay') {
    recordVisual(node.visual);
  }
  return hash(JSON.stringify({ node, deps })).slice(0, 24);
}

export function resolveFlowBundle(
  files: Record<string, string>,
  flowPath: string,
  project?: Project,
  scenes?: Scene[],
): ResolvedFlowBundle {
  const normalizedPath = flowPath.replace(/\\/g, '/');
  const raw = files[normalizedPath];
  if (typeof raw !== 'string') {
    throw new VmotionError('FLOW_NOT_FOUND', `Flow resource "${normalizedPath}" does not exist`, {
      file: normalizedPath,
    });
  }
  const document = parseJsonWithError(normalizedPath, raw, (d) => flowDocumentSchema.parse(d));
  const nodesDir = flowNodesDir(normalizedPath);
  const dirPrefix = `${nodesDir}/`;
  const splitFiles = Object.keys(files)
    .filter((f) => f.startsWith(dirPrefix) && f.endsWith('.json'))
    .sort();

  const rawEntries = new Map<string, { node: FlowNode; file: string }>();
  if (document.nodes) {
    for (const [id, node] of Object.entries(document.nodes)) {
      rawEntries.set(id, { node, file: normalizedPath });
    }
  }
  for (const file of splitFiles) {
    const parsedNode = parseJsonWithError(
      file,
      files[file],
      (d) => flowNodeSchema.parse(d),
      'FLOW_NODE_DOCUMENT',
    );
    const expectedName = `${parsedNode.id}.json`;
    if (path.posix.basename(file) !== expectedName) {
      throw new VmotionError(
        'FLOW_NODE_FILENAME',
        `Split flow node file "${file}" must match its id ("${expectedName}")`,
        { file, id: parsedNode.id },
      );
    }
    if (rawEntries.has(parsedNode.id)) {
      throw new VmotionError(
        'FLOW_DUPLICATE_NODE',
        `Flow node "${parsedNode.id}" is defined both inline in ${normalizedPath} and in ${file}`,
        { file, flowPath: normalizedPath, nodeId: parsedNode.id },
      );
    }
    rawEntries.set(parsedNode.id, { node: parsedNode, file });
  }

  const spineSet = new Set(document.spine);
  const overlaySet = new Set(document.overlays);
  for (const id of document.spine) {
    if (!rawEntries.has(id)) {
      throw new VmotionError(
        'FLOW_MISSING_NODE',
        `Spine node "${id}" is missing (expected ${dirPrefix}${id}.json or inline in ${normalizedPath})`,
        { file: normalizedPath, nodeId: id, expectedFile: `${dirPrefix}${id}.json` },
      );
    }
  }
  for (const id of document.overlays) {
    if (!rawEntries.has(id)) {
      throw new VmotionError(
        'FLOW_MISSING_NODE',
        `Overlay node "${id}" is missing (expected ${dirPrefix}${id}.json or inline in ${normalizedPath})`,
        { file: normalizedPath, nodeId: id, expectedFile: `${dirPrefix}${id}.json` },
      );
    }
  }

  const assetsById = new Map((project?.assets ?? []).map((a) => [a.id, a]));
  const entries = new Map<string, ResolvedFlowNodeEntry>();
  const draftNodeIds: string[] = [];

  for (const [id, { node, file }] of rawEntries.entries()) {
    const resolvedNode = interpolateVariables(node, document.variables);
    const role: ResolvedFlowNodeEntry['role'] = spineSet.has(id)
      ? 'spine'
      : overlaySet.has(id)
        ? 'overlay'
        : 'draft';
    if (role === 'draft') draftNodeIds.push(id);
    entries.set(id, {
      node: resolvedNode,
      rawNode: node,
      file,
      role,
      contentHash: computeNodeContentHash(resolvedNode, files, project, scenes),
      unbaked: computeNodeUnbaked(resolvedNode, files, assetsById),
    });
  }

  const split = splitFiles.length > 0 || !document.nodes;
  const bundleHash = hash(
    JSON.stringify({
      flowPath: normalizedPath,
      doc: {
        id: document.id,
        name: document.name,
        spine: document.spine,
        overlays: document.overlays,
        variables: document.variables,
        soundBed: document.soundBed ?? null,
      },
      nodes: [...entries.entries()].map(([id, e]) => [id, e.role, e.contentHash, e.unbaked]),
    }),
  );

  return {
    flowPath: normalizedPath,
    nodesDir,
    split,
    document,
    entries,
    draftNodeIds,
    bundleHash,
  };
}

function secondsToFrame(seconds: number, fps: { num: number; den: number }): number {
  return Math.max(0, Math.round((seconds * fps.num) / fps.den));
}

function assetDurationSeconds(
  assetId: string | undefined,
  project: Project,
  files: Record<string, string>,
): number | undefined {
  if (!assetId) return undefined;
  const asset = project.assets.find((a) => a.id === assetId);
  if (!asset) return undefined;
  if (typeof asset.metadata?.duration === 'number' && Number.isFinite(asset.metadata.duration) && asset.metadata.duration > 0) {
    return asset.metadata.duration;
  }
  if (typeof asset.metadata?.durationSeconds === 'number' && Number.isFinite(asset.metadata.durationSeconds) && asset.metadata.durationSeconds > 0) {
    return asset.metadata.durationSeconds;
  }
  if (asset.soundSource && files[asset.soundSource]) {
    try {
      const sound = JSON.parse(files[asset.soundSource]) as {
        unit?: 'beats' | 'seconds';
        duration?: number;
        tail?: number;
        tempo?: Array<{ beat: number; bpm: number }>;
      };
      if (typeof sound.duration === 'number' && sound.duration > 0) {
        if (sound.unit === 'seconds') return sound.duration + (sound.tail ?? 0);
        const bpm = sound.tempo?.[0]?.bpm ?? 120;
        return (sound.duration * 60) / bpm + (sound.tail ?? 0);
      }
    } catch {}
  }
  return undefined;
}

function resolveSoundBpm(
  soundAssetId: string | undefined,
  project: Project,
  files: Record<string, string>,
): number | undefined {
  if (!soundAssetId) return undefined;
  const asset = project.assets.find((a) => a.id === soundAssetId);
  if (asset?.soundSource && files[asset.soundSource]) {
    try {
      const sound = JSON.parse(files[asset.soundSource]) as {
        tempo?: Array<{ beat: number; bpm: number }>;
      };
      const bpm = sound.tempo?.[0]?.bpm;
      if (typeof bpm === 'number' && bpm > 0) return bpm;
    } catch {}
  }
  if (typeof asset?.metadata?.bpm === 'number' && asset.metadata.bpm > 0) {
    return asset.metadata.bpm;
  }
  return undefined;
}

function dbToLinearGain(db: number): number {
  return Math.min(4, Math.max(0, Math.pow(10, db / 20)));
}

function makeSubtitleScene(
  id: string,
  text: string,
  durationFrames: number,
  project: Project,
  style: FlowSubtitle,
): Scene {
  const w = project.width;
  const h = project.height;
  const boxW = Math.round(w * 0.84);
  const boxH = Math.max(Math.round(style.fontSize * 2.1), 72);
  const x = Math.round((w - boxW) / 2);
  const y = Math.round(h * style.yRatio - boxH / 2);
  return sceneSchema.parse({
    id,
    name: `字幕 · ${text.slice(0, 24)}`,
    duration: Math.max(1, durationFrames),
    background: 'rgba(0,0,0,0)',
    nodes: [
      newNode({
        id: 'bg',
        type: 'rect',
        name: '字幕底条',
        x,
        y,
        width: boxW,
        height: boxH,
        radius: 12,
        fill: style.background,
      }),
      newNode({
        id: 'caption',
        type: 'text',
        name: '字幕文本',
        x: x + 24,
        y: y + Math.round((boxH - style.fontSize * 1.3) / 2),
        width: boxW - 48,
        height: Math.round(style.fontSize * 1.5),
        text,
        fontSize: style.fontSize,
        fontWeight: 600,
        align: 'center',
        fill: style.color,
      }),
    ],
  });
}

function makePlaceholderScene(
  id: string,
  title: string,
  subtitle: string,
  durationFrames: number,
  project: Project,
  bgColor: string,
): Scene {
  const w = project.width;
  const h = project.height;
  return sceneSchema.parse({
    id,
    name: title,
    duration: Math.max(1, durationFrames),
    background: bgColor,
    nodes: [
      newNode({
        id: 'card',
        type: 'rect',
        name: '待烘焙占位框',
        x: Math.round(w * 0.12),
        y: Math.round(h * 0.28),
        width: Math.round(w * 0.76),
        height: Math.round(h * 0.44),
        radius: 20,
        fill: 'rgba(255, 255, 255, 0.04)',
        stroke: '#74cbb8',
        strokeWidth: 2,
      }),
      newNode({
        id: 'title',
        type: 'text',
        name: '镜头标题',
        x: Math.round(w * 0.16),
        y: Math.round(h * 0.38),
        width: Math.round(w * 0.68),
        height: 64,
        text: title,
        fontSize: 42,
        fontWeight: 700,
        align: 'center',
        fill: '#f2f5fa',
      }),
      newNode({
        id: 'desc',
        type: 'text',
        name: '镜头意图',
        x: Math.round(w * 0.16),
        y: Math.round(h * 0.5),
        width: Math.round(w * 0.68),
        height: 96,
        text: subtitle,
        fontSize: 26,
        align: 'center',
        fill: '#9aa5b8',
      }),
    ],
  });
}

const COMPILE_CACHE_LIMIT = 64;
const compileCache = new Map<string, CompiledFlowResult>();

export interface FlowCompileContext {
  project: Project;
  scenes: Scene[];
  files: Record<string, string>;
}

export function compileFlow(
  bundle: ResolvedFlowBundle,
  context: FlowCompileContext,
): CompiledFlowResult {
  const { project, scenes, files } = context;
  const cacheKey = hash(
    JSON.stringify({
      bundleHash: bundle.bundleHash,
      fps: project.fps,
      width: project.width,
      height: project.height,
    }),
  );
  const cached = compileCache.get(cacheKey);
  if (cached) return structuredClone(cached);

  const flowId = bundle.document.id;
  const fps = project.fps;
  const scenesById = new Map(scenes.map((s) => [s.id, s]));

  const videoClipsA: Clip[] = [];
  const videoClipsB: Clip[] = [];
  let useVideoB = false;
  const overlayClips: Clip[] = [];
  const subtitleClips: Clip[] = [];
  const voiceClipsA: Clip[] = [];
  const voiceClipsB: Clip[] = [];
  let useVoiceB = false;
  const sfxClips: Clip[] = [];
  const markers: Sequence['markers'] = [];
  const virtualScenes: Array<{ file: string; originFile: string; scene: Scene }> = [];
  const placements: CompiledNodePlacement[] = [];
  const placementById = new Map<string, CompiledNodePlacement>();

  const registerVirtualScene = (originFile: string, scene: Scene): string => {
    virtualScenes.push({
      file: makeVirtualSceneFile(originFile, scene.id),
      originFile,
      scene,
    });
    return scene.id;
  };

  const resolveVisualClipTarget = (
    nodeId: string,
    originFile: string,
    vis: FlowVisual,
    durationFrames: number,
    intentText?: string,
  ): {
    sceneId?: string;
    assetId?: string;
    sourceIn: number;
    speed: number;
    audioEnabled?: boolean;
    volume?: number;
  } => {
    if (vis.kind === 'scene') {
      const targetScene = scenesById.get(vis.sceneId);
      if (vis.params && Object.keys(vis.params).length > 0 && targetScene) {
        const cloned = structuredClone(targetScene);
        cloned.id = `flow:${flowId}:${nodeId}:scene`;
        cloned.duration = Math.max(cloned.duration, durationFrames);
        for (const n of cloned.nodes) {
          if (n.type === 'component') {
            n.params = { ...n.params, ...vis.params };
          }
        }
        return {
          sceneId: registerVirtualScene(originFile, cloned),
          sourceIn: secondsToFrame(vis.sourceIn, fps),
          speed: vis.speed,
        };
      }
      return { sceneId: vis.sceneId, sourceIn: secondsToFrame(vis.sourceIn, fps), speed: vis.speed };
    }
    if (vis.kind === 'component') {
      const vId = `flow:${flowId}:${nodeId}:comp`;
      const scene = sceneSchema.parse({
        id: vId,
        name: `${nodeId} 组件镜头`,
        duration: Math.max(1, durationFrames),
        background: vis.background,
        nodes: [
          newNode({
            id: 'root',
            type: 'component',
            name: nodeId,
            x: 0,
            y: 0,
            width: project.width,
            height: project.height,
            component: vis.source,
            params: vis.params,
          }),
        ],
      });
      return { sceneId: registerVirtualScene(originFile, scene), sourceIn: 0, speed: 1 };
    }
    if (vis.kind === 'asset') {
      return {
        assetId: vis.assetId,
        sourceIn: secondsToFrame(vis.sourceIn, fps),
        speed: vis.speed,
        audioEnabled: vis.audioEnabled,
        volume: vis.volume,
      };
    }
    // vis.kind === 'workflow'
    if (vis.bakedAssetId && project.assets.some((a) => a.id === vis.bakedAssetId)) {
      const assetDur = assetDurationSeconds(vis.bakedAssetId, project, files);
      const shotSec = (durationFrames * fps.den) / fps.num;
      const speed =
        vis.fitPolicy === 'fit-speed' && assetDur && shotSec > 0
          ? Math.min(100, Math.max(0.05, assetDur / shotSec))
          : 1;
      return { assetId: vis.bakedAssetId, sourceIn: 0, speed, audioEnabled: false };
    }
    if (vis.fallbackSceneId && scenesById.has(vis.fallbackSceneId)) {
      return { sceneId: vis.fallbackSceneId, sourceIn: 0, speed: 1 };
    }
    const placeholder = makePlaceholderScene(
      `flow:${flowId}:${nodeId}:pending`,
      `[待烘焙 ${vis.modality === 'video' ? '视频' : '画面'}] ${nodeId}`,
      intentText ?? vis.workflow,
      durationFrames,
      project,
      vis.fallbackColor,
    );
    return { sceneId: registerVirtualScene(originFile, placeholder), sourceIn: 0, speed: 1 };
  };

  const emitSubtitleClips = (
    nodeId: string,
    originFile: string,
    shotStartSec: number,
    shotEndSec: number,
    subtitle: FlowSubtitle | undefined,
    fallbackText?: string,
    fallbackCues?: FlowCue[],
  ) => {
    if (!subtitle || subtitle.mode === 'none') return;
    const cues =
      subtitle.cues && subtitle.cues.length > 0
        ? subtitle.cues
        : subtitle.mode === 'from-voice' && fallbackCues && fallbackCues.length > 0
          ? fallbackCues
          : undefined;
    if (cues && cues.length > 0) {
      cues.forEach((cue, idx) => {
        const sFrame = secondsToFrame(shotStartSec + cue.start, fps);
        const eFrame = Math.min(
          secondsToFrame(shotEndSec, fps),
          Math.max(sFrame + 1, secondsToFrame(shotStartSec + cue.end, fps)),
        );
        if (eFrame <= sFrame) return;
        const subScene = makeSubtitleScene(
          `flow:${flowId}:${nodeId}:sub-${idx}`,
          cue.text,
          eFrame - sFrame,
          project,
          subtitle,
        );
        subtitleClips.push(
          clipSchema.parse({
            id: `flow/${flowId}/${nodeId}/sub-${idx}`,
            name: cue.text.slice(0, 24),
            sceneId: registerVirtualScene(originFile, subScene),
            start: sFrame,
            duration: eFrame - sFrame,
          }),
        );
      });
      return;
    }
    const text = subtitle.mode === 'custom' ? subtitle.text : (subtitle.text ?? fallbackText);
    if (!text?.trim()) return;
    const sFrame = secondsToFrame(shotStartSec, fps);
    const eFrame = Math.max(sFrame + 1, secondsToFrame(shotEndSec, fps));
    const subScene = makeSubtitleScene(
      `flow:${flowId}:${nodeId}:sub`,
      text.trim(),
      eFrame - sFrame,
      project,
      subtitle,
    );
    subtitleClips.push(
      clipSchema.parse({
        id: `flow/${flowId}/${nodeId}/sub`,
        name: text.trim().slice(0, 24),
        sceneId: registerVirtualScene(originFile, subScene),
        start: sFrame,
        duration: eFrame - sFrame,
      }),
    );
  };

  const defaultBpm =
    resolveSoundBpm(bundle.document.soundBed?.assetId, project, files) ?? 120;

  let cursorSeconds = 0;
  let prevDurationSeconds = 0;

  for (const nodeId of bundle.document.spine) {
    const entry = bundle.entries.get(nodeId)!;
    const { node, file } = entry;
    if (!node.enabled) continue;

    if (node.type === 'broll-overlay') {
      throw new VmotionError(
        'FLOW_ROLE_MISMATCH',
        `Node "${node.id}" has type "broll-overlay" and belongs in overlays[], not spine[]`,
        { file, nodeId: node.id },
      );
    }

    const transition = node.transitionIn;
    let overlapSeconds = 0;
    if (
      placements.length > 0 &&
      transition &&
      transition.type !== 'cut' &&
      transition.seconds > 0
    ) {
      overlapSeconds = Math.min(transition.seconds, prevDurationSeconds * 0.45);
    }

    const nodeStartSeconds = Math.max(0, cursorSeconds - overlapSeconds);

    if (node.chapter) {
      markers.push({
        id: `flow/${flowId}/chapter/${node.id}`,
        frame: secondsToFrame(nodeStartSeconds, fps),
        label: node.chapter,
        kind: 'chapter',
        group: `flow/${flowId}`,
      });
    }

    if (node.type === 'shot') {
      const shotDurationSec = resolveShotDurationSeconds(node, context, defaultBpm);
      if (overlapSeconds > shotDurationSec * 0.45) {
        overlapSeconds = shotDurationSec * 0.45;
      }
      const startSec = Math.max(0, cursorSeconds - overlapSeconds);
      const endSec = startSec + shotDurationSec;
      const startFrame = secondsToFrame(startSec, fps);
      const endFrame = Math.max(startFrame + 1, secondsToFrame(endSec, fps));
      const durFrames = endFrame - startFrame;
      const overlapFrames = secondsToFrame(overlapSeconds, fps);

      if (overlapFrames > 0) {
        const prevList = useVideoB ? videoClipsB : videoClipsA;
        const prevClip = prevList[prevList.length - 1];
        if (prevClip) {
          prevClip.fadeOut = Math.min(prevClip.duration, overlapFrames);
        }
        useVideoB = !useVideoB;
      }

      const target = resolveVisualClipTarget(
        node.id,
        file,
        node.visual,
        durFrames,
        node.intent ?? node.name,
      );
      const vClip = clipSchema.parse({
        id: `flow/${flowId}/${node.id}/v`,
        name: node.name ?? node.id,
        ...(target.sceneId ? { sceneId: target.sceneId } : { assetId: target.assetId }),
        start: startFrame,
        duration: durFrames,
        sourceIn: target.sourceIn,
        speed: target.speed,
        ...(target.audioEnabled !== undefined ? { audioEnabled: target.audioEnabled } : {}),
        ...(target.volume !== undefined ? { volume: target.volume } : {}),
        fadeIn: overlapFrames > 0 ? Math.min(durFrames, overlapFrames) : 0,
        linkedGroup: `flow/${flowId}/${node.id}`,
      });
      (useVideoB ? videoClipsB : videoClipsA).push(vClip);

      // Voice / TTS placement
      let voiceText: string | undefined;
      let voiceCues: FlowCue[] | undefined;
      if (node.voice) {
        const voiceStartSec = startSec + node.timing.padStart;
        if (node.voice.kind === 'asset') {
          voiceCues = node.voice.cues;
          const vDur =
            node.voice.duration ??
            assetDurationSeconds(node.voice.assetId, project, files) ??
            Math.max(0.2, shotDurationSec - node.timing.padStart - node.timing.padEnd);
          const vsFrame = secondsToFrame(voiceStartSec, fps);
          const veFrame = Math.max(vsFrame + 1, secondsToFrame(voiceStartSec + vDur, fps));
          voiceClipsA.push(
            clipSchema.parse({
              id: `flow/${flowId}/${node.id}/voice`,
              name: `${node.name ?? node.id} 配音`,
              assetId: node.voice.assetId,
              start: vsFrame,
              duration: veFrame - vsFrame,
              sourceIn: secondsToFrame(node.voice.sourceIn, fps),
              volume: node.voice.volume,
              fadeIn: secondsToFrame(node.voice.fadeIn, fps),
              fadeOut: secondsToFrame(node.voice.fadeOut, fps),
              linkedGroup: `flow/${flowId}/${node.id}`,
            }),
          );
        } else {
          voiceText = node.voice.text;
          voiceCues = node.voice.cues;
          const bakedVoiceId = node.voice.bakedAssetId;
          if (bakedVoiceId && project.assets.some((a) => a.id === bakedVoiceId)) {
            const vDur =
              assetDurationSeconds(bakedVoiceId, project, files) ??
              estimateSpeechSeconds(node.voice.text, node.voice.speed);
            const vsFrame = secondsToFrame(voiceStartSec, fps);
            const veFrame = Math.max(vsFrame + 1, secondsToFrame(voiceStartSec + vDur, fps));
            voiceClipsA.push(
              clipSchema.parse({
                id: `flow/${flowId}/${node.id}/voice`,
                name: `${node.name ?? node.id} TTS`,
                assetId: node.voice.bakedAssetId,
                start: vsFrame,
                duration: veFrame - vsFrame,
                volume: node.voice.volume,
                linkedGroup: `flow/${flowId}/${node.id}`,
              }),
            );
          }
        }
      }

      emitSubtitleClips(
        node.id,
        file,
        startSec + node.timing.padStart,
        endSec - node.timing.padEnd,
        node.subtitle,
        voiceText,
        voiceCues,
      );

      // Local relative overlays & SFX
      for (const att of node.overlays) {
        const relSec =
          att.atProgress !== undefined ? shotDurationSec * att.atProgress : att.atSeconds;
        const attStartSec = startSec + relSec;
        const attDurSec =
          att.durationSeconds ??
          assetDurationSeconds(att.sfxAssetId ?? att.assetId, project, files) ??
          Math.max(0.5, shotDurationSec - relSec);
        const asFrame = secondsToFrame(attStartSec, fps);
        const aeFrame = Math.max(asFrame + 1, secondsToFrame(attStartSec + attDurSec, fps));
        if (att.sfxAssetId) {
          sfxClips.push(
            clipSchema.parse({
              id: `flow/${flowId}/${node.id}/sfx-${att.id}`,
              name: att.id,
              assetId: att.sfxAssetId,
              start: asFrame,
              duration: aeFrame - asFrame,
              volume: dbToLinearGain(att.gainDb),
              linkedGroup: `flow/${flowId}/${node.id}`,
            }),
          );
        } else {
          overlayClips.push(
            clipSchema.parse({
              id: `flow/${flowId}/${node.id}/ov-${att.id}`,
              name: att.id,
              ...(att.sceneId ? { sceneId: att.sceneId } : { assetId: att.assetId }),
              start: asFrame,
              duration: aeFrame - asFrame,
              linkedGroup: `flow/${flowId}/${node.id}`,
            }),
          );
        }
      }

      const placement: CompiledNodePlacement = {
        nodeId: node.id,
        file,
        role: 'spine',
        startSeconds: startSec,
        endSeconds: endSec,
        startFrame,
        endFrame,
        durationFrames: durFrames,
        contentHash: entry.contentHash,
        unbaked: entry.unbaked,
      };
      placements.push(placement);
      placementById.set(node.id, placement);
      cursorSeconds = endSec;
      prevDurationSeconds = shotDurationSec;
      continue;
    }

    if (node.type === 'transcript-cut') {
      const byId = new Map(node.segments.map((s) => [s.id, s]));
      const kept = node.keepIds
        ? node.keepIds.map((id) => byId.get(id)!).filter(Boolean)
        : node.segments.filter((s) => s.keep);
      const maxSourceDur = assetDurationSeconds(node.assetId, project, files) ?? Infinity;
      const segmentSpans: NonNullable<CompiledNodePlacement['segmentSpans']> = {};
      let segCursor = nodeStartSeconds;

      kept.forEach((seg, idx) => {
        const srcStart = Math.max(0, seg.start - node.padStart);
        const srcEnd = Math.min(maxSourceDur, seg.end + node.padEnd);
        const segDur = Math.max(0.05, srcEnd - srcStart);
        const sFrame = secondsToFrame(segCursor, fps);
        const eFrame = Math.max(sFrame + 1, secondsToFrame(segCursor + segDur, fps));
        const vDurFrames = eFrame - sFrame;

        (useVideoB ? videoClipsB : videoClipsA).push(
          clipSchema.parse({
            id: `flow/${flowId}/${node.id}/seg-${idx}-v`,
            name: seg.text ? seg.text.slice(0, 24) : `${node.id}:${seg.id}`,
            assetId: node.assetId,
            start: sFrame,
            duration: vDurFrames,
            sourceIn: secondsToFrame(srcStart, fps),
            audioEnabled: false,
            linkedGroup: `flow/${flowId}/${node.id}/${seg.id}`,
          }),
        );

        // Separate audio clip to allow clean J-Cut / L-Cut audio extensions
        const jLead = idx > 0 ? Math.min(node.jCutSeconds, srcStart) : 0;
        const lTrail =
          idx < kept.length - 1
            ? Math.min(node.lCutSeconds, Math.max(0, maxSourceDur - srcEnd))
            : 0;
        const aStartSec = Math.max(0, segCursor - jLead);
        const aEndSec = segCursor + segDur + lTrail;
        const asFrame = secondsToFrame(aStartSec, fps);
        const aeFrame = Math.max(asFrame + 1, secondsToFrame(aEndSec, fps));
        const fadeFrames = secondsToFrame(Math.max(jLead, lTrail, 0.02), fps);
        if (jLead > 0 || lTrail > 0) useVoiceB = !useVoiceB;
        (useVoiceB ? voiceClipsB : voiceClipsA).push(
          clipSchema.parse({
            id: `flow/${flowId}/${node.id}/seg-${idx}-a`,
            name: `${node.id}:${seg.id} 对白`,
            assetId: node.assetId,
            start: asFrame,
            duration: aeFrame - asFrame,
            sourceIn: secondsToFrame(srcStart - jLead, fps),
            volume: node.volume,
            fadeIn: jLead > 0 ? Math.min(aeFrame - asFrame, fadeFrames) : 0,
            fadeOut: lTrail > 0 ? Math.min(aeFrame - asFrame, fadeFrames) : 0,
            linkedGroup: `flow/${flowId}/${node.id}/${seg.id}`,
          }),
        );

        if (node.subtitle && node.subtitle.mode !== 'none' && seg.text?.trim()) {
          emitSubtitleClips(
            `${node.id}-${seg.id}`,
            file,
            segCursor,
            segCursor + segDur,
            { ...node.subtitle, mode: 'custom', text: seg.text },
          );
        }

        segmentSpans[seg.id] = {
          startSeconds: segCursor,
          endSeconds: segCursor + segDur,
          startFrame: sFrame,
          endFrame: eFrame,
        };
        segCursor += segDur;
      });

      const totalSec = Math.max(0.1, segCursor - nodeStartSeconds);
      const startFrame = secondsToFrame(nodeStartSeconds, fps);
      const endFrame = Math.max(startFrame + 1, secondsToFrame(nodeStartSeconds + totalSec, fps));
      const placement: CompiledNodePlacement = {
        nodeId: node.id,
        file,
        role: 'spine',
        startSeconds: nodeStartSeconds,
        endSeconds: nodeStartSeconds + totalSec,
        startFrame,
        endFrame,
        durationFrames: endFrame - startFrame,
        contentHash: entry.contentHash,
        unbaked: entry.unbaked,
        segmentSpans,
      };
      placements.push(placement);
      placementById.set(node.id, placement);
      cursorSeconds = nodeStartSeconds + totalSec;
      prevDurationSeconds = totalSec;
      continue;
    }

    if (node.type === 'beat-cut') {
      const bpm =
        node.bpm ?? resolveSoundBpm(node.soundAssetId, project, files) ?? defaultBpm;
      let localBeats = 0;
      node.items.forEach((item, idx) => {
        const beats = item.beats ?? node.beatsPerCut;
        const itemStartSec = nodeStartSeconds + (localBeats * 60) / bpm;
        const itemEndSec = nodeStartSeconds + ((localBeats + beats) * 60) / bpm;
        const sFrame = secondsToFrame(itemStartSec, fps);
        const eFrame = Math.max(sFrame + 1, secondsToFrame(itemEndSec, fps));
        (useVideoB ? videoClipsB : videoClipsA).push(
          clipSchema.parse({
            id: `flow/${flowId}/${node.id}/beat-${idx}`,
            name: item.label ?? `${node.id}:${item.id}`,
            ...(item.kind === 'scene' ? { sceneId: item.refId } : { assetId: item.refId }),
            start: sFrame,
            duration: eFrame - sFrame,
            sourceIn: item.kind === 'asset' ? secondsToFrame(item.sourceIn, fps) : item.sourceIn,
            ...(item.kind === 'asset' ? { audioEnabled: false } : {}),
            linkedGroup: `flow/${flowId}/${node.id}`,
          }),
        );
        localBeats += beats;
      });
      const totalSec = Math.max(0.1, (localBeats * 60) / bpm);
      const startFrame = secondsToFrame(nodeStartSeconds, fps);
      const endFrame = Math.max(startFrame + 1, secondsToFrame(nodeStartSeconds + totalSec, fps));
      const placement: CompiledNodePlacement = {
        nodeId: node.id,
        file,
        role: 'spine',
        startSeconds: nodeStartSeconds,
        endSeconds: nodeStartSeconds + totalSec,
        startFrame,
        endFrame,
        durationFrames: endFrame - startFrame,
        contentHash: entry.contentHash,
        unbaked: entry.unbaked,
      };
      placements.push(placement);
      placementById.set(node.id, placement);
      cursorSeconds = nodeStartSeconds + totalSec;
      prevDurationSeconds = totalSec;
    }
  }

  // Second pass: anchored overlay nodes (e.g. broll-overlay)
  for (const ovId of bundle.document.overlays) {
    const entry = bundle.entries.get(ovId)!;
    const { node, file } = entry;
    if (!node.enabled) continue;
    if (node.type !== 'broll-overlay') {
      throw new VmotionError(
        'FLOW_ROLE_MISMATCH',
        `Node "${node.id}" has type "${node.type}" and belongs in spine[], not overlays[]`,
        { file, nodeId: node.id },
      );
    }
    const anchorTarget = placementById.get(node.anchor.nodeId);
    if (!anchorTarget) {
      throw new VmotionError(
        'FLOW_ANCHOR_MISSING',
        `B-roll node "${node.id}" anchors to missing or disabled spine node "${node.anchor.nodeId}"`,
        { file, nodeId: node.id, anchorNodeId: node.anchor.nodeId },
      );
    }
    const baseSpan = node.anchor.segmentId
      ? anchorTarget.segmentSpans?.[node.anchor.segmentId]
      : anchorTarget;
    if (!baseSpan) {
      throw new VmotionError(
        'FLOW_ANCHOR_SEGMENT_MISSING',
        `B-roll node "${node.id}" anchors to missing or removed segment "${node.anchor.segmentId}" on "${node.anchor.nodeId}"`,
        { file, nodeId: node.id, segmentId: node.anchor.segmentId },
      );
    }
    const startSec = Math.max(0, baseSpan.startSeconds + node.anchor.offsetSeconds);
    const durSec =
      node.anchor.durationSeconds ??
      Math.max(0.2, baseSpan.endSeconds - baseSpan.startSeconds - Math.max(0, node.anchor.offsetSeconds));
    const sFrame = secondsToFrame(startSec, fps);
    const eFrame = Math.max(sFrame + 1, secondsToFrame(startSec + durSec, fps));
    const durFrames = eFrame - sFrame;
    const target = resolveVisualClipTarget(
      node.id,
      file,
      node.visual,
      durFrames,
      node.intent ?? node.name,
    );
    overlayClips.push(
      clipSchema.parse({
        id: `flow/${flowId}/${node.id}/broll`,
        name: node.name ?? node.id,
        ...(target.sceneId ? { sceneId: target.sceneId } : { assetId: target.assetId }),
        start: sFrame,
        duration: durFrames,
        sourceIn: target.sourceIn,
        speed: target.speed,
        audioEnabled: false,
      }),
    );
    placements.push({
      nodeId: node.id,
      file,
      role: 'overlay',
      startSeconds: startSec,
      endSeconds: startSec + durSec,
      startFrame: sFrame,
      endFrame: eFrame,
      durationFrames: durFrames,
      contentHash: entry.contentHash,
      unbaked: entry.unbaked,
    });
  }

  const maxClipEnd = Math.max(
    1,
    secondsToFrame(cursorSeconds, fps),
    ...overlayClips.map((c) => c.start + c.duration),
    ...subtitleClips.map((c) => c.start + c.duration),
    ...voiceClipsA.map((c) => c.start + c.duration),
    ...voiceClipsB.map((c) => c.start + c.duration),
    ...sfxClips.map((c) => c.start + c.duration),
  );

  // Assemble clean non-empty tracks in bottom-to-top compositing order
  const tracks: Track[] = [];
  if (videoClipsA.length > 0 || tracks.length === 0) {
    tracks.push({
      id: `flow/${flowId}/video`,
      name: '主画面流',
      type: 'video',
      muted: false,
      clips: videoClipsA,
    });
  }
  if (videoClipsB.length > 0) {
    tracks.push({
      id: `flow/${flowId}/video-b`,
      name: '转场衔接轨',
      type: 'video',
      muted: false,
      clips: videoClipsB,
    });
  }
  if (overlayClips.length > 0) {
    tracks.push({
      id: `flow/${flowId}/overlay`,
      name: 'B-Roll 与挂件轨',
      type: 'video',
      muted: false,
      clips: overlayClips,
    });
  }
  if (subtitleClips.length > 0) {
    tracks.push({
      id: `flow/${flowId}/subtitles`,
      name: '流绑定字幕轨',
      type: 'video',
      muted: false,
      clips: subtitleClips,
    });
  }
  if (voiceClipsA.length > 0) {
    tracks.push({
      id: `flow/${flowId}/voice`,
      name: '配音与对白轨',
      type: 'audio',
      muted: false,
      clips: voiceClipsA,
    });
  }
  if (voiceClipsB.length > 0) {
    tracks.push({
      id: `flow/${flowId}/voice-b`,
      name: '对白交叠轨',
      type: 'audio',
      muted: false,
      clips: voiceClipsB,
    });
  }
  if (sfxClips.length > 0) {
    tracks.push({
      id: `flow/${flowId}/sfx`,
      name: '音效轨',
      type: 'audio',
      muted: false,
      clips: sfxClips,
    });
  }

  let mix: AudioMix | undefined;
  const bed = bundle.document.soundBed;
  if (bed) {
    const bedTrackId = `flow/${flowId}/bed`;
    tracks.push({
      id: bedTrackId,
      name: '全局背景音乐',
      type: 'audio',
      muted: false,
      clips: [
        clipSchema.parse({
          id: `flow/${flowId}/bed/main`,
          name: 'BGM',
          assetId: bed.assetId,
          start: 0,
          duration: maxClipEnd,
          sourceIn: secondsToFrame(bed.sourceIn, fps),
          volume: bed.volume,
          fadeIn: Math.min(maxClipEnd, secondsToFrame(bed.fadeInSeconds, fps)),
          fadeOut: Math.min(maxClipEnd, secondsToFrame(bed.fadeOutSeconds, fps)),
        }),
      ],
    });
    if (bed.ducking?.enabled && voiceClipsA.length > 0) {
      mix = audioMixSchema.parse({
        tracks: {
          [bedTrackId]: {
            ducking: {
              source: { type: 'track', id: `flow/${flowId}/voice` },
              thresholdDb: bed.ducking.thresholdDb,
              ratio: 6,
              kneeDb: 6,
              attack: bed.ducking.attackMs / 1000,
              release: bed.ducking.releaseMs / 1000,
              maxReductionDb: Math.abs(bed.ducking.reductionDb),
            },
          },
        },
      });
    }
  }

  const result: CompiledFlowResult = {
    flowId,
    flowPath: bundle.flowPath,
    durationFrames: maxClipEnd,
    durationSeconds: Number(((maxClipEnd * fps.den) / fps.num).toFixed(4)),
    tracks,
    markers,
    virtualScenes,
    mix,
    placements,
    draftNodeIds: bundle.draftNodeIds,
  };

  if (compileCache.size >= COMPILE_CACHE_LIMIT) {
    const oldest = compileCache.keys().next().value;
    if (oldest !== undefined) compileCache.delete(oldest);
  }
  compileCache.set(cacheKey, structuredClone(result));
  return result;
}

function resolveShotDurationSeconds(
  node: FlowShotNode,
  context: FlowCompileContext,
  defaultBpm: number,
): number {
  const { project, scenes, files } = context;
  const fps = project.fps;
  const t = node.timing;
  let raw = 3;

  if (t.mode === 'bars') {
    const bpm = t.bpm ?? defaultBpm;
    raw = ((t.bars ?? 4) * t.beatsPerBar * 60) / bpm;
  } else if (t.mode === 'follow-voice' && node.voice) {
    let voiceDur: number | undefined;
    if (node.voice.kind === 'asset') {
      voiceDur =
        node.voice.duration ?? assetDurationSeconds(node.voice.assetId, project, files);
    } else {
      voiceDur = node.voice.bakedAssetId
        ? assetDurationSeconds(node.voice.bakedAssetId, project, files)
        : undefined;
      if (voiceDur === undefined) {
        const lastCueEnd = node.voice.cues?.length
          ? Math.max(...node.voice.cues.map((c) => c.end))
          : undefined;
        voiceDur = lastCueEnd ?? estimateSpeechSeconds(node.voice.text, node.voice.speed);
      }
    }
    raw = (voiceDur ?? t.seconds ?? 3) + t.padStart + t.padEnd;
  } else if (t.mode === 'follow-visual') {
    let visDur: number | undefined;
    if (node.visual.kind === 'scene') {
      const targetSceneId = node.visual.sceneId;
      const sc = scenes.find((s) => s.id === targetSceneId);
      if (sc) visDur = (sc.duration * fps.den) / fps.num / node.visual.speed;
    } else if (node.visual.kind === 'asset') {
      const d =
        node.visual.duration ?? assetDurationSeconds(node.visual.assetId, project, files);
      if (d !== undefined) visDur = d / node.visual.speed;
    } else if (node.visual.kind === 'workflow' && node.visual.bakedAssetId) {
      visDur = assetDurationSeconds(node.visual.bakedAssetId, project, files);
    }
    raw = (visDur ?? t.seconds ?? 3) + t.padStart + t.padEnd;
  } else if (t.frames !== undefined) {
    raw = (t.frames * fps.den) / fps.num;
  } else if (t.seconds !== undefined) {
    raw = t.seconds;
  }

  // `extend-shot` policy for baked generative video longer than nominal shot duration
  if (
    node.visual.kind === 'workflow' &&
    node.visual.fitPolicy === 'extend-shot' &&
    node.visual.bakedAssetId
  ) {
    const bakedDur = assetDurationSeconds(node.visual.bakedAssetId, project, files);
    if (bakedDur !== undefined && bakedDur > raw) raw = bakedDur;
  }

  if (t.minSeconds !== undefined) raw = Math.max(t.minSeconds, raw);
  if (t.maxSeconds !== undefined) raw = Math.min(t.maxSeconds, raw);
  return Math.max(fps.den / fps.num, raw);
}

/**
 * Compiles ONE flow node in complete isolation (`0..nodeDuration`), allowing O(1) memory & CPU
 * pinpoint preview/verification without evaluating the rest of the film.
 */
export function compileSingleFlowNode(
  bundle: ResolvedFlowBundle,
  nodeId: string,
  context: FlowCompileContext,
): CompiledFlowResult {
  const entry = bundle.entries.get(nodeId);
  if (!entry) {
    throw new VmotionError('FLOW_MISSING_NODE', `Flow node "${nodeId}" does not exist`, {
      flowPath: bundle.flowPath,
      nodeId,
    });
  }
  if (entry.node.type === 'broll-overlay') {
    const anchorId = entry.node.anchor.nodeId;
    const subDoc: FlowDocument = {
      ...bundle.document,
      spine: [anchorId],
      overlays: [nodeId],
      soundBed: undefined,
    };
    return compileFlow({ ...bundle, document: subDoc, bundleHash: `${bundle.bundleHash}:single:${nodeId}` }, context);
  }
  const enabledEntry: ResolvedFlowNodeEntry = {
    ...entry,
    node: { ...entry.node, enabled: true, transitionIn: undefined } as FlowNode,
    role: 'spine',
  };
  const subEntries = new Map(bundle.entries);
  subEntries.set(nodeId, enabledEntry);
  const subDoc: FlowDocument = {
    ...bundle.document,
    spine: [nodeId],
    overlays: [],
    soundBed: undefined,
  };
  return compileFlow(
    {
      ...bundle,
      document: subDoc,
      entries: subEntries,
      bundleHash: `${bundle.bundleHash}:single:${nodeId}`,
    },
    context,
  );
}

export function diffFlowCompilations(
  before: CompiledFlowResult | undefined,
  after: CompiledFlowResult,
): FlowDiffSummary {
  const prevById = new Map((before?.placements ?? []).map((p) => [p.nodeId, p]));
  const nextById = new Map(after.placements.map((p) => [p.nodeId, p]));
  const dirtyNodes: string[] = [];
  const shiftedNodes: string[] = [];
  const addedNodes: string[] = [];
  const removedNodes: string[] = [];
  const unbakedNodes: string[] = [];
  const dirtyFrameRanges: FlowDiffSummary['dirtyFrameRanges'] = [];

  for (const p of after.placements) {
    if (p.unbaked.visual || p.unbaked.voice) unbakedNodes.push(p.nodeId);
    const prev = prevById.get(p.nodeId);
    if (!prev) {
      addedNodes.push(p.nodeId);
      dirtyNodes.push(p.nodeId);
      dirtyFrameRanges.push({ nodeId: p.nodeId, startFrame: p.startFrame, endFrame: p.endFrame });
    } else if (prev.contentHash !== p.contentHash) {
      dirtyNodes.push(p.nodeId);
      dirtyFrameRanges.push({ nodeId: p.nodeId, startFrame: p.startFrame, endFrame: p.endFrame });
    } else if (prev.startFrame !== p.startFrame || prev.endFrame !== p.endFrame) {
      shiftedNodes.push(p.nodeId);
    }
  }
  for (const id of prevById.keys()) {
    if (!nextById.has(id)) removedNodes.push(id);
  }
  return {
    dirtyNodes,
    shiftedNodes,
    addedNodes,
    removedNodes,
    unbakedNodes,
    dirtyFrameRanges,
  };
}
