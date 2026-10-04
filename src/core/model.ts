import { z } from 'zod';
import { drawingDocumentSchema, type DrawingDocument } from './drawing-model.js';
import { fileEditSchema, type FileEdit } from './file-edits.js';
import { vectorFields } from './vector-schema.js';
import { matrixSchema } from './repeater-schema.js';
import { contentTimeSchema } from './content-time-schema.js';
import { scene3dSchema } from './scene3d-schema.js';
import { spatialEffectSchema } from './spatial-effect-schema.js';
import { temporalEffectSchema } from './temporal-effect.js';
import { pinGrid } from './warp-grid.js';

export const FORMAT_VERSION = 1;
const finite = z.number().finite();
const id = z.string().min(1).max(200);
const color = z.string().min(1);
const pointSchema = z.object({ x: finite, y: finite });
const curveSchema = z
  .array(z.object({ x: finite.min(0).max(1), y: finite.min(0).max(1) }))
  .min(2)
  .max(32)
  .refine(
    (points) => points.every((p, i) => i === 0 || p.x > points[i - 1].x),
    'Curve input positions must increase',
  );
export const gradientSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('linear'),
    from: pointSchema,
    to: pointSchema,
    stops: z
      .array(z.object({ offset: finite.min(0).max(1), color }))
      .min(2)
      .max(32),
  }),
  z.object({
    type: z.literal('radial'),
    center: pointSchema,
    radius: finite.positive(),
    stops: z
      .array(z.object({ offset: finite.min(0).max(1), color }))
      .min(2)
      .max(32),
  }),
]);
const baseEffectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('blur'), radius: finite.min(0).max(300) }),
  z.object({
    type: z.literal('glow'),
    color,
    radius: finite.min(0).max(300),
    intensity: finite.min(0).max(4).default(1),
    threshold: finite.min(0).max(1).optional(),
  }),
  z.object({
    type: z.literal('color'),
    brightness: finite.min(0).max(4).default(1),
    contrast: finite.min(0).max(4).default(1),
    saturation: finite.min(0).max(4).default(1),
    hue: finite.default(0),
  }),
  z.object({
    type: z.literal('shadow'),
    color,
    blur: finite.min(0).max(300),
    x: finite,
    y: finite,
  }),
  z.object({
    type: z.literal('chromaKey'),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    tolerance: finite.min(0).max(1).default(0.12),
    softness: finite.min(0.001).max(1).default(0.15),
    despill: finite.min(0).max(1).default(0.8),
  }),
  z.object({
    type: z.literal('levels'),
    inputBlack: finite.min(0).max(0.999).default(0),
    inputWhite: finite.min(0.001).max(1).default(1),
    gamma: finite.min(0.05).max(20).default(1),
    outputBlack: finite.min(0).max(1).default(0),
    outputWhite: finite.min(0).max(1).default(1),
  }),
  z.object({
    type: z.literal('curves'),
    master: curveSchema.optional(),
    red: curveSchema.optional(),
    green: curveSchema.optional(),
    blue: curveSchema.optional(),
  }),
  z.object({
    type: z.literal('lut3d'),
    size: z.number().int().min(2).max(33),
    data: z
      .array(finite)
      .min(24)
      .max(33 ** 3 * 3),
    domainMin: z.tuple([finite, finite, finite]).default([0, 0, 0]),
    domainMax: z.tuple([finite, finite, finite]).default([1, 1, 1]),
    intensity: finite.min(0).max(1).default(1),
  }),
  z.object({
    type: z.literal('vignette'),
    amount: finite.min(0).max(1).default(0.5),
    radius: finite.min(0.05).max(2).default(0.75),
    softness: finite.min(0.01).max(2).default(0.6),
    center: pointSchema.default({ x: 0.5, y: 0.5 }),
  }),
  z.object({
    type: z.literal('grain'),
    amount: finite.min(0).max(1).default(0.08),
    seed: z.number().int().default(1),
    monochrome: z.boolean().default(true),
    animated: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('displacement'),
    amountX: finite.min(-500).max(500).default(20),
    amountY: finite.min(-500).max(500).default(20),
    scale: finite.min(1).max(2000).default(100),
    seed: z.number().int().default(1),
    evolution: finite.default(0),
    octaves: z.number().int().min(1).max(6).default(3),
    edge: z.enum(['transparent', 'clamp', 'wrap']).default('transparent'),
  }),
  z.object({ type: z.literal('pixelate'), size: finite.min(1).max(500).default(12) }),
  ...spatialEffectSchema.options,
  ...temporalEffectSchema.options,
]);
export const effectDefinitions = baseEffectSchema.options.map((option) =>
  option.extend({ id: z.string().min(1).max(200).optional(), enabled: z.boolean().optional() }),
);
type EffectMetadata = { id?: string; enabled?: boolean };
export const effectSchema = z
  .discriminatedUnion(
    'type',
    effectDefinitions as [
      (typeof effectDefinitions)[number],
      ...Array<(typeof effectDefinitions)[number]>,
    ],
  )
  .superRefine((effect, ctx) => {
    if (
      effect.type === 'meshWarp' &&
      effect.points.length !== (effect.columns + 1) * (effect.rows + 1)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Grid point count must be (columns+1)*(rows+1)',
        path: ['points'],
      });
    if (effect.type === 'cornerPin') {
      try {
        pinGrid(effect.corners);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: (error as Error).message, path: ['corners'] });
      }
    }
  }) as unknown as z.ZodType<
  z.output<typeof baseEffectSchema> & EffectMetadata,
  z.ZodTypeDef,
  z.input<typeof baseEffectSchema> & EffectMetadata
