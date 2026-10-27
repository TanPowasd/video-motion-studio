import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import {
  VmotionError,
  type Clip,
  type Operation,
  type Sequence,
  type Snapshot,
} from '../core/model.js';
import {
  SLIDE_LAYOUT_IDS,
  SLIDE_THEME_PRESETS,
  analyzeSlideReadability,
  buildPptxBuffer,
  buildSlideScene,
  estimateSlideDurationFrames,
  parsePptxBuffer,
  slideDeckDocumentSchema,
  slideSpecSchema,
  slideThemeSchema,
  slideTransitionSchema,
  syncSlideFromScene,
  type SlideDeckDocument,
  type SlideSpec,
  type SlideTheme,
} from '../core/slides.js';
import { storeAgentPlan } from './agent-plans.js';
import { applyOperations } from './operations.js';
import { atomicWrite, hash, json, safePath, validateSnapshot } from './project.js';

export const slidesPathSchema = z.string().regex(/^components\/slides\/.+\.json$/);

const slideThemeInputSchema = z.union([
  z.enum(['editorial-dark', 'executive-light', 'emerald-tech', 'sunset-keynote']),
  slideThemeSchema,
]);

function resolveSlideTheme(
  input: z.infer<typeof slideThemeInputSchema> | undefined,
  fallback: SlideTheme = SLIDE_THEME_PRESETS['editorial-dark'],
): SlideTheme {
  if (!input) return fallback;
  if (typeof input === 'string') {
    return SLIDE_THEME_PRESETS[input] ?? fallback;
  }
  return slideThemeSchema.parse(input);
}

export const slidesInspectSchema = z
  .object({
    source: slidesPathSchema.optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(25),
    includeDocument: z.boolean().default(false),
  })
  .strict();

export const slidesImportSchema = z
  .object({
    revision: z.string().optional(),
    file: z.string().min(1).optional(),
    pptxBase64: z.string().min(1).optional(),
    slides: z.array(slideSpecSchema).min(1).max(200).optional(),
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,80}$/)
      .default('main-deck'),
    name: z.string().min(1).max(200).optional(),
    source: slidesPathSchema.optional(),
    sequenceId: z.string().optional(),
    videoTrackId: z.string().optional(),
    theme: slideThemeInputSchema.optional(),
    defaultDurationFrames: z.number().int().min(15).max(36000).optional(),
    detail: z.boolean().default(false),
  })
  .strict();

export const slidePlanActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('addSlide'),
      slide: slideSpecSchema,
      index: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('updateSlide'),
      slideId: z.string().min(1),
      patch: slideSpecSchema.omit({ id: true }).partial(),
    })
    .strict(),
  z
    .object({
      type: z.literal('removeSlides'),
      slideIds: z.array(z.string().min(1)).min(1).max(200),
    })
    .strict(),
  z
    .object({
      type: z.literal('reorderSlides'),
      slideIds: z.array(z.string().min(1)).min(1).max(200),
    })
    .strict(),
  z
    .object({
      type: z.literal('applyTheme'),
      preset: z
        .enum(['editorial-dark', 'executive-light', 'emerald-tech', 'sunset-keynote'])
        .optional(),
      patch: slideThemeSchema.partial().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('setTransitions'),
      transition: slideTransitionSchema,
      slideIds: z.array(z.string().min(1)).max(200).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('autoTiming'),
      minDurationFrames: z.number().int().min(15).max(36000).default(60),
      maxDurationFrames: z.number().int().min(30).max(36000).default(900),
      slideIds: z.array(z.string().min(1)).max(200).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('splitSlide'),
      slideId: z.string().min(1),
      maxBulletsPerSlide: z.number().int().min(2).max(8).default(4),
    })
    .strict(),
]);

export const slidesPlanSchema = z
  .object({
    revision: z.string().optional(),
    source: slidesPathSchema.optional(),
    expectedHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    document: slideDeckDocumentSchema.optional(),
    actions: z.array(slidePlanActionSchema).max(200).default([]),
    exportPptx: z
      .object({
        path: z.string().regex(/^exports\/.+\.pptx$/),
      })
      .strict()
      .optional(),
    detail: z.boolean().default(false),
  })
  .strict();

