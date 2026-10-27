import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { Clip, Node, Scene, Sequence, Snapshot, Track } from '../model.js';

export const RENDER_SCHEDULE_MODES = ['serial', 'auto', 'split-tracks', 'split-scenes'] as const;
export const renderScheduleSchema = z.enum(RENDER_SCHEDULE_MODES);
export type RenderScheduleMode = z.infer<typeof renderScheduleSchema>;

export type DeviceAffinity = 'gpu' | 'cpu';

export interface SceneAffinityReport {
  sceneId: string;
  affinity: DeviceAffinity;
  gpuScore: number;
  cpuScore: number;
  gpuOperators: string[];
  cpuOperators: string[];
  opaqueBackground: boolean;
  hasCrossLayerBlend: boolean;
}

export interface TrackAffinityReport {
  trackId: string;
  trackName: string;
  clipId: string;
  sourceType: 'scene' | 'sequence' | 'asset';
  sourceId: string;
  affinity: DeviceAffinity;
  gpuScore: number;
  cpuScore: number;
  gpuOperators: string[];
  cpuOperators: string[];
  canRenderOffscreen: boolean;
  reason: string;
}

export interface HeterogeneousFrameDispatch {
  frame: number;
  requestedSchedule: RenderScheduleMode;
  effectiveSchedule: 'serial' | 'split-tracks' | 'split-scenes';
  fallbackReason?: string;
  gpuTracks: string[];
  cpuTracks: string[];
  gpuScenes: string[];
  cpuScenes: string[];
  gpuLaneMs: number;
  cpuLaneMs: number;
  parallelOverlapMs: number;
  serialEstimateMs: number;
  wallMs: number;
}

export interface HeterogeneousReport {
  requestedSchedule: RenderScheduleMode;
  effectiveSchedule: 'serial' | 'split-tracks' | 'split-scenes';
  fallbackReason?: string;
  dispatches: number;
  splitTrackFrames: number;
  splitSceneFrames: number;
  serialFrames: number;
  gpuTracks: string[];
  cpuTracks: string[];
  gpuScenes: string[];
  cpuScenes: string[];
  gpuLaneMs: number;
  cpuLaneMs: number;
  parallelOverlapMs: number;
  serialEstimateMs: number;
  wallMs: number;
  speedupRatio: number;
  sceneAffinities: SceneAffinityReport[];
  trackAffinities: TrackAffinityReport[];
}

const GPU_POINT_EFFECTS = new Set([
  'color',
  'colorMatrix',
  'levels',
  'curves',
  'channelMixer',
  'chromaKey',
  'keyer',
  'lut3d',
  'gradientMap',
  'vignette',
  'grain',
  'threshold',
  'posterize',
  'invert',
  'tint',
  'exposure',
  'vibrance',
]);

export function isOpaqueCssColor(color: string | undefined): boolean {
  if (!color) return false;
  const trimmed = color.trim().toLowerCase();
  if (trimmed === 'transparent' || trimmed === 'none') return false;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(trimmed)) return true;
  if (/^#[0-9a-f]{8}$/i.test(trimmed)) {
    return trimmed.slice(7, 9).toLowerCase() === 'ff';
  }
  if (trimmed.startsWith('rgb(')) return true;
  if (trimmed.startsWith('rgba(')) {
    const parts = trimmed
      .slice(5, -1)
      .split(',')
      .map((s) => s.trim());
    const alpha = Number.parseFloat(parts[3] ?? '1');
    return Number.isFinite(alpha) && alpha >= 1;
  }
  return true;
}