>;
const effectArraySchema = z
  .array(effectSchema)
  .max(16)
  .superRefine((effects, ctx) => {
    const ids = effects.flatMap((e) => (e.id ? [e.id] : []));
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'Effect IDs must be unique within a layer' });
  });
export const keyframeSchema = z.object({
  frame: z.number().int().nonnegative(),
  value: finite,
  easing: z
    .enum(['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold', 'spring', 'bezier'])
    .default('linear'),
  bezier: z.tuple([finite.min(0).max(1), finite, finite.min(0).max(1), finite]).optional(),
});
export const animationSchema = z.object({
  property: z
    .string()
    .regex(
      /^(x|y|width|height|rotation|scaleX|scaleY|originX|originY|opacity|fontSize|reveal|blur|brightness|saturation|maskFeather|strokeWidth|strokeDashOffset|strokeMiterLimit|radius|timeMapping\.(anchor|offset|rate|frame)|matrix\.[0-5]|scene3d\.(camera\.(position|target|up)\.[xyz]|camera\.(fov|near|far|orthographicHeight)|instances\.\d+\.transform\.(position|rotation|scale|pivot)\.[xyz]|instances\.\d+\.matrix\.\d+|instances\.\d+\.material\.(metallic|roughness|emissiveIntensity|creaseAngle)|options\.light\.[xyz]|options\.(ambient|exposure)|options\.lights\.\d+\.(intensity|range|position\.[xyz]|direction\.[xyz]))|pathTrim\.(start|end|offset)|strokeDash\.\d+|params\.[a-zA-Z][\w-]*(?:\.(?:[a-zA-Z][\w-]*|\d+))*|effects\.\d+\.(radius|intensity|threshold|brightness|contrast|saturation|hue|amount|amountX|amountY|wavelength|angle|phase|shutterAngle|spacing|decay|strength|progress|feather|brushes\.\d+\.(radius|dx|dy|angle|amount|center\.[xy])|points\.\d+\.(x|y|weight)|corners\.\d+\.[xy]|center\.[xy]|region\.(x|y|width|height)|scale|evolution|size|gamma|inputBlack|inputWhite|outputBlack|outputWhite|tolerance|softness|despill|blur|x|y)|gradient\.(from|to|center)\.(x|y)|gradient\.radius|gradient\.stops\.\d+\.offset|clip\.(x|y|width|height))$/,
      'Unsupported numeric animation target',
    ),
  keys: z.array(keyframeSchema).min(1),
});
export const overrideSchema = z
  .object({
    name: z.string().optional(),
    visible: z.boolean().optional(),
    x: finite.optional(),
    y: finite.optional(),
    width: finite.nonnegative().optional(),
    height: finite.nonnegative().optional(),
    rotation: finite.optional(),
    scaleX: finite.optional(),
    scaleY: finite.optional(),
    originX: finite.optional(),
    originY: finite.optional(),
    matrix: matrixSchema.optional(),
    timeMapping: contentTimeSchema.optional(),
    opacity: finite.min(0).max(1).optional(),
    fill: color.optional(),
    stroke: z.string().optional(),
    strokeWidth: finite.nonnegative().optional(),
    strokeDash: vectorFields.strokeDash.optional(),
    strokeDashOffset: vectorFields.strokeDashOffset.optional(),
    strokeCap: vectorFields.strokeCap.optional(),
    strokeJoin: vectorFields.strokeJoin.optional(),
    strokeMiterLimit: vectorFields.strokeMiterLimit.optional(),
    fillRule: vectorFields.fillRule.optional(),
    pathTrim: vectorFields.pathTrim.optional(),
    path: z.string().optional(),
    radius: finite.nonnegative().optional(),
    text: z.string().optional(),
    fontFamily: z.string().optional(),
    fontSize: finite.positive().optional(),
    fontWeight: z.number().int().min(100).max(900).optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    lineHeight: finite.positive().optional(),
    reveal: finite.min(0).max(1).optional(),
    effects: effectArraySchema.optional(),
    gradient: gradientSchema.optional(),
    animations: z.array(animationSchema).optional(),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().positive().optional(),
    maskFeather: finite.min(0).max(300).optional(),
    maskMode: z.enum(['alpha', 'alphaInverted', 'luma', 'lumaInverted']).optional(),
    params: z.record(z.unknown()).optional(),
    sceneId: id.optional(),
    scene3d: scene3dSchema.optional(),
  })
  .strict();