function findDefaultSlideSource(snapshot: Snapshot): string | undefined {
  return Object.keys(snapshot.files)
    .filter((f) => /^components\/slides\/.+\.json$/.test(f))
    .sort()[0];
}

function loadDeckFromSnapshot(snapshot: Snapshot, requestedSource?: string): { source: string; deck: SlideDeckDocument } {
  const source = requestedSource ?? findDefaultSlideSource(snapshot);
  if (!source || snapshot.files[source] === undefined) {
    throw new VmotionError(
      'SLIDES_SOURCE',
      'Slide deck resource not found; import a .pptx or create a deck first',
    );
  }
  const parsed = slideDeckDocumentSchema.parse(JSON.parse(snapshot.files[source]));
  const syncedSlides = parsed.slides.map((slide) => {
    const scene = snapshot.scenes.find((s) => s.id === (slide.sceneId ?? slide.id));
    return syncSlideFromScene(slide, scene);
  });
  return {
    source,
    deck: { ...parsed, slides: syncedSlides },
  };
}

export function inspectSlides(snapshot: Snapshot, raw: unknown) {
  const request = slidesInspectSchema.parse(raw ?? {});
  const { source, deck } = loadDeckFromSnapshot(snapshot, request.source);
  const rawText = snapshot.files[source]!;
  const sequence = snapshot.sequences.find((s) => s.id === deck.sequenceId);
  const track = sequence?.tracks.find((t) => t.id === deck.videoTrackId);
  const prefix = `slides/${deck.id}/`;

  const allItems = deck.slides.map((slide, index) => {
    const clip = track?.clips.find((c) => c.id === `${prefix}${slide.id}`);
    const readability = analyzeSlideReadability(slide);
    return {
      index,
      id: slide.id,
      sceneId: slide.sceneId ?? slide.id,
      layout: slide.layout,
      badge: slide.badge,
      title: slide.title,
      subtitle: slide.subtitle,
      bullets: slide.bullets,
      left: slide.left,
      right: slide.right,
      metrics: slide.metrics,
      quote: slide.quote,
      code: slide.code,
      table: slide.table,
      mediaAssetId: slide.mediaAssetId,
      footer: slide.footer,
      notes: slide.notes,
      durationFrames: slide.durationFrames,
      transition: slide.transition,
      readability,
      placement: clip
        ? {
            sequenceId: deck.sequenceId,
            trackId: deck.videoTrackId,
            clipId: clip.id,
            start: clip.start,
            duration: clip.duration,
            end: clip.start + clip.duration,
          }
        : null,
    };
  });

  const totalDurationFrames = allItems.reduce((sum, item) => sum + item.durationFrames, 0);
  const slidesWithNotes = allItems.filter((item) => item.readability.hasNotes).length;
  const overflowWarnings = allItems.reduce((sum, item) => sum + item.readability.warnings.length, 0);

  return {
    revision: snapshot.revision,
    source,
    hash: hash(rawText),
    id: deck.id,
    name: deck.name,
    sequenceId: deck.sequenceId,
    videoTrackId: deck.videoTrackId,
    theme: deck.theme,
    availableLayouts: SLIDE_LAYOUT_IDS,
    availableThemes: Object.keys(SLIDE_THEME_PRESETS),
    summary: {
      totalSlides: allItems.length,
      totalDurationFrames,
      slidesWithNotes,
      overflowWarnings,
    },
    slides: {
      total: allItems.length,
      offset: request.offset,
      items: allItems.slice(request.offset, request.offset + request.limit),
      hasMore: request.offset + request.limit < allItems.length,
    },
    ...(request.includeDocument ? { document: deck } : {}),
  };
}

/**
 * Compile a `SlideDeckDocument` into atomic Vmotion operations (scenes, sequence clips/markers, and `components/slides/<id>.json`).
 */
