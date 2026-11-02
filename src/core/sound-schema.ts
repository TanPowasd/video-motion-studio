import { z } from 'zod';
import { migrateSoundV1 } from './sound-migrate.js';
const n = z.number().finite(),
  id = z.string().min(1).max(160);
export const soundNoteSchema = z.union([
  n.min(0).max(127),
  z.string().regex(/^[A-Ga-g](?:#|b)?-?\d{1,2}$/),
]);
export const audioPluginSchema = z
  .object({
    format: z.enum(['vst3', 'au']),
    path: z.string().min(1).max(1024),
    classId: z.string().min(1).max(128),
    name: z.string().max(200).optional(),
    fingerprint: z.string().max(300).optional(),
    parameters: z.record(z.string().regex(/^\d+$/), n.min(0).max(1)).default({}),
    state: z
      .string()
      .max(2 * 1024 * 1024)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .optional(),
    controllerState: z
      .string()
      .max(2 * 1024 * 1024)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .optional(),
  })
  .strict();
export const builtinSoundEffectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('gain'), db: n.min(-80).max(24) }).strict(),
  z
    .object({
      type: z.literal('filter'),
      mode: z.enum(['lowpass', 'highpass', 'peaking', 'lowshelf', 'highshelf']),
      frequency: n.min(10).max(22000),
      q: n.min(0.1).max(20).default(0.707),
      db: n.min(-24).max(24).default(0),
    })
    .strict(),
  z
    .object({
      type: z.literal('distortion'),
      drive: n.min(1).max(30).default(3),
      mix: n.min(0).max(1).default(0.5),
    })
    .strict(),
  z
    .object({
      type: z.literal('delay'),
      seconds: n.min(0.001).max(3).default(0.25),
      rightSeconds: n.min(0.001).max(3).optional(),
      feedback: n.min(0).max(0.9).default(0.3),
      mix: n.min(0).max(1).default(0.25),
    })
    .strict(),
  z
    .object({
      type: z.literal('chorus'),
      rate: n.min(0.01).max(10).default(0.8),
      depth: n.min(0).max(0.015).default(0.003),
      delay: n.min(0.016).max(0.05).default(0.02),
      mix: n.min(0).max(1).default(0.3),
    })
    .strict(),
  z
    .object({
      type: z.literal('reverb'),
      seconds: n.min(0.1).max(8).default(1.5),
      damping: n.min(0).max(0.95).default(0.4),
      mix: n.min(0).max(1).default(0.2),
    })
    .strict(),
  z
    .object({
      type: z.literal('compressor'),
      thresholdDb: n.min(-60).max(0).default(-18),
      ratio: n.min(1).max(30).default(4),
      kneeDb: n.min(0).max(24).default(6),
      attack: n.min(0.0001).max(0.5).default(0.01),
      release: n.min(0.001).max(3).default(0.15),
      makeupDb: n.min(0).max(24).default(0),
    })
    .strict(),
  z
    .object({
      type: z.literal('limiter'),
      ceilingDb: n.min(-24).max(0).default(-1),
      release: n.min(0.001).max(3).default(0.1),
    })
    .strict(),
]);
export const masterGainStageSchema = z.enum(['pre', 'post']);
/**
 * Integrated-loudness normalisation (BS.1770 / EBU R128 gating) followed by a 4x
 * oversampled true-peak limiter, applied to the whole rendered sound after the master
 * chain. targetLufs null = limit only; truePeakDb null = normalise only.
 */
export const soundLoudnessSchema = z
  .object({
    targetLufs: n.min(-36).max(-5).nullable().default(-14),
    truePeakDb: n.min(-9).max(0).nullable().default(-1),
    /** Upper bound for the normalisation gain on quiet material. */
    maxGainDb: n.min(0).max(36).default(24),
    release: n.min(0.001).max(1).default(0.05),
  })
  .strict();