export const nodeBaseSchema = z
  .object({
    id,
    type: z.enum([
      'group',
      'text',
      'rect',
      'ellipse',
      'path',
      'image',
      'video',
      'formula',
      'chart',
      'component',
      'drawing',
      'scene',
      'scene3d',
    ]),
    name: z.string().default('Layer'),
    parentId: id.optional(),
    visible: z.boolean().default(true),
    x: finite.default(0),
    y: finite.default(0),
    width: finite.nonnegative().default(200),
    height: finite.nonnegative().default(100),
    rotation: finite.default(0),
    scaleX: finite.default(1),
    scaleY: finite.default(1),
    originX: finite.default(0),
    originY: finite.default(0),
    matrix: matrixSchema.default([1, 0, 0, 1, 0, 0]),
    timeMapping: contentTimeSchema.default({}),
    opacity: finite.min(0).max(1).default(1),
    fill: color.default('#7c8cff'),
    gradient: gradientSchema.optional(),
    effects: effectArraySchema.default([]),
    stroke: z.string().default(''),
    strokeWidth: finite.nonnegative().default(0),
    ...vectorFields,
    radius: finite.nonnegative().default(0),
    text: z.string().default(''),
    fontFamily: z.string().default('Microsoft YaHei'),
    fontSize: finite.positive().default(48),
    fontWeight: z.number().int().min(100).max(900).default(400),
    align: z.enum(['left', 'center', 'right']).default('left'),
    lineHeight: finite.positive().default(1.3),
    reveal: finite.min(0).max(1).default(1),
    textMotion: z
      .object({
        unit: z.enum(['grapheme', 'word']).default('grapheme'),
        start: z.number().int().nonnegative().default(0),
        duration: z.number().int().positive().default(18),
        stagger: z.number().int().nonnegative().default(2),
        offsetX: finite.default(0),
        offsetY: finite.default(24),
        rotation: finite.default(0),
        scale: finite.min(0.01).max(10).default(0.85),
      })
      .optional(),
    assetId: id.optional(),
    source: z.string().optional(),
    sceneId: id.optional(),
    component: z.string().optional(),
    scene3d: scene3dSchema.optional(),
    audioAssetId: id.optional(),
    audioOffset: finite.default(0),
    params: z.record(z.unknown()).default({}),
    overrides: z.record(overrideSchema).default({}),
    path: z.string().default(''),
    blend: z
      .enum([
        'source-over',
        'multiply',
        'screen',
        'overlay',
        'darken',
        'lighten',
        'difference',
        'destination-in',
      ])
      .default('source-over'),
    blur: finite.nonnegative().default(0),
    shadow: z.object({ color, blur: finite.nonnegative(), x: finite, y: finite }).optional(),
    clip: z
      .object({ x: finite, y: finite, width: finite.nonnegative(), height: finite.nonnegative() })
      .optional(),
    maskId: id.optional(),
    maskMode: z.enum(['alpha', 'alphaInverted', 'luma', 'lumaInverted']).default('alpha'),
    maskFeather: finite.min(0).max(300).default(0),
    brightness: finite.min(0).max(4).default(1),
    saturation: finite.min(0).max(4).default(1),
    start: z.number().int().nonnegative().default(0),
    end: z.number().int().positive().optional(),
    animations: z.array(animationSchema).default([]),
    points: z
      .array(z.object({ x: finite, y: finite, pressure: finite.min(0).max(1).default(1) }))
      .default([]),
  })
  .strict();
const editSchema = z
  .object({
    added: z.array(nodeBaseSchema).max(4000).default([]),
    removed: z.array(id).max(10000).default([]),
    parents: z.record(id.nullable()).default({}),
    order: z.array(id).max(10000).default([]),
  })
  .strict();