async function compileDeckCandidate(
  root: string,
  snapshot: Snapshot,
  deck: SlideDeckDocument,
  source: string,
  extraOps: Operation[] = [],
  detail = false,
) {
  safePath(root, source);
  const sequence = snapshot.sequences.find((s) => s.id === deck.sequenceId);
  if (!sequence) {
    throw new VmotionError('MISSING_SEQUENCE', `Sequence ${deck.sequenceId} not found`);
  }
  const videoTrack = sequence.tracks.find((t) => t.id === deck.videoTrackId);
  if (!videoTrack || videoTrack.type !== 'video') {
    throw new VmotionError('SLIDES_TRACK', `Video track ${deck.videoTrackId} not found`);
  }
  if (videoTrack.locked) {
    throw new VmotionError('TRACK_LOCKED', `Target video track ${deck.videoTrackId} is locked`);
  }

  const ops: Operation[] = [...extraOps];
  const width = snapshot.project.width;
  const height = snapshot.project.height;

  // Normalize sceneIds and build/update scenes
  const activeSceneIds = new Set<string>();
  const normalizedSlides: SlideSpec[] = deck.slides.map((slide, idx) => {
    const sceneId = slide.sceneId ?? `${deck.id}-${slide.id}`;
    activeSceneIds.add(sceneId);
    const normalized: SlideSpec = { ...slide, sceneId };
    const builtScene = buildSlideScene(
      normalized,
      deck.theme,
      idx,
      deck.slides.length,
      width,
      height,
    );
    if (snapshot.scenes.some((s) => s.id === sceneId)) {
      ops.push({ type: 'updateScene', sceneId, patch: builtScene });
    } else {
      ops.push({ type: 'addScene', scene: builtScene });
    }
    return normalized;
  });

  // Remove orphaned scenes that previously belonged to this deck if they are not used elsewhere
  const previousRaw = snapshot.files[source];
  if (previousRaw) {
    try {
      const previousDeck = slideDeckDocumentSchema.parse(JSON.parse(previousRaw));
      for (const oldSlide of previousDeck.slides) {
        const oldSceneId = oldSlide.sceneId ?? `${previousDeck.id}-${oldSlide.id}`;
        if (!activeSceneIds.has(oldSceneId) && snapshot.scenes.some((s) => s.id === oldSceneId)) {
          const usedElsewhere = snapshot.sequences.some((seq) =>
            seq.tracks.some((tr) =>
              tr.clips.some(
                (c) => c.sceneId === oldSceneId && !c.id.startsWith(`slides/${deck.id}/`),
              ),
            ),
          );
          if (!usedElsewhere) {
            ops.push({ type: 'removeScene', sceneId: oldSceneId });
          }
        }
      }
    } catch {
      // Ignore malformed previous deck
    }
  }

  // Update sequence clips and chapter markers for this slide deck
  const prefix = `slides/${deck.id}/`;
  const nextSeq: Sequence = structuredClone(sequence);
  const nextTrack = nextSeq.tracks.find((t) => t.id === deck.videoTrackId)!;
  nextTrack.clips = nextTrack.clips.filter((c) => !c.id.startsWith(prefix));
  nextSeq.markers = nextSeq.markers.filter((m) => m.group !== `slides/${deck.id}`);

  // Start after any non-deck clips on the target track (or at 0 if empty)
  let cursor = nextTrack.clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0);
  const placements: Array<{
    slideId: string;
    sceneId: string;
    layout: string;
    title: string;
    at: number;
    end: number;
    durationFrames: number;
    readability: ReturnType<typeof analyzeSlideReadability>;
  }> = [];

  for (const [idx, slide] of normalizedSlides.entries()) {
    const sceneId = slide.sceneId!;
    const duration = slide.durationFrames;
    const transitionFrames =
      slide.transition.type === 'none'
        ? 0
        : Math.min(Math.floor(duration / 3), slide.transition.durationFrames);
    const clip: Clip = {
      id: `${prefix}${slide.id}`,
      sceneId,
      start: cursor,
      duration,
      sourceIn: 0,
      sourceOut: duration,
      speed: 1,
      volume: 1,
      fadeIn: transitionFrames,
      fadeOut: transitionFrames,
      name: `${String(idx + 1).padStart(2, '0')} · ${slide.title.slice(0, 48)}`,
    };
    nextTrack.clips.push(clip);
    nextSeq.markers.push({
      id: `${prefix}marker/${slide.id}`,
      frame: cursor,
      label: slide.chapter ?? `${idx + 1}. ${slide.title.slice(0, 40)}`,
      kind: 'chapter',
      group: `slides/${deck.id}`,
    });
    placements.push({
      slideId: slide.id,
      sceneId,
      layout: slide.layout,
      title: slide.title,
      at: cursor,
      end: cursor + duration,
      durationFrames: duration,
      readability: analyzeSlideReadability(slide),
    });
    cursor += duration;
  }

  const maxTrackEnd = nextSeq.tracks.reduce(
    (max, tr) =>
      Math.max(
        max,
        tr.clips.reduce((cMax, c) => Math.max(cMax, c.start + c.duration), 0),
      ),
    0,
  );
  nextSeq.duration = Math.max(nextSeq.duration, maxTrackEnd, 1);

  ops.push({
    type: 'updateSequence',
    sequenceId: nextSeq.id,
    patch: nextSeq,
  });

  const finalDeck: SlideDeckDocument = {
    ...deck,
    slides: normalizedSlides,
  };

  ops.push({
    type: 'editFiles',
    edits: [
      {
        type: 'replace',
        path: source,
        content: json(finalDeck),
        expectedHash: previousRaw === undefined ? null : hash(previousRaw),
      },
    ],
  });

  const final = applyOperations(root, snapshot, ops);
  const diagnostics = await validateSnapshot(root, final);
  if (diagnostics.some((d) => d.severity === 'error')) {
    throw new VmotionError('VALIDATION_FAILED', 'Slide deck candidate is invalid', diagnostics);
  }

  const samples = [
    ...new Set(
      placements.flatMap((p) => [p.at, Math.floor((p.at + p.end - 1) / 2), Math.max(p.at, p.end - 1)]),
    ),
  ].map((frame) => ({ sequenceId: nextSeq.id, frame }));

  const planInput = {
    revision: snapshot.revision,
    operations: ops,
    assetChecks: [],
    samples: samples.slice(0, 4),
    width: 320,
    determinism: true,
  };
  const plan = await storeAgentPlan(root, planInput);

  return {
    baseRevision: snapshot.revision,
    candidateRevision: final.revision,
    source,
    deckId: finalDeck.id,
    name: finalDeck.name,
    sequenceId: finalDeck.sequenceId,
    videoTrackId: finalDeck.videoTrackId,
    theme: finalDeck.theme,
    slides: detail ? placements : placements.slice(0, 25),
    slideCount: placements.length,
    omittedSlides: detail ? 0 : Math.max(0, placements.length - 25),
    duration: nextSeq.duration,
    coverage: {
      proposed: samples.length,
      selected: Math.min(4, samples.length),
      incomplete: samples.length > 4,
    },
    plan,
    candidate: { planId: plan.planId },
    apply: { planId: plan.planId, expectedCandidateRevision: final.revision },
    _finalSnapshot: final,
    _finalDeck: finalDeck,
  };
}