export const soundEffectSchema = z.discriminatedUnion('type', [
  ...builtinSoundEffectSchema.options,
  audioPluginSchema.extend({ type: z.literal('plugin') }),
]);
export const soundInstrumentSchema = z.discriminatedUnion('type', [
  audioPluginSchema.extend({ type: z.literal('plugin'), release: n.min(0).max(10).default(0) }),
  z
    .object({
      type: z.literal('synth'),
      wave: z.enum(['sine', 'triangle', 'saw', 'square', 'noise']).default('sine'),
      gain: n.min(0).max(2).default(0.3),
      attack: n.min(0).max(10).default(0.008),
      decay: n.min(0).max(10).default(0.15),
      sustain: n.min(0).max(1).default(0.6),
      release: n.min(0).max(10).default(0.2),
      fmRatio: n.min(0).max(20).default(0),
      fmIndex: n.min(0).max(20).default(0),
      detune: n.min(-100).max(100).default(0),
    })
    .strict(),
  z
    .object({
      type: z.literal('drum'),
      voice: z.enum(['kick', 'snare', 'hat', 'tom', 'clap']),
      gain: n.min(0).max(2).default(0.5),
      release: n.min(0.01).max(3).default(0.3),
    })
    .strict(),
  z
    .object({
      type: z.literal('sample'),
      assetId: id,
      sourceIn: n.nonnegative().default(0),
      sourceDuration: n.positive().max(1800),
      rootNote: soundNoteSchema.default(60),
      loop: z.boolean().default(false),
      attack: n.min(0).max(10).default(0.005),
      release: n.min(0).max(10).default(0.05),
      gain: n.min(0).max(2).default(1),
    })
    .strict(),
]);
export const soundEventSchema = z
  .object({
    id,
    at: n.nonnegative(),
    duration: n.positive(),
    note: soundNoteSchema.default(60),
    endNote: soundNoteSchema.optional(),
    velocity: n.min(0).max(1).default(0.8),
    pan: n.min(-1).max(1).default(0),
  })
  .strict();
const effects = z.array(soundEffectSchema).max(12).default([]),
  sends = z
    .array(z.object({ busId: id, db: n.min(-80).max(12).default(-12) }).strict())
    .max(8)
    .default([]);
const trackFields = {
  id,
  name: z.string().default('Track'),
  instrument: soundInstrumentSchema,
  events: z.array(soundEventSchema).max(20000).default([]),
  muted: z.boolean().default(false),
  solo: z.boolean().default(false),
  gainDb: n.min(-80).max(24).default(0),
  pan: n.min(-1).max(1).default(0),
  busId: id.default('master'),
  sends,
  effects,
};
/** Version-1 per-track automation (gain/pan linear keys); v2 stores it as automation clips. */
export const soundTrackAutomationV1Schema = z
  .object({
    property: z.enum(['gainDb', 'pan']),
    keys: z
      .array(z.object({ at: n.nonnegative(), value: n }).strict())
      .min(1)
      .max(2000),
  })
  .strict();
/** Version-2 instrument track (channel). Automation lives in `automationClips`. */
export const soundTrackSchema = z.object(trackFields).strict();
export const soundTrackV1Schema = z
  .object({
    ...trackFields,
    automation: z.array(soundTrackAutomationV1Schema).max(2).default([]),
  })
  .strict();
export const soundBusSchema = z
  .object({
    id,
    name: z.string().default('Bus'),
    busId: id.default('master'),
    gainDb: n.min(-80).max(24).default(0),
    pan: n.min(-1).max(1).default(0),
    sends,
    effects,
  })
  .strict();