function collectNodeAffinity(
  snapshot: Snapshot,
  nodes: Node[],
  visitedScenes = new Set<string>(),
): {
  gpuScore: number;
  cpuScore: number;
  gpuOperators: Set<string>;
  cpuOperators: Set<string>;
  hasCrossLayerBlend: boolean;
} {
  let gpuScore = 0;
  let cpuScore = 0;
  const gpuOperators = new Set<string>();
  const cpuOperators = new Set<string>();
  let hasCrossLayerBlend = false;

  for (const node of nodes) {
    if (!node.visible) continue;
    if (!node.parentId && node.blend !== 'source-over') {
      hasCrossLayerBlend = true;
    }
    if (node.type === 'program' || node.programSource) {
      gpuScore += 5;
      gpuOperators.add('program');
    } else if (node.type === 'text' || node.type === 'formula' || node.type === 'chart') {
      cpuScore += 3;
      cpuOperators.add(node.type);
    } else if (node.type === 'rect' || node.type === 'ellipse' || node.type === 'path') {
      cpuScore += 2;
      cpuOperators.add(node.type);
      if (node.shapeOperators && node.shapeOperators.length > 0) {
        cpuScore += 2;
        cpuOperators.add('shapeOperators');
      }
    } else if (node.type === 'component') {
      cpuScore += 4;
      cpuOperators.add('component');
    } else if (node.type === 'scene3d') {
      cpuScore += 4;
      cpuOperators.add('scene3d');
    } else if (node.type === 'drawing') {
      cpuScore += 3;
      cpuOperators.add('drawing');
    } else if (node.type === 'image' || node.type === 'video') {
      if (node.effects.length > 0 || node.brightness !== 1 || node.saturation !== 1 || node.blur > 0) {
        gpuScore += 2;
        gpuOperators.add(`${node.type}:raster`);
      } else {
        cpuScore += 2;
        cpuOperators.add(node.type);
      }
    } else if (node.type === 'scene' && node.sceneId && !visitedScenes.has(node.sceneId)) {
      visitedScenes.add(node.sceneId);
      const nested = snapshot.scenes.find((s) => s.id === node.sceneId);
      if (nested) {
        const sub = collectNodeAffinity(snapshot, nested.nodes, visitedScenes);
        gpuScore += sub.gpuScore;
        cpuScore += sub.cpuScore;
        for (const op of sub.gpuOperators) gpuOperators.add(op);
        for (const op of sub.cpuOperators) cpuOperators.add(op);
      }
    }

    if (node.brightness !== 1 || node.saturation !== 1) {
      gpuScore += 2;
      gpuOperators.add('colorAdjust');
    }
    if (node.blur > 0) {
      gpuScore += 2;
      gpuOperators.add('blur');
    }
    if (node.gradient) {
      gpuScore += 1;
      gpuOperators.add(`gradient:${node.gradient.type}`);
    }

    for (const effect of node.effects) {
      if (effect.enabled === false) continue;
      if (GPU_POINT_EFFECTS.has(effect.type)) {
        gpuScore += 4;
        gpuOperators.add(`point:${effect.type}`);
      } else if (effect.type === 'program') {
        gpuScore += 5;
        gpuOperators.add('effect:program');
      } else if (effect.type === 'effectGraph') {
        gpuScore += 4;
        gpuOperators.add('effectGraph');
      } else {
        gpuScore += 2;
        gpuOperators.add(`effect:${effect.type}`);
      }
    }
  }

  return { gpuScore, cpuScore, gpuOperators, cpuOperators, hasCrossLayerBlend };
}

/**
 * Analyze a `Scene`'s GPU vs CPU operator affinity.
 */
export function analyzeSceneAffinity(snapshot: Snapshot, scene: Scene): SceneAffinityReport {
  const visited = new Set<string>([scene.id]);
  const { gpuScore, cpuScore, gpuOperators, cpuOperators, hasCrossLayerBlend } = collectNodeAffinity(
    snapshot,
    scene.nodes,
    visited,
  );
  const affinity: DeviceAffinity = gpuScore > 0 && gpuScore >= cpuScore * 0.4 ? 'gpu' : 'cpu';
  const sameSize =
    (scene.width === undefined || scene.width === snapshot.project.width) &&
    (scene.height === undefined || scene.height === snapshot.project.height);
  return {
    sceneId: scene.id,
    affinity,
    gpuScore,
    cpuScore,
    gpuOperators: [...gpuOperators].sort(),
    cpuOperators: [...cpuOperators].sort(),
    opaqueBackground: sameSize && isOpaqueCssColor(scene.background),
    hasCrossLayerBlend,
  };
}

/**
 * Analyze an active track clip at a given sequence frame for heterogeneous GPU/CPU split rendering.
 */