export async function importSlides(root: string, snapshot: Snapshot, raw: unknown) {
  const request = slidesImportSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision) {
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before slides import');
  }
  const sourceCount =
    (request.file ? 1 : 0) + (request.pptxBase64 ? 1 : 0) + (request.slides ? 1 : 0);
  if (sourceCount !== 1) {
    throw new VmotionError(
      'SLIDES_IMPORT_SOURCE',
      'Provide exactly one of file (.pptx path), pptxBase64, or slides[]',
    );
  }

  const sequenceId = request.sequenceId ?? snapshot.project.activeSequence;
  const sequence = snapshot.sequences.find((s) => s.id === sequenceId);
  if (!sequence) throw new VmotionError('MISSING_SEQUENCE', `Sequence ${sequenceId} not found`);
  const videoTrack = request.videoTrackId
    ? sequence.tracks.find((t) => t.id === request.videoTrackId)
    : sequence.tracks.find((t) => t.type === 'video');
  if (!videoTrack || videoTrack.type !== 'video') {
    throw new VmotionError('SLIDES_TRACK', 'No valid video track found for slide deck');
  }

  const extraOps: Operation[] = [];
  let parsedSlides: SlideSpec[];
  let inferredName = request.name ?? 'Slide Presentation';

  if (request.slides) {
    parsedSlides = request.slides.map((s) => slideSpecSchema.parse(s));
  } else {
    let buffer: Uint8Array;
    if (request.file) {
      const filePath = isAbsolute(request.file) ? resolve(request.file) : safePath(root, request.file);
      try {
        buffer = new Uint8Array(await readFile(filePath));
      } catch (err) {
        throw new VmotionError(
          'PPTX_READ_FAILED',
          `Cannot read .pptx file at ${request.file}: ${(err as Error).message}`,
        );
      }
    } else {
      buffer = new Uint8Array(Buffer.from(request.pptxBase64!, 'base64'));
    }

    const parsed = parsePptxBuffer(buffer, {
      fpsNum: snapshot.project.fps.num,
      fpsDen: snapshot.project.fps.den,
      defaultDurationFrames: request.defaultDurationFrames,
    });
    inferredName = request.name ?? parsed.title;
    parsedSlides = parsed.slides;

    // Extract any embedded media files into assets/slides/<deckId>/
    for (const [assetId, mediaItem] of parsed.media.entries()) {
      const fullAssetId = `${request.id}-${assetId}`;
      const relAssetPath = `assets/slides/${request.id}/${mediaItem.filename}`;
      const absAssetPath = safePath(root, relAssetPath);
      await mkdir(dirname(absAssetPath), { recursive: true });
      await atomicWrite(absAssetPath, mediaItem.data);
      const digest = hash(mediaItem.data);
      if (!snapshot.project.assets.some((a) => a.id === fullAssetId)) {
        extraOps.push({
          type: 'addAsset',
          asset: {
            id: fullAssetId,
            name: mediaItem.filename,
            path: relAssetPath,
            type: 'image',
            managed: true,
            fingerprint: digest,
            metadata: { mimeType: mediaItem.mimeType, source: 'pptx-import' },
          },
        });
      }
      for (const s of parsedSlides) {
        if (s.mediaAssetId === assetId) s.mediaAssetId = fullAssetId;
      }
    }
  }

  const source = request.source ?? `components/slides/${encodeURIComponent(request.id)}.json`;
  const deck: SlideDeckDocument = slideDeckDocumentSchema.parse({
    id: request.id,
    name: inferredName,
    sequenceId: sequence.id,
    videoTrackId: videoTrack.id,
    theme: resolveSlideTheme(request.theme),
    slides: parsedSlides,
  });

  const compiled = await compileDeckCandidate(
    root,
    snapshot,
    deck,
    source,
    extraOps,
    request.detail,
  );
  const { _finalSnapshot, _finalDeck, ...publicResult } = compiled;
  return publicResult;
}