const tempoSchema = z
    .array(z.object({ beat: n.nonnegative(), bpm: n.min(20).max(400) }).strict())
    .min(1)
    .max(1000)
    .default([{ beat: 0, bpm: 120 }]),
  timeSignatureSchema = z
    .tuple([
      z.number().int().min(1).max(32),
      z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(16)]),
    ])
    .default([4, 4]),
  masterSchema = z
    .object({
      gainDb: n.min(-80).max(24).default(0),
      /**
       * 'pre' (default): master gain feeds the master effects, so a master limiter is the
       * last stage. 'post': legacy order (gain after effects, can push past a limiter).
       */
      gainStage: masterGainStageSchema.default('pre'),
      effects,
      /** Offline loudness normalisation + true-peak limiting of the rendered sound. */
      loudness: soundLoudnessSchema.nullable().optional(),
    })
    .strict()
    .default({}),
  patternChannelSchema = z
    .object({ trackId: id, events: z.array(soundEventSchema).max(20000).default([]) })
    .strict(),
  documentHead = {
    kind: z.literal('sound'),
    id,
    name: z.string().min(1),
    unit: z.enum(['beats', 'seconds']).default('beats'),
    duration: n.positive().max(14400),
    tail: n.min(0).max(20).default(1),
    seed: z.number().int().min(0).max(0xffffffff).default(1),
    tempo: tempoSchema,
    timeSignature: timeSignatureSchema,
  };

// ---------------------------------------------------------------- version 1 (input only)

/** The version-1 document. Accepted on input and upgraded by `migrateSoundV1`; never written. */
export const soundDocumentV1Schema = z
  .object({
    ...documentHead,
    version: z.literal(1),
    tracks: z.array(soundTrackV1Schema).max(64).default([]),
    patterns: z
      .array(
        z
          .object({
            id,
            name: z.string().min(1),
            length: n.positive().max(14400),
            channels: z.array(patternChannelSchema).max(64),
          })
          .strict(),
      )
      .max(128)
      .optional(),
    arrangement: z
      .array(
        z
          .object({
            id,
            patternId: id,
            at: n.nonnegative(),
            repeats: z.number().int().min(1).max(1024).default(1),
          })
          .strict(),
      )
      .max(2000)
      .optional(),
    buses: z.array(soundBusSchema).max(16).default([]),
    master: masterSchema,
  })
  .strict();

// ---------------------------------------------------------------- version 2

export const MAX_PLAYLIST_TRACKS = 500;
export const DEFAULT_PLAYLIST_TRACKS = 16;
export const MAX_SOUND_CLIPS = 20000;
export const MAX_AUTOMATION_CLIPS = 512;
export const playlistColors = [
  '#ff7a66',
  '#57d6b0',
  '#7aa2ff',
  '#f4c45f',
  '#c38cff',
  '#5fc8f4',
  '#ff9fd0',
  '#a6d36a',
];
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a #rrggbb hex string')
  .optional();
export function defaultPlaylistTracks(count = DEFAULT_PLAYLIST_TRACKS) {
  return Array.from({ length: count }, (_, i) => ({
    id: `lane-${i + 1}`,
    name: `Track ${i + 1}`,
    color: playlistColors[i % playlistColors.length],
    muted: false,
    height: 56,
  }));
}
export const playlistTrackSchema = z
  .object({
    id,
    name: z.string().max(200).default('Track'),
    color,
    muted: z.boolean().default(false),
    height: n
      .min(16, 'playlist track height must be 16..400 px')
      .max(400, 'playlist track height must be 16..400 px')
      .default(56),
  })
  .strict();
export const soundClipSchema = z
  .object({
    id,
    kind: z.enum(['pattern', 'audio', 'automation'], {
      message: "clip kind must be 'pattern', 'audio' or 'automation'",
    }),
    /** Index into `playlistTracks` (0-based). */
    lane: z
      .number()
      .int('clip lane must be an integer playlist track index')
      .min(0, 'clip lane must be >= 0')
      .max(MAX_PLAYLIST_TRACKS - 1, `clip lane must be < ${MAX_PLAYLIST_TRACKS}`)
      .default(0),
    /** Start in document time. */
    at: n.nonnegative('clip at must be >= 0'),
    /** Visible length in document time; the window [offset, offset+length) of the source. */
    length: n.positive('clip length must be > 0').max(14400),
    /** Trim of the source start, in document time units. */
    offset: n.nonnegative('clip offset must be >= 0').max(14400).default(0),
    muted: z.boolean().default(false),
    color,
    /** Pattern id, audio asset id, or automation clip id, by `kind`. */
    refId: id,
  })
  .strict();