export function analyzeTrackClipAffinity(
  snapshot: Snapshot,
  track: Track,
  clip: Clip,
  trackIndex: number,
  fade: number,
): TrackAffinityReport {
  if (clip.sceneId) {
    const scene = snapshot.scenes.find((s) => s.id === clip.sceneId);
    if (scene) {
      const report = analyzeSceneAffinity(snapshot, scene);
      // Track 0 (bottom-most) or any faded clip (fade < 1) or any full-frame opaque-background scene can render directly to an offscreen surface with 0 rounding drift
      const canRenderOffscreen = trackIndex === 0 || fade < 1 || report.opaqueBackground;
      return {
        trackId: track.id,
        trackName: track.name,
        clipId: clip.id,
        sourceType: 'scene',
        sourceId: scene.id,
        affinity: report.affinity,
        gpuScore: report.gpuScore,
        cpuScore: report.cpuScore,
        gpuOperators: report.gpuOperators,
        cpuOperators: report.cpuOperators,
        canRenderOffscreen,
        reason:
          report.affinity === 'gpu'
            ? `Scene ${scene.id} has GPU operators (${report.gpuOperators.join(', ')})`
            : `Scene ${scene.id} is CPU-bound (${report.cpuOperators.join(', ') || 'vector/typography'})`,
      };
    }
  }
  if (clip.sequenceId) {
    const nestedSeq = snapshot.sequences.find((s) => s.id === clip.sequenceId);
    let gpuScore = 0;
    let cpuScore = 0;
    const gpuOps = new Set<string>();
    const cpuOps = new Set<string>();
    if (nestedSeq) {
      for (const t of nestedSeq.tracks) {
        if (t.type !== 'video' || t.muted) continue;
        for (const c of t.clips) {
          if (c.sceneId) {
            const sc = snapshot.scenes.find((s) => s.id === c.sceneId);
            if (sc) {
              const r = analyzeSceneAffinity(snapshot, sc);
              gpuScore += r.gpuScore;
              cpuScore += r.cpuScore;
              for (const op of r.gpuOperators) gpuOps.add(op);
              for (const op of r.cpuOperators) cpuOps.add(op);
            }
          }
        }
      }
    }
    const affinity: DeviceAffinity = gpuScore > 0 && gpuScore >= cpuScore * 0.4 ? 'gpu' : 'cpu';
    return {
      trackId: track.id,
      trackName: track.name,
      clipId: clip.id,
      sourceType: 'sequence',
      sourceId: clip.sequenceId,
      affinity,
      gpuScore,
      cpuScore,
      gpuOperators: [...gpuOps].sort(),
      cpuOperators: [...cpuOps].sort(),
      canRenderOffscreen: trackIndex === 0 || fade < 1,
      reason: `Nested sequence ${clip.sequenceId} classified as ${affinity.toUpperCase()}`,
    };
  }
  const asset = snapshot.project.assets.find((a) => a.id === clip.assetId);
  const isDrawing = asset?.type === 'drawing';
  return {
    trackId: track.id,
    trackName: track.name,
    clipId: clip.id,
    sourceType: 'asset',
    sourceId: clip.assetId ?? 'unknown',
    affinity: isDrawing ? 'cpu' : 'gpu',
    gpuScore: isDrawing ? 0 : 2,
    cpuScore: isDrawing ? 3 : 0,
    gpuOperators: isDrawing ? [] : [`asset:${asset?.type ?? 'image'}`],
    cpuOperators: isDrawing ? ['drawing'] : [],
    canRenderOffscreen: trackIndex === 0 || fade < 1,
    reason: isDrawing ? 'Drawing asset rendered on CPU lane' : 'Raster media asset assigned to GPU lane',
  };
}

/**
 * Tracks heterogeneous GPU/CPU scheduling telemetry across frames in a `Renderer` instance.
 */
export class HeterogeneousTracker {
  requestedSchedule: RenderScheduleMode;
  private dispatches: HeterogeneousFrameDispatch[] = [];
  private sceneAffinities = new Map<string, SceneAffinityReport>();
  private trackAffinities = new Map<string, TrackAffinityReport>();

  constructor(schedule: RenderScheduleMode = 'serial') {
    this.requestedSchedule = schedule;
  }

  reset() {
    this.dispatches = [];
    this.sceneAffinities.clear();
    this.trackAffinities.clear();
  }

  recordSceneAffinity(report: SceneAffinityReport) {
    this.sceneAffinities.set(report.sceneId, report);
  }

  recordTrackAffinity(report: TrackAffinityReport) {
    this.trackAffinities.set(`${report.trackId}:${report.clipId}`, report);
  }

  recordDispatch(dispatch: HeterogeneousFrameDispatch) {
    this.dispatches.push(dispatch);
  }

  /**
   * Execute GPU lane tasks and CPU lane tasks concurrently and measure lane timings and overlap.
   */
  async runLanes<T>(
    gpuTasks: Array<{ id: string; run: () => Promise<T> }>,
    cpuTasks: Array<{ id: string; run: () => Promise<T> }>,
  ): Promise<{
    gpuResults: Map<string, T>;
    cpuResults: Map<string, T>;
    gpuLaneMs: number;
    cpuLaneMs: number;
    parallelOverlapMs: number;
    serialEstimateMs: number;
    wallMs: number;
  }> {
    const gpuResults = new Map<string, T>();
    const cpuResults = new Map<string, T>();
    const wallStart = performance.now();

    const runGpuLane = async () => {
      const start = performance.now();
      for (const task of gpuTasks) {
        gpuResults.set(task.id, await task.run());
      }
      return gpuTasks.length > 0 ? performance.now() - start : 0;
    };

    const runCpuLane = async () => {
      const start = performance.now();
      for (const task of cpuTasks) {
        cpuResults.set(task.id, await task.run());
      }
      return cpuTasks.length > 0 ? performance.now() - start : 0;
    };

    const [gpuLaneMs, cpuLaneMs] = await Promise.all([runGpuLane(), runCpuLane()]);
    const wallMs = performance.now() - wallStart;
    const serialEstimateMs = gpuLaneMs + cpuLaneMs;
    const parallelOverlapMs = Math.max(0, serialEstimateMs - wallMs);

    return {
      gpuResults,
      cpuResults,
      gpuLaneMs,
      cpuLaneMs,
      parallelOverlapMs,
      serialEstimateMs,
      wallMs,
    };
  }

