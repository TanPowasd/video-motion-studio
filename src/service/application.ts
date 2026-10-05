import { EventEmitter } from 'node:events';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ProjectService } from './service.js';
import { Renderer } from '../core/renderer.js';
import { RenderManager, type RenderOptions } from '../media/export.js';
import { collectAssets, validateSnapshot, safePath, atomicWrite } from './project.js';
import {
  nodeSchema,
  VmotionError,
  type Node,
  type Operation,
  type Snapshot,
} from '../core/model.js';
import type { CompositionDraft } from '../core/interaction.js';
import { compositionStructure } from './structure.js';
import {
  getDrawing,
  drawingEdit,
  publishDrawing,
  drawingFromAsset,
  drawingPreview,
} from './drawings.js';
import { drawingDocumentSchema } from '../core/drawing-model.js';
import { drawingFrame } from '../core/drawing-renderer.js';
import { placeAsset } from './assets.js';
import { probe, proxy, waveform } from '../media/ffmpeg.js';
import { importArtwork } from '../media/artwork.js';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { fingerprint } from '../media/ffmpeg.js';
import { performance } from 'node:perf_hooks';
import { animationReference } from '../sdk/reference.js';
import { analyzeAudio } from '../media/analysis.js';
import { parseCube } from '../sdk/post.js';
import { agentContext, readProjectFile } from './agent.js';
import { preflight } from './preflight.js';
import { projectSchemaInfo } from './schemas.js';
import { animationEdits, inspectAnimation } from './animation.js';
import { AudioPreview, audioMetrics } from '../media/audio-preview.js';
import { pcmWave, audioClips, AUDIO_SAMPLE_RATE, sampleAtFrame } from '../media/audio.js';
import { inspectComponentParameters, editComponentParameters } from './component-parameters.js';
import { visualAudit } from './visual-audit.js';
import { pathGeometry } from '../core/vector.js';
import { bakeVector } from './vector.js';
import { createRepeater } from './repeater.js';
import { describeRepeater } from '../sdk/repeater.js';
import {
  precompose,
  placeScene,
  inspectSceneReferences,
  resetSceneInstance,
} from './shared-scenes.js';
import { applyOperations } from './operations.js';
import { inspectContentTime, editContentTime } from './content-time.js';
import { sequenceEdits } from './editing.js';
import { importCaptions, inspectCaptions } from './captions.js';
import { inspectMedia, sampleMedia, checkAssets } from './media-evidence.js';
import { planSequence } from './sequence-plan.js';
import { linearAlgebra } from './linear-algebra.js';
import { agentGuide } from './agent-guide.js';
import { matrix3d } from './matrix3d.js';
import { inspectRasterScene } from './scene3d.js';
import { toolDefinitions } from '../mcp/catalog.js';
import { findTool } from '../mcp/discovery.js';
import { invokeTool, toolCallSchema } from '../mcp/invoke.js';
import { z } from 'zod';
import { resolveAgentPlan, storeAgentPlan } from './agent-plans.js';
import { materialEdits } from './materials3d.js';
import { effectGuide, inspectEffects, planEffects } from './effects2d.js';
import { generateMesh, importMesh, inspectMeshResource } from './meshes.js';
import { planVisualRepair } from './visual-repair.js';
import { motionTemplates, planMotion } from './motion-plan.js';
import { inspectParticles, planParticles } from './particle-field.js';
import { inspectEffectGraph, planEffectGraph } from './effect-graphs.js';
import { inspectDrivers, planDrivers, inspectCurve } from './drivers.js';
import {
  soundLibrary,
  inspectSound,
  planSound,
  previewSound,
  soundMidi,
  soundPreviewSchema,
} from './sound.js';
import { audioSourceFile } from '../media/sound-source.js';
import { inspectAudioMix, planAudioMix, auditAudio } from './audio-mixing.js';
import { profileRendering } from './render-profile.js';
import { planTransitions } from './transitions.js';
import { planStoryboard, inspectStoryboard } from './storyboards.js';
import { auditSequence } from './sequence-audit.js';
import { visualTemplates, planVisual } from './visual-library.js';
import { ProxyManager } from '../media/proxy-cache.js';
import {
  mediaStatus,
  planMediaRelink,
  proxyOperation,
  mediaProxySchema,
} from './media-management.js';
import { inspectCaches, planCacheCleanup, applyCacheCleanup } from './cache-management.js';
import { inspectGraphics, planGraphics } from './graphics.js';
import { designPlugin } from '../plugins/design.js';
import { mathPlugin } from '../plugins/math.js';
import { visualPlugin } from '../plugins/visual.js';
import { PluginRegistry, builtinPluginNames } from '../core/plugins.js';
import {
  inspectPlugins,
  packagePlugin,
  pluginCatalog,
  planPlugins,
  callPluginTool,
} from './plugins.js';
import { projectPluginTools } from '../mcp/plugin-tools.js';
import { TrackingManager, trackingAnalyzeSchema } from './tracking-jobs.js';
import { inspectTracking, planTracking, trackingEvidence } from './tracking.js';

