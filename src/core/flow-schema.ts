import { z } from 'zod';

const finite = z.number().finite();
const nonnegative = finite.nonnegative();
const positive = finite.positive();

/** Safe identifier usable both as a stable graph ID and as `<id>.json` filename under `nodes/`. */
export const flowNodeIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
    'Flow node IDs must use ASCII letters, digits, underscores or hyphens',
  );

export const flowIdSchema = flowNodeIdSchema;

export const flowCueSchema = z
  .object({
    start: nonnegative,
    end: positive,
    text: z.string().min(1).max(1000),
  })
  .strict()
  .refine((c) => c.end > c.start, 'Cue end must exceed start');

export const flowTimingSchema = z
  .object({
    mode: z.enum(['fixed', 'follow-voice', 'follow-visual', 'bars']).default('fixed'),
    seconds: positive.max(3600).optional(),
    frames: z.number().int().positive().max(216000).optional(),
    bars: positive.max(512).optional(),
    bpm: positive.min(20).max(400).optional(),
    beatsPerBar: z.number().int().min(1).max(16).default(4),
    padStart: nonnegative.max(60).default(0),
    padEnd: nonnegative.max(60).default(0),
    minSeconds: positive.max(3600).optional(),
    maxSeconds: positive.max(3600).optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (
      t.minSeconds !== undefined &&
      t.maxSeconds !== undefined &&
      t.maxSeconds < t.minSeconds
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'maxSeconds must be greater than or equal to minSeconds',
        path: ['maxSeconds'],
      });
    }
  });

export const flowTransitionSchema = z
  .object({
    type: z.enum(['cut', 'dissolve', 'fade']).default('cut'),
    seconds: nonnegative.max(10).default(0),
  })
  .strict();

export const flowVisualSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('scene'),
      sceneId: z.string().min(1).max(200),
      sourceIn: nonnegative.default(0),
      speed: positive.max(100).default(1),
      params: z.record(z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('component'),
      source: z.string().min(1).max(300),
      params: z.record(z.unknown()).default({}),
      background: z.string().min(1).max(64).default('#101525'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('asset'),
      assetId: z.string().min(1).max(200),
      sourceIn: nonnegative.default(0),
      duration: positive.max(7200).optional(),
      speed: positive.max(100).default(1),
      audioEnabled: z.boolean().default(false),
      volume: finite.min(0).max(4).default(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('workflow'),
      workflow: z.string().min(1).max(300),
      modality: z.enum(['image', 'video']).default('image'),
      params: z.record(z.unknown()).default({}),
      bakedAssetId: z.string().min(1).max(200).optional(),
      bakedHash: z.string().max(128).optional(),
      fitPolicy: z.enum(['trim', 'fit-speed', 'extend-shot']).default('trim'),
      fallbackSceneId: z.string().min(1).max(200).optional(),
      fallbackColor: z.string().min(1).max(64).default('#161d2e'),
    })
    .strict(),
]);

export const flowVoiceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('asset'),
      assetId: z.string().min(1).max(200),
      sourceIn: nonnegative.default(0),
      duration: positive.max(7200).optional(),
      volume: finite.min(0).max(4).default(1),
      fadeIn: nonnegative.max(10).default(0),
      fadeOut: nonnegative.max(10).default(0),
      cues: z.array(flowCueSchema).max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('tts'),
      text: z.string().min(1).max(4000),
      provider: z.string().min(1).max(120).default('local-tts'),
      workflow: z.string().min(1).max(300).optional(),
      voiceRefAssetId: z.string().min(1).max(200).optional(),
      voicePreset: z.string().min(1).max(120).optional(),
      speed: positive.min(0.25).max(4).default(1),
      volume: finite.min(0).max(4).default(1),
      bakedAssetId: z.string().min(1).max(200).optional(),
      bakedHash: z.string().max(128).optional(),
      cues: z.array(flowCueSchema).max(500).optional(),
    })
    .strict(),
]);

export const flowSubtitleSchema = z
  .object({
    mode: z.enum(['none', 'from-voice', 'custom']).default('none'),
    text: z.string().max(4000).optional(),
    cues: z.array(flowCueSchema).max(500).optional(),
    fontSize: positive.min(12).max(240).default(44),
    color: z.string().min(1).max(64).default('#f5f7fb'),
    background: z.string().min(1).max(64).default('rgba(10, 14, 24, 0.72)'),
    yRatio: finite.min(0.05).max(0.95).default(0.86),
  })
  .strict();

