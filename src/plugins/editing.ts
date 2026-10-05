import {
  storyboardPlanSchema,
  storyboardInspectSchema,
  planStoryboard,
  inspectStoryboard,
} from '../service/storyboards.js';
import { sequenceAuditSchema, auditSequence } from '../service/sequence-audit.js';
import { sequencePlanSchema, planSequence } from '../service/sequence-plan.js';
import { sequenceEditSchema, sequenceEdits } from '../service/editing.js';
import { captionsImportSchema, importCaptions, inspectCaptions } from '../service/captions.js';
import { VmotionError } from '../core/model.js';
import { z } from 'zod';
import type { ToolDefinition } from '../mcp/catalog.js';
import type { BuiltinPluginModule } from './types.js';

export const editingPlugin: BuiltinPluginModule = {
  id: 'vmotion.editing',
  name: '剪辑、字幕与分镜',
  version: '1.0.0',
  dependencies: { 'vmotion.media': '^1.0.0', 'vmotion.audio': '^1.0.0' },
  methods: new Set([
    'storyboardPlan',
    'storyboardInspect',
    'sequenceAudit',
    'sequencePlan',
    'sequenceEdit',
    'captionsImport',
    'captionsInspect',
  ]),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'storyboard_plan',
        method: 'storyboardPlan',
        schema: storyboardPlanSchema.shape,
        description:
          'Assemble or edit a reusable chapter/shot/storyboard JSON resource with stable visual/narration clip IDs. Cumulative frame/second boundaries prevent per-shot rounding drift. Uses existing media/sequence planning, source fingerprints, locks and exact stored candidate/undo. Replaces only this storyboard generated clips and markers; existing content overlap is rejected. Optional shared operations can author source scenes/code atomically.',
      },
      {
        name: 'storyboard_inspect',
        method: 'storyboardInspect',
        schema: storyboardInspectSchema.shape,
        description:
          'Read storyboard resource hash, chapters and paged stable shots plus their actual generated sequence placements. includeDocument opts into full authoring JSON; no full project source is returned by default.',
      },
      {
        name: 'sequence_audit',
        method: 'sequenceAudit',
        schema: sequenceAuditSchema.omit({ inline: true }).shape,
        description:
          'Audit a complete sequence or exact candidate: structural clip/source ranges and overlap, source-scene object locators, stratified start/mid/end/boundary/marker output samples, actual composite pixel evidence and contact images. Coverage/omitted findings remain explicit; masks/effects are in final pixels, but artistic/per-object visibility and audio intelligibility are not inferred.',
      },
      {
        name: 'sequence_plan',
        description:
          'Plan source-range assembly without saving: append, insert across tracks, or overwrite target tracks. Preserves split source/fade clocks, linked sound, markers and locked tracks. Returns exact candidate/apply payloads, fixed IDs, revisions, source fingerprints and suggested sample frames. Preflight candidate, then submit apply unchanged; do not regenerate the plan after reviewing it.',
        method: 'sequencePlan',
        schema: sequencePlanSchema.shape,
      },
      {
        name: 'sequence_edit',
        description:
          'Atomic movie/remix timeline edits: split at playhead, trim in/out with source handles, slip source frames, delete selected clips, ripple-delete time across tracks, link/unlink clips, track locks and markers. Split/trim preserve original fade envelopes and fractional source positions; linked audio/video right parts get their own group. Ripple respects locked tracks and moves markers. One revision-checked undo step; audio and visual renderers share preserved fades.',
        method: 'sequenceEdit',
        schema: sequenceEditSchema.shape,
      },
      {
        name: 'captions_import',
        description:
          'Import SRT/VTT text or a local file into an editable JSON cue document and a visual subtitle track. Rational FPS conversion, overlap/range checks, configurable font/color/bottom margin, and efficient current-cue evaluation. Generates normal scene/component layers so per-cue overrides and source edits remain available. Does not perform speech recognition or call AI.',
        method: 'captionsImport',
        schema: captionsImportSchema.innerType().shape,
      },
      {
        name: 'captions_inspect',
        description:
          'Read a paginated editable subtitle cue document with IDs, source-frame times, text, FPS and revision. Edit its JSON through project_apply or file operations with revision checks.',
        method: 'captionsInspect',
        schema: {
          dataFile: z.string(),
          offset: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(500).default(100),
        },
      },
    ];
  },
  async dispatch(host, method, params) {
    const snapshot = host.snapshot;
    switch (method) {
      case 'storyboardPlan':
        return planStoryboard(host.root, structuredClone(snapshot), params);
      case 'storyboardInspect':
        return inspectStoryboard(snapshot, params);
      case 'sequencePlan':
        return planSequence(host.root, structuredClone(snapshot), params);
      case 'sequenceAudit': {
        const candidate = await host.candidateSnapshot(params);
        return host.withMediaTask(() =>
          auditSequence(host.root, candidate, { ...params, revision: candidate.revision }),
        );
      }
      case 'captionsImport': {
        const created = await importCaptions(snapshot, params),
          state = await host.transact(
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
        return inspectCaptions(snapshot, params.dataFile, params.offset, params.limit);
      case 'sequenceEdit': {
        const edited = sequenceEdits(snapshot, params),
          state = await host.transact(
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
      default:
        throw new VmotionError('METHOD_NOT_FOUND', 'Editing module does not handle this method', {
          method,
        });
    }
  },
};