export const structureSchema = editSchema.extend({ nested: z.record(editSchema).default({}) });
export const nodeSchema = nodeBaseSchema.extend({ structure: structureSchema.optional() });
export const sceneSchema = z
  .object({
    id,
    name: z.string(),
    duration: z.number().int().positive(),
    width: z.number().int().min(16).max(3840).optional(),
    height: z.number().int().min(16).max(2160).optional(),
    background: color.default('#101525'),
    nodes: z.array(nodeSchema),
    camera: z
      .object({ x: finite, y: finite, zoom: finite.positive(), rotation: finite })
      .optional(),
  })
  .strict();
export const clipSchema = z
  .object({
    id,
    sceneId: id.optional(),
    sequenceId: id.optional(),
    assetId: id.optional(),
    start: z.number().int().nonnegative(),
    duration: z.number().int().positive(),
    sourceIn: finite.nonnegative().default(0),
    sourceOut: finite.positive().optional(),
    speed: finite.positive().default(1),
    volume: finite.min(0).max(4).default(1),
    fadeIn: z.number().int().nonnegative().default(0),
    fadeOut: z.number().int().nonnegative().default(0),
    name: z.string().optional(),
    linkedGroup: id.optional(),
    audioEnabled: z.boolean().optional(),
    fadeWindow: z.object({ offset: finite, duration: finite.positive() }).strict().optional(),
    sourceWindow: z
      .object({ sourceIn: finite.nonnegative(), duration: finite.positive() })
      .strict()
      .optional(),
  })
  .strict();
export const trackSchema = z
  .object({
    id,
    name: z.string(),
    type: z.enum(['video', 'audio']),
    muted: z.boolean().default(false),
    locked: z.boolean().optional(),
    clips: z.array(clipSchema),
  })
  .strict();
export const sequenceSchema = z
  .object({
    id,
    name: z.string(),
    duration: z.number().int().positive(),
    tracks: z.array(trackSchema),
    workflow: z.enum(['general', 'remix', 'film']).optional(),
    workArea: z
      .object({ start: z.number().int().nonnegative(), end: z.number().int().positive() })
      .refine((r) => r.end > r.start, 'Out point must follow in point')
      .optional(),
    markers: z
      .array(
        z.object({
          id,
          frame: z.number().int().nonnegative(),
          label: z.string(),
          kind: z.enum(['marker', 'beat', 'chapter']).optional(),
          group: id.optional(),
        }),
      )
      .default([]),
  })
  .strict();
export const assetSchema = z
  .object({
    id,
    name: z.string(),
    path: z.string().min(1),
    type: z.enum(['image', 'video', 'audio', 'font', 'drawing']),
    managed: z.boolean().default(false),
    fingerprint: z.string().optional(),
    metadata: z.record(z.unknown()).default({}),
  })
  .strict();
export const projectSchema = z
  .object({
    formatVersion: z.literal(FORMAT_VERSION),
    id,
    name: z.string().min(1),
    width: z.number().int().min(16).max(3840),
    height: z.number().int().min(16).max(2160),
    fps: z.object({
      num: z.number().int().positive().max(60000),
      den: z.number().int().positive().max(1001),
    }),
    colorSpace: z.literal('srgb').default('srgb'),
    sampleRate: z.literal(48000).default(48000),
    activeSequence: id,
    scenes: z.array(z.string()),
    sequences: z.array(z.string()),
    assets: z.array(assetSchema),
    drawings: z
      .array(z.object({ id, name: z.string().min(1), path: z.string().min(1) }).strict())
      .default([]),
    sdkVersion: z.string().default('0.1.0'),
    motionBlur: z
      .object({
        samples: z.number().int().min(2).max(16),
        shutterAngle: finite.min(0).max(360).default(180),
      })
      .optional(),
  })
  .strict()
  .refine((p) => p.fps.num / p.fps.den <= 60, 'Frame rate must not exceed 60fps');