/** What an automation clip drives. Track volume/pan and bpm render today; the rest are stored. */
export const automationTargetSchema = z.discriminatedUnion(
  'type',
  [
    z.object({ type: z.literal('track'), trackId: id, param: z.enum(['gainDb', 'pan']) }).strict(),
    z
      .object({
        type: z.literal('bus'),
        /** A bus id, or 'master' for the master output. */
        busId: id,
        param: z.enum(['gainDb', 'pan']),
      })
      .strict(),
    z
      .object({
        type: z.literal('effect'),
        /** Track id, bus id, or 'master'. */
        ownerId: id,
        index: z.number().int().min(0).max(11),
        param: z.string().min(1).max(64),
      })
      .strict(),
    z.object({ type: z.literal('synth'), trackId: id, param: z.string().min(1).max(64) }).strict(),
    z
      .object({
        type: z.literal('plugin'),
        /** Track id, bus id, or 'master'. */
        ownerId: id,
        /** 'instrument' or the effect slot index holding the plugin. */
        slot: z.union([z.literal('instrument'), z.number().int().min(0).max(11)]),
        /** VST3/AU parameter number. */
        index: z.number().int().min(0).max(1_000_000),
      })
      .strict(),
    z.object({ type: z.literal('tempo') }).strict(),
  ],
  {
    errorMap: () => ({
      message:
        "automation target type must be 'track', 'bus', 'effect', 'synth', 'plugin' or 'tempo'",
    }),
  },
);
export const automationPointSchema = z
  .object({
    /** Time relative to the automation clip source start, in document time units. */
    at: n.nonnegative('automation point at must be >= 0'),
    value: n,
    /** Shape of the segment from this point to the next. */
    curve: z
      .enum(['hold', 'linear', 'smooth', 'tension'], {
        message: "automation curve must be 'hold', 'linear', 'smooth' or 'tension'",
      })
      .default('linear'),
    tension: n
      .min(-1, 'automation tension must be -1..1')
      .max(1, 'automation tension must be -1..1')
      .default(0),
  })
  .strict();
export const automationClipSchema = z
  .object({
    id,
    name: z.string().max(200).optional(),
    target: automationTargetSchema,
    points: z
      .array(automationPointSchema)
      .min(1, 'an automation clip needs at least one point')
      .max(2000, 'an automation clip holds at most 2000 points'),
  })
  .strict();
export const soundPatternSchema = z
  .object({
    id,
    name: z.string().min(1),
    length: n.positive().max(14400),
    /** When true, editing commands keep `length` at the notes' end rounded up to a bar. */
    autoLength: z.boolean().optional(),
    color,
    channels: z.array(patternChannelSchema).max(64),
  })
  .strict();
/** The canonical version-2 object (no migration, no cross-field checks). */
export const soundDocumentObjectSchema = z
  .object({
    ...documentHead,
    version: z.literal(2),
    /** Time-signature changes after the opening `timeSignature`, by beat. */
    timeSignatureChanges: z
      .array(
        z
          .object({
            beat: n.nonnegative(),
            numerator: z.number().int().min(1).max(32),
            denominator: z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(16)]),
          })
          .strict(),
      )
      .max(1000)
      .default([]),
    tracks: z.array(soundTrackSchema).max(64).default([]),
    patterns: z.array(soundPatternSchema).max(128).optional(),
    playlistTracks: z
      .array(playlistTrackSchema)
      .min(1, 'playlistTracks needs at least one track')
      .max(MAX_PLAYLIST_TRACKS, `playlistTracks holds at most ${MAX_PLAYLIST_TRACKS} tracks`)
      .default(() => defaultPlaylistTracks()),
    clips: z
      .array(soundClipSchema)
      .max(MAX_SOUND_CLIPS, `at most ${MAX_SOUND_CLIPS} playlist clips`)
      .default([]),
    automationClips: z
      .array(automationClipSchema)
      .max(MAX_AUTOMATION_CLIPS, `at most ${MAX_AUTOMATION_CLIPS} automation clips`)
      .default([]),
    markers: z
      .array(z.object({ at: n.nonnegative(), name: z.string().max(200).default('') }).strict())
      .max(1000)
      .default([]),
    loop: z
      .object({ start: n.nonnegative(), end: n.positive() })
      .strict()
      .refine((l) => l.end > l.start, 'loop.end must be after loop.start')
      .nullable()
      .optional(),
    buses: z.array(soundBusSchema).max(16).default([]),
    master: masterSchema,
  })
  .strict();
