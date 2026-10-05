import { TypographyLayout, invalidateTypographyFonts } from './typography.js';
import { GeometryCache } from './geometry-cache.js';
import { ThemeResolver } from './theme.js';
import { TemplateResolver } from './template-resource.js';
import { SurfacePool } from './surface-pool.js';
import {
  createCanvas,
  loadImage,
  GlobalFonts,
  ImageData,
  type Canvas,
  type SKRSContext2D,
  type Image,
} from '@napi-rs/canvas';
import path, { resolve as pathResolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import { ComponentHost } from './components.js';
import { evaluateNode, frameSeconds } from './time.js';
import { nodeSchema, VmotionError, type Snapshot, type Scene, type Node } from './model.js';
import { VideoDecoder, fingerprint } from '../media/ffmpeg.js';
import { NativeEvaluator } from './native.js';
import { lumaMatte } from './pixels.js';
import { rasterPass } from './raster-pass.js';
import { resolveEffectGraph } from './effect-graph.js';
import { renderEffectGraph } from './effect-graph-render.js';
import { evaluateDrivers, hasDrivers, type DriverContext } from './drivers.js';
import { analyzeAudio, audioAt, type AudioAnalysis } from '../media/analysis.js';
import { audioSourceFile } from '../media/sound-source.js';
import { videoProxy, useCacheFile } from '../media/proxy-cache.js';
import { composeGenerated, isolateGroup, prefixNodes } from './composition.js';
import { normalizeDrawing, paintDrawing, drawingInkBounds } from './drawing-renderer.js';
import { shapePath, shapeBounds } from './vector.js';
import { contentTiming, timeControlled, contextFramesSchema } from './content-time.js';
import { clipGain, clipSourceFrame } from './clip-window.js';
import { prepareRasterScene } from './raster3d.js';
import { resolveSceneMeshes } from './mesh-resources.js';
import {
  temporalActive,
  temporalEffectSchema,
  temporalSamples,
  TemporalPixels,
} from './temporal-effect.js';
import { evaluateScene3D, type MeshInstance3D } from '../sdk/matrix3d.js';
import {
  cameraMatrix,
  inverse,
  multiply,
  nodeMatrix,
  transform,
  type Bounds,
  type InteractionLayer,
  type Matrix,
} from './interaction.js';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const math = mathjax.document('', {
  InputJax: new TeX({ packages: AllPackages }),
  OutputJax: new SVG({ fontCache: 'none' }),
});
export type RenderDriverScope = Pick<DriverContext, 'width' | 'height' | 'duration'> & {
  group?: { id: string; sourceAt: (frame: number) => Promise<Node[]> };
};
export type RendererOptions = {
  width?: number;
  height?: number;
  sceneId?: string;
  path?: string[];
  contextFrames?: number[];
  mediaQuality?: 'original' | 'auto';
};
export class Renderer {
  readonly surfaces = new SurfacePool();
  readonly typography: TypographyLayout;
  readonly geometry: GeometryCache<ReturnType<typeof shapePath>>;
  readonly themes: ThemeResolver;
  readonly templates: TemplateResolver;
  private timings = { paintCalls: 0, componentCalls: 0, componentMs: 0, evaluateMs: 0 };
  performanceInfo() {
    return {
      ...this.timings,
      typography: this.typography.report(),
      geometry: this.geometry.report(),
      themes: this.themes.report(),
      templates: this.templates.report(),
      liveLayerBytes: this.layerBytes,
      temporalPixels: this.temporalWork,
      temporalQueries: this.temporalQueries,
      effectGraphPixels: this.effectGraphWork,
      fieldPixels: this.fieldPixels,
      components: this.components.diagnostics(),
      surfaces: this.surfaces.report(),
    };
  }
  readonly components: ComponentHost;
  readonly native = new NativeEvaluator();
  private images = new Map<string, { image: Image; bytes: number }>();
  private imageBytes = 0;
  private decoders = new Map<string, VideoDecoder>();
  private decoderLeases = new Map<string, () => void>();
  private rendering = 0;
  private mediaQuality: 'original' | 'auto' = 'original';
  private mediaUsed: Array<{
    assetId?: string;
    proxy: boolean;
    decodeWidth: number;
    decodeHeight: number;
    path: string;
  }> = [];
  get busy() {
    return this.rendering > 0 || this.audioControllers.size > 0;
  }
  mediaInfo() {
    return {
      quality: this.mediaQuality,
      uses: this.mediaUsed,
      framing: this.mediaFraming,
      decoders: [...this.decoders.values()].map((d) => d.diagnostics()),
    };
  }
  private mediaFraming: 'direct' | 'concat' = 'direct';
  async clearMediaCache() {
    if (this.busy) throw new VmotionError('CACHE_BUSY', 'Renderer is using media caches');
    await Promise.all([...this.decoders.values()].map((decoder) => decoder.close()));
    for (const release of this.decoderLeases.values()) release();
    this.decoders.clear();
    this.decoderLeases.clear();
    this.images.clear();
    this.imageBytes = 0;
  }
  private fonts = new Set<string>();
  private layerBytes = 0;
  private canvasMatrix: Matrix = [1, 0, 0, 1, 0, 0];
  private temporalBytes = 0;
  private temporalWork = 0;
  private temporalQueries = 0;
  private temporalDepth = 0;
  private effectGraphStack = new Set<string>();
  private effectGraphWork = 0;
  private fieldPixels = 0;
  private fullFieldScan = false;
  private driverBudget = { remaining: 200000 };
  private audioAnalysis = new Map<string, Promise<AudioAnalysis>>();
  private audioControllers = new Map<string, AbortController>();
  constructor(
    readonly root: string,
    options: {
      surfacePoolBytes?: number;
      fullFieldScan?: boolean;
      graphicsCache?: boolean;
      mediaFraming?: 'direct' | 'concat';
      resourceCache?: boolean;
    } = {},
  ) {
    const budget = options.graphicsCache === false ? 0 : 8 * 1024 * 1024;
    this.typography = new TypographyLayout(budget);
    this.geometry = new GeometryCache(budget);
    this.themes = new ThemeResolver(options.resourceCache === false ? 0 : 4 * 1024 * 1024);
    this.templates = new TemplateResolver(options.resourceCache === false ? 0 : 8 * 1024 * 1024);
    if (options.surfacePoolBytes !== undefined)
      this.surfaces = new SurfacePool(options.surfacePoolBytes);
    this.fullFieldScan = options.fullFieldScan ?? false;
    this.mediaFraming = options.mediaFraming ?? 'direct';
    this.components = new ComponentHost(root);
  }
  async render(snapshot: Snapshot, frame: number, options: RendererOptions = {}): Promise<Canvas> {
    this.rendering++;
    try {
      return await this.renderImpl(snapshot, frame, options);
    } finally {
      this.rendering--;
    }
  }
  private async renderImpl(
    snapshot: Snapshot,
    frame: number,
    options: RendererOptions = {},
  ): Promise<Canvas> {
    this.timings = { paintCalls: 0, componentCalls: 0, componentMs: 0, evaluateMs: 0 };
    this.temporalWork = 0;
    this.temporalQueries = 0;
    this.effectGraphWork = 0;
    this.fieldPixels = 0;
    this.mediaQuality = options.mediaQuality ?? 'original';
    this.mediaUsed = [];
    this.driverBudget = { remaining: 200000 };
    if (
      (options.path?.length || options.sceneId) &&
      (options.width === undefined || options.height === undefined)
    ) {
      const scope = await this.inspectComposition(
        snapshot,
        options.sceneId ?? snapshot.scenes[0].id,
        frame,
        options.path,
        options.contextFrames,
      );
      options = {
        ...options,
        width: options.width ?? scope.width,
        height: options.height ?? scope.height,
      };
    }
    const motion = snapshot.project.motionBlur;
    if (!motion || motion.shutterAngle === 0) return this.frame(snapshot, frame, options);
    if (!Number.isFinite(frame) || frame < 0)
      throw new VmotionError('FRAME_RANGE', 'Frame must be finite and nonnegative');
    const width = Math.round(options.width ?? snapshot.project.width),
      height = Math.round(options.height ?? snapshot.project.height);
    if (width < 16 || height < 16 || width > 3840 || height > 2160)
      throw new VmotionError('RESOLUTION', 'Motion blur resolution must be within UHD 4K');
    const accumulator = new Float32Array(width * height * 4),
      linear = Array.from({ length: 256 }, (_, v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
    for (let sample = 0; sample < motion.samples; sample++) {
      const t = Math.max(
          0,
          frame + (((sample + 0.5) / motion.samples - 0.5) * motion.shutterAngle) / 360,
        ),
        canvas = await this.frame(snapshot, t, options),
        pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
      for (let i = 0; i < pixels.length; i += 4) {
        const alpha = pixels[i + 3] / 255;
        accumulator[i] += linear[pixels[i]] * alpha;
        accumulator[i + 1] += linear[pixels[i + 1]] * alpha;
        accumulator[i + 2] += linear[pixels[i + 2]] * alpha;
        accumulator[i + 3] += alpha;
      }
      canvas.width = 1;
      canvas.height = 1;
    }
    const result = createCanvas(width, height),
      pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      const sumAlpha = accumulator[i + 3];
      if (sumAlpha === 0) continue;
      for (let c = 0; c < 3; c++) {
        const value = accumulator[i + c] / sumAlpha;
        pixels[i + c] = Math.round(
          255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055),
        );
      }
      pixels[i + 3] = Math.round((sumAlpha / motion.samples) * 255);
    }
    result.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
    return result;
  }
  private async frame(
    snapshot: Snapshot,
    frame: number,
    options: {
      width?: number;
      height?: number;
      sceneId?: string;
      path?: string[];
      contextFrames?: number[];
      nodesAt?: (frame: number) => Promise<Node[]>;
      driverContext?: RenderDriverScope;
    } = {},
  ): Promise<Canvas> {
    if (options.path?.length) {
      const inspected = await this.inspectComposition(
        snapshot,
        options.sceneId ?? snapshot.scenes[0].id,
        frame,
        options.path,
        options.contextFrames,
      );
      return this.frame(
        {
          ...snapshot,
          project: { ...snapshot.project, width: inspected.width, height: inspected.height },
          scenes: [
            ...snapshot.scenes
              .filter((s) => s.id !== inspected.scene.id)
              .map((scene) => ({
                ...scene,
                width: scene.width ?? snapshot.project.width,
                height: scene.height ?? snapshot.project.height,
              })),
            inspected.scene,
          ],
        },
        frame,
        {
          ...options,
          path: undefined,
          sceneId: inspected.scene.id,
          driverContext: inspected.driverContext,
          nodesAt: async (at) =>
            (
              await this.inspectComposition(
                snapshot,
                options.sceneId ?? snapshot.scenes[0].id,
                at,
                options.path,
                options.contextFrames,
              )
            ).scene.nodes,
        },
      );
    }
    if (!Number.isFinite(frame) || frame < 0)
      throw new VmotionError('FRAME_RANGE', 'Frame must be finite and nonnegative');
    const width = Math.round(options.width ?? snapshot.project.width),
      height = Math.round(options.height ?? snapshot.project.height);
    if (width < 16 || height < 16 || width > 3840 || height > 2160)
      throw new VmotionError('RESOLUTION', 'Render size must be between 16px and UHD 4K');
    for (const asset of snapshot.project.assets.filter((a) => a.type === 'font')) {
      const file = path.resolve(this.root, asset.path);
      if (!this.fonts.has(file)) {
        GlobalFonts.registerFromPath(file, asset.name.replace(/\.[^.]+$/, ''));
        this.fonts.add(file);
        invalidateTypographyFonts();
      }
    }
    const canvas = createCanvas(width, height),
      ctx = canvas.getContext('2d');
    if (options.sceneId) {
      const scene = snapshot.scenes.find((s) => s.id === options.sceneId);
      if (!scene) throw new VmotionError('NOT_FOUND', 'Scene not found');
      this.canvasMatrix = [
        width / (scene.width ?? snapshot.project.width),
        0,
        0,
        height / (scene.height ?? snapshot.project.height),
        0,
        0,
      ];
      ctx.scale(
        width / (scene.width ?? snapshot.project.width),
        height / (scene.height ?? snapshot.project.height),
      );
      await this.scene(ctx, snapshot, scene, frame, 0, options.nodesAt, options.driverContext);
    } else {
      this.canvasMatrix = [
        width / snapshot.project.width,
        0,
        0,
        height / snapshot.project.height,
        0,
        0,
      ];
      ctx.scale(width / snapshot.project.width, height / snapshot.project.height);
      await this.sequence(ctx, snapshot, snapshot.project.activeSequence, frame, 0);
    }
    return canvas;
  }
  private async sequence(
    ctx: SKRSContext2D,
    snapshot: Snapshot,
    id: string,
    frame: number,
    depth: number,
  ) {
    if (depth > 32) throw new VmotionError('NESTING_DEPTH', 'Sequence nesting exceeds 32');
    const sequence = snapshot.sequences.find((s) => s.id === id);
    if (!sequence) throw new VmotionError('MISSING_SEQUENCE', id);
    for (const track of sequence.tracks.filter((t) => t.type === 'video' && !t.muted))
      for (const clip of track.clips) {
        if (frame < clip.start || frame >= clip.start + clip.duration) continue;
        const local = clipSourceFrame(clip, frame - clip.start);
        ctx.save();
        const fade = clipGain(clip, frame - clip.start);
        const faded = fade < 1 ? this.surface(ctx) : undefined,
          target = faded?.ctx ?? ctx;
        if (faded) target.setTransform(ctx.getTransform());
        try {
          if (clip.sceneId) {
            const scene = snapshot.scenes.find((s) => s.id === clip.sceneId)!;
            target.scale(
              snapshot.project.width / (scene.width ?? snapshot.project.width),
              snapshot.project.height / (scene.height ?? snapshot.project.height),
            );
            await this.scene(target, snapshot, scene, local, depth + 1);
          } else if (clip.sequenceId)
            await this.sequence(target, snapshot, clip.sequenceId, local, depth + 1);
          else if (clip.assetId) {
            const asset = snapshot.project.assets.find((a) => a.id === clip.assetId)!;
            await this.node(
              target,
              snapshot,
              nodeSchema.parse({
                id: clip.id,
                type:
                  asset.type === 'drawing' ? 'drawing' : asset.type === 'video' ? 'video' : 'image',
                assetId: clip.assetId,
                width: snapshot.project.width,
                height: snapshot.project.height,
              }),
              local,
              depth + 1,
            );
          }
          if (faded) {
            ctx.resetTransform();
            ctx.globalAlpha *= fade;
            ctx.drawImage(faded.canvas, 0, 0);
          }
        } finally {
          faded?.release();
          ctx.restore();
        }
      }
  }
  private async scene(
    ctx: SKRSContext2D,
    snapshot: Snapshot,
    scene: Scene,
    frame: number,
    depth: number,
    nodesAt?: (frame: number) => Promise<Node[]>,
    driverContext?: RenderDriverScope,
  ) {
    if (depth > 32) throw new VmotionError('NESTING_DEPTH', 'Scene nesting exceeds 32');
    ctx.save();
    try {
      const width = scene.width ?? snapshot.project.width,
        height = scene.height ?? snapshot.project.height;
      ctx.fillStyle = scene.background;
      ctx.fillRect(0, 0, width, height);
      ctx.transform(...cameraMatrix(scene.camera, width, height));
      await this.graph(
        ctx,
        snapshot,
        scene.nodes,
        frame,
        depth,
        nodesAt,
        undefined,
        undefined,
        driverContext ?? {
          width,
          height,
          duration: scene.duration,
        },
      );
    } finally {
      ctx.restore();
    }
  }
  private surface(ctx: SKRSContext2D, width = ctx.canvas.width, height = ctx.canvas.height) {
    const bytes = width * height * 4;
    if (this.layerBytes + bytes > 256 * 1024 * 1024)
      throw new VmotionError(
        'EFFECT_MEMORY',
        'Temporary effect surfaces exceed the 256MB frame budget. Reduce resolution or nested effects.',
      );
    this.layerBytes += bytes;
    try {
      const canvas = this.surfaces.acquire(width, height);
      let released = false;
      return {
        canvas,
        ctx: canvas.getContext('2d'),
        release: () => {
          if (released) return;
          released = true;
          this.layerBytes -= bytes;
          this.surfaces.release(canvas);
        },
      };
    } catch (e) {
      this.layerBytes -= bytes;
      throw e;
    }
  }
  private async graph(
    ctx: SKRSContext2D,
    snapshot: Snapshot,
    nodes: Node[],
    frame: number,
    depth: number,
    nodesAt: (frame: number) => Promise<Node[]> = async () => nodes,
    onlyId?: string,
    before?: { index: number; id?: string },
    driverContext: RenderDriverScope = {
      width: snapshot.project.width,
      height: snapshot.project.height,
      duration: snapshot.scenes[0]?.duration ?? 1,
    },
  ) {
    const evaluated = await this.driven(nodes, frame, snapshot, driverContext, this.driverBudget),
      byId = new Map(evaluated.map((n) => [n.id, n]));
    if (byId.size !== nodes.length)
      throw new VmotionError('GRAPH_IDS', 'Generated node IDs must be unique');
    const masks = new Set(evaluated.flatMap((n) => (n.maskId ? [n.maskId] : [])));
    const byParent = new Map<string | undefined, Node[]>();
    for (const n of evaluated) {
      if (n.parentId && !byId.has(n.parentId))
        throw new VmotionError('GRAPH_PARENT', `${n.id}: missing parent ${n.parentId}`);
      const seen = new Set([n.id]);
      let parent = n.parentId;
      while (parent) {
        if (seen.has(parent)) throw new VmotionError('GRAPH_CYCLE', `${n.id}: parent cycle`);
        seen.add(parent);
        if (seen.size > 33)
          throw new VmotionError('NESTING_DEPTH', 'Generated hierarchy exceeds 32 levels');
        parent = byId.get(parent)?.parentId;
      }
      if (n.maskId && (!byId.has(n.maskId) || n.maskId === n.id))
        throw new VmotionError('GRAPH_MASK', `${n.id}: invalid mask ${n.maskId}`);
      const maskChain = new Set([n.id]);
      let maskId = n.maskId;
      while (maskId) {
        if (maskChain.has(maskId))
          throw new VmotionError('GRAPH_MASK_CYCLE', `${n.id}: mask cycle`);
        maskChain.add(maskId);
        maskId = byId.get(maskId)?.maskId;
      }
      if (n.maskId && byId.get(n.maskId)!.parentId !== n.parentId)
        throw new VmotionError(
          'GRAPH_MASK_SPACE',
          `${n.id}: mask and target must share a parent coordinate space`,
        );
      const siblings = byParent.get(n.parentId) ?? [];
      siblings.push(n);
      byParent.set(n.parentId, siblings);
    }
    const historical = async (
      target: SKRSContext2D,
      nodeId: string,
      at: number,
      limit: { index: number; id?: string },
      level: number,
    ) => {
      this.temporalWork += target.canvas.width * target.canvas.height;
      if (
        ++this.temporalQueries > 512 ||
        this.temporalWork > 256 * 1024 * 1024 ||
        this.temporalDepth >= 8
      )
        throw new VmotionError(
          'TEMPORAL_BUDGET',
          'Temporal sampling exceeds the frame work/depth budget',
          { pixels: this.temporalWork, depth: this.temporalDepth },
        );
      const surface = this.surface(target);
      this.temporalDepth++;
      try {
        surface.ctx.setTransform(target.getTransform());
        await this.graph(
          surface.ctx,
          snapshot,
          await nodesAt(at),
          at,
          level,
          nodesAt,
          nodeId,
          limit,
          driverContext,
        );
        return surface;
      } catch (error) {
        surface.release();
        throw error;
      } finally {
        this.temporalDepth--;
      }
    };
    const draw = async (target: SKRSContext2D, parent?: string, level = depth) => {
      if (level > 32) throw new VmotionError('NESTING_DEPTH', 'Layer hierarchy exceeds 32');
      for (const raw of onlyId && parent === undefined
        ? [byId.get(onlyId)].filter((node): node is Node => !!node)
        : (byParent.get(parent) ?? [])) {
        let n = raw;
        if (onlyId === raw.id) n = { ...raw, blend: 'source-over' };
        if (onlyId === raw.id && before) {
          const index = before.id
            ? raw.effects.findIndex((effect) => effect.id === before.id)
            : before.index;
          n = {
            ...raw,
            blend: 'source-over',
            effects: raw.effects.slice(0, index >= 0 ? index : before.index),
          };
        }
        const temporal = n.effects.some((effect) =>
          temporalActive(effect as unknown as Record<string, unknown> & { type: string }),
        );
        if (
          (masks.has(n.id) && onlyId !== n.id) ||
          (!temporal &&
            (!n.visible ||
              n.opacity === 0 ||
              frame < n.start ||
              (n.end !== undefined && frame >= n.end)))
        )
          continue;
        const sample = (at: number, limit: { index: number; id?: string }) =>
          historical(target, n.id, at, limit, level);
        const nodeAt = async (at: number, id = n.id) =>
          (
            await this.driven(await nodesAt(at), at, snapshot, driverContext, this.driverBudget)
          ).find((node) => node.id === id);
        const graphInput = async (layerId: string) => {
          const id = byId.has(layerId)
              ? layerId
              : n.id.slice(0, n.id.lastIndexOf('/') + 1) + layerId,
            source = byId.get(id);
          if (!source)
            throw new VmotionError('EFFECT_GRAPH_LAYER', 'Graph input layer is missing', {
              nodeId: n.id,
              input: layerId,
            });
          if (source.parentId !== n.parentId)
            throw new VmotionError(
              'EFFECT_GRAPH_SPACE',
              'Graph input layers must share the owner parent; precompose or use a sibling group',
              { nodeId: n.id, input: id },
            );
          const surface = this.surface(target);
          try {
            surface.ctx.setTransform(target.getTransform());
            await this.graph(
              surface.ctx,
              snapshot,
              nodes,
              frame,
              level,
              nodesAt,
              id,
              undefined,
              driverContext,
            );
            return surface;
          } catch (error) {
            surface.release();
            throw error;
          }
        };
        if (temporal && n.maskId) {
          await this.node(
            target,
            snapshot,
            { ...n, maskId: undefined },
            frame,
            level,
            (next) => draw(next, n.id, level + 1),
            sample,
            graphInput,
            nodeAt,
          );
          continue;
        }
        if (!n.maskId) {
          await this.node(
            target,
            snapshot,
            n,
            frame,
            level,
            (next) => draw(next, n.id, level + 1),
            sample,
            graphInput,
            nodeAt,
          );
          continue;
        }
        const paint = this.surface(target),
          matrix = target.getTransform();
        let mask: ReturnType<Renderer['surface']> | undefined;
        try {
          mask = this.surface(target);
          paint.ctx.setTransform(matrix);
          mask.ctx.setTransform(matrix);
          await this.node(
            paint.ctx,
            snapshot,
            { ...n, maskId: undefined, blend: 'source-over' },
            frame,
            level,
            (next) => draw(next, n.id, level + 1),
            sample,
            graphInput,
            nodeAt,
          );
          const maskNode = byId.get(n.maskId)!;
          if (
            maskNode.effects.some((effect) =>
              temporalActive(effect as unknown as Record<string, unknown> & { type: string }),
            ) ||
            (maskNode.visible &&
              frame >= maskNode.start &&
              (maskNode.end === undefined || frame < maskNode.end))
          )
            await this.node(
              mask.ctx,
              snapshot,
              { ...maskNode, blend: 'source-over' },
              frame,
              level,
              (next) => draw(next, maskNode.id, level + 1),
              (at, limit) => historical(mask!.ctx, maskNode.id, at, limit, level),
              graphInput,
              (at) => nodeAt(at, maskNode.id),
            );
          if (n.maskMode === 'luma' || n.maskMode === 'lumaInverted') {
            const image = mask.ctx.getImageData(0, 0, mask.canvas.width, mask.canvas.height);
            mask.ctx.resetTransform();
            mask.ctx.putImageData(
              new ImageData(lumaMatte(image.data), image.width, image.height),
              0,
              0,
            );
          }
          let matte = mask.canvas;
          let feather: ReturnType<Renderer['surface']> | undefined;
          try {
            if (n.maskFeather > 0) {
              feather = this.surface(target);
              feather.ctx.filter = `blur(${n.maskFeather * Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d))}px)`;
              feather.ctx.drawImage(mask.canvas, 0, 0);
              matte = feather.canvas;
            }
            paint.ctx.resetTransform();
            paint.ctx.globalCompositeOperation = n.maskMode.endsWith('Inverted')
              ? 'destination-out'
              : 'destination-in';
            paint.ctx.drawImage(matte, 0, 0);
          } finally {
            feather?.release();
          }
          target.save();
          try {
            target.resetTransform();
            target.filter = 'none';
            target.globalCompositeOperation = n.blend;
            target.drawImage(paint.canvas, 0, 0);
          } finally {
            target.restore();
          }
        } finally {
          paint.release();
          mask?.release();
        }
      }
    };
    await draw(ctx);
  }
  private async image(key: string, source: string | Buffer): Promise<Image> {
    if (this.images.has(key)) {
      const value = this.images.get(key)!;
      this.images.delete(key);
      this.images.set(key, value);
      return value.image;
    }
    const image = await loadImage(source),
      bytes = image.width * image.height * 4;
    while (this.imageBytes + bytes > 128 * 1024 * 1024 && this.images.size) {
      const first = this.images.keys().next().value!;
      this.imageBytes -= this.images.get(first)!.bytes;
      this.images.delete(first);
    }
    if (bytes <= 128 * 1024 * 1024) {
      this.images.set(key, { image, bytes });
      this.imageBytes += bytes;
    }
    return image;
  }
  private async node(
    ctx: SKRSContext2D,
    snapshot: Snapshot,
    n: Node,
    frame: number,
    depth: number,
    children?: (target: SKRSContext2D) => Promise<void>,
    sampleSource?: (
      frame: number,
      before: { index: number; id?: string },
    ) => Promise<ReturnType<Renderer['surface']>>,
    graphSource?: (layerId: string) => Promise<ReturnType<Renderer['surface']>>,
    nodeSource?: (frame: number) => Promise<Node | undefined>,
  ) {
    if (depth > 32) throw new VmotionError('NESTING_DEPTH', 'Layer nesting exceeds 32');
    this.timings.paintCalls++;
    const container = ['group', 'component', 'scene', 'drawing'].includes(n.type),
      isolate =
        n.isolation === true ||
        n.effects.some((effect) => effect.enabled !== false) ||
        (container &&
          (n.opacity !== 1 ||
            n.blend !== 'source-over' ||
            n.blur > 0 ||
            n.brightness !== 1 ||
            n.saturation !== 1 ||
            !!n.shadow));
    if (isolate) {
      const layer = this.surface(ctx),
        matrix = ctx.getTransform();
      try {
        layer.ctx.setTransform(matrix);
        await this.node(
          layer.ctx,
          snapshot,
          {
            ...n,
            isolation: false,
            opacity: 1,
            blend: 'source-over',
            blur: 0,
            brightness: 1,
            saturation: 1,
            shadow: undefined,
            effects: [],
          },
          frame,
          depth,
          children,
          undefined,
          graphSource,
          nodeSource,
        );
        const scale = Math.max(
          Math.hypot(matrix.a, matrix.b) * Math.abs(n.scaleX),
          Math.hypot(matrix.c, matrix.d) * Math.abs(n.scaleY),
        );
        const effects = [
          ...(n.blur ? [{ type: 'blur' as const, radius: n.blur }] : []),
          ...(n.brightness !== 1 || n.saturation !== 1
            ? [
                {
                  type: 'color' as const,
                  brightness: n.brightness,
                  saturation: n.saturation,
                  contrast: 1,
                  hue: 0,
                },
              ]
            : []),
          ...(n.shadow ? [{ type: 'shadow' as const, ...n.shadow }] : []),
          ...n.effects,
        ];
        const ownsSampledOpacity = n.effects.some((effect) =>
            temporalActive(effect as unknown as Record<string, unknown> & { type: string }),
          ),
          legacyCount = effects.length - n.effects.length;
        const environment = {
          makeSurface: (width?: number, height?: number) => this.surface(ctx, width, height),
          frame,
          fps: snapshot.project.fps.num / snapshot.project.fps.den,
          scale,
          matrix: multiply(
            [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f],
            nodeMatrix(n),
          ),
          offsetMatrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f] as Matrix,
          bounds: { x: 0, y: 0, width: n.width, height: n.height },
          canvasMatrix: this.canvasMatrix,
          fullFieldScan: this.fullFieldScan,
          evaluatedPixels: (pixels: number) => {
            this.fieldPixels += pixels;
            if (this.fieldPixels > 256 * 1024 * 1024)
              throw new VmotionError(
                'FIELD_BUDGET',
                'Output frame exceeds 256M field/ray scalar evaluations',
              );
          },
        };
        let current = layer.canvas;
        let previous: ReturnType<Renderer['surface']> | undefined;
        try {
          for (const [effectIndex, effect] of effects.entries()) {
            if ('enabled' in effect && effect.enabled === false) continue;
            let out: ReturnType<Renderer['surface']> | undefined;
            try {
              if (effect.type === 'motionBlur' || effect.type === 'echo') {
                out = this.surface(ctx);
                if (
                  !temporalActive(effect as unknown as Record<string, unknown> & { type: string })
                )
                  out.ctx.drawImage(current, 0, 0);
                else {
                  if (!sampleSource)
                    throw new VmotionError(
                      'TEMPORAL_SOURCE',
                      'Temporal layer has no historical graph source',
                    );
                  const { id: _id, enabled: _enabled, ...config } = effect,
                    temporal = temporalEffectSchema.parse(config),
                    length = current.width * current.height * 4,
                    bytes = length * 4;
                  if (this.temporalBytes + bytes > 256 * 1024 * 1024)
                    throw new VmotionError(
                      'EFFECT_MEMORY',
                      'Temporal accumulators exceed the 256MB budget',
                    );
                  this.temporalBytes += bytes;
                  try {
                    const pixels = new TemporalPixels(
                      length,
                      temporal.type === 'motionBlur' ? 'average' : temporal.operator,
                    );
                    for (const entry of temporalSamples(
                      temporal,
                      frame,
                      snapshot.project.fps.num / snapshot.project.fps.den,
                    )) {
                      const source = await sampleSource(entry.frame, {
                        index: effectIndex - legacyCount,
                        id: 'id' in effect ? effect.id : undefined,
                      });
                      try {
                        pixels.add(
                          source.ctx.getImageData(0, 0, source.canvas.width, source.canvas.height)
                            .data,
                          entry.weight,
                        );
                      } finally {
                        source.release();
                      }
                    }
                    out.ctx.putImageData(
                      new ImageData(pixels.finish(), current.width, current.height),
                      0,
                      0,
                    );
                  } finally {
                    this.temporalBytes -= bytes;
                  }
                }
              } else if (effect.type === 'effectGraph') {
                const graph = resolveEffectGraph(snapshot, effect),
                  key = n.id + ':' + effectIndex;
                if (this.effectGraphStack.has(key))
                  throw new VmotionError(
                    'EFFECT_GRAPH_CYCLE',
                    'Layer graph bindings contain a rendering cycle',
                    { nodeId: n.id },
                  );
                if (this.effectGraphStack.size >= 16)
                  throw new VmotionError(
                    'EFFECT_GRAPH_LIMIT',
                    'Layer graph binding depth exceeds 16',
                  );
                this.effectGraphStack.add(key);
                try {
                  out = await renderEffectGraph(graph, {
                    ...environment,
                    fullFieldScan: this.fullFieldScan,
                    evaluatedPixels: (pixels) => {
                      this.fieldPixels += pixels;
                      if (this.fieldPixels > 256 * 1024 * 1024)
                        throw new VmotionError(
                          'FIELD_BUDGET',
                          'Output frame exceeds 256M field/ray scalar evaluations',
                        );
                    },
                    charge: (pixels) => {
                      this.effectGraphWork += pixels;
                      if (this.effectGraphWork > 256 * 1024 * 1024)
                        throw new VmotionError(
                          'EFFECT_GRAPH_BUDGET',
                          'Output frame exceeds the effect graph work budget',
                        );
                    },
                    input: async (slot) => {
                      if (slot === 'source') {
                        const copy = this.surface(ctx);
                        try {
                          copy.ctx.drawImage(current, 0, 0);
                          return copy;
                        } catch (error) {
                          copy.release();
                          throw error;
                        }
                      }
                      const id = Object.hasOwn(effect.bindings, slot)
                        ? effect.bindings[slot]
                        : undefined;
                      if (!id || !graphSource)
                        throw new VmotionError(
                          'EFFECT_GRAPH_BINDING',
                          'A named graph input needs a layer binding',
                          { nodeId: n.id, slot },
                        );
                      return graphSource(id);
                    },
                  });
                } finally {
                  this.effectGraphStack.delete(key);
                }
              } else {
                out = rasterPass(current, effect, environment);
              }
            } catch (e) {
              out?.release();
              throw e;
            }
            previous?.release();
            current = out.canvas;
            previous = out;
          }
          ctx.save();
          try {
            ctx.resetTransform();
            ctx.filter = 'none';
            ctx.globalAlpha *= ownsSampledOpacity ? 1 : n.opacity;
            ctx.globalCompositeOperation = n.blend;
            ctx.drawImage(current, 0, 0);
          } finally {
            ctx.restore();
          }
        } finally {
          previous?.release();
        }
      } finally {
        layer.release();
      }
      return;
    }
    ctx.save();
    try {
      ctx.transform(...nodeMatrix(n));
      ctx.globalAlpha *= n.opacity;
      ctx.globalCompositeOperation = n.blend;
      const filters: string[] = [];
      if (n.blur > 0) filters.push(`blur(${n.blur}px)`);
      if (n.brightness !== 1) filters.push(`brightness(${n.brightness})`);
      if (n.saturation !== 1) filters.push(`saturate(${n.saturation})`);
      ctx.filter = filters.length ? filters.join(' ') : 'none';
      ctx.fillStyle = n.fill;
      if (n.gradient) {
        const g = n.gradient,
          paint =
            g.type === 'linear'
              ? ctx.createLinearGradient(g.from.x, g.from.y, g.to.x, g.to.y)
              : ctx.createRadialGradient(
                  g.center.x,
                  g.center.y,
                  0,
                  g.center.x,
                  g.center.y,
                  g.radius,
                );
        for (const stop of [...g.stops].sort((a, b) => a.offset - b.offset))
          paint.addColorStop(stop.offset, stop.color);
        ctx.fillStyle = paint;
      }
      ctx.strokeStyle = n.stroke || 'transparent';
      ctx.lineWidth = n.strokeWidth;
      ctx.lineCap = n.strokeCap;
      ctx.lineJoin = n.strokeJoin;
      ctx.miterLimit = Math.max(1, n.strokeMiterLimit);
      ctx.setLineDash(n.strokeDash.map((value) => Math.max(0, value)));
      ctx.lineDashOffset = n.strokeDashOffset;
      if (n.shadow) {
        ctx.shadowColor = n.shadow.color;
        ctx.shadowBlur = n.shadow.blur;
        ctx.shadowOffsetX = n.shadow.x;
        ctx.shadowOffsetY = n.shadow.y;
      }
      if (n.clip) {
        ctx.beginPath();
        ctx.rect(n.clip.x, n.clip.y, n.clip.width, n.clip.height);
        ctx.clip();
      }
      if (['rect', 'ellipse', 'path'].includes(n.type)) {
        const p = shapePath(n, this.geometry);
        if (n.fill !== 'transparent' || n.gradient) ctx.fill(p, n.fillRule);
        if (n.strokeWidth) ctx.stroke(p);
      } else if (n.type === 'text') this.text(ctx, n, frame);
      else if (n.type === 'scene3d') {
        if (!n.scene3d) throw new VmotionError('SCENE3D_SOURCE', `${n.id}: missing 3D scene data`);
        if (n.width === 0 || n.height === 0) return;
        const m = ctx.getTransform(),
          factor = Math.min(
            1,
            3840 / Math.max(1, n.width * Math.hypot(m.a, m.b)),
            2160 / Math.max(1, n.height * Math.hypot(m.c, m.d)),
          ),
          width = Math.max(1, Math.min(3840, Math.ceil(n.width * Math.hypot(m.a, m.b) * factor))),
          height = Math.max(1, Math.min(2160, Math.ceil(n.height * Math.hypot(m.c, m.d) * factor))),
          prepared = prepareRasterScene(
            n.id,
            resolveSceneMeshes(snapshot, n.scene3d),
            width,
            height,
          ),
          result = await this.native.raster3D(prepared.request),
          image = createCanvas(width, height);
        image
          .getContext('2d')
          .putImageData(new ImageData(new Uint8ClampedArray(result.pixels), width, height), 0, 0);
        ctx.drawImage(image, 0, 0, n.width, n.height);
        image.width = 1;
        image.height = 1;
      } else if (n.type === 'formula') {
        const key = `math:${n.text}:${n.fill}:${n.fontSize}`;
        let image: Image;
        if (this.images.has(key)) image = this.images.get(key)!.image;
        else {
          const outer = adaptor.outerHTML(math.convert(n.text, { display: true }));
          let svg = outer
            .slice(outer.indexOf('<svg'), outer.lastIndexOf('</svg>') + 6)
            .replace(/currentColor/g, n.fill);
          const box = svg
            .match(/viewBox="([^"]+)"/)?.[1]
            .split(/\s+/)
            .map(Number);
          if (!box || box.length !== 4)
            throw new VmotionError('FORMULA_RENDER', 'Formula has no valid SVG viewBox');
          svg = svg
            .replace(/width="[^"]+"/, `width="${Math.max(1, (box[2] * n.fontSize) / 1000)}"`)
            .replace(/height="[^"]+"/, `height="${Math.max(1, (box[3] * n.fontSize) / 1000)}"`);
          image = await this.image(key, Buffer.from(svg));
        }
        const scale = Math.min(1, n.width / image.width, n.height / image.height);
        ctx.drawImage(image, 0, 0, image.width * scale, image.height * scale);
      } else if (n.type === 'image' || n.type === 'video') {
        const asset = snapshot.project.assets.find((a) => a.id === n.assetId);
        const file = asset
          ? path.resolve(this.root, asset.path)
          : n.source
            ? path.resolve(this.root, n.source)
            : undefined;
        if (!file) throw new VmotionError('MISSING_ASSET', `${n.id}: no source`);
        if (n.type === 'image') {
          const image = await this.image(file + ':' + (await fingerprint(file)), file);
          ctx.drawImage(image, 0, 0, n.width, n.height);
        } else {
          const proxy =
              this.mediaQuality === 'auto' && asset
                ? await videoProxy(this.root, snapshot, asset)
                : undefined,
            mediaFile = proxy?.output ?? file,
            matrix = ctx.getTransform(),
            previewScale =
              this.mediaQuality === 'auto'
                ? Math.min(
                    1,
                    Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d)),
                  )
                : 1,
            factor = proxy
              ? Math.min(
                  previewScale,
                  proxy.width / Math.max(1, n.width),
                  proxy.height / Math.max(1, n.height),
                )
              : previewScale,
            width = Math.max(16, Math.min(snapshot.project.width, Math.round(n.width * factor))),
            height = Math.max(16, Math.min(snapshot.project.height, Math.round(n.height * factor)));
          this.mediaUsed.push({
            assetId: asset?.id,
            proxy: !!proxy,
            decodeWidth: width,
            decodeHeight: height,
            path: mediaFile,
          });
          const key = `${mediaFile}:${await fingerprint(mediaFile)}:${width}:${height}:${snapshot.project.fps.num}/${snapshot.project.fps.den}`;
          let decoder = this.decoders.get(key);
          if (!decoder) {
            while (this.decoders.size >= 3) {
              const first = this.decoders.keys().next().value!;
              this.decoders.get(first)!.close();
              this.decoderLeases.get(first)?.();
              this.decoderLeases.delete(first);
              this.decoders.delete(first);
            }
            decoder = new VideoDecoder(mediaFile, width, height, snapshot.project.fps, {
              framing: this.mediaFraming,
            });
            this.decoders.set(key, decoder);
            this.decoderLeases.set(key, useCacheFile(mediaFile));
          }
          const timing = contentTiming(snapshot, n, frame, true);
          if (!timing.present) return;
          const pixels = await decoder.frame(timing.sourceFrame);
          const image = createCanvas(width, height);
          image
            .getContext('2d')
            .putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
          ctx.drawImage(image, 0, 0, n.width, n.height);
          image.width = 1;
          image.height = 1;
        }
      } else if (n.type === 'component') {
        const timing = contentTiming(snapshot, n, frame, true);
        if (!timing.present) return;
        const nodes = await this.generatedNodes(snapshot, n, timing.sourceFrame);
        if (depth > 32) throw new VmotionError('NESTING_DEPTH', 'Component nesting exceeds 32');
        const generated = prefixNodes(nodes, n.id);
        await this.graph(
          ctx,
          snapshot,
          generated,
          timing.sourceFrame,
          depth + 1,
          async (at) => {
            const parentFrame =
              n.timeMapping.mode === 'linear' && n.timeMapping.rate !== 0
                ? frame + (at - timing.sourceFrame) / n.timeMapping.rate
                : frame;
            const sampled =
              (await nodeSource?.(Math.max(0, parentFrame))) ??
              evaluateNode(n, Math.max(0, parentFrame));
            return prefixNodes(await this.generatedNodes(snapshot, sampled, at), n.id);
          },
          undefined,
          undefined,
          {
            width: n.width,
            height: n.height,
            duration: n.timeMapping.duration ?? snapshot.scenes[0].duration,
          },
        );
      } else if (n.type === 'scene') {
        const timing = contentTiming(snapshot, n, frame, true);
        if (!timing.present) return;
        const scene = this.referencedScene(snapshot, n);
        ctx.scale(
          n.width / (scene.width ?? snapshot.project.width),
          n.height / (scene.height ?? snapshot.project.height),
        );
        await this.scene(
          ctx,
          snapshot,
          {
            ...scene,
            nodes: prefixNodes(
              composeGenerated(this.templates.apply(snapshot, n, scene.nodes), n),
              n.id,
            ),
          },
          timing.sourceFrame,
          depth + 1,
        );
      } else if (n.type === 'chart') this.chart(ctx, n);
      else if (n.type === 'drawing') {
        let resource: unknown = { points: n.points };
        let sourceWidth = snapshot.project.width,
          sourceHeight = snapshot.project.height;
        if (n.assetId) {
          const asset = snapshot.project.assets.find((a) => a.id === n.assetId);
          if (asset) {
            resource = JSON.parse(await readFile(path.resolve(this.root, asset.path), 'utf8'));
            sourceWidth = Number(asset.metadata.width ?? sourceWidth);
            sourceHeight = Number(asset.metadata.height ?? sourceHeight);
          }
        }
        const original =
          n.assetId && n.strokeWidth === 0
            ? snapshot.scenes
                .flatMap((s) => s.nodes)
                .find(
                  (layer) =>
                    layer.type === 'drawing' &&
                    layer.assetId === n.assetId &&
                    layer.strokeWidth > 0,
                )
            : undefined;
        const doc = normalizeDrawing(resource, {
          ...n,
          ...(original ? { stroke: original.stroke, strokeWidth: original.strokeWidth } : {}),
          width: sourceWidth,
          height: sourceHeight,
        });
        ctx.scale(n.width / doc.width, n.height / doc.height);
        paintDrawing(ctx, doc);
      }
      if (children) await children(ctx);
    } finally {
      ctx.restore();
    }
  }
  referencedScene(snapshot: Snapshot, node: Node): Scene {
    const scene = snapshot.scenes.find((s) => s.id === node.sceneId);
    if (!scene)
      throw new VmotionError(
        'MISSING_SCENE',
        `Referenced scene ${node.sceneId ?? node.id} not found`,
      );
    return scene;
  }
  async driven(
    nodes: Node[],
    frame: number,
    snapshot: Snapshot,
    context: RenderDriverScope,
    budget = { remaining: 200000 },
  ) {
    if (context.group) return isolateGroup(await context.group.sourceAt(frame), context.group.id);
    nodes = nodes.map((node) => this.themes.resolveNode(snapshot, node));
    const started = performance.now(),
      animated = await this.native.evaluate(nodes, frame);
    this.timings.evaluateMs += performance.now() - started;
    return hasDrivers(nodes)
      ? evaluateDrivers(
          nodes,
          { ...context, frame, fps: snapshot.project.fps.num / snapshot.project.fps.den, budget },
          animated,
        ).nodes
      : animated;
  }
  async inspectComposition(
    snapshot: Snapshot,
    sceneId: string,
    frame: number,
    path: string[] = [],
    contextFrames: number[] = [],
  ) {
    contextFramesSchema.parse(contextFrames);
    if (contextFrames.length > path.length)
      throw new VmotionError('CONTENT_CONTEXT', 'Parent context cannot exceed navigation depth');
    const original = snapshot.scenes.find((s) => s.id === sceneId);
    if (!original) throw new VmotionError('NOT_FOUND', 'Scene not found');
    if (path.length > 32)
      throw new VmotionError('NESTING_DEPTH', 'Composition navigation exceeds 32');
    let nodes = original.nodes,
      width = original.width ?? snapshot.project.width,
      height = original.height ?? snapshot.project.height,
      name = original.name,
      duration = original.duration,
      background = original.background,
      camera = original.camera;
    type Target =
      | { kind: 'node'; nodeId: string }
      | { kind: 'generated'; rootNodeId: string; relativeId: string };
    let targets: Record<string, Target> = Object.fromEntries(
      nodes.map((n) => [n.id, { kind: 'node' as const, nodeId: n.id }]),
    );
    const breadcrumbs: Array<{ id: string; name: string; type: string }> = [];
    let scope: { parentId?: string; ownerNodeId?: string; componentPath?: string } = {},
      componentPrefix = '';
    let driverContext: RenderDriverScope = { width, height, duration };
    for (const [index, id] of path.entries()) {
      const root = nodes.find((n) => n.id === id);
      if (!root) throw new VmotionError('NOT_FOUND', `Composition layer ${id} no longer exists`);
      breadcrumbs.push({ id, name: root.name, type: root.type });
      name = root.name;
      if (root.type === 'group') {
        const parentNodes = nodes,
          parentContext = driverContext,
          parentPath = path.slice(0, index),
          parentContexts = contextFrames.slice(0, index);
        driverContext = {
          width,
          height,
          duration,
          group: {
            id,
            sourceAt: async (at) => {
              if (!parentPath.length) return this.driven(parentNodes, at, snapshot, parentContext);
              const parent = await this.inspectComposition(
                snapshot,
                sceneId,
                at,
                parentPath,
                parentContexts,
              );
              return this.driven(parent.scene.nodes, at, snapshot, parent.driverContext);
            },
          },
        };
        scope = {
          ...scope,
          parentId: componentPrefix ? root.id.slice(componentPrefix.length + 1) : root.id,
        };
        nodes = isolateGroup(nodes, id);
        targets = Object.fromEntries(nodes.map((n) => [n.id, targets[n.id]]));
        camera = undefined;
      } else if (root.type === 'component' || root.type === 'scene') {
        const target = targets[root.id],
          source = (
            await this.driven(nodes, contextFrames[index] ?? frame, snapshot, driverContext)
          ).find((node) => node.id === root.id)!,
          sourceFrame = index + 1 < path.length ? (contextFrames[index + 1] ?? frame) : frame;
        let generated: Node[];
        if (root.type === 'scene') {
          const scene = this.referencedScene(snapshot, source);
          generated = composeGenerated(this.templates.apply(snapshot, source, scene.nodes), source);
          width = scene.width ?? snapshot.project.width;
          height = scene.height ?? snapshot.project.height;
          duration = scene.duration;
          background = scene.background;
          camera = scene.camera;
        } else {
          generated = await this.generatedNodes(snapshot, source, sourceFrame);
          width = Math.max(16, Math.round(root.width));
          height = Math.max(16, Math.round(root.height));
          duration = source.timeMapping.duration ?? duration;
          camera = undefined;
        }
        scope =
          target.kind === 'node'
            ? { ownerNodeId: target.nodeId, componentPath: '' }
            : { ownerNodeId: target.rootNodeId, componentPath: target.relativeId };
        componentPrefix = root.id;
        nodes = prefixNodes(generated, root.id);
        driverContext = { width, height, duration };
        targets = Object.fromEntries(
          generated.map((n, i) => [
            nodes[i].id,
            target.kind === 'node'
              ? { kind: 'generated' as const, rootNodeId: target.nodeId, relativeId: n.id }
              : {
                  kind: 'generated' as const,
                  rootNodeId: target.rootNodeId,
                  relativeId: `${target.relativeId}/${n.id}`,
                },
          ]),
        );
      } else throw new VmotionError('COMPOSITION_TYPE', 'Open a group or programmable component');
    }
    return {
      scene: {
        ...original,
        id: `${original.id}::focus`,
        name,
        nodes,
        width,
        height,
        duration,
        background,
        camera,
      },
      width,
      height,
      targets,
      breadcrumbs,
      revision: snapshot.revision,
      scope,
      componentPrefix,
      driverContext,
      contextFrames,
      frame,
    };
  }
  async inspectInteractions(
    snapshot: Snapshot,
    sceneId: string,
    frame: number,
    path: string[] = [],
    options: {
      includeEmpty?: boolean;
      includeInactive?: boolean;
      contextFrames?: number[];
      includeEvaluated?: boolean;
    } = {},
  ) {
    const scope = await this.inspectComposition(
        snapshot,
        sceneId,
        frame,
        path,
        options.contextFrames,
      ),
      layers: InteractionLayer[] = [],
      ctx = createCanvas(1, 1).getContext('2d');
    for (const asset of snapshot.project.assets.filter((a) => a.type === 'font')) {
      const file = pathResolve(this.root, asset.path);
      if (!this.fonts.has(file)) {
        GlobalFonts.registerFromPath(file, asset.name.replace(/\.[^.]+$/, ''));
        this.fonts.add(file);
        invalidateTypographyFonts();
      }
    }
    const walk = async (
      nodes: Node[],
      parentMatrix: Matrix,
      editPath: string[],
      clips: InteractionLayer['clips'],
      depth: number,
      opacity = 1,
      uncertainty: string[] = [],
      localFrame = frame,
      contexts = scope.contextFrames,
      localContext: RenderDriverScope = scope.driverContext,
    ) => {
      if (depth > 32) throw new VmotionError('NESTING_DEPTH', 'Interaction hierarchy exceeds 32');
      const evaluated = await this.driven(nodes, localFrame, snapshot, localContext),
        masks = new Set(evaluated.flatMap((n) => (n.maskId ? [n.maskId] : [])));
      const visit = async (
        parent: string | undefined,
        matrix: Matrix,
        inherited: InteractionLayer['clips'],
        level: number,
        inheritedOpacity = opacity,
        inheritedUncertainty = uncertainty,
      ) => {
        if (level > 32) throw new VmotionError('NESTING_DEPTH', 'Interaction hierarchy exceeds 32');
        for (const n of evaluated.filter((n) => n.parentId === parent)) {
          if (
            !options.includeInactive &&
            (masks.has(n.id) ||
              !n.visible ||
              n.opacity === 0 ||
              localFrame < n.start ||
              (n.end !== undefined && localFrame >= n.end))
          )
            continue;
          const world = multiply(matrix, nodeMatrix(n)),
            nextClips = n.clip ? [...inherited, { matrix: world, bounds: n.clip }] : inherited;
          const timing = timeControlled(n)
            ? contentTiming(snapshot, n, localFrame, true)
            : undefined;
          if (timing && !timing.present && !options.includeInactive) continue;
          const alpha = inheritedOpacity * n.opacity,
            uncertain = [
              ...new Set([
                ...inheritedUncertainty,
                ...(n.maskId ? ['mask'] : []),
                ...(n.effects.length || n.blur || n.shadow ? ['effect'] : []),
                ...(n.blend !== 'source-over' ? ['blend'] : []),
              ]),
            ];
          let bounds: Bounds = { x: 0, y: 0, width: n.width, height: n.height };
          let strokes: InteractionLayer['strokes'];
          let polygons: InteractionLayer['contentPolygons'],
            textLayout: InteractionLayer['textLayout'];
          if (n.type === 'text') {
            const text = this.textGeometry(n, localFrame);
            textLayout = text.metrics;
            const regions = text.runs
              .filter((run) => run.alpha >= 0.05 && run.text.trim())
              .map((run) => {
                const pad = n.strokeWidth / 2,
                  left = run.box.x - pad,
                  right = run.box.x + run.box.width + pad,
                  top = run.box.y - pad,
                  bottom = run.box.y + run.box.height + pad,
                  angle = (run.rotation * Math.PI) / 180,
                  c = Math.cos(angle),
                  s = Math.sin(angle),
                  m: Matrix = [
                    c * run.scaleX,
                    s * run.scaleX,
                    -s * run.scaleY,
                    c * run.scaleY,
                    run.x,
                    run.y,
                  ];
                return [
                  { x: left, y: top },
                  { x: right, y: top },
                  { x: right, y: bottom },
                  { x: left, y: bottom },
                ].map((p) => transform(m, p));
              });
            const corners = regions.flat();
            polygons = regions.map((region) => region.map((point) => transform(world, point)));
            if (!corners.length) {
              if (!options.includeEmpty) continue;
              bounds = {
                x: 0,
                y: 0,
                width: options.includeInactive ? n.width : 0,
                height: options.includeInactive ? n.height : 0,
              };
            } else {
              const x = Math.min(...corners.map((p) => p.x)),
                y = Math.min(...corners.map((p) => p.y));
              bounds = {
                x,
                y,
                width: Math.max(...corners.map((p) => p.x)) - x,
                height: Math.max(...corners.map((p) => p.y)) - y,
              };
            }
          } else if (n.type === 'drawing') {
            let resource: unknown = { points: n.points },
              sourceWidth = snapshot.project.width,
              sourceHeight = snapshot.project.height;
            if (n.assetId) {
              const asset = snapshot.project.assets.find((a) => a.id === n.assetId);
              if (asset) {
                resource = JSON.parse(await readFile(pathResolve(this.root, asset.path), 'utf8'));
                sourceWidth = Number(asset.metadata.width ?? sourceWidth);
                sourceHeight = Number(asset.metadata.height ?? sourceHeight);
              }
            }
            const doc = normalizeDrawing(resource, {
                ...n,
                width: sourceWidth,
                height: sourceHeight,
              }),
              ink = drawingInkBounds(doc),
              sx = n.width / doc.width,
              sy = n.height / doc.height;
            bounds = {
              x: ink.x * sx,
              y: ink.y * sy,
              width: ink.width * sx,
              height: ink.height * sy,
            };
            strokes = doc.layers
              .filter((l) => l.visible && l.opacity)
              .flatMap((l) =>
                l.strokes
                  .filter((s) => s.tool === 'brush' && s.opacity)
                  .map((s) => ({
                    width: s.width * Math.max(Math.abs(sx), Math.abs(sy)),
                    points: s.points.map((p) => ({
                      ...p,
                      x: (p.x + l.x) * sx,
                      y: (p.y + l.y) * sy,
                    })),
                  })),
              );
            if (!strokes.length && !options.includeInactive) continue;
          } else if (['rect', 'ellipse', 'path'].includes(n.type)) {
            bounds = shapeBounds(n, shapePath(n, this.geometry));
          } else if (n.type === 'scene3d' && n.scene3d) {
            const data = resolveSceneMeshes(snapshot, n.scene3d),
              evaluated = evaluateScene3D(
                n.id,
                data.instances as unknown as MeshInstance3D[],
                data.camera,
                data.options,
              ),
              b = evaluated.bounds,
              sx = n.width / data.camera.width,
              sy = n.height / data.camera.height;
            bounds = b
              ? {
                  x: b.x * sx,
                  y: b.y * sy,
                  width: (b.right - b.x) * sx,
                  height: (b.bottom - b.y) * sy,
                }
              : { x: 0, y: 0, width: 0, height: 0 };
            uncertain.push('depth-raster');
          }
          const index = layers.length;
          layers.push({
            frame: localFrame,
            contentFrame: timing?.sourceFrame,
            contextFrames: contexts,
            node: nodes.find((raw) => raw.id === n.id)!,
            ...(options.includeEvaluated ? { evaluatedNode: n } : {}),
            path: editPath,
            matrix: world,
            parentMatrix: matrix,
            bounds,
            clips: nextClips,
            container: ['group', 'component', 'scene'].includes(n.type),
            strokes,
            opacity: alpha,
            uncertainty: uncertain,
            contentPolygons: polygons,
            textLayout,
          });
          if (layers.length > 20000)
            throw new VmotionError('INTERACTION_LIMIT', 'Interaction graph exceeds 20000 layers');
          if (n.type === 'component' || n.type === 'scene') {
            const scene = n.type === 'scene' ? this.referencedScene(snapshot, n) : undefined,
              generated = prefixNodes(
                scene
                  ? composeGenerated(this.templates.apply(snapshot, n, scene.nodes), n)
                  : await this.generatedNodes(snapshot, n, timing!.sourceFrame),
                n.id,
              ),
              sourceWidth = scene?.width ?? snapshot.project.width,
              sourceHeight = scene?.height ?? snapshot.project.height,
              sourceMatrix = scene
                ? multiply(
                    [n.width / sourceWidth, 0, 0, n.height / sourceHeight, 0, 0],
                    cameraMatrix(scene.camera, sourceWidth, sourceHeight),
                  )
                : ([1, 0, 0, 1, 0, 0] as Matrix);
            await walk(
              generated,
              multiply(world, sourceMatrix),
              [...editPath, n.id],
              nextClips,
              level + 1,
              alpha,
              uncertain,
              timing!.sourceFrame,
              [...contexts, localFrame],
              {
                width: scene ? sourceWidth : n.width,
                height: scene ? sourceHeight : n.height,
                duration: scene?.duration ?? n.timeMapping.duration ?? localContext.duration,
              },
            );
          }
          await visit(n.id, world, nextClips, level + 1, alpha, uncertain);
          if (n.type === 'group') {
            const inv = inverse(world);
            if (inv) {
              const points = layers.slice(index + 1).flatMap((layer) => {
                const b = layer.bounds,
                  m = multiply(inv, layer.matrix);
                return [
                  { x: b.x, y: b.y },
                  { x: b.x + b.width, y: b.y },
                  { x: b.x + b.width, y: b.y + b.height },
                  { x: b.x, y: b.y + b.height },
                ].map((p) => transform(m, p));
              });
              if (points.length) {
                const x = Math.min(...points.map((p) => p.x)),
                  y = Math.min(...points.map((p) => p.y));
                layers[index].bounds = {
                  x,
                  y,
                  width: Math.max(...points.map((p) => p.x)) - x,
                  height: Math.max(...points.map((p) => p.y)) - y,
                };
              }
            }
          }
        }
      };
      await visit(undefined, parentMatrix, clips, depth);
    };
    await walk(
      scope.scene.nodes,
      cameraMatrix(scope.scene.camera, scope.width, scope.height),
      path,
      [],
      0,
    );
    return {
      revision: snapshot.revision,
      frame,
      sceneId,
      path,
      contextFrames: scope.contextFrames,
      layers,
    };
  }
  async generatedNodes(snapshot: Snapshot, n: Node, frame: number): Promise<Node[]> {
    let audio: ReturnType<typeof audioAt> | undefined;
    if (n.audioAssetId) {
      const asset = snapshot.project.assets.find((a) => a.id === n.audioAssetId);
      if (!asset)
        throw new VmotionError('MISSING_AUDIO', `Audio asset ${n.audioAssetId} not found`);
      const file = await audioSourceFile(this.root, snapshot, asset),
        time = frameSeconds(frame, snapshot.project.fps) + n.audioOffset,
        segment = Math.max(0, Math.floor(time / 30)),
        key = `${file}:${await fingerprint(file)}:${segment}`;
      if (!this.audioAnalysis.has(key)) {
        if (this.audioAnalysis.size >= 3) {
          const first = this.audioAnalysis.keys().next().value!;
          this.audioAnalysis.delete(first);
          this.audioControllers.get(first)?.abort();
          this.audioControllers.delete(first);
        }
        const controller = new AbortController();
        this.audioControllers.set(key, controller);
        this.audioAnalysis.set(
          key,
          analyzeAudio(file, { start: segment * 30, duration: 31, signal: controller.signal })
            .catch((e) => {
              if (e instanceof VmotionError && e.code === 'ANALYSIS_RANGE')
                return {
                  sampleRate: 24000,
                  rate: 30,
                  duration: 0,
                  bpm: 0,
                  beats: [],
                  features: [],
                };
              this.audioAnalysis.delete(key);
              throw e;
            })
            .finally(() => this.audioControllers.delete(key)),
        );
      }
      audio = audioAt(await this.audioAnalysis.get(key)!, time - segment * 30);
    }
    const started = performance.now(),
      nodes = await this.components.render(snapshot, n, {
        frame,
        seconds: frameSeconds(frame, snapshot.project.fps),
        fps: snapshot.project.fps.num / snapshot.project.fps.den,
        width: n.width,
        height: n.height,
        seed: 1,
        audio,
      });
    this.timings.componentCalls++;
    this.timings.componentMs += performance.now() - started;
    return composeGenerated(nodes, n);
  }
  textGeometry(n: Node, frame = 0) {
    const ctx = createCanvas(1, 1).getContext('2d');
    if (n.pathText || n.textAnimators.length) return this.typography.layout(ctx, n, frame);
    const lines = this.textLines(ctx, n),
      rendered = lines.filter((_, i) => i * n.fontSize * n.lineHeight < n.height),
      full = n.reveal === 1 ? lines : this.textLines(ctx, { ...n, reveal: 1 });
    const runs = this.textRuns(ctx, n, frame).map((run, index) => {
      ctx.font = `${n.fontWeight} ${n.fontSize}px "${n.fontFamily}"`;
      ctx.textAlign = 'left';
      ctx.textBaseline = run.baseline;
      const m = ctx.measureText(run.text);
      return {
        ...run,
        index,
        wordIndex: -1,
        lineIndex: 0,
        width: m.width,
        box: {
          x: -m.actualBoundingBoxLeft,
          y: -m.actualBoundingBoxAscent,
          width: Math.max(m.width, m.actualBoundingBoxRight) + m.actualBoundingBoxLeft,
          height: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
        },
      };
    });
    return {
      runs,
      metrics: {
        lineCount: lines.length,
        renderedLineCount: rendered.length,
        fullLineCount: full.length,
        truncatedCharacters: lines.slice(rendered.length).join('').length,
        requiredHeight: full.length * n.fontSize * n.lineHeight + n.strokeWidth,
      },
    };
  }
  private textLines(ctx: SKRSContext2D, n: Node) {
    return this.typography.lines(ctx, n);
  }
  private textRuns(ctx: SKRSContext2D, n: Node, frame: number) {
    if (n.pathText || n.textAnimators.length) return this.typography.layout(ctx, n, frame).runs;
    const lines = this.textLines(ctx, n);
    const runs: Array<{
      text: string;
      x: number;
      y: number;
      rotation: number;
      scaleX: number;
      scaleY: number;
      baseline: 'top' | 'alphabetic';
      fill?: string;
      alpha: number;
    }> = [];
    let unitIndex = 0;
    lines.forEach((line, i) => {
      if (i * n.fontSize * n.lineHeight >= n.height) return;
      if (n.textMotion) {
        const motion = n.textMotion,
          units = Array.from(
            new Intl.Segmenter('zh', {
              granularity: motion.unit === 'word' ? 'word' : 'grapheme',
            }).segment(line),
            (s) => s.segment,
          ),
          lineWidth = ctx.measureText(line).width,
          origin =
            n.align === 'center'
              ? (n.width - lineWidth) / 2
              : n.align === 'right'
                ? n.width - lineWidth
                : 0;
        let prefix = '';
        for (const unit of units) {
          const p = Math.max(
              0,
              Math.min(1, (frame - motion.start - unitIndex++ * motion.stagger) / motion.duration),
            ),
            e = 1 - (1 - p) ** 3,
            position = ctx.measureText(prefix).width;
          prefix += unit;
          if (p === 0) continue;
          runs.push({
            text: unit,
            x: origin + position + motion.offsetX * (1 - e),
            y: i * n.fontSize * n.lineHeight + motion.offsetY * (1 - e),
            rotation: motion.rotation * (1 - e),
            scaleX: motion.scale + (1 - motion.scale) * e,
            scaleY: motion.scale + (1 - motion.scale) * e,
            baseline: 'top',
            alpha: p,
          });
        }
        return;
      }
      const width = ctx.measureText(line).width;
      runs.push({
        text: line,
        x: n.align === 'center' ? (n.width - width) / 2 : n.align === 'right' ? n.width - width : 0,
        y: i * n.fontSize * n.lineHeight,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        baseline: 'top',
        alpha: 1,
      });
    });
    return runs;
  }
  private text(ctx: SKRSContext2D, n: Node, frame: number) {
    const runs = this.textRuns(ctx, n, frame);
    ctx.textAlign = 'left';
    for (const run of runs) {
      ctx.save();
      ctx.globalAlpha *= run.alpha;
      ctx.translate(run.x, run.y);
      ctx.rotate((run.rotation * Math.PI) / 180);
      ctx.scale(run.scaleX, run.scaleY);
      ctx.textBaseline = run.baseline;
      if (run.fill) ctx.fillStyle = run.fill;
      if (n.strokeWidth) ctx.strokeText(run.text, 0, 0);
      ctx.fillText(run.text, 0, 0);
      ctx.restore();
    }
  }
  private chart(ctx: SKRSContext2D, n: Node) {
    const values = Array.isArray(n.params.values)
        ? n.params.values.map(Number)
        : [25, 60, 45, 90, 70],
      max = Math.max(1, ...values),
      mode = n.params.mode ?? 'bar';
    ctx.strokeStyle = '#44516b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, n.height);
    ctx.lineTo(n.width, n.height);
    ctx.stroke();
    if (mode === 'line') {
      ctx.strokeStyle = n.fill;
      ctx.lineWidth = 3;
      ctx.beginPath();
      values.forEach((v, i) => {
        const x = (i * n.width) / Math.max(1, values.length - 1),
          y = n.height - (v / max) * (n.height - 20) * n.reveal;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    } else
      values.forEach((v, i) => {
        const slot = n.width / values.length,
          height = (v / max) * (n.height - 20) * n.reveal;
        ctx.fillRect(i * slot + slot * 0.12, n.height - height, slot * 0.76, height);
      });
  }
  private drawing(ctx: SKRSContext2D, n: Node, points: Node['points']) {
    ctx.strokeStyle = n.stroke || n.fill;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      ctx.lineWidth = Math.max(0.5, (n.strokeWidth * (a.pressure + b.pressure)) / 2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
  async close() {
    this.themes.clear();
    this.templates.clear();
    this.typography.clear();
    this.geometry.clear();
    for (const controller of this.audioControllers.values()) controller.abort();
    await Promise.allSettled(this.audioAnalysis.values());
    this.audioAnalysis.clear();
    this.audioControllers.clear();
    this.native.close();
    await this.components.close();
    await Promise.all([...this.decoders.values()].map((decoder) => decoder.close()));
    this.decoders.clear();
    for (const release of this.decoderLeases.values()) release();
    this.decoderLeases.clear();
    this.images.clear();
    this.imageBytes = 0;
    this.surfaces.clear();
  }
}