export type Node = z.infer<typeof nodeSchema>;
export type ComponentStructure = z.infer<typeof structureSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type Sequence = z.infer<typeof sequenceSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type Clip = z.infer<typeof clipSchema>;
export type Track = z.infer<typeof trackSchema>;
export type Keyframe = z.infer<typeof keyframeSchema>;
export type Effect = z.infer<typeof effectSchema>;
export type Gradient = z.infer<typeof gradientSchema>;
export interface Snapshot {
  project: Project;
  scenes: Scene[];
  sequences: Sequence[];
  revision: string;
  files: Record<string, string>;
}
export interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  path?: string;
}
export interface Conflict {
  file: string;
  path: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
}
export type Operation =
  | { type: 'editFiles'; edits: FileEdit[] }
  | { type: 'writeDrawing'; document: DrawingDocument }
  | { type: 'removeDrawing'; id: string }
  | { type: 'updateNode'; sceneId: string; nodeId: string; patch: Partial<Node> }
  | { type: 'addNode'; sceneId: string; node: Partial<Node> & Pick<Node, 'id' | 'type'> }
  | { type: 'removeNode'; sceneId: string; nodeId: string }
  | { type: 'updateScene'; sceneId: string; patch: Partial<Scene> }
  | { type: 'addScene'; scene: Scene }
  | { type: 'removeScene'; sceneId: string }
  | { type: 'updateSequence'; sequenceId: string; patch: Partial<Sequence> }
  | { type: 'addTrack'; sequenceId: string; track: Track }
  | { type: 'removeTrack'; sequenceId: string; trackId: string }
  | { type: 'addClip'; sequenceId: string; trackId: string; clip: Clip }
  | {
      type: 'updateClip';
      sequenceId: string;
      trackId: string;
      clipId: string;
      patch: Partial<Clip>;
    }
  | { type: 'removeClip'; sequenceId: string; trackId: string; clipId: string }
  | { type: 'updateProject'; patch: Partial<Project> }
  | { type: 'addAsset'; asset: Asset }
  | { type: 'writeSource'; path: string; content: string };

const nodePatchSchema = nodeSchema.partial();
const scenePatchSchema = sceneSchema.partial();
const updateNodeOperation: z.ZodObject<{
  type: z.ZodLiteral<'updateNode'>;
  sceneId: typeof id;
  nodeId: typeof id;
  patch: typeof nodePatchSchema;
}> = z.object({ type: z.literal('updateNode'), sceneId: id, nodeId: id, patch: nodePatchSchema });
const addNodeOperation: z.ZodObject<{
  type: z.ZodLiteral<'addNode'>;
  sceneId: typeof id;
  node: typeof nodeSchema;
}> = z.object({ type: z.literal('addNode'), sceneId: id, node: nodeSchema });
const updateSceneOperation: z.ZodObject<{
  type: z.ZodLiteral<'updateScene'>;
  sceneId: typeof id;
  patch: typeof scenePatchSchema;
}> = z.object({ type: z.literal('updateScene'), sceneId: id, patch: scenePatchSchema });
const addSceneOperation: z.ZodObject<{
  type: z.ZodLiteral<'addScene'>;
  scene: typeof sceneSchema;
}> = z.object({ type: z.literal('addScene'), scene: sceneSchema });
const operationOptions = [
  z.object({ type: z.literal('editFiles'), edits: z.array(fileEditSchema).min(1).max(1000) }),
  z.object({ type: z.literal('writeDrawing'), document: drawingDocumentSchema }),
  z.object({ type: z.literal('removeDrawing'), id }),
  updateNodeOperation,
  addNodeOperation,
  z.object({ type: z.literal('removeNode'), sceneId: id, nodeId: id }),
  updateSceneOperation,
  addSceneOperation,
  z.object({ type: z.literal('removeScene'), sceneId: id }),
  z.object({ type: z.literal('updateSequence'), sequenceId: id, patch: sequenceSchema.partial() }),
  z.object({ type: z.literal('addTrack'), sequenceId: id, track: trackSchema }),
  z.object({ type: z.literal('removeTrack'), sequenceId: id, trackId: id }),
  z.object({ type: z.literal('addClip'), sequenceId: id, trackId: id, clip: clipSchema }),
  z.object({
    type: z.literal('updateClip'),
    sequenceId: id,
    trackId: id,
    clipId: id,
    patch: clipSchema.partial(),
  }),
  z.object({ type: z.literal('removeClip'), sequenceId: id, trackId: id, clipId: id }),
  z.object({ type: z.literal('updateProject'), patch: projectSchema.innerType().partial() }),
  z.object({ type: z.literal('addAsset'), asset: assetSchema }),
  z.object({ type: z.literal('writeSource'), path: z.string(), content: z.string() }),
] as const;
export const operationSchema: z.ZodDiscriminatedUnion<'type', typeof operationOptions> =
  z.discriminatedUnion('type', operationOptions);

export class VmotionError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: unknown = undefined,
  ) {
    super(message);
    this.name = 'VmotionError';
  }
}
export const newNode = (value: Partial<Node> & Pick<Node, 'id' | 'type'>): Node =>
  nodeSchema.parse(value);