export class Application extends EventEmitter {
  service: ProjectService;
  renderer: Renderer;
  renders: RenderManager;
  readonly audioPreview: AudioPreview;
  readonly proxies: ProxyManager;
  readonly tracking: TrackingManager;
  readonly plugins = new PluginRegistry();
  private readonly builtinTools = toolDefinitions();
  private pluginToolCache?: { hash: string; tools: ReturnType<typeof projectPluginTools> };
  private pluginDefinitions() {
    const catalog = pluginCatalog(this.plugins, this.service.snapshot, this.pluginToolCache?.hash);
    if (!catalog.notModified)
      this.pluginToolCache = { hash: catalog.catalogHash, tools: projectPluginTools(catalog) };
    return this.pluginToolCache!.tools;
  }
  private mediaTasks = 0;
  private activeRequests = 0;
  private cacheApplying = false;
  private mediaEpoch = 0;
  private publishedProxies = new Set<string>();
  private previewQueue: Promise<unknown> = Promise.resolve();
  private lastFrame?: {
    buffer: Buffer;
    revision: string;
    frame: number;
    media?: { quality: string; proxyCount: number; decodePixels: number };
  };
  private lastRgbaFrame?: {
    buffer: Buffer;
    revision: string;
    frame: number;
    width: number;
    height: number;
    media?: { quality: string; proxyCount: number; decodePixels: number };
  };
  private assetThumbnails = new Map<string, Promise<Buffer>>();
  constructor(readonly root: string) {
    super();
    this.service = new ProjectService(root);
    this.renderer = new Renderer(root);
    this.audioPreview = new AudioPreview(root);
    this.tracking = new TrackingManager(root, () => this.emit('tracking', this.tracking.status()));
    this.proxies = new ProxyManager(root, () => {
      this.emit('proxy', this.proxies.status());
      for (const job of this.proxies.jobs.values())
        if (job.status === 'completed' && !this.publishedProxies.has(job.id)) {
          this.publishedProxies.add(job.id);
          this.mediaEpoch++;
          this.emit('change', { ...this.service.state(), mediaEpoch: this.mediaEpoch });
        }
    });
    this.service.extraValidation = async (snapshot) => {
      try {
        const typed = this.renderer.components.typecheck(snapshot);
        if (typed.length) return typed;
        await this.renderer.components.validate(snapshot);
        return [];
      } catch (e) {
        return [
          {
            severity: 'error',
            code: e instanceof VmotionError ? e.code : 'COMPONENT_ERROR',
            message: (e as Error).message,
            ...(e instanceof VmotionError ? (e.details as object) : {}),
          },
        ];
      }
    };
    this.renders = new RenderManager(root, () =>
      this.emit('render', Array.from(this.renders.jobs.values())),
    );
    this.service.on('change', () => this.emit('change', this.service.state()));
  }
  private connection() {
    const dir = path.dirname(
        typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')
          ? fileURLToPath(import.meta.url)
          : String(import.meta.url),
      ),
      cli = path.resolve(dir, '../../dist/cli/index.mjs');
    return {
      command: process.execPath,
      args: [cli, 'mcp', '--project', path.resolve(this.root), '--tools', 'compact'],
      ...(process.versions.electron
        ? {
            env: {
              ELECTRON_RUN_AS_NODE: '1',
              VMOTION_NATIVE: process.env.VMOTION_NATIVE,
              VMOTION_SDK_SOURCE: process.env.VMOTION_SDK_SOURCE,
              ESBUILD_BINARY_PATH: process.env.ESBUILD_BINARY_PATH,
            },
          }
        : {}),
    };
  }
  async open(watch = true) {
    await this.service.open(watch);
    return this;
  }
  async frame(
    params: {
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
    } = {},
  ): Promise<{
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
  }> {
    if (this.cacheApplying)
      throw new VmotionError(
        'CACHE_BUSY',
        'Cache cleanup is active; retry the preview after it completes',
      );
    const task = this.previewQueue.then(async () => {
      try {
        const snapshot = params.draft
          ? await this.compositionDraft(
              this.service.snapshot,
              params.sceneId!,
              params.frame ?? 0,
              params.draft,
            )
          : this.service.snapshot;
        const start = performance.now(),
          canvas = await this.renderer.render(snapshot, params.frame ?? 0, params),
          renderMs = performance.now() - start;
        try {
          const encodedAt = performance.now(),
            format = params.format ?? 'png',
            width = canvas.width,
            height = canvas.height,
            buffer =
              format === 'rgba'
                ? Buffer.from(canvas.getContext('2d').getImageData(0, 0, width, height).data)
                : await canvas.encode('png'),
            encodeMs = performance.now() - encodedAt;
          const used = this.renderer.mediaInfo(),
            media = {
              quality: used.quality,
              proxyCount: used.uses.filter((u) => u.proxy).length,
              decodePixels: used.uses.reduce((n, u) => n + u.decodeWidth * u.decodeHeight, 0),
            };
          if (!params.draft) {
            if (format === 'rgba')
              this.lastRgbaFrame = {
                buffer,
                revision: snapshot.revision,
                frame: params.frame ?? 0,
                width,
                height,
                media,
              };
            else
              this.lastFrame = {
                buffer,
                revision: snapshot.revision,
                frame: params.frame ?? 0,
                media,
              };
          }
          return {
            buffer,
            stale: false,
            revision: snapshot.revision,
            frame: params.frame ?? 0,
            format,
            width,
            height,
            renderMs,
            encodeMs,
            media,
          };
        } finally {
          canvas.width = 1;
          canvas.height = 1;
        }
      } catch (e) {
        const previous = params.format === 'rgba' ? this.lastRgbaFrame : this.lastFrame;
        if (params.fallback && previous)
          return {
            ...previous,
            format: params.format ?? 'png',
            stale: true,
            error: (e as Error).message,
          };
        throw e;
      }
    });
    this.previewQueue = task.catch(() => {});
    return task;
  }
  private async compositionDraft(
    snapshot: Snapshot,
    sceneId: string,
    frame: number,
    draft: CompositionDraft | CompositionDraft[],
  ): Promise<Snapshot> {
    const operations = await this.compositionOperations(
      snapshot,
      sceneId,
      frame,
      Array.isArray(draft) ? draft : [draft],
    );
    const updates = new Map(
      operations.map((op) => {
        const update = op as Extract<Operation, { type: 'updateNode' }>;
        return [update.nodeId, update.patch];
      }),
    );
    return {
      ...snapshot,
      scenes: snapshot.scenes.map((scene) =>
        scene.id !== sceneId
          ? scene
          : {
              ...scene,
              nodes: scene.nodes.map((node) => {
                const patch = updates.get(node.id);
                return patch ? nodeSchema.parse({ ...node, ...patch, id: node.id }) : node;
              }),
            },
      ),
    };
  }
  private async compositionOperations(
    snapshot: Snapshot,
    sceneId: string,
    frame: number,
    edits: CompositionDraft[],
  ): Promise<Operation[]> {
    if (!Array.isArray(edits) || !edits.length || edits.length > 1000)
      throw new VmotionError('OPERATIONS', 'Expected 1–1000 composition edits');
    const scene = snapshot.scenes.find((s) => s.id === sceneId);
    if (!scene) throw new VmotionError('NOT_FOUND', 'Scene not found');
    const scopes = new Map<string, Awaited<ReturnType<Renderer['inspectComposition']>>>(),
      updates = new Map<string, Node>();
    for (const edit of edits) {
      const editFrame = edit.frame ?? frame,
        contextFrames = edit.contextFrames ?? [];
      const key = JSON.stringify([edit.path ?? [], editFrame, contextFrames]);
      if (!scopes.has(key))
        scopes.set(
          key,
          await this.renderer.inspectComposition(
            snapshot,
            sceneId,
            editFrame,
            edit.path ?? [],
            contextFrames,
          ),
        );
      const target = scopes.get(key)!.targets[edit.nodeId];
      if (!target) throw new VmotionError('NOT_FOUND', 'Composition layer not found');
      const id = target.kind === 'node' ? target.nodeId : target.rootNodeId,
        root = updates.get(id) ?? scene.nodes.find((n) => n.id === id);
      if (!root) throw new VmotionError('NOT_FOUND', 'Source layer not found');
      const changed =
        target.kind === 'node'
          ? { ...root, ...edit.patch, id: root.id }
          : {
              ...root,
              overrides: {
                ...root.overrides,
                [target.relativeId]: { ...root.overrides[target.relativeId], ...edit.patch },
              },
            };
      updates.set(id, nodeSchema.parse(changed));
    }
    return [...updates.values()].map((node) => ({
      type: 'updateNode',
      sceneId,
      nodeId: node.id,
      patch: node,
    }));
  }
  async dispatch(method: string, params: any = {}): Promise<any> {
    if (method === 'agentToolInvoke') return this.dispatchImpl(method, params);
    if (this.cacheApplying && !['state', 'ping', 'renderStatus', 'cacheInspect'].includes(method))
      throw new VmotionError('CACHE_BUSY', 'Cache cleanup is active; retry after it completes');
    this.activeRequests++;
    try {
      return await this.dispatchImpl(method, params);
    } finally {
      this.activeRequests--;
    }
  }
  private async dispatchImpl(method: string, params: any = {}): Promise<any> {
    if (designPlugin.methods.has(method))
      return designPlugin.dispatch(
        {
          root: this.root,
          renderer: this.renderer,
          snapshot: this.service.snapshot,
          edit: (s, scene, frame, edits) => this.compositionOperations(s, scene, frame, edits),
        },
        method,
        params,
      );
    if (mathPlugin.methods.has(method)) return mathPlugin.dispatch(method, params);
    if (visualPlugin.methods.has(method))
      return visualPlugin.dispatch(
        { renderer: this.renderer, snapshot: this.service.snapshot },
        method,
        params,
      );
    if (method.startsWith('plugin:')) {
      const [, id, toolId] = method.split(':');
      return callPluginTool(
        this.root,
        this.plugins,
        this.renderer,
        structuredClone(this.service.snapshot),
        id,
        toolId,
        params,
      );
    }
    switch (method) {
      case 'pluginCatalog':
        return pluginCatalog(this.plugins, this.service.snapshot, params.ifHash);
      case 'agentDefinitions':
        return pluginCatalog(this.plugins, this.service.snapshot, params.ifHash);
      case 'pluginsInspect': {
        const groups: Record<string, { name: string; tools: string[] }> = {};
        for (const tool of this.builtinTools) {
          const id = tool.plugin!.id;
          const entry = (groups[id] ??= { name: builtinPluginNames[id] ?? id, tools: [] });
          entry.tools.push(tool.name);
        }
        return inspectPlugins(this.plugins, this.service.snapshot, params, groups);
      }
      case 'pluginsPackage':
        return packagePlugin(this.plugins, this.service.snapshot, params);
      case 'pluginsPlan':
        return planPlugins(this.root, this.plugins, structuredClone(this.service.snapshot), params);
      case 'mediaStatus':
        return mediaStatus(this.root, this.service.snapshot, params);
      case 'trackingAnalyze': {
        const p = trackingAnalyzeSchema.parse(params);
        if (p.action === 'status') return this.tracking.status(p.id);
        if (p.action === 'cancel') {
          if (!p.id) throw new VmotionError('TRACKING_JOB', 'Cancel requires a job ID');
          return this.tracking.cancel(p.id);
        }
        if (!p.request)
          throw new VmotionError('TRACKING_REQUEST', 'Start requires an analysis request');
        const job = this.tracking.start(this.service.snapshot, p.request);
        return p.wait ? this.tracking.wait(job.id) : job;
      }
      case 'trackingInspect':
        return inspectTracking(this.root, this.service.snapshot, params);
      case 'trackingPlan':
        return planTracking(
          this.root,
          this.renderer,
          structuredClone(this.service.snapshot),
          params,
          (s, scene, frame, edits) => this.compositionOperations(s, scene, frame, edits),
        );
      case 'trackingEvidence':
        return this.withMediaTask(() =>
          trackingEvidence(this.root, structuredClone(this.service.snapshot), params),
        );
      case 'mediaRelinkPlan':
        return planMediaRelink(this.root, structuredClone(this.service.snapshot), params);
      case 'mediaProxy':
        params = mediaProxySchema.parse(params);
        if (params.revision && params.revision !== this.service.snapshot.revision)
          throw new VmotionError('REVISION_CONFLICT', 'Project changed before proxy operation');
        if (params.action === 'release') {
          if (
            this.renderer.busy ||
            this.audioPreview.busy ||
            this.mediaTasks ||
            this.tracking.active ||
            this.proxies.active ||
            [...this.renders.jobs.values()].some((j) => ['queued', 'running'].includes(j.status))
          )
            throw new VmotionError('CACHE_BUSY', 'Preview/media operations are active');
          this.cacheApplying = true;
          try {
            await this.renderer.clearMediaCache();
            return { released: true, projectChanged: false };
          } finally {
            this.cacheApplying = false;
          }
        }
        return proxyOperation(this.root, this.service.snapshot, this.proxies, params);
      case 'cacheInspect':
        return inspectCaches(this.root, params, this.service.snapshot);
      case 'cachePlan':
        return planCacheCleanup(this.root, params, this.service.snapshot);
      case 'cacheApply': {
        if (
          this.activeRequests > 1 ||
          this.mediaTasks ||
          this.tracking.active ||
          this.renderer.busy ||
          this.audioPreview.busy ||
          this.proxies.active ||
          [...this.renders.jobs.values()].some((j) => ['queued', 'running'].includes(j.status))
        )
          throw new VmotionError(
            'CACHE_BUSY',
            'Finish or cancel active media/render tasks before reclaiming caches',
          );
        this.cacheApplying = true;
        try {
          await this.renderer.clearMediaCache();
          this.audioPreview.clearCache();
          const result = await applyCacheCleanup(this.root, params, this.service.snapshot);
          this.mediaEpoch++;
          this.emit('change', { ...this.service.state(), mediaEpoch: this.mediaEpoch });
          return result;
        } finally {
          this.cacheApplying = false;
        }
      }
      case 'visualTemplates':
        return visualTemplates(params);
      case 'storyboardPlan':
        return planStoryboard(this.root, structuredClone(this.service.snapshot), params);
      case 'storyboardInspect':
        return inspectStoryboard(this.service.snapshot, params);
      case 'sequenceAudit': {
        const snapshot = await this.candidateSnapshot(params);
        return auditSequence(this.root, snapshot, { ...params, revision: snapshot.revision });
      }
      case 'transitionPlan':
        return planTransitions(this.root, structuredClone(this.service.snapshot), params);
      case 'renderProfile': {
        const snapshot = await this.candidateSnapshot(params);
        return this.withMediaTask(() =>
          profileRendering(this.root, snapshot, { ...params, revision: snapshot.revision }),
        );
      }
      case 'audioMixInspect':
        return inspectAudioMix(this.service.snapshot, params);
      case 'audioMixPlan':
        return planAudioMix(this.root, structuredClone(this.service.snapshot), params);
      case 'audioAudit': {
        const snapshot = await this.candidateSnapshot(params);
        return this.withMediaTask(() =>
          auditAudio(this.root, snapshot, { ...params, revision: snapshot.revision }),
        );
      }
      case 'soundLibrary':
        return soundLibrary(params);
      case 'soundInspect':
        return inspectSound(this.service.snapshot, params);
      case 'soundPlan':
        return planSound(this.root, structuredClone(this.service.snapshot), params);
      case 'soundMidi':
        return soundMidi(this.root, structuredClone(this.service.snapshot), params);
      case 'soundPreview': {
        const request = soundPreviewSchema.parse(params);
        let snapshot = structuredClone(this.service.snapshot);
        if (request.revision && request.revision !== snapshot.revision)
          throw new VmotionError('REVISION_CONFLICT', 'Project changed before sound audition');
        if (request.planId) {
          const input = await resolveAgentPlan(this.root, { planId: request.planId });
          if (input.revision !== snapshot.revision)
            throw new VmotionError(
              'REVISION_CONFLICT',
              'Sound candidate base changed; regenerate the plan',
            );
          snapshot = applyOperations(this.root, snapshot, [
            ...(input.operations ?? []),
            ...(input.files?.length ? [{ type: 'editFiles', edits: input.files }] : []),
          ]);
          await checkAssets(this.root, snapshot, input.assetChecks ?? []);
        }
        return this.withMediaTask(() =>
          previewSound(this.root, snapshot, { ...request, revision: snapshot.revision }),
        );
      }
      case 'effectsGuide':
        return effectGuide(params);
      case 'curvePath':
        return inspectCurve(params);
      case 'driversInspect':
        return inspectDrivers(this.renderer, this.service.snapshot, params);
      case 'driversPlan': {
        const snapshot = structuredClone(this.service.snapshot),
          planned = await planDrivers(
            this.root,
            this.renderer,
            snapshot,
            params,
            (candidate, sceneId, frame, edits) =>
              this.compositionOperations(candidate, sceneId, frame, edits),
          ),
          input = {
            revision: snapshot.revision,
            operations: planned.operations,
            samples: planned.samples,
            width: 320,
            determinism: true,
            visual: true,
          },
          stored =
            planned.request.delivery === 'stored'
              ? await storeAgentPlan(this.root, input)
              : undefined;
        return {
          baseRevision: snapshot.revision,
          candidateRevision: planned.candidate.revision,
          layers: planned.layers,
          coverage: planned.coverage,
          ...(stored ? { plan: stored } : {}),
          candidate: stored ? { planId: stored.planId } : input,
          apply: {
            ...(stored ? { planId: stored.planId } : input),
            expectedCandidateRevision: planned.candidate.revision,
          },
        };
      }
      case 'effectGraphInspect':
        return inspectEffectGraph(this.renderer, this.service.snapshot, params);
      case 'visualPlan':
      case 'effectGraphPlan': {
        const snapshot = structuredClone(this.service.snapshot),
          planned = await (method === 'visualPlan' ? planVisual : planEffectGraph)(
            this.root,
            this.renderer,
            snapshot,
            params,
            (candidate, sceneId, frame, edits) =>
              this.compositionOperations(candidate, sceneId, frame, edits),
          ),
          input = {
            revision: snapshot.revision,
            operations: planned.operations,
            samples: planned.samples,
            width: 320,
            visual: true,
            determinism: true,
          },
          stored =
            planned.request.delivery === 'stored'
              ? await storeAgentPlan(this.root, input)
              : undefined;
        return {
          baseRevision: snapshot.revision,
          candidateRevision: planned.candidate.revision,
          source: planned.source,
          layers: planned.layers,
          coverage: planned.coverage,
          summary: planned.summary,
          ...(stored ? { plan: stored } : {}),
          candidate: stored ? { planId: stored.planId } : input,
          apply: {
            ...(stored ? { planId: stored.planId } : input),
            expectedCandidateRevision: planned.candidate.revision,
          },
        };
      }
      case 'particlesInspect':
        return inspectParticles(params);
      case 'particlesPlan':
        return planParticles(
          this.root,
          this.renderer,
          structuredClone(this.service.snapshot),
          params,
        );
      case 'motionTemplates':
        return motionTemplates(this.service.snapshot, params);
      case 'motionPlan': {
        const snapshot = structuredClone(this.service.snapshot),
          planned = await planMotion(
            this.root,
            this.renderer,
            snapshot,
            params,
            (candidate, sceneId, frame, edits) =>
              this.compositionOperations(candidate, sceneId, frame, edits),
          ),
          input = {
            revision: snapshot.revision,
            operations: planned.operations,
            samples: planned.samples,
            visual: true,
            determinism: true,
            width: 320,
          },
          stored =
            planned.request.delivery === 'stored'
              ? await storeAgentPlan(this.root, input)
              : undefined;
        return {
          baseRevision: snapshot.revision,
          candidateRevision: planned.candidate.revision,
          layers: planned.layers,
          sources: planned.sources,
          savedTemplates: planned.savedTemplates,
          coverage: planned.coverage,
          ...(stored ? { plan: stored } : {}),
          candidate: stored ? { planId: stored.planId } : input,
          apply: {
            ...(stored ? { planId: stored.planId } : input),
            expectedCandidateRevision: planned.candidate.revision,
          },
        };
      }
      case 'effectsInspect':
        return inspectEffects(this.renderer, this.service.snapshot, params);
      case 'graphicsInspect':
        return inspectGraphics(this.renderer, this.service.snapshot, params);
      case 'graphicsPlan': {
        const snapshot = structuredClone(this.service.snapshot),
          planned = await planGraphics(this.renderer, snapshot, params),
          p = planned.request,
          operations = await this.compositionOperations(
            snapshot,
            p.sceneId,
            p.frame,
            planned.edits,
          ),
          candidate = applyOperations(this.root, snapshot, operations),
          input = {
            revision: snapshot.revision,
            operations,
            samples: planned.samples,
            width: 320,
            determinism: true,
            visual: true,
          },
          stored = p.delivery === 'stored' ? await storeAgentPlan(this.root, input) : undefined;
        return {
          baseRevision: snapshot.revision,
          candidateRevision: candidate.revision,
          layers: planned.layers,
          sampleCoverage: planned.coverage,
          ...(stored ? { plan: stored } : {}),
          candidate: stored ? { planId: stored.planId } : input,
          apply: {
            ...(stored ? { planId: stored.planId } : input),
            expectedCandidateRevision: candidate.revision,
          },
        };
      }
      case 'effectsPlan': {
        const snapshot = this.service.snapshot,
          planned = await planEffects(this.renderer, snapshot, params),
          p = planned.request,
          operations = await this.compositionOperations(
            snapshot,
            p.sceneId,
            p.frame,
            planned.edits,
          ),
          candidate = applyOperations(this.root, snapshot, operations),
          input = {
            revision: snapshot.revision,
            operations,
            samples: planned.samples,
            width: 320,
            determinism: true,
          },
          stored = p.delivery === 'stored' ? await storeAgentPlan(this.root, input) : undefined;
        return {
          baseRevision: snapshot.revision,
          candidateRevision: candidate.revision,
          layers: planned.layers,
          ...(stored ? { plan: stored } : {}),
          candidate: stored ? { planId: stored.planId } : input,
          apply: {
            ...(stored ? { planId: stored.planId } : input),
            expectedCandidateRevision: candidate.revision,
          },
        };
      }
      case 'scene3dMaterials': {
        const snapshot = this.service.snapshot,
          edited = await materialEdits(this.renderer, snapshot, params),
          p = edited.request;
        if (!edited.patch) return edited.report;
        const operations = await this.compositionOperations(snapshot, p.sceneId, p.frame, [
            { nodeId: p.nodeId, path: p.path, contextFrames: p.contextFrames, patch: edited.patch },
          ]),
          candidate = applyOperations(this.root, snapshot, operations),
          input = {
            revision: snapshot.revision,
            operations,
            samples: [
              { sceneId: p.sceneId, path: p.path, contextFrames: p.contextFrames, frame: p.frame },
            ],
            width: 320,
            determinism: true,
          },
          stored = p.delivery === 'stored' ? await storeAgentPlan(this.root, input) : undefined;
        return {
          ...edited.report,
          planned: edited.planned,
          baseRevision: snapshot.revision,
          candidateRevision: candidate.revision,
          ...(stored ? { plan: stored } : {}),
          candidate: stored ? { planId: stored.planId } : input,
          apply: {
            ...(stored ? { planId: stored.planId } : input),
            expectedCandidateRevision: candidate.revision,
          },
        };
      }
      case 'meshGenerate':
        return generateMesh(
          this.renderer,
          this.root,
          structuredClone(this.service.snapshot),
          params,
        );
      case 'meshImport':
        return importMesh(this.renderer, this.root, structuredClone(this.service.snapshot), params);
      case 'meshInspect':
        return inspectMeshResource(this.service.snapshot, params);
      case 'ping':
        return {
          revision: this.service.snapshot.revision,
          formatVersion: this.service.snapshot.project.formatVersion,
          aiIntegration: false,
        };
      case 'agentToolInvoke': {
        let request;
        try {
          request = toolCallSchema.extend({ inline: z.boolean().default(true) }).parse(params);
        } catch (e) {
          if (e instanceof z.ZodError)
            throw new VmotionError(
              'TOOL_ARGUMENTS',
              'Invalid agent tool invocation',
              e.issues.map((i) => ({ path: '/' + i.path.join('/'), message: i.message })),
            );
          throw e;
        }
        return invokeTool(
          findTool([...this.builtinTools, ...this.pluginDefinitions()], request.name),
          request.arguments,
          (method, args) => this.dispatch(method, args),
          { response: request.response, inline: request.inline },
        );
      }
      case 'scene3dRender':
        return inspectRasterScene(
          this.root,
          this.renderer,
          structuredClone(this.service.snapshot),
          params,
        );
      case 'matrix3d':
        return matrix3d(params);
      case 'agentGuide': {
        const guide = agentGuide(params);
        guide.discovery.availableCapabilities =
          this.builtinTools.length + this.pluginDefinitions().length;
        return guide;
      }
      case 'linearAlgebra':
        return linearAlgebra(params);
      case 'mediaInspect':
        return inspectMedia(this.root, structuredClone(this.service.snapshot), params);
      case 'mediaSample':
        return sampleMedia(this.root, structuredClone(this.service.snapshot), params);
      case 'sequencePlan':
        return planSequence(this.root, structuredClone(this.service.snapshot), params);
      case 'captionsImport': {
        const snapshot = this.service.snapshot,
          created = await importCaptions(snapshot, params),
          state = await this.service.transact(
            created.operations,
            created.request.revision ?? snapshot.revision,
          );
        return {
          ...state,
          captions: {
            dataFile: created.dataFile,
            componentFile: created.componentFile,
            sceneId: created.sceneId,
            trackId: created.trackId,
            clipId: created.clipId,
            count: created.document.cues.length,
          },
        };
      }
      case 'captionsInspect':
        return inspectCaptions(this.service.snapshot, params.dataFile, params.offset, params.limit);
      case 'sequenceEdit': {
        const snapshot = this.service.snapshot,
          edited = sequenceEdits(snapshot, params),
          state = await this.service.transact(
            [{ type: 'updateSequence', sequenceId: edited.sequence.id, patch: edited.sequence }],
            edited.request.revision ?? snapshot.revision,
          );
        return {
          ...state,
          edit: {
            selection: edited.selection,
            changes: edited.changes,
            duration: edited.sequence.duration,
          },
        };
      }
      case 'timeInspect':
        return inspectContentTime(this.renderer, this.service.snapshot, params);
      case 'timeEdit': {
        const snapshot = this.service.snapshot,
          edited = await editContentTime(this.renderer, snapshot, params);
        const operations = await this.compositionOperations(
          snapshot,
          edited.request.sceneId,
          edited.request.frame,
          [
            {
              nodeId: edited.nodeId,
              path: edited.request.path,
              contextFrames: edited.request.contextFrames,
              patch: edited.patch,
            },
          ],
        );
        const state = await this.service.transact(
          operations,
          edited.request.revision ?? snapshot.revision,
        );
        return { ...state, timing: edited.sample };
      }
      case 'sceneReferences':
        return inspectSceneReferences(this.service.snapshot, params.sourceId);
      case 'sceneReset': {
        const snapshot = this.service.snapshot,
          reset = await resetSceneInstance(this.renderer, snapshot, params);
        return this.service.transact(
          [reset.operation],
          reset.request.revision ?? snapshot.revision,
        );
      }
      case 'scenePrecompose': {
        const snapshot = this.service.snapshot,
          created = await precompose(this.root, this.renderer, snapshot, params);
        await this.service.transact(
          created.operations,
          created.request.revision ?? snapshot.revision,
        );
        this.service.selection = created.selection;
        this.emit('change', this.service.state());
        return {
          ...this.service.state(),
          sharedScene: {
            sourceId: created.sourceId,
            sourceFile: created.sourceFile,
            captureMode: created.captureMode,
            reordered: created.reordered,
            warnings: created.warnings,
          },
        };
      }
      case 'scenePlace': {
        const snapshot = this.service.snapshot,
          edit = await placeScene(this.renderer, snapshot, params);
        await this.service.transact(edit.operations, edit.request.revision ?? snapshot.revision);
        this.service.selection = edit.selection;
        this.emit('change', this.service.state());
        return this.service.state();
      }
      case 'repeatDescribe':
        return describeRepeater(params);
      case 'pathGeometry':
        return pathGeometry(params);
      case 'repeatCreate': {
        const snapshot = this.service.snapshot,
          created = await createRepeater(this.root, this.renderer, snapshot, params),
          request = created.request;
        let candidate = applyOperations(this.root, snapshot, created.operations);
        if (request.hideSources)
          candidate = applyOperations(
            this.root,
            candidate,
            await this.compositionOperations(
              candidate,
              request.sceneId,
              request.frame,
              created.sourceIds.map((nodeId) => ({
                path: request.path,
                contextFrames: request.contextFrames,
                nodeId,
                patch: { visible: false },
              })),
            ),
          );
        const scene = candidate.scenes.find((s) => s.id === request.sceneId)!;
        await this.service.transact(
          [
            created.operations[0],
            { type: 'updateScene', sceneId: request.sceneId, patch: { nodes: scene.nodes } },
          ],
          request.revision ?? snapshot.revision,
        );
        this.service.selection = created.selection;
        this.emit('change', this.service.state());
        return {
          ...this.service.state(),
          repeater: {
            sourceFile: created.sourceFile,
            parameters: created.parameters,
            sourceIds: created.sourceIds,
            sourceNodes: created.sourceNodes,
            generatedNodes: created.generatedNodes,
          },
        };
      }
      case 'vectorBake': {
        const snapshot = this.service.snapshot,
          baked = await bakeVector(this.renderer, snapshot, params),
          request = baked.request;
        const edit = await compositionStructure(
          this.renderer,
          snapshot,
          request.sceneId,
          request.frame,
          request.path,
          { type: 'add', node: baked.node },
          request.contextFrames,
        );
        let candidate = applyOperations(this.root, snapshot, edit.operations);
        if (request.hideSources)
          candidate = applyOperations(
            this.root,
            candidate,
            await this.compositionOperations(
              candidate,
              request.sceneId,
              request.frame,
              request.nodeIds.map((nodeId) => ({
                path: request.path,
                contextFrames: request.contextFrames,
                nodeId,
                patch: { visible: false },
              })),
            ),
          );
        const scene = candidate.scenes.find((s) => s.id === request.sceneId)!;
        await this.service.transact(
          [{ type: 'updateScene', sceneId: request.sceneId, patch: { nodes: scene.nodes } }],
          request.revision ?? snapshot.revision,
        );
        this.service.selection = edit.selection;
        this.emit('change', this.service.state());
        return { ...this.service.state(), geometry: baked.geometry, warnings: baked.warnings };
      }
      case 'visualAudit':
        return visualAudit(this.root, structuredClone(this.service.snapshot), params);
      case 'visualRepairPlan': {
        const snapshot = structuredClone(this.service.snapshot),
          planned = await planVisualRepair(
            this.root,
            this.renderer,
            snapshot,
            params,
            (candidate, edits) =>
              this.compositionOperations(candidate, params.sceneId, params.frame ?? 0, edits),
          ),
          input = {
            revision: snapshot.revision,
            operations: planned.operations,
            samples: planned.samples,
            visual: true,
            determinism: true,
            width: 320,
          },
          stored =
            planned.request.delivery === 'stored'
              ? await storeAgentPlan(this.root, input)
              : undefined;
        return {
          baseRevision: snapshot.revision,
          candidateRevision: planned.candidate.revision,
          changes: planned.changes,
          before: {
            summary: planned.before.summary,
            findings: planned.before.findings,
            diagnostics: planned.before.diagnostics,
          },
          after: {
            summary: planned.after.summary,
            findings: planned.after.findings,
            diagnostics: planned.after.diagnostics,
          },
          limitations: planned.limitations,
          ...(stored ? { plan: stored } : {}),
          candidate: stored ? { planId: stored.planId } : input,
          apply: {
            ...(stored ? { planId: stored.planId } : input),
            expectedCandidateRevision: planned.candidate.revision,
          },
        };
      }
      case 'audioTimeline': {
        const snapshot = this.service.snapshot,
          sequenceId = params.sequenceId ?? snapshot.project.activeSequence,
          clips = audioClips(snapshot, sequenceId),
          sequence = snapshot.sequences.find((s) => s.id === sequenceId)!;
        return {
          revision: snapshot.revision,
          sequenceId,
          sampleRate: AUDIO_SAMPLE_RATE,
          durationSamples: sampleAtFrame(sequence.duration, snapshot.project.fps),
          clips: clips.map((clip) => ({
            ...clip,
            asset: {
              id: clip.asset.id,
              name: clip.asset.name,
              type: clip.asset.type,
              path: clip.asset.path,
            },
            startSample: sampleAtFrame(clip.start, snapshot.project.fps),
            endSample: sampleAtFrame(clip.start + clip.duration, snapshot.project.fps),
          })),
        };
      }
      case 'audioPreview': {
        const snapshot = await this.candidateSnapshot(params),
          { output, inline, planId, ...request } = params,
          result = await this.audioPreview.range(snapshot, {
            ...request,
            revision: snapshot.revision,
          }),
          file = path.resolve(
            output ??
              safePath(
                this.root,
                `.vmotion/audio-preview/${result.revision}-${result.sequenceId}-${result.startSample}.wav`,
              ),
          ),
          buffer = pcmWave(result.buffer),
          metrics = audioMetrics(result.buffer);
        await atomicWrite(file, buffer);
        return {
          output: file,
          revision: result.revision,
          sequenceId: result.sequenceId,
          startSample: result.startSample,
          sampleCount: result.sampleCount,
          sampleRate: result.sampleRate,
          channels: result.channels,
          duration: result.duration,
          clipCount: result.clipCount,
          metrics,
          mimeType: 'audio/wav',
          ...(inline ? { data: buffer.toString('base64') } : {}),
        };
      }
      case 'animationInspect':
        return inspectAnimation(this.renderer, this.service.snapshot, params);
      case 'animationEdit': {
        const snapshot = this.service.snapshot,
          edit = await animationEdits(this.renderer, snapshot, params),
          operations = await this.compositionOperations(
            snapshot,
            edit.request.sceneId,
            edit.request.frame,
            edit.edits,
          );
        const state = await this.service.transact(
          operations,
          edit.request.revision ?? snapshot.revision,
        );
        return state;
      }
      case 'componentParameters': {
        const inspected = await inspectComponentParameters(
          this.renderer,
          this.service.snapshot,
          params,
        );
        return {
          nodeId: inspected.node.id,
          source: inspected.node.component,
          parameters: inspected.metadata.parameters,
          jsonSchema: inspected.metadata.jsonSchema,
          defaults: inspected.metadata.defaults,
          values: inspected.values,
          evaluated: inspected.evaluated,
          revision: inspected.revision,
          channels: inspected.channels,
          channelCount: inspected.total,
          truncated: inspected.truncated,
        };
      }
      case 'componentParametersEdit': {
        const snapshot = this.service.snapshot,
          edited = await editComponentParameters(this.renderer, snapshot, params),
          operations = await this.compositionOperations(
            snapshot,
            edited.request.sceneId,
            edited.request.frame,
            [
              {
                path: edited.request.path,
                contextFrames: edited.request.contextFrames,
                nodeId: edited.nodeId,
                patch: edited.patch,
              },
            ],
          );
        const state = await this.service.transact(
          operations,
          edited.request.revision ?? snapshot.revision,
        );
        return { ...state, parameterValues: edited.values };
      }
      case 'projectSchema':
        return projectSchemaInfo(params.name, params.operationType);
      case 'projectContext':
        return agentContext(this.service, params);
      case 'projectFileRead':
        return readProjectFile(this.service, params);
      case 'projectPreflight': {
        params = await resolveAgentPlan(this.root, params);
        return (
          await preflight(
            this.root,
            structuredClone({
              ...this.service.snapshot,
              files:
                params.version === 'pending'
                  ? (this.service.pendingFiles ?? this.service.snapshot.files)
                  : this.service.snapshot.files,
            }),
            params,
          )
        ).result;
      }
      case 'projectApply': {
        params = await resolveAgentPlan(this.root, params);
        if (this.service.pendingFiles && params.version !== 'pending')
          throw new VmotionError(
            'INVALID_ON_DISK',
            'Pending external files exist; read version=pending and preflight that version before applying repairs',
          );
        const { expectedCandidateRevision, ...input } = params,
          checked = await preflight(
            this.root,
            structuredClone({
              ...this.service.snapshot,
              files:
                params.version === 'pending'
                  ? (this.service.pendingFiles ?? this.service.snapshot.files)
                  : this.service.snapshot.files,
            }),
            input,
          );
        if (!checked.result.valid)
          throw new VmotionError(
            'VALIDATION_FAILED',
            'Preflight failed; no project changes saved',
            checked.result.diagnostics,
          );
        if (
          expectedCandidateRevision &&
          expectedCandidateRevision !== checked.result.candidateRevision
        )
          throw new VmotionError(
            'CANDIDATE_REVISION',
            'This candidate differs from the inspected preflight',
            { expected: expectedCandidateRevision, actual: checked.result.candidateRevision },
          );
        if (!checked.operations.length)
          return { ...checked.result, applied: false, revision: this.service.snapshot.revision };
        const state = await this.service.transact(
          checked.operations,
          checked.result.baseRevision,
          true,
          (candidate) => checkAssets(this.root, candidate, checked.result.assetChecks),
        );
        return {
          ...checked.result,
          applied: true,
          revision: state.snapshot.revision,
          canUndo: state.canUndo,
          canRedo: state.canRedo,
        };
      }
      case 'state':
        return {
          mediaEpoch: this.mediaEpoch,
          proxyJobs: [...this.proxies.jobs.values()].map((job) => ({ ...job })),
          ...this.service.state(),
          root: this.root,
          connection: this.connection(),
          jobs: Array.from(this.renders.jobs.values()),
          capabilities: {
            formatVersion: 1,
            renderer: 'Rust/Skia CPU (@napi-rs/canvas)',
            nativeAnimation: this.renderer.native.available,
            gpu: false,
            workspaces: ['animation', 'editing', 'drawing', 'code'],
            aiIntegration: false,
            animationTools: [
              'timing',
              'spring',
              'stagger',
              'motionPath',
              'pointMorph',
              'gradient',
              'textAnimator',
              'effectStack',
              'particles',
              'trail',
              'projection3D',
              'matrixScene3D',
              'depthRaster3D',
              'temporalMotionBlur',
              'multiFrameCapture',
            ],
          },
        };
      case 'drawingList':
        return this.service.snapshot.project.drawings;
      case 'assetThumbnail': {
        const buffer = await this.assetThumbnail(params.assetId, params.width, params.height),
          output = path.resolve(
            params.output ?? safePath(this.root, `.vmotion/frames/asset-${params.assetId}.png`),
          );
        await atomicWrite(output, buffer);
        return {
          output,
          assetId: params.assetId,
          revision: this.service.snapshot.revision,
          mimeType: 'image/png',
          ...(params.inline ? { data: buffer.toString('base64') } : {}),
        };
      }
      case 'assetPlace': {
        const snapshot = this.service.snapshot,
          placement = await placeAsset(this.renderer, snapshot, params);
        const state = await this.service.transact(
          placement.operations,
          params.revision ?? snapshot.revision,
        );
        return { ...state, ...placement, operations: undefined };
      }
      case 'drawingGet':
        return {
          document: getDrawing(this.service.snapshot, params.id),
          revision: this.service.snapshot.revision,
        };
      case 'drawingCreate': {
        const snapshot = this.service.snapshot,
          id = params.id ?? randomUUID(),
          document = drawingDocumentSchema.parse({
            id,
            name: params.name ?? '未命名画稿',
            width: params.width ?? snapshot.project.width,
            height: params.height ?? snapshot.project.height,
            layers: [{ id: randomUUID(), name: '图层 1', strokes: [] }],
          });
        if (snapshot.project.drawings.some((d) => d.id === id))
          throw new VmotionError('DUPLICATE_ID', '画稿 ID 已存在');
        return {
          ...(await this.service.transact(
            [{ type: 'writeDrawing', document }],
            params.revision ?? snapshot.revision,
          )),
          document,
        };
      }
      case 'drawingEdit':
        return drawingEdit(this.service, params.id, params.operations, params.revision);
      case 'drawingPublish':
        return publishDrawing(
          this.root,
          this.service,
          params.id,
          params.layerIds,
          params.name,
          params.revision,
        );
      case 'drawingOpenAsset': {
        const snapshot = this.service.snapshot,
          doc = await drawingFromAsset(this.root, snapshot, params.assetId),
          document = { ...doc, id: randomUUID(), name: doc.name + ' · 编辑' };
        return {
          ...(await this.service.transact(
            [{ type: 'writeDrawing', document }],
            params.revision ?? snapshot.revision,
          )),
          document,
        };
      }
      case 'drawingFrame': {
        const result = await drawingPreview(
            this.service.snapshot,
            params.id,
            params.width,
            params.height,
            params.draft,
          ),
          output = path.resolve(
            params.output ?? safePath(this.root, `.vmotion/frames/drawing-${params.id}.png`),
          );
        await atomicWrite(output, result.buffer);
        return {
          output,
          revision: result.revision,
          mimeType: 'image/png',
          ...(params.inline ? { data: result.buffer.toString('base64') } : {}),
        };
      }
      case 'transact':
        if (!Array.isArray(params.operations) || params.operations.length > 1000)
          throw new VmotionError('OPERATIONS', 'Expected 1–1000 operations');
        return this.service.transact(
          params.operations as Operation[],
          params.revision,
          params.save !== false,
        );
      case 'save':
        return this.service.save();
      case 'undo':
        return this.service.undo();
      case 'redo':
        return this.service.redo();
      case 'resolve':
        return this.service.resolve(params.index, params.choice);
      case 'selection':
        this.service.selection = Array.isArray(params.ids) ? params.ids : [];
        this.emit('change', this.service.state());
        return this.service.selection;
      case 'component':
        return this.renderer.components.describe(this.service.snapshot, params.source);
      case 'compositionInspect':
        return this.renderer.inspectComposition(
          this.service.snapshot,
          params.sceneId,
          params.frame ?? 0,
          params.path ?? [],
          params.contextFrames ?? [],
        );
      case 'compositionInteractions': {
        const graph = await this.renderer.inspectInteractions(
          this.service.snapshot,
          params.sceneId,
          params.frame ?? 0,
          params.path ?? [],
          { contextFrames: params.contextFrames ?? [] },
        );
        return params.nodeIds
          ? {
              ...graph,
              layers: graph.layers.filter((layer) => params.nodeIds.includes(layer.node.id)),
            }
          : graph;
      }
      case 'compositionTransact': {
        const snapshot = this.service.snapshot;
        return this.service.transact(
          await this.compositionOperations(snapshot, params.sceneId, params.frame ?? 0, [
            {
              path: params.path ?? [],
              contextFrames: params.contextFrames ?? [],
              nodeId: params.nodeId,
              patch: params.patch,
            },
          ]),
          params.revision ?? snapshot.revision,
        );
      }
      case 'compositionTransactBatch': {
        const snapshot = this.service.snapshot;
        return this.service.transact(
          await this.compositionOperations(
            snapshot,
            params.sceneId,
            params.frame ?? 0,
            params.edits,
          ),
          params.revision ?? snapshot.revision,
        );
      }
      case 'compositionStructure': {
        const snapshot = this.service.snapshot;
        const edit = await compositionStructure(
          this.renderer,
          snapshot,
          params.sceneId,
          params.frame ?? 0,
          params.path ?? [],
          params.action,
          params.contextFrames ?? [],
        );
        await this.service.transact(edit.operations, params.revision ?? snapshot.revision);
        this.service.selection = edit.selection;
        this.emit('change', this.service.state());
        return this.service.state();
      }
      case 'compositionStructureBatch': {
        if (!Array.isArray(params.actions) || !params.actions.length || params.actions.length > 100)
          throw new VmotionError('OPERATIONS', 'Expected 1–100 structure actions');
        const snapshot = structuredClone(this.service.snapshot),
          scene = snapshot.scenes.find((s) => s.id === params.sceneId);
        if (!scene) throw new VmotionError('NOT_FOUND', 'Scene not found');
        const selection: string[] = [];
        for (const action of params.actions) {
          const edit = await compositionStructure(
            this.renderer,
            snapshot,
            params.sceneId,
            action.frame ?? params.frame ?? 0,
            action.path ?? [],
            action.action,
            action.contextFrames ?? params.contextFrames ?? [],
          );
          for (const op of edit.operations) {
            if (op.type === 'updateScene') scene.nodes = op.patch.nodes!;
            else if (op.type === 'updateNode') {
              const index = scene.nodes.findIndex((n) => n.id === op.nodeId);
              scene.nodes[index] = nodeSchema.parse({ ...scene.nodes[index], ...op.patch });
            }
          }
          selection.push(...edit.selection);
        }
        await this.service.transact(
          [{ type: 'updateScene', sceneId: scene.id, patch: { nodes: scene.nodes } }],
          params.revision ?? snapshot.revision,
        );
        this.service.selection = [...new Set(selection)];
        this.emit('change', this.service.state());
        return this.service.state();
      }
      case 'guide':
        return animationReference;
      case 'importLut': {
        const scene = this.service.snapshot.scenes.find((s) => s.id === params.sceneId),
          node = scene?.nodes.find((n) => n.id === params.nodeId);
        if (!node) throw new VmotionError('NOT_FOUND', 'Target layer not found');
        const source = await readFile(path.resolve(params.path), 'utf8');
        if (source.length > 8 * 1024 * 1024)
          throw new VmotionError('LUT_SIZE', 'LUT file is too large');
        const effect = parseCube(source, params.intensity ?? 1);
        return this.service.transact(
          [
            {
              type: 'updateNode',
              sceneId: scene!.id,
              nodeId: node.id,
              patch: { effects: [...node.effects, effect] },
            },
          ],
          params.revision,
        );
      }
      case 'sample': {
        if (
          !Array.isArray(params.frames) ||
          !params.frames.length ||
          params.frames.length > 12 ||
          params.frames.some((n: unknown) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)
        )
          throw new VmotionError('SAMPLE_FRAMES', 'Expected 1–12 finite nonnegative frame numbers');
        const snapshot = structuredClone(this.service.snapshot),
          renderer = new Renderer(this.root),
          width = Math.round(params.width ?? 640),
          height = Math.round((width * snapshot.project.height) / snapshot.project.width);
        if (width < 160 || width > 800)
          throw new VmotionError('SAMPLE_SIZE', 'Contact-sheet frame width must be 160–800px');
        const columns = Math.min(4, params.frames.length),
          sheet = createCanvas(
            columns * width,
            Math.ceil(params.frames.length / columns) * (height + 30),
          ),
          ctx = sheet.getContext('2d');
        ctx.fillStyle = '#151a26';
        ctx.fillRect(0, 0, sheet.width, sheet.height);
        const samples: Array<{ frame: number; seconds: number; elapsedMs: number }> = [];
        try {
          for (const [index, frame] of params.frames.entries()) {
            const start = performance.now(),
              image = await renderer.render(snapshot, frame, {
                width,
                height,
                sceneId: params.sceneId,
                path: params.path,
              }),
              x = (index % columns) * width,
              y = Math.floor(index / columns) * (height + 30);
            ctx.drawImage(image, x, y);
            ctx.font = '14px "Microsoft YaHei"';
            ctx.fillStyle = '#c3ccdf';
            const seconds = (frame * snapshot.project.fps.den) / snapshot.project.fps.num;
            ctx.fillText(`${frame}f · ${seconds.toFixed(2)}s`, x + 10, y + height + 8);
            samples.push({ frame, seconds, elapsedMs: performance.now() - start });
          }
          const buffer = await sheet.encode('png'),
            output = path.resolve(
              params.output ?? safePath(this.root, `.vmotion/frames/sample-${randomUUID()}.png`),
            );
          await atomicWrite(output, buffer);
          return {
            output,
            revision: snapshot.revision,
            samples,
            mimeType: 'image/png',
            ...(params.inline ? { data: buffer.toString('base64') } : {}),
          };
        } finally {
          await renderer.close();
        }
      }
      case 'validate': {
        await this.service.exclusive(() => this.service.reload());
        const diagnostics = this.service.pendingFiles
          ? this.service.diagnostics
          : await this.service.validate(this.service.snapshot);
        try {
          await this.renderer.components.validate(this.service.snapshot);
        } catch (e) {
          diagnostics.push({
            severity: 'error',
            code: e instanceof VmotionError ? e.code : 'COMPONENT_ERROR',
            message: (e as Error).message,
            ...(e instanceof VmotionError ? (e.details as object) : {}),
          });
        }
        this.service.diagnostics = diagnostics;
        this.emit('change', this.service.state());
        return {
          valid: !diagnostics.some((d) => d.severity === 'error'),
          revision: this.service.snapshot.revision,
          diagnostics,
        };
      }
      case 'frame': {
        const { buffer, revision, frame } = await this.frame(params);
        const output = path.resolve(
          params.output ?? safePath(this.root, `.vmotion/frames/frame-${params.frame ?? 0}.png`),
        );
        await atomicWrite(output, buffer);
        return {
          output,
          revision,
          frame,
          mimeType: 'image/png',
          ...(params.inline ? { data: buffer.toString('base64') } : {}),
        };
      }
      case 'render':
        if (
          this.service.pendingFiles ||
          this.service.diagnostics.some((d) => d.severity === 'error')
        )
          throw new VmotionError(
            'VALIDATION_FAILED',
            'Fix project diagnostics before exporting; the last valid preview is preserved',
            this.service.diagnostics,
          );
        return this.renders.start(this.service.snapshot, {
          output: path.resolve(
            params.output ??
              path.join(this.root, 'exports', this.service.snapshot.project.name + '.mp4'),
          ),
          format: params.format ?? 'mp4',
          start: params.start,
          end: params.end,
          width: params.width,
          height: params.height,
          encoder: params.encoder,
          resume: params.resume,
          revision: params.revision,
        } as RenderOptions);
      case 'jobs':
        return Array.from(this.renders.jobs.values());
      case 'job': {
        const job = this.renders.jobs.get(params.id);
        if (!job) throw new VmotionError('NOT_FOUND', 'Job not found');
        return job;
      }
      case 'cancel':
        return this.renders.cancel(params.id);
      case 'pack':
        return collectAssets(this.root, params.output, this.service.snapshot);
      case 'import': {
        if (/\.(psd|ora)$/i.test(params.path)) {
          const artwork = await importArtwork(
            this.root,
            params.path,
            params.sceneId ?? this.service.snapshot.scenes[0].id,
          );
          const state = await this.service.transact(artwork.operations);
          this.service.diagnostics.push(
            ...artwork.warnings.map((message) => ({
              severity: 'warning' as const,
              code: 'ARTWORK_COMPATIBILITY',
              message,
              file: params.path,
            })),
          );
          this.emit('change', this.service.state());
          return {
            ...state,
            warnings: artwork.warnings,
            importedArtwork: {
              assetIds: artwork.operations.flatMap((op) =>
                op.type === 'addAsset' ? [op.asset.id] : [],
              ),
            },
          };
        }
        let metadata: Record<string, unknown> = {};
        if (params.type === 'audio' || params.type === 'video') {
          const info = await probe(path.resolve(params.path)),
            audio = info.streams.find((stream) => stream.codec_type === 'audio'),
            video = info.streams.find((stream) => stream.codec_type === 'video'),
            duration = Number(info.format.duration ?? audio?.duration ?? video?.duration);
          if (params.type === 'audio' && !audio)
            throw new VmotionError('NO_AUDIO', 'Selected media has no audio stream');
          if (params.type === 'video' && !video)
            throw new VmotionError('NO_VIDEO', 'Selected media has no video stream');
          metadata = {
            ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
            hasAudio: !!audio,
            ...(audio
              ? {
                  ...(Number.isFinite(Number(audio.sample_rate))
                    ? { sampleRate: Number(audio.sample_rate) }
                    : {}),
                  channels: audio.channels,
                }
              : {}),
            ...(video ? { width: video.width, height: video.height } : {}),
          };
        } else if (params.type === 'image') {
          const image = await loadImage(path.resolve(params.path));
          metadata = { width: image.width, height: image.height };
        }
        return this.service.importAsset(params.path, params.type, params.copy, metadata);
      }
      case 'drawingStroke': {
        const id = randomUUID(),
          file = `assets/drawing-${id}.json`;
        await atomicWrite(safePath(this.root, file), JSON.stringify({ points: params.points }));
        return this.service.transact([
          {
            type: 'addAsset',
            asset: {
              id,
              name: `Drawing ${id.slice(0, 6)}`,
              path: file,
              type: 'drawing',
              managed: true,
              metadata: {},
            },
          },
          {
            type: 'addNode',
            sceneId: params.sceneId,
            node: {
              id,
              type: 'drawing',
              name: 'Brush stroke',
              assetId: id,
              x: 0,
              y: 0,
              width: this.service.snapshot.project.width,
              height: this.service.snapshot.project.height,
              stroke: params.color,
              strokeWidth: params.width,
              start: params.start,
              end: params.end,
            },
          },
        ]);
      }
      case 'probe':
        return probe(await this.audioAssetPath(params.assetId));
      case 'waveform':
        return waveform(await this.audioAssetPath(params.assetId));
      case 'audioAnalyze': {
        if (params.duration !== undefined && (params.duration <= 0 || params.duration > 600))
          throw new VmotionError(
            'ANALYSIS_RANGE',
            'Request at most 600 seconds of audio per analysis call',
          );
        const analysis = await analyzeAudio(await this.audioAssetPath(params.assetId), {
          rate: params.rate,
          start: params.start,
          duration: params.duration ?? 60,
        });
        return { assetId: params.assetId, ...analysis };
      }
      case 'proxy': {
        const job = this.proxies.start(this.service.snapshot, params.assetId, 960),
          result = await this.proxies.wait(job.id);
        if (result.status !== 'completed')
          throw new VmotionError('PROXY_PROCESS', result.error ?? 'Proxy generation failed');
        return { output: result.output, jobId: job.id };
      }
      default:
        throw new VmotionError('METHOD_NOT_FOUND', `Unknown method: ${method}`);
    }
  }
  async drawingFrame(params: any) {
    return drawingPreview(
      this.service.snapshot,
      params.id,
      params.width,
      params.height,
      params.draft,
    );
  }
  async assetThumbnail(id: string, width = 160, height = 100) {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 16 ||
      height < 16 ||
      width > 512 ||
      height > 512
    )
      throw new VmotionError('RESOLUTION', '素材缩略图尺寸无效');
    const snapshot = this.service.snapshot,
      asset = snapshot.project.assets.find((a) => a.id === id);
    if (!asset) throw new VmotionError('NOT_FOUND', '素材不存在');
    const key = `${id}:${await fingerprint(path.resolve(this.root, asset.path))}:${snapshot.revision}:${width}:${height}`;
    if (!this.assetThumbnails.has(key)) {
      if (this.assetThumbnails.size >= 128)
        this.assetThumbnails.delete(this.assetThumbnails.keys().next().value!);
      const promise = (async () => {
        if (asset.type === 'drawing')
          return drawingFrame(
            await drawingFromAsset(this.root, snapshot, id),
            width,
            height,
            true,
          ).encode('png');
        if (asset.type === 'image') {
          const image = await loadImage(path.resolve(this.root, asset.path)),
            canvas = createCanvas(width, height),
            ctx = canvas.getContext('2d'),
            scale = Math.min(width / image.width, height / image.height);
          ctx.drawImage(
            image,
            (width - image.width * scale) / 2,
            (height - image.height * scale) / 2,
            image.width * scale,
            image.height * scale,
          );
          return canvas.encode('png');
        }
        if (asset.type === 'video') {
          const scene = {
            id: 'asset-thumbnail',
            name: asset.name,
            duration: 1,
            background: 'transparent',
            nodes: [
              nodeSchema.parse({
                id: 'thumbnail',
                type: 'video',
                assetId: id,
                width: snapshot.project.width,
                height: snapshot.project.height,
              }),
            ],
          };
          return (
            await this.renderer.render({ ...snapshot, scenes: [scene] }, 0, {
              sceneId: scene.id,
              width,
              height,
            })
          ).encode('png');
        }
        throw new VmotionError('ASSET_TYPE', '此素材没有视觉缩略图');
      })().catch((e) => {
        this.assetThumbnails.delete(key);
        throw e;
      });
      this.assetThumbnails.set(key, promise);
    }
    return this.assetThumbnails.get(key)!;
  }
  private async candidateSnapshot(params: {
    planId?: string;
    revision?: string;
  }): Promise<Snapshot> {
    let snapshot = structuredClone(this.service.snapshot);
    if (params.revision && params.revision !== snapshot.revision)
      throw new VmotionError('REVISION_CONFLICT', 'Project changed before candidate inspection');
    if (params.planId) {
      const input = await resolveAgentPlan(this.root, { planId: params.planId });
      if (input.revision !== snapshot.revision)
        throw new VmotionError('REVISION_CONFLICT', 'Candidate base changed; regenerate it');
      snapshot = applyOperations(this.root, snapshot, [
        ...(input.operations ?? []),
        ...(input.files?.length ? [{ type: 'editFiles', edits: input.files }] : []),
      ]);
      await checkAssets(this.root, snapshot, input.assetChecks ?? []);
    }
    return snapshot;
  }
  private async withMediaTask<T>(work: () => Promise<T>) {
    if (this.cacheApplying) throw new VmotionError('CACHE_BUSY', 'Cache cleanup is active');
    this.mediaTasks++;
    try {
      return await work();
    } finally {
      this.mediaTasks--;
    }
  }
  async audioRange(snapshot: Snapshot, params: unknown, signal?: AbortSignal) {
    return this.withMediaTask(() => this.audioPreview.range(snapshot, params, signal));
  }
  private assetPath(id: string) {
    const asset = this.service.snapshot.project.assets.find((a) => a.id === id);
    if (!asset) throw new VmotionError('NOT_FOUND', 'Asset not found');
    return path.resolve(this.root, asset.path);
  }
  private async audioAssetPath(id: string) {
    const snapshot = this.service.snapshot,
      asset = snapshot.project.assets.find((a) => a.id === id);
    if (!asset) throw new VmotionError('NOT_FOUND', 'Asset not found');
    return audioSourceFile(this.root, snapshot, asset);
  }
  async close() {
    this.plugins.clear();
    await this.service.close();
    await this.renders.close();
    await this.proxies.close();
    await this.tracking.close();
    await this.audioPreview.close();
    await this.previewQueue;
    this.lastFrame = undefined;
    this.lastRgbaFrame = undefined;
    await this.renderer.close();
  }
}