type SoundDocumentObject = z.output<typeof soundDocumentObjectSchema>;
function crossCheck(doc: SoundDocumentObject, ctx: z.RefinementCtx) {
  const lanes = doc.playlistTracks.length,
    patterns = new Set((doc.patterns ?? []).map((p) => p.id)),
    autos = new Set(doc.automationClips.map((a) => a.id));
  doc.clips.forEach((clip, i) => {
    if (clip.lane >= lanes)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clips', i, 'lane'],
        message: `clip lane ${clip.lane} has no playlist track (${lanes} defined)`,
      });
    if (clip.kind === 'pattern' && !patterns.has(clip.refId))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clips', i, 'refId'],
        message: `pattern clip references missing pattern '${clip.refId}'`,
      });
    if (clip.kind === 'automation' && !autos.has(clip.refId))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clips', i, 'refId'],
        message: `automation clip references missing automationClips id '${clip.refId}'`,
      });
  });
}
/**
 * The sound document schema used everywhere a document is parsed. It accepts version 1 and
 * version 2 input; version 1 is validated against the v1 schema and upgraded (see
 * `sound-migrate.ts`), so the output is always version 2.
 */
export const soundDocumentSchema = z.preprocess((raw, ctx) => {
  if (
    !raw ||
    typeof raw !== 'object' ||
    (raw as { version?: unknown }).version !== 1 ||
    (raw as { kind?: unknown }).kind !== 'sound'
  )
    return raw;
  const v1 = soundDocumentV1Schema.safeParse(raw);
  if (!v1.success) {
    for (const issue of v1.error.issues)
      ctx.addIssue({ ...issue, message: `version 1 document: ${issue.message}` } as z.IssueData);
    return z.NEVER;
  }
  try {
    return migrateSoundV1(v1.data);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `version 1 document could not be upgraded: ${(error as Error).message}`,
    });
    return z.NEVER;
  }
}, soundDocumentObjectSchema.superRefine(crossCheck));
export type SoundDocument = z.output<typeof soundDocumentObjectSchema>;
export type SoundInputV2 = z.input<typeof soundDocumentObjectSchema>;
export type SoundDocumentV1 = z.output<typeof soundDocumentV1Schema>;
export type SoundInputV1 = z.input<typeof soundDocumentV1Schema>;
export type SoundInput = SoundInputV2 | SoundInputV1;
export type SoundInstrument = z.output<typeof soundInstrumentSchema>;
export type SoundEffect = z.output<typeof soundEffectSchema>;
export type SoundLoudness = z.output<typeof soundLoudnessSchema>;
export type AudioPluginConfig = z.output<typeof audioPluginSchema>;
export type SoundTrack = z.output<typeof soundTrackSchema>;
export type SoundTrackV1 = z.output<typeof soundTrackV1Schema>;
export type SoundEvent = z.output<typeof soundEventSchema>;
export type SoundPattern = z.output<typeof soundPatternSchema>;
export type SoundClip = z.output<typeof soundClipSchema>;
export type PlaylistTrack = z.output<typeof playlistTrackSchema>;
export type AutomationClip = z.output<typeof automationClipSchema>;
export type AutomationTarget = z.output<typeof automationTargetSchema>;
export type AutomationPoint = z.output<typeof automationPointSchema>;