  report(): HeterogeneousReport {
    const gpuTracks = new Set<string>();
    const cpuTracks = new Set<string>();
    const gpuScenes = new Set<string>();
    const cpuScenes = new Set<string>();
    let gpuLaneMs = 0;
    let cpuLaneMs = 0;
    let parallelOverlapMs = 0;
    let serialEstimateMs = 0;
    let wallMs = 0;
    let splitTrackFrames = 0;
    let splitSceneFrames = 0;
    let serialFrames = 0;

    for (const d of this.dispatches) {
      for (const t of d.gpuTracks) gpuTracks.add(t);
      for (const t of d.cpuTracks) cpuTracks.add(t);
      for (const s of d.gpuScenes) gpuScenes.add(s);
      for (const s of d.cpuScenes) cpuScenes.add(s);
      gpuLaneMs += d.gpuLaneMs;
      cpuLaneMs += d.cpuLaneMs;
      parallelOverlapMs += d.parallelOverlapMs;
      serialEstimateMs += d.serialEstimateMs;
      wallMs += d.wallMs;
      if (d.effectiveSchedule === 'split-tracks') splitTrackFrames++;
      else if (d.effectiveSchedule === 'split-scenes') splitSceneFrames++;
      else serialFrames++;
    }

    for (const sa of this.sceneAffinities.values()) {
      if (sa.affinity === 'gpu') gpuScenes.add(sa.sceneId);
      else cpuScenes.add(sa.sceneId);
    }
    for (const ta of this.trackAffinities.values()) {
      if (ta.affinity === 'gpu') gpuTracks.add(ta.trackId);
      else cpuTracks.add(ta.trackId);
    }

    const effectiveSchedule: 'serial' | 'split-tracks' | 'split-scenes' =
      splitTrackFrames > 0
        ? 'split-tracks'
        : splitSceneFrames > 0
          ? 'split-scenes'
          : 'serial';
    const fallbackReason =
      this.requestedSchedule !== 'serial' && effectiveSchedule === 'serial'
        ? (this.dispatches.find((d) => d.fallbackReason)?.fallbackReason ?? 'single-unit-workload')
        : undefined;
    const speedupRatio =
      wallMs > 0 && serialEstimateMs > 0
        ? Number(Math.max(1, serialEstimateMs / wallMs).toFixed(3))
        : 1;

    return {
      requestedSchedule: this.requestedSchedule,
      effectiveSchedule,
      ...(fallbackReason ? { fallbackReason } : {}),
      dispatches: this.dispatches.length,
      splitTrackFrames,
      splitSceneFrames,
      serialFrames,
      gpuTracks: [...gpuTracks].sort(),
      cpuTracks: [...cpuTracks].sort(),
      gpuScenes: [...gpuScenes].sort(),
      cpuScenes: [...cpuScenes].sort(),
      gpuLaneMs: Number(gpuLaneMs.toFixed(3)),
      cpuLaneMs: Number(cpuLaneMs.toFixed(3)),
      parallelOverlapMs: Number(parallelOverlapMs.toFixed(3)),
      serialEstimateMs: Number(serialEstimateMs.toFixed(3)),
      wallMs: Number(wallMs.toFixed(3)),
      speedupRatio,
      sceneAffinities: [...this.sceneAffinities.values()],
      trackAffinities: [...this.trackAffinities.values()],
    };
  }
}

/**
 * Analyze all scenes in a sequence and partition them into GPU-affinity and CPU-affinity sets.
 */
export function analyzeSequenceScenes(
  snapshot: Snapshot,
  sequence: Sequence,
): {
  sceneAffinities: SceneAffinityReport[];
  gpuScenes: string[];
  cpuScenes: string[];
} {
  const seen = new Set<string>();
  const sceneAffinities: SceneAffinityReport[] = [];
  for (const track of sequence.tracks) {
    if (track.type !== 'video' || track.muted) continue;
    for (const clip of track.clips) {
      if (clip.sceneId && !seen.has(clip.sceneId)) {
        seen.add(clip.sceneId);
        const scene = snapshot.scenes.find((s) => s.id === clip.sceneId);
        if (scene) {
          sceneAffinities.push(analyzeSceneAffinity(snapshot, scene));
        }
      }
    }
  }
  return {
    sceneAffinities,
    gpuScenes: sceneAffinities.filter((s) => s.affinity === 'gpu').map((s) => s.sceneId),
    cpuScenes: sceneAffinities.filter((s) => s.affinity === 'cpu').map((s) => s.sceneId),
  };
}