export const flowAttachmentSchema = z
  .object({
    id: flowNodeIdSchema,
    atSeconds: nonnegative.max(3600).default(0),
    atProgress: finite.min(0).max(1).optional(),
    durationSeconds: positive.max(3600).optional(),
    sfxAssetId: z.string().min(1).max(200).optional(),
    sceneId: z.string().min(1).max(200).optional(),
    assetId: z.string().min(1).max(200).optional(),
    gainDb: finite.min(-60).max(12).default(0),
  })
  .strict()
  .superRefine((att, ctx) => {
    const count = [att.sfxAssetId, att.sceneId, att.assetId].filter(Boolean).length;
    if (count !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'Attachment must specify exactly one of sfxAssetId, sceneId or assetId',
      });
    }
  });

const nodeCommon = {
  kind: z.literal('flow-node').default('flow-node'),
  version: z.literal(1).default(1),
  id: flowNodeIdSchema,
  name: z.string().min(1).max(240).optional(),
  intent: z.string().max(500).optional(),
  chapter: z.string().min(1).max(240).optional(),
  enabled: z.boolean().default(true),
  pos: z.tuple([finite, finite]).optional(),
};

export const flowShotNodeSchema = z
  .object({
    ...nodeCommon,
    type: z.literal('shot'),
    timing: flowTimingSchema.default({}),
    transitionIn: flowTransitionSchema.optional(),
    visual: flowVisualSchema,
    voice: flowVoiceSchema.optional(),
    subtitle: flowSubtitleSchema.optional(),
    overlays: z.array(flowAttachmentSchema).max(16).default([]),
  })
  .strict();

export const flowTranscriptSegmentSchema = z
  .object({
    id: flowNodeIdSchema,
    start: nonnegative,
    end: positive,
    text: z.string().max(1000).optional(),
    keep: z.boolean().default(true),
  })
  .strict()
  .refine((s) => s.end > s.start, 'Transcript segment end must exceed start');

const flowTranscriptCutBaseSchema = z
  .object({
    ...nodeCommon,
    type: z.literal('transcript-cut'),
    assetId: z.string().min(1).max(200),
    segments: z.array(flowTranscriptSegmentSchema).min(1).max(1000),
    keepIds: z.array(flowNodeIdSchema).max(1000).optional(),
    padStart: nonnegative.max(5).default(0.05),
    padEnd: nonnegative.max(5).default(0.08),
    jCutSeconds: nonnegative.max(3).default(0),
    lCutSeconds: nonnegative.max(3).default(0),
    volume: finite.min(0).max(4).default(1),
    subtitle: flowSubtitleSchema.optional(),
    transitionIn: flowTransitionSchema.optional(),
  })
  .strict();

function refineTranscriptCut(
  node: z.output<typeof flowTranscriptCutBaseSchema>,
  ctx: z.RefinementCtx,
) {
  const ids = node.segments.map((s) => s.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({
      code: 'custom',
      message: 'Transcript segment IDs must be unique',
      path: ['segments'],
    });
  }
  if (node.keepIds) {
    const known = new Set(ids);
    for (const [i, keepId] of node.keepIds.entries()) {
      if (!known.has(keepId)) {
        ctx.addIssue({
          code: 'custom',
          message: `Unknown transcript segment ID "${keepId}"`,
          path: ['keepIds', i],
        });
      }
    }
  }
}

export const flowTranscriptCutNodeSchema = flowTranscriptCutBaseSchema.superRefine(
  refineTranscriptCut,
);

export const flowBeatCutItemSchema = z
  .object({
    id: flowNodeIdSchema,
    kind: z.enum(['scene', 'asset']),
    refId: z.string().min(1).max(200),
    beats: positive.max(256).optional(),
    sourceIn: nonnegative.default(0),
    label: z.string().max(240).optional(),
  })
  .strict();

const flowBeatCutBaseSchema = z
  .object({
    ...nodeCommon,
    type: z.literal('beat-cut'),
    bpm: positive.min(20).max(400).optional(),
    soundAssetId: z.string().min(1).max(200).optional(),
    beatsPerCut: positive.max(256).default(4),
    items: z.array(flowBeatCutItemSchema).min(1).max(256),
    transitionIn: flowTransitionSchema.optional(),
  })
  .strict();

function refineBeatCut(node: z.output<typeof flowBeatCutBaseSchema>, ctx: z.RefinementCtx) {
  const ids = node.items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({
      code: 'custom',
      message: 'Beat-cut item IDs must be unique',
      path: ['items'],
    });
  }
}

export const flowBeatCutNodeSchema = flowBeatCutBaseSchema.superRefine(refineBeatCut);

