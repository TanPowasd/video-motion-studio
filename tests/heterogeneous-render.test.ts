import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  analyzeSceneAffinity,
  analyzeSequenceScenes,
} from '../src/core/rendering/heterogeneous-scheduler.js';
import { RenderManager } from '../src/media/export.js';
import { ProjectService } from '../src/service/service.js';
import { compareRendering } from '../src/service/render-compare.js';
import { profileRendering } from '../src/service/render-profile.js';

describe('Heterogeneous GPU/CPU Split Rendering (split-tracks, split-scenes, auto)', () => {
  let root = '';
  let service: ProjectService;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vmotion-hetero-render-'));
    await mkdir(path.join(root, 'scenes'), { recursive: true });
    await mkdir(path.join(root, 'sequences'), { recursive: true });

    await writeFile(
      path.join(root, 'project.vmotion.json'),
      JSON.stringify(
        {
          formatVersion: 1,
          id: 'hetero-test-project',
          name: 'Heterogeneous Render Demo',
          width: 640,
          height: 360,
          fps: { num: 30, den: 1 },
          activeSequence: 'multi-track',
          scenes: ['scenes/gpu_backdrop.json', 'scenes/cpu_overlay.json'],
          sequences: ['sequences/multi_track.json', 'sequences/multi_scene.json'],
          assets: [],
        },
        null,
        2,
      ),
    );

    // Scene 1: GPU-affinity scene with point effects (levels, tint, invert)
    await writeFile(
      path.join(root, 'scenes/gpu_backdrop.json'),
      JSON.stringify(
        {
          id: 'gpu-backdrop',
          name: 'GPU Effect Backdrop',
          duration: 60,
          background: '#0f172a',
          nodes: [
            {
              id: 'gpu-card',
              name: 'Graded Backdrop Card',
              type: 'rect',
              x: 40,
              y: 30,
              width: 560,
              height: 300,
              radius: 24,
              fill: '#38bdf8',
              brightness: 1.15,
              saturation: 1.25,
              effects: [
                {
                  id: 'fx-levels',
                  type: 'levels',
                  inputBlack: 0.05,
                  inputWhite: 0.92,
                  gamma: 1.1,
                  outputBlack: 0,
                  outputWhite: 1,
                },
                {
                  id: 'fx-color',
                  type: 'color',
                  brightness: 1.1,
                  contrast: 1.15,
                  saturation: 1.2,
                  hue: 8,
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
    );

    // Scene 2: CPU-affinity scene with transparent background, vector paths, and anti-aliased typography
    await writeFile(
      path.join(root, 'scenes/cpu_overlay.json'),
      JSON.stringify(
        {
          id: 'cpu-overlay',
          name: 'CPU Typography & Vector Overlay',
          duration: 60,
          background: 'rgba(0, 0, 0, 0)',
          nodes: [
            {
              id: 'cpu-badge',
              name: 'Overlay Pill',
              type: 'rect',
              x: 72,
              y: 64,
              width: 220,
              height: 44,
              radius: 22,
              fill: '#1e293b',
            },
            {
              id: 'cpu-title',
              name: 'Overlay Title',
              type: 'text',
              text: 'Heterogeneous Split Compositor',
              x: 72,
              y: 128,
              width: 496,
              height: 72,
              fontSize: 34,
              fontWeight: 700,
              fill: '#f8fafc',
            },
            {
              id: 'cpu-subtitle',
              name: 'Overlay Subtitle',
              type: 'text',
              text: 'Zero-drift GPU track + CPU typography track',
              x: 72,
              y: 204,
              width: 496,
              height: 48,
              fontSize: 22,
              fill: '#cbd5e1',
            },
          ],
        },
        null,
        2,
      ),
    );

    // Sequence 1: Multi-track simultaneous composition (Track 1 = GPU backdrop, Track 2 = CPU overlay)
    await writeFile(
      path.join(root, 'sequences/multi_track.json'),
      JSON.stringify(
        {
          id: 'multi-track',
          name: 'Multi-Track Split Sequence',
          duration: 60,
          tracks: [
            {
              id: 'video-gpu',
              name: 'GPU Backdrop Track',
              type: 'video',
              muted: false,
              clips: [
                {
                  id: 'clip-gpu-bg',
                  sceneId: 'gpu-backdrop',
                  start: 0,
                  duration: 60,
                  sourceIn: 0,
                  sourceOut: 60,
                  fadeIn: 0,
                  fadeOut: 0,
                },
              ],
            },
            {
              id: 'video-cpu',
              name: 'CPU Overlay Track',
              type: 'video',
              muted: false,
              clips: [
                {
                  id: 'clip-cpu-fg',
                  sceneId: 'cpu-overlay',
                  start: 0,
                  duration: 60,
                  sourceIn: 0,
                  sourceOut: 60,
                  fadeIn: 6,
                  fadeOut: 0,
                },
              ],
            },
          ],
          markers: [],
        },
        null,
        2,
      ),
    );

    // Sequence 2: Multi-scene sequential timeline (Scene 1 = GPU backdrop 0..30, Scene 2 = CPU overlay 30..60)
    await writeFile(
      path.join(root, 'sequences/multi_scene.json'),
      JSON.stringify(
        {
          id: 'multi-scene',
          name: 'Multi-Scene Split Sequence',
          duration: 60,
          tracks: [
            {
              id: 'video-main',
              name: 'Main Video Track',
              type: 'video',
              muted: false,
              clips: [
                {
                  id: 'clip-scene-1',
                  sceneId: 'gpu-backdrop',
                  start: 0,
                  duration: 30,
                  sourceIn: 0,
                  sourceOut: 30,
                },
                {
                  id: 'clip-scene-2',
                  sceneId: 'cpu-overlay',
                  start: 30,
                  duration: 30,
                  sourceIn: 0,
                  sourceOut: 30,
                },
              ],
            },
          ],
          markers: [],
        },
        null,
        2,
      ),
    );

    service = await new ProjectService(root).open();
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('classifies GPU-heavy and CPU-heavy scenes and sequence tracks accurately', () => {
    const snapshot = service.snapshot;
    const gpuScene = snapshot.scenes.find((s) => s.id === 'gpu-backdrop')!;
    const cpuScene = snapshot.scenes.find((s) => s.id === 'cpu-overlay')!;

    const gpuReport = analyzeSceneAffinity(snapshot, gpuScene);
    expect(gpuReport.affinity).toBe('gpu');
    expect(gpuReport.gpuScore).toBeGreaterThan(gpuReport.cpuScore);
    expect(gpuReport.gpuOperators).toEqual(
      expect.arrayContaining(['colorAdjust', 'point:color', 'point:levels']),
    );
    expect(gpuReport.opaqueBackground).toBe(true);

    const cpuReport = analyzeSceneAffinity(snapshot, cpuScene);
    expect(cpuReport.affinity).toBe('cpu');
    expect(cpuReport.cpuScore).toBeGreaterThan(cpuReport.gpuScore);
    expect(cpuReport.cpuOperators).toEqual(expect.arrayContaining(['rect', 'text']));
    expect(cpuReport.opaqueBackground).toBe(false);

    const seqReport = analyzeSequenceScenes(
      snapshot,
      snapshot.sequences.find((s) => s.id === 'multi-scene')!,
    );
    expect(seqReport.gpuScenes).toEqual(['gpu-backdrop']);
    expect(seqReport.cpuScenes).toEqual(['cpu-overlay']);
  });

  it('renders multi-track sequences with split-tracks and auto schedules with zero pixel difference (maxDiff === 0) vs serial', async () => {
    // Frame 3 tests fade < 1 (offscreen surface path) and Frame 15 tests fade === 1 (transparent upper track over GPU backdrop)
    const compared = await compareRendering(root, service.snapshot, {
      sequenceId: 'multi-track',
      frames: [3, 15],
      width: 640,
      height: 360,
      repeat: 1,
      pixelTolerance: 0,
      baseline: {
        schedule: 'serial',
        gpu: 'cpu',
      },
      optimized: {
        schedule: 'split-tracks',
        gpu: 'cpu',
      },
      detail: true,
    });

    expect(compared.equivalence.matched).toBe(true);
    expect(compared.equivalence.mismatches).toBe(0);
    expect(compared.baseline.heterogeneous.effectiveSchedule).toBe('serial');
    expect(compared.optimized.heterogeneous).toMatchObject({
      requestedSchedule: 'split-tracks',
      effectiveSchedule: 'split-tracks',
      splitTrackFrames: 2,
      gpuTracks: ['video-gpu'],
      cpuTracks: ['video-cpu'],
      gpuScenes: ['gpu-backdrop'],
      cpuScenes: ['cpu-overlay'],
    });

    // Also verify schedule: 'auto' automatically selects 'split-tracks' on multi-track sequences
    const autoProfile = await profileRendering(root, service.snapshot, {
      sequenceId: 'multi-track',
      frames: [15],
      width: 640,
      height: 360,
      repeat: 1,
      schedule: 'auto',
    });
    expect(autoProfile.heterogeneous.effectiveSchedule).toBe('split-tracks');
    expect(autoProfile.frames?.[0]?.pixelHash).toBe(
      compared.optimized.samples?.[1]?.pixelHash,
    );
  });

  it('renders multi-scene sequences with split-scenes and auto schedules with zero pixel difference vs serial', async () => {
    const compared = await compareRendering(root, service.snapshot, {
      sequenceId: 'multi-scene',
      frames: [10, 40],
      width: 640,
      height: 360,
      repeat: 1,
      pixelTolerance: 0,
      baseline: {
        schedule: 'serial',
      },
      optimized: {
        schedule: 'split-scenes',
      },
      detail: true,
    });

    expect(compared.equivalence.matched).toBe(true);
    expect(compared.equivalence.mismatches).toBe(0);
    expect(compared.optimized.heterogeneous).toMatchObject({
      requestedSchedule: 'split-scenes',
      effectiveSchedule: 'split-scenes',
      splitSceneFrames: 2,
      gpuScenes: ['gpu-backdrop'],
      cpuScenes: ['cpu-overlay'],
    });

    const autoScenes = await profileRendering(root, service.snapshot, {
      sequenceId: 'multi-scene',
      frames: [10, 40],
      width: 640,
      height: 360,
      repeat: 1,
      schedule: 'auto',
    });
    expect(autoScenes.heterogeneous.effectiveSchedule).toBe('split-scenes');
  });

  it('records heterogeneous schedule telemetry in RenderManager export jobs', async () => {
    const manager = new RenderManager(root);
    try {
      const outDir = path.join(root, 'exports/hetero-frames');
      const job = manager.start(service.snapshot, {
        output: outDir,
        format: 'png',
        start: 0,
        end: 2,
        width: 320,
        height: 180,
        schedule: 'split-tracks',
      });
      const finished = await manager.wait(job.id);
      expect(finished.status).toBe('completed');
      expect(finished.heterogeneous).toBeDefined();
      expect(finished.heterogeneous?.effectiveSchedule).toBe('split-tracks');
      expect(finished.heterogeneous?.gpuTracks).toEqual(['video-gpu']);
      expect(finished.heterogeneous?.cpuTracks).toEqual(['video-cpu']);
    } finally {
      await manager.close();
    }
  });
});