export async function planSlides(root: string, snapshot: Snapshot, raw: unknown) {
  const request = slidesPlanSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision) {
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before slides planning');
  }

  let source: string;
  let deck: SlideDeckDocument;
  if (request.document) {
    deck = structuredClone(request.document);
    source = request.source ?? `components/slides/${encodeURIComponent(deck.id)}.json`;
  } else {
    const loaded = loadDeckFromSnapshot(snapshot, request.source);
    source = loaded.source;
    deck = loaded.deck;
  }

  const oldRaw = snapshot.files[source];
  if (request.expectedHash && hash(oldRaw ?? '') !== request.expectedHash) {
    throw new VmotionError('FILE_HASH_CONFLICT', 'Slide deck resource changed; inspect and retry');
  }

  for (const action of request.actions) {
    switch (action.type) {
      case 'addSlide': {
        if (deck.slides.some((s) => s.id === action.slide.id)) {
          throw new VmotionError('SLIDES_DUPLICATE_ID', `Slide ${action.slide.id} already exists`);
        }
        const idx =
          action.index === undefined
            ? deck.slides.length
            : Math.min(deck.slides.length, Math.max(0, action.index));
        deck.slides.splice(idx, 0, slideSpecSchema.parse(action.slide));
        break;
      }
      case 'updateSlide': {
        const idx = deck.slides.findIndex((s) => s.id === action.slideId);
        if (idx < 0) {
          throw new VmotionError('SLIDES_NOT_FOUND', `Slide ${action.slideId} not found`);
        }
        deck.slides[idx] = slideSpecSchema.parse({
          ...deck.slides[idx],
          ...action.patch,
          id: action.slideId,
        });
        break;
      }
      case 'removeSlides': {
        for (const id of action.slideIds) {
          if (!deck.slides.some((s) => s.id === id)) {
            throw new VmotionError('SLIDES_NOT_FOUND', `Slide ${id} not found`);
          }
        }
        const remaining = deck.slides.filter((s) => !action.slideIds.includes(s.id));
        if (remaining.length === 0) {
          throw new VmotionError('SLIDES_EMPTY', 'A slide deck must keep at least one slide');
        }
        deck.slides = remaining;
        break;
      }
      case 'reorderSlides': {
        if (
          action.slideIds.length !== deck.slides.length ||
          new Set(action.slideIds).size !== action.slideIds.length ||
          action.slideIds.some((id) => !deck.slides.some((s) => s.id === id))
        ) {
          throw new VmotionError(
            'SLIDES_ORDER',
            'reorderSlides must include every slide ID in the deck exactly once',
          );
        }
        deck.slides = action.slideIds.map((id) => deck.slides.find((s) => s.id === id)!);
        break;
      }
      case 'applyTheme': {
        const presetBase = action.preset
          ? (SLIDE_THEME_PRESETS[action.preset] ?? deck.theme)
          : deck.theme;
        deck.theme = slideThemeSchema.parse({
          ...presetBase,
          ...(action.patch ?? {}),
        });
        break;
      }
      case 'setTransitions': {
        const targetIds = action.slideIds ? new Set(action.slideIds) : null;
        deck.slides = deck.slides.map((s) =>
          !targetIds || targetIds.has(s.id) ? { ...s, transition: action.transition } : s,
        );
        break;
      }
      case 'autoTiming': {
        const targetIds = action.slideIds ? new Set(action.slideIds) : null;
        deck.slides = deck.slides.map((s) => {
          if (targetIds && !targetIds.has(s.id)) return s;
          const estimated = estimateSlideDurationFrames(
            s,
            snapshot.project.fps.num,
            snapshot.project.fps.den,
          );
          const clamped = Math.max(
            action.minDurationFrames,
            Math.min(action.maxDurationFrames, estimated),
          );
          return { ...s, durationFrames: clamped };
        });
        break;
      }
      case 'splitSlide': {
        const idx = deck.slides.findIndex((s) => s.id === action.slideId);
        if (idx < 0) {
          throw new VmotionError('SLIDES_NOT_FOUND', `Slide ${action.slideId} not found`);
        }
        const target = deck.slides[idx];
        const maxPer = action.maxBulletsPerSlide;
        if (target.bullets.length <= maxPer) break;
        const chunks: string[][] = [];
        for (let i = 0; i < target.bullets.length; i += maxPer) {
          chunks.push(target.bullets.slice(i, i + maxPer));
        }
        const splitSlides: SlideSpec[] = chunks.map((chunk, cIdx) => {
          const newId = cIdx === 0 ? target.id : `${target.id}-part-${cIdx + 1}`;
          const newSceneId = cIdx === 0 ? target.sceneId : `${deck.id}-${newId}`;
          return slideSpecSchema.parse({
            ...target,
            id: newId,
            sceneId: newSceneId,
            title: cIdx === 0 ? target.title : `${target.title} (${cIdx + 1}/${chunks.length})`,
            bullets: chunk,
            durationFrames: estimateSlideDurationFrames(
              { ...target, bullets: chunk, notes: cIdx === 0 ? target.notes : '' },
              snapshot.project.fps.num,
              snapshot.project.fps.den,
            ),
          });
        });
        deck.slides.splice(idx, 1, ...splitSlides);
        break;
      }
    }
  }

  const compiled = await compileDeckCandidate(
    root,
    snapshot,
    deck,
    source,
    [],
    request.detail,
  );

  let exportedPptx:
    | {
        path: string;
        bytes: number;
        sha256: string;
        slideCount: number;
      }
    | undefined;

  if (request.exportPptx) {
    const outFile = safePath(root, request.exportPptx.path);
    const pptxBytes = buildPptxBuffer(compiled._finalDeck, {
      widthPx: snapshot.project.width,
      heightPx: snapshot.project.height,
      snapshot: compiled._finalSnapshot,
    });
    await mkdir(dirname(outFile), { recursive: true });
    await atomicWrite(outFile, pptxBytes);
    exportedPptx = {
      path: request.exportPptx.path,
      bytes: pptxBytes.byteLength,
      sha256: hash(pptxBytes),
      slideCount: compiled._finalDeck.slides.length,
    };
  }

  const { _finalSnapshot, _finalDeck, ...publicResult } = compiled;
  return {
    ...publicResult,
    ...(exportedPptx ? { exportedPptx } : {}),
  };
}