export const flowBRollOverlayNodeSchema = z
  .object({
    ...nodeCommon,
    type: z.literal('broll-overlay'),
    anchor: z
      .object({
        nodeId: flowNodeIdSchema,
        segmentId: flowNodeIdSchema.optional(),
        offsetSeconds: finite.min(-60).max(3600).default(0),
        durationSeconds: positive.max(3600).optional(),
      })
      .strict(),
    visual: flowVisualSchema,
  })
  .strict();

export const flowNodeSchema = z
  .discriminatedUnion('type', [
    flowShotNodeSchema,
    flowTranscriptCutBaseSchema,
    flowBeatCutBaseSchema,
    flowBRollOverlayNodeSchema,
  ])
  .superRefine((node, ctx) => {
    if (node.type === 'transcript-cut') refineTranscriptCut(node, ctx);
    else if (node.type === 'beat-cut') refineBeatCut(node, ctx);
  });

export const flowSoundBedSchema = z
  .object({
    assetId: z.string().min(1).max(200),
    volume: finite.min(0).max(4).default(0.45),
    sourceIn: nonnegative.default(0),
    fadeInSeconds: nonnegative.max(30).default(0.3),
    fadeOutSeconds: nonnegative.max(30).default(1.0),
    ducking: z
      .object({
        enabled: z.boolean().default(true),
        reductionDb: finite.min(-40).max(0).default(-10),
        thresholdDb: finite.min(-60).max(0).default(-28),
        attackMs: finite.min(1).max(500).default(25),
        releaseMs: finite.min(10).max(3000).default(280),
      })
      .strict()
      .default({}),
  })
  .strict();

export const flowVariableValueSchema = z.union([
  z.string(),
  finite,
  z.boolean(),
  z.record(z.union([z.string(), finite, z.boolean()])),
]);

export const flowDocumentSchema = z
  .object({
    kind: z.literal('flow'),
    version: z.literal(1),
    id: flowIdSchema,
    name: z.string().min(1).max(240),
    spine: z.array(flowNodeIdSchema).max(500).default([]),
    overlays: z.array(flowNodeIdSchema).max(200).default([]),
    variables: z.record(flowVariableValueSchema).default({}),
    soundBed: flowSoundBedSchema.optional(),
    /** Optional inline node definitions (packed single-file mode); split mode uses sibling `nodes/<id>.json`. */
    nodes: z.record(flowNodeSchema).optional(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    if (new Set(doc.spine).size !== doc.spine.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Spine node IDs must not repeat; create separate shot nodes for repeated uses',
        path: ['spine'],
      });
    }
    if (new Set(doc.overlays).size !== doc.overlays.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Overlay node IDs must be unique',
        path: ['overlays'],
      });
    }
    const overlap = doc.overlays.filter((id) => doc.spine.includes(id));
    if (overlap.length) {
      ctx.addIssue({
        code: 'custom',
        message: `Node "${overlap[0]}" cannot appear in both spine and overlays`,
        path: ['overlays'],
      });
    }
    if (doc.nodes) {
      for (const [key, node] of Object.entries(doc.nodes)) {
        if (key !== node.id) {
          ctx.addIssue({
            code: 'custom',
            message: `Inline node key "${key}" must match node.id "${node.id}"`,
            path: ['nodes', key],
          });
        }
      }
    }
  });

export type FlowNode = z.output<typeof flowNodeSchema>;
export type FlowNodeInput = z.input<typeof flowNodeSchema>;
export type FlowShotNode = z.output<typeof flowShotNodeSchema>;
export type FlowTranscriptCutNode = z.output<typeof flowTranscriptCutNodeSchema>;
export type FlowBeatCutNode = z.output<typeof flowBeatCutNodeSchema>;
export type FlowBRollOverlayNode = z.output<typeof flowBRollOverlayNodeSchema>;
export type FlowDocument = z.output<typeof flowDocumentSchema>;
export type FlowDocumentInput = z.input<typeof flowDocumentSchema>;

/**
 * Deterministic pre-bake speech duration estimate from text so `follow-voice` TTS shots
 * already lay out realistic timeline durations before audio generation runs.
 */
export function estimateSpeechSeconds(text: string, speed = 1): number {
  const cleaned = text.trim();
  if (!cleaned) return 1;
  const cjk = (cleaned.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) ?? [])
    .length;
  const latinWords = cleaned
    .replace(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  const pauses = (cleaned.match(/[，,。！？!?；;：:—…]/g) ?? []).length;
  const rawSeconds = cjk / 4.2 + latinWords / 2.6 + pauses * 0.18;
  return Math.max(0.6, Number((rawSeconds / Math.max(0.25, speed)).toFixed(3)));
}
