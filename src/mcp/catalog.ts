import { z } from 'zod';
import { graphicsInspectSchema, graphicsPlanSchema } from '../service/graphics.js';
import { designPlugin } from '../plugins/design.js';
import { mathPlugin } from '../plugins/math.js';
import { visualPlugin } from '../plugins/visual.js';
import { toolCategories, type ToolCategory } from './discovery.js';
import { pluginInspectSchema, pluginPackageSchema, pluginPlanSchema } from '../service/plugins.js';
import { trackingAnalyzeSchema } from '../service/tracking-jobs.js';
import {
  trackingInspectSchema,
  trackingPlanSchema,
  trackingEvidenceSchema,
} from '../service/tracking.js';
import {
  mediaStatusSchema,
  mediaProxySchema,
  mediaRelinkSchema,
} from '../service/media-management.js';
import {
  cacheInspectSchema,
  cachePlanSchema,
  cacheApplySchema,
} from '../service/cache-management.js';
import { visualPlanSchema } from '../service/visual-library.js';
import { storyboardPlanSchema, storyboardInspectSchema } from '../service/storyboards.js';
import { sequenceAuditSchema } from '../service/sequence-audit.js';
import {
  audioMixInspectSchema,
  audioMixPlanSchema,
  audioAuditSchema,
} from '../service/audio-mixing.js';
import { renderProfileSchema } from '../service/render-profile.js';
import { transitionPlanSchema } from '../service/transitions.js';
import { structureActionSchema } from '../core/structure.js';
import { drawingOperationSchema } from '../core/drawing-model.js';
import { contextOptionsSchema, fileReadSchema } from '../service/agent.js';
import { preflightSchema } from '../service/preflight.js';
import { parameterEditSchema } from '../service/component-parameters.js';
import { animationEditSchema, animationInspectSchema } from '../service/animation.js';
import { audioRangeSchema } from '../media/audio-preview.js';
import { visualAuditSchema } from '../service/visual-audit.js';
import { visualRepairSchema } from '../service/visual-repair.js';
import { motionPlanSchema } from '../service/motion-plan.js';
import { particlesInspectSchema, particlesPlanSchema } from '../service/particle-field.js';
import { effectGraphPlanSchema } from '../service/effect-graphs.js';
import { driversInspectSchema, driversPlanSchema, curvePathSchema } from '../service/drivers.js';
import {
  soundLibrarySchema,
  soundInspectSchema,
  soundPlanSchema,
  soundPreviewSchema,
  soundMidiSchema,
} from '../service/sound.js';
import { pathGeometrySchema } from '../core/vector-schema.js';
import { vectorBakeSchema } from '../service/vector.js';
import { repeatCreateSchema } from '../service/repeater.js';
import { repeatDescribeSchema } from '../core/repeater-schema.js';
import { precomposeSchema, scenePlaceSchema, sceneResetSchema } from '../service/shared-scenes.js';
import { timeInspectSchema, timeEditSchema } from '../service/content-time.js';
import { contextFramesSchema } from '../core/content-time.js';
import { sequenceEditSchema } from '../service/editing.js';
import { captionsImportSchema } from '../service/captions.js';
import { mediaInspectSchema, mediaSampleSchema } from '../service/media-evidence.js';
import { sequencePlanSchema } from '../service/sequence-plan.js';
import { agentGuideSchema } from '../service/agent-guide.js';
import { scene3dRenderSchema } from '../service/scene3d.js';
import { meshGenerateSchema, meshImportSchema, meshInspectSchema } from '../service/meshes.js';
import { scene3dMaterialsSchema } from '../service/materials3d.js';
import { effectsPlanSchema } from '../service/effects2d.js';

export interface ToolDefinition {
  name: string;
  description: string;
  method: string;
  schema: Record<string, z.ZodTypeAny>;
  plugin?: { id: string; version: string; origin: 'builtin' | 'project'; hash?: string };
  categories?: ToolCategory[];
  keywords?: string;
  annotations?: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}
export function toolDefinitions(): ToolDefinition[] {
  const candidateInput = {
    ...Object.fromEntries(
      Object.entries(preflightSchema.omit({ inline: true }).shape).map(([name, schema]) => [
        name,
        schema instanceof z.ZodDefault ? schema.removeDefault().optional() : schema,
      ]),
    ),
    operations: z.array(z.record(z.unknown())).max(1000).optional(),
  };
  const tools: ToolDefinition[] = [
    ...designPlugin.tools(),
    ...mathPlugin.tools(),
    ...visualPlugin.tools(),
    {
      name: 'plugins_inspect',
      description:
        'Inspect paged builtin/project plugins, versions, dependencies, contribution sources and namespaced tools. Full manifests are opt-in. Existing ordinary resource references survive library disable/removal.',
      method: 'pluginsInspect',
      schema: pluginInspectSchema.shape,
      categories: ['core', 'composition'],
      keywords: '插件 注册 依赖 版本 plugin module',
    },
    {
      name: 'plugins_plan',
      description:
        'Plan project-local plugin registration, enabling/disabling/removal, hash-checked source files and component placements in one exact candidate. Dependencies/API/duplicate IDs are checked; preflight loads typed tool exports and sampled native frames. No source is deleted on removal unless explicitly requested.',
      method: 'pluginsPlan',
      schema: pluginPlanSchema.shape,
      categories: ['core', 'composition', 'recovery'],
      keywords: '插件 安装 注册 创建 更新 禁用 移除 候选 plugin register dependency',
    },
    {
      name: 'plugins_package',
      description:
        'Read a paginated plugin package index with manifest/content hashes, dependencies and bounded file sizes. Source text is never duplicated by default; use project_file_read only for selected ranges.',
      method: 'pluginsPackage',
      schema: pluginPackageSchema.shape,
      categories: ['core'],
      keywords: '插件 包 指纹 hash 依赖 文件 package integrity bundle',
    },
    {
      name: 'media_status',
      method: 'mediaStatus',
      schema: mediaStatusSchema.shape,
      description:
        'Inspect paged asset availability, registered/probed stream metadata and ready/stale proxies without dumping project source. Source fingerprints and frame/second units are explicit. Missing files remain identified by stable IDs for relink candidates.',
    },
    {
      name: 'media_relink_plan',
      method: 'mediaRelinkPlan',
      schema: mediaRelinkSchema.shape,
      description:
        'Relink image/video/audio assets to explicit existing files by reference while preserving stable IDs, scene/clip references and one atomic undo. Compatible policy checks registered dimensions/streams/duration; replace is explicit and rejects shorter existing timeline uses. Returns stored exact preflight/apply candidate with freshly probed metadata and new-file fingerprints; no files are moved or overwritten.',
    },
    {
      name: 'media_proxy',
      method: 'mediaProxy',
      schema: mediaProxySchema.shape,
      description:
        'Start/query/cancel bounded background proxy tasks or inspect cached readiness. Proxies are lossless FFV1, intra frames, project rational FPS, no audio, and source-fingerprint checked before atomic publication. Preview auto mode uses matching proxies and screen-sized decode; exports/native evidence use originals. Eight pending tasks and source/version limits are explicit.',
    },
    {
      name: 'cache_inspect',
      method: 'cacheInspect',
      schema: cacheInspectSchema.shape,
      description:
        'Inspect named regenerable project-cache groups with byte totals, leased/project-reference protection and optional file paging. Does not scan/delete source/assets/history/candidate plans/render checkpoints or loaded component bundles. Links are skipped and scan work is bounded.',
    },
    {
      name: 'cache_plan',
      method: 'cachePlan',
      schema: cachePlanSchema.shape,
      description:
        'Plan oldest eligible regenerable-cache files toward an explicit byte budget and minimum age without deleting. Fixed SHA-256 plan includes exact paths/size/mtime, excludes live leases and registered project media, and reports incomplete quotas. Stored candidates, source/history, render checkpoints and compiled modules stay protected.',
    },
    {
      name: 'cache_apply',
      method: 'cacheApply',
      schema: cacheApplySchema.shape,
      description:
        'Apply a reviewed fixed cache-cleanup plan. Rejects active media/render/proxy work, revalidates resolved paths against named cache roots and skips changed/leased/newly referenced targets. Clears inactive preview readers first; returns actual reclaimed bytes and omissions. Only regenerable caches are removed, with no source/history/candidate/checkpoint deletion.',
    },
    {
      name: 'visual_plan',
      method: 'visualPlan',
      schema: visualPlanSchema.shape,
      description:
        'Apply a selected visual template to multi-scene/scoped layers in one stored graph candidate, with parameter animation and optional same-parent map input bindings. Existing edited shared resources are retained; new template graphs are materialized under components/effects. Use native preflight/pictures and render_profile bounded/full field evidence, then unchanged apply for one undo.',
    },
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
      name: 'render_profile',
      method: 'renderProfile',
      schema: renderProfileSchema.shape,
      description:
        'Measure real cold/warm render performance for scene/sequence/focused frames or an exact candidate. Returns wall-clock rendering/optional PNG encoding, component compilation hits, bounded surface-pool reuse/memory, native evaluation work and repeated-frame pixel hashes. Compact summaries by default; detail opts into per-round records. Does not lower export quality or hide nondeterministic code behind a frame cache.',
    },
    {
      name: 'transition_plan',
      method: 'transitionPlan',
      schema: transitionPlanSchema.shape,
      description:
        'Create reusable parameterized transition compositions between existing scenes as one exact batch candidate, optionally place clips at explicit timeline frames. Crossfade, slide/push, wipe, iris, zoom, dip and cut share source dimensions/content clocks and declare scene dependencies. Isolated additive compositing preserves transparent crossfade endpoints. Source scenes are preserved; native preflight/apply shares one undo.',
    },
    {
      name: 'audio_mix_inspect',
      method: 'audioMixInspect',
      schema: audioMixInspectSchema.shape,
      description:
        'Inspect timeline track/bus/master routing, effects, gain/pan, sidechain dependencies and normalization settings with selected node IDs and optional full configuration. Declared graph rejects feedback cycles. Ordinary audio preview/export uses the same full-history mix cache.',
    },
    {
      name: 'audio_mix_plan',
      method: 'audioMixPlan',
      schema: audioMixPlanSchema.shape,
      description:
        'Plan multi-sequence track/bus/master mixing, sidechain ducking, gain/pan automation and measured loudness normalization as an exact atomic candidate. Stable track/bus actions, locked-track checks, explicit scratch budgets and source fingerprints preserve safety/undo. Audition audio_preview planId and measure audio_audit before applying unchanged.',
    },
    {
      name: 'audio_audit',
      method: 'audioAudit',
      schema: audioAuditSchema.shape,
      description:
        'Measure actual sequence or audio/video/sound asset PCM through FFmpeg EBU R128/BS.1770: integrated LUFS, LRA and true peak with profile findings, whole/range coverage and bounded cached evidence. Supports exact stored candidates. Silence/short ranges report uncertainty; encoded lossy deliveries should be audited separately.',
    },
    {
      name: 'sound_library',
      method: 'soundLibrary',
      schema: soundLibrarySchema.shape,
      description:
        'Discover local synth/FM/noise/drum/sample instruments and gain/EQ/distortion/delay/chorus/reverb/compressor/limiter effects, units, budgets and the agent music workflow. No AI calls or external instrument plugins. Full interfaces use project_schema sound/soundInstrument/soundEffect.',
    },
    {
      name: 'sound_inspect',
      method: 'soundInspect',
      schema: soundInspectSchema.shape,
      description:
        'Inspect an editable JSON sound asset: tempo map, duration/sample positions, note events by stable IDs with paging, instruments, automation and acyclic bus/send order. Optional full document for code authoring. Audio rendering and sample evidence use sound_preview.',
    },
    {
      name: 'sound_plan',
      method: 'soundPlan',
      schema: soundPlanSchema.shape,
      description:
        'Create or edit multi-track music and sound effects as an exact atomic candidate. Supports full documents or stable-ID track/note actions, transpose/quantize/duplicate, synth/FM/noise/drums/audio samples, beat/second clocks, gain/pan automation, effects and buses. Optional locked-track-aware timeline placement. Review sound_preview planId then project_preflight/project_apply unchanged for one undo; sample fingerprints are pinned.',
    },
    {
      name: 'sound_preview',
      method: 'soundPreview',
      schema: soundPreviewSchema.shape,
      description:
        'Audition 1–10 seconds of an editable sound asset or a stored candidate without applying it. Renders deterministic stereo 48 kHz from origin, retaining delay/reverb/compressor history when seeking; returns playable WAV, RMS/peak/waveform and full-mix clipping evidence. Project source is preserved, outputs are cache/export files.',
    },
    {
      name: 'sound_midi',
      method: 'soundMidi',
      schema: soundMidiSchema.shape,
      description:
        'Import standard MIDI format 0/1 PPQ as an editable sound candidate, or export notes/tempo to format 1 MIDI. Import supports tempo maps, velocity and sustain; maps GM to local presets and reports unsupported controls/plugins. Export explicitly reports processing/sampling/sweeps omitted from MIDI. Source MIDI is preserved.',
    },
    {
      name: 'drivers_inspect',
      description:
        'Inspect evaluated property expressions, responsive layout constraints and curved motion paths at local frames. Returns actual pose/value dependency evidence, stable layer references and shared driver descriptions without full project source. Native key values precede drivers; expression outputs override layout/path fields. Cycles/missing references/nonfinite outputs have precise diagnostics.',
      method: 'driversInspect',
      schema: driversInspectSchema.shape,
    },
    {
      name: 'drivers_plan',
      description:
        'Plan an atomic multi-scene batch of property expressions, responsive parent/scene/sibling layout constraints, SVG/shape-referenced arc-length motion and their numeric keys. Expression fields resolve lazy dependencies and deterministic clocks; generated edits persist overrides. Returns exact stored candidate for native preflight/apply and one undo, with sample coverage.',
      method: 'driversPlan',
      schema: driversPlanSchema.shape,
    },
    {
      name: 'curve_path',
      description:
        'Measure and sample SVG line/quadratic/cubic/arc motion by length, returning local position, tangent, auto-facing angle and multi-contour jump evidence. Clamp/loop/pingpong handle progress without state. Pure geometry query; does not edit project files.',
      method: 'curvePath',
      schema: curvePathSchema.shape,
    },
    {
      name: 'effect_graph_plan',
      description:
        'Plan graph resources and multi-scene scoped attachments/updates as one exact candidate. Full JSON or stable-node-ID add/update/replace/remove/output/links/parameters actions support short edits, branch/mix/mask/transform/noise/displacement and nested reusable subgraphs. Hash-check resource edits; bind sibling input layers, materialize numeric parameter keys, preserve generated source. Explicit resetParams/resetKeys handles graph upgrades; native preflight/apply shares one undo and reports coverage.',
      method: 'effectGraphPlan',
      schema: effectGraphPlanSchema.shape,
    },
    {
      name: 'particles_inspect',
      description:
        'Evaluate a seeded analytical particle field at an arbitrary time without creating project files. Returns bounded birth-ID records, age/position/velocity/color, conservative local bounds and explicit scan/live truncation. Supports burst/continuous, point/box/disk/line emission, gravity, drag, fade, size/tint/spin and circle/square/streak sprites.',
      method: 'particlesInspect',
      schema: particlesInspectSchema.shape,
    },
    {
      name: 'particles_plan',
      description:
        'Plan an editable parameterized TypeScript particle component in a scene/group/generated scope, optionally with whole-emitter effects. Code/time evaluation is pure; renderer temporal sampling re-evaluates births. Returns exact stored candidate for native preflight/apply and one undo; all controls remain available through component_parameters.',
      method: 'particlesPlan',
      schema: particlesPlanSchema.shape,
    },
    {
      name: 'motion_plan',
      description:
        'Compose parameterized animation cues (builtin, inline or shared JSON) across multiple scenes/layer scopes in one exact candidate. Supports frame/second clocks, per-target offsets and cue bindings, relative static/evaluated poses, explicit existing-channel collision policies, and atomic template saving. Generated edits persist overrides, source code stays editable. Returns stored preflight/apply plan, channel/timing evidence and sampling coverage; one shared undo.',
      method: 'motionPlan',
      schema: motionPlanSchema.shape,
    },
    {
      name: 'visual_repair_plan',
      description:
        'Plan explicit batch layout repairs from inspected stable layer IDs: fit full text height using native layout, move in canvas/parent coordinates, or place inside a padded canvas. Preserves entire key trajectories by default; currentKey edits a pose. Resolves generated layer scopes automatically, keeps component source intact, audits before/after and returns an exact stored candidate for preflight/apply and one undo. Does not guess artistic fixes for overlap, clipping or motion.',
      method: 'visualRepairPlan',
      schema: visualRepairSchema.shape,
    },
    {
      name: 'effects_plan',
      description:
        'Plan an atomic multi-layer effect edit: append/update/copy/move/toggle/remove/clear and numeric keys, with stable effect IDs and automatic animation-index remapping. Fits new spatial effects to current content bounds by default. Generated layers persist overrides; source code stays editable. Returns compact stored planId; preflight images and apply unchanged for one undo.',
      method: 'effectsPlan',
      schema: effectsPlanSchema.shape,
    },
    {
      name: 'scene3d_materials',
      description:
        'Inspect current per-instance materials/light controls without vertex arrays, or plan stable-instance-ID material/lighting edits for a scene3d layer in any scope. Supports metallic/roughness/emissive/unlit/smooth/flat/double-sided materials, directional/point lights and exposure/tone mapping. Existing numeric keys update at the requested frame; reset removes material keys. Returns exact stored planId for preflight/apply and one undo; replacing animated lights requires explicit key reset.',
      method: 'scene3dMaterials',
      schema: scene3dMaterialsSchema.shape,
    },
    {
      name: 'mesh_generate',
      description:
        'Plan a reusable JSON mesh resource (box/sphere/cylinder/cone/torus/plane), optionally placing a meshSource scene3d layer in a native/group/component scope with automatic camera fit. Returns summary/topology and compact candidate/apply plan IDs by default; preflight and apply unchanged for one undo. No project edits during planning. delivery=inline returns exact operations.',
      method: 'meshGenerate',
      schema: meshGenerateSchema.shape,
    },
    {
      name: 'mesh_import',
      description:
        'Plan local OBJ geometry import with line diagnostics, negative indices, concave polygon triangulation, object/group filters and explicit material colors. Preserves UV/normal corner references as resource metadata; renderer remains flat/opaque. Captures source SHA-256, saves versioned project JSON via candidate/apply, optionally places a meshSource layer. Returns compact plan IDs; no model/API calls or automatic MTL/texture loading.',
      method: 'meshImport',
      schema: meshImportSchema.innerType().shape,
    },
    {
      name: 'mesh_inspect',
      description:
        'Inspect a pinned project mesh resource or inline mesh: bounds, area, signed volume, boundary/nonmanifold/inconsistent edges and degenerate faces. Paginate face geometry, normals, centers and source groups without dumping every vertex. Mesh identity edges are used; unwelded coincident vertices are reported as boundaries.',
      method: 'meshInspect',
      schema: meshInspectSchema.shape,
    },
    {
      name: 'scene3d_render',
      description:
        'Render a supplied scene or a current scene3d layer with native per-sample depth testing. Return color, normalized eye-depth and face-ID PNG evidence, visible-pixel counts, stable face/object IDs and requested pixel picks. Supports nested composition paths, frame/contextFrames and revision. Opaque flat-shaded meshes with 1/4 antialias samples; outer layer effects/masks are excluded from this local inspection.',
      method: 'scene3dRender',
      schema: scene3dRenderSchema.omit({ inline: true }).shape,
    },
    {
      name: 'agent_guide',
      description:
        'Concise workflow routing for external agents: overview, animation, editing, 3d, math or recovery. Tool names, units, evidence/commit steps and retry guidance; no source or large schemas dumped. Start here, then project_context.',
      method: 'agentGuide',
      schema: agentGuideSchema.shape,
    },
    {
      name: 'media_inspect',
      description:
        'Probe actual source metadata, dimensions, audio streams, exclusive sourceEnd in project FPS, and size/mtime fingerprint. Return assetCheck for evidence-checked planning and commits.',
      method: 'mediaInspect',
      schema: mediaInspectSchema.shape,
    },
    {
      name: 'media_sample',
      description:
        'Inspect video/image/drawing source frames before editing. Returns a native contact sheet, project-source frame numbers, seconds, pixel hashes and assetCheck. Optional fingerprint rejects stale evidence; at most 24 samples with bounded decode size. Independent of live preview.',
      method: 'mediaSample',
      schema: mediaSampleSchema.omit({ inline: true }).shape,
    },
    {
      name: 'sequence_plan',
      description:
        'Plan source-range assembly without saving: append, insert across tracks, or overwrite target tracks. Preserves split source/fade clocks, linked sound, markers and locked tracks. Returns exact candidate/apply payloads, fixed IDs, revisions, source fingerprints and suggested sample frames. Preflight candidate, then submit apply unchanged; do not regenerate the plan after reviewing it.',
      method: 'sequencePlan',
      schema: sequencePlanSchema.shape,
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
    {
      name: 'sequence_edit',
      description:
        'Atomic movie/remix timeline edits: split at playhead, trim in/out with source handles, slip source frames, delete selected clips, ripple-delete time across tracks, link/unlink clips, track locks and markers. Split/trim preserve original fade envelopes and fractional source positions; linked audio/video right parts get their own group. Ripple respects locked tracks and moves markers. One revision-checked undo step; audio and visual renderers share preserved fades.',
      method: 'sequenceEdit',
      schema: sequenceEditSchema.shape,
    },
    {
      name: 'time_inspect',
      description:
        'Inspect visual content clocks for a video/component/scene reference: normalized mapping, remap channels, parent-to-source sampled frames, repeat bounds and visibility. Layer transforms/parameters remain on the parent clock while visual content uses the mapped source clock. Nested edits use local frame plus contextFrames from composition_interactions.',
      method: 'timeInspect',
      schema: timeInspectSchema.shape,
    },
    {
      name: 'time_edit',
      description:
        'Revision-checked visual retiming with one undo step: rate/offset/anchor, negative-rate reverse, freeze, clamp/loop/pingpong/blank bounds, numeric remap keys with easing, or reset. Scene/video asset durations are inferred; components need explicit duration for bounded modes. Audio is not implicitly retimed by these visual-layer controls.',
      method: 'timeEdit',
      schema: timeEditSchema.shape,
    },
    {
      name: 'scene_reset_instance',
      description:
        'Remove this scene-reference instance internal property/structure overrides in one undo step, keeping source scene and outer reference placement. Generated references clear edits stored on their owning instance; source-provided defaults remain. Revision-checked and supports nested component/reference paths.',
      method: 'sceneReset',
      schema: sceneResetSchema.shape,
    },
    {
      name: 'scene_precompose',
      description:
        'Create a reusable JSON scene from selected adjacent sibling layers and descendants, replacing them with one editable reference at the original stacking slot. Native keyframes/hierarchies/masks are preserved; generated leaf content is captured at the chosen frame and source TypeScript stays intact. Instance edits use overrides, source-scene edits affect all references. One revision-checked undo step restores originals. allowReorder explicitly permits a selection that crosses unselected siblings.',
      method: 'scenePrecompose',
      schema: precomposeSchema.shape,
    },
    {
      name: 'scene_place',
      description:
        'Insert an existing scene as a scaled/positioned reusable reference into a scene/group/component. Returns selection; rejects declared cyclic references before saving. Enter the reference via composition_inspect and edit its instance overrides with ordinary composition/animation tools.',
      method: 'scenePlace',
      schema: scenePlaceSchema.shape,
    },
    {
      name: 'scene_references',
      description:
        'Inspect a source scene size/duration and all declared incoming/outgoing layer, structural, override and sequence-clip references before a shared edit or removal. Dynamic TypeScript-generated references require sampled graph inspection.',
      method: 'sceneReferences',
      schema: { sourceId: z.string() },
    },
    {
      name: 'repeat_describe',
      description:
        'Calculate a repeater pattern before editing: normalized parameters, fractional copy opacity, exact affine transforms at up to 128 indices, stable copy IDs and a conservative union bound for an optional source rectangle. Does not generate project files. Use frame_capture/visual_audit for actual clipping, mask/effect visibility and visual quality.',
      method: 'repeatDescribe',
      schema: repeatDescribeSchema.shape,
    },
    {
      name: 'repeat_create',
      description:
        'Create a fully editable TypeScript repeater component from selected sibling layers and their descendants. Linear/grid/radial patterns, fractional counts, rotation/scale/skew/pivot, opacity and stacking parameters are exposed to the inspector and component_parameters_edit keyframes. Source layers/code are preserved; optional hiding and creation use one revision-checked undo step. Generated source contains a copied base graph, not a live link to every original layer. Per-copy edits persist as normal component overrides.',
      method: 'repeatCreate',
      schema: repeatCreateSchema.shape,
    },
    {
      name: 'vector_bake',
      description:
        'Create a new static editable vector path from sibling rect/ellipse/path layers at one frame. Supports boolean operations, simplify, rounded corners and solid stroke outline; preserves source layers/code, optionally hides operands, commits one revision-checked undo step, and handles generated component structure/overrides. This bakes geometry and local transforms, not pixel effects or source animations; the first operand supplies solid fill/opacity.',
      method: 'vectorBake',
      schema: vectorBakeSchema.shape,
    },
    {
      name: 'path_geometry',
      description:
        'Compute native SVG path geometry without editing files: boolean union/difference/intersect/xor/reverseDifference, simplify, rounded corners, solid stroke outline, trim or bounds. Operands may have affine transforms and evenodd filling. Returns SVG, winding rule and local bounds; trim uses combined contour length, offset in turns and wraps when start > end. Apply returned SVG through a transaction or component source.',
      method: 'pathGeometry',
      schema: pathGeometrySchema.shape,
    },
    {
      name: 'graphics_inspect',
      description:
        'Inspect text/path typography or native shape operators at the final evaluated pose. Returns shared local bounds/world matrix, stable stack IDs/channels, text line/word/grapheme counts and paginated glyph poses (16 by default). SVG and full values are opt-in. Rendering and selection use the same layout/geometry.',
      method: 'graphicsInspect',
      schema: graphicsInspectSchema.shape,
    },
    {
      name: 'tracking_analyze',
      description:
        'Run deterministic sparse point tracking on a video asset with original pixels, source-frame range, manual seeds/reseeds or automatic corners. Independent worker uses pyramidal Lucas–Kanade with photometric/forward-backward checks. Start returns a background job; poll status or cancel. Completed SHA analysisId is immutable; default replies omit trajectories. Lost points stay lost until explicit reseed. Does not modify project/history.',
      method: 'trackingAnalyze',
      schema: trackingAnalyzeSchema.shape,
    },
    {
      name: 'tracking_inspect',
      description:
        'Read a tracking analysisId or editable project tracking JSON. Paginated point/gap summaries and chosen source-frame positions; full matching evidence is opt-in. Report confidence as a heuristic. Read before binding or repairing samples.',
      method: 'trackingInspect',
      schema: trackingInspectSchema.shape,
    },
    {
      name: 'tracking_plan',
      description:
        'Plan editable tracking resource/manual sample edits and batch point/translation/similarity/affine attachment, video stabilization or four-point corner pin. Uses actual source video fit/clock and target parent/TRS. Generates ordinary matrix/effect keys, preserves TypeScript, protects existing channels, rejects loss by default; explicit hold reports held samples. Fingerprint-pinned short planId for unchanged preflight/apply and one undo. Smoothing/zoom are explicit; transparent borders remain possible.',
      method: 'trackingPlan',
      schema: trackingPlanSchema.shape,
    },
    {
      name: 'tracking_evidence',
      description:
        'Capture annotated original video frames with tracked/manual point crosses and confidence/loss counts, using recorded source FPS and pinned source fingerprint. Native PNG evidence contains no duplicated media Base64 in metadata.',
      method: 'trackingEvidence',
      schema: trackingEvidenceSchema.omit({ inline: true }).shape,
    },
    {
      name: 'graphics_plan',
      description:
        'Plan a batch of path text, range text animators and ordered shape operators across native/generated layers. Stable-ID append/update/copy/move/toggle/remove/keys preserve indexed channels and expression targets. Operators: trim/round/dash/outline/transform/boolean/closed offset. Text selectors: grapheme/word/line and percent/index ranges. Returns a short stored candidate for unchanged preflight/apply and one undo; preserves TypeScript. Expression index references require explicit rewrites before topology changes.',
      method: 'graphicsPlan',
      schema: graphicsPlanSchema.shape,
    },
    {
      name: 'visual_audit',
      description:
        'Inspect a scene/group/component across sampled frames for definite text truncation and review hints: text canvas overflow, clipping, overlap, opaque-rectangle coverage and fast/jumping motion. Returns stable IDs, owner paths, times, thresholds, limitations and annotated native frame evidence. Geometry hints require visual judgement and do not modify project/history.',
      method: 'visualAudit',
      schema: visualAuditSchema.omit({ inline: true }).shape,
    },
    {
      name: 'audio_timeline',
      description:
        'Inspect the audible sequence mix: clip sample positions, source trims, effective nested speeds/volumes and fade envelopes. Muted tracks are excluded.',
      method: 'audioTimeline',
      schema: { sequenceId: z.string().optional() },
    },
    {
      name: 'audio_preview',
      description:
        'Render up to 10 seconds of the actual sequence audio mix at exact 48 kHz sample positions. Returns playable WAV audio plus waveform levels, RMS, peak and limiter sample ratio; uses the same mixer as export and checks project revision.',
      method: 'audioPreview',
      schema: { ...audioRangeSchema.shape, output: z.string().optional() },
    },
    {
      name: 'animation_inspect',
      description:
        'Read layer animation channels and sample evaluated values plus numerical velocity per second at chosen frames. Supports native and generated layers and structured component numeric paths.',
      method: 'animationInspect',
      schema: animationInspectSchema.shape,
    },
    {
      name: 'animation_edit',
      description:
        'Atomically edit keyframes across multiple layers. Actions upsert/remove/ease/transform support selected channels, times or ranges; transform can copy, shift/scale time and values around pivots. Defaults reject time collisions. Component defaults are materialized; generated edits persist as owner overrides.',
      method: 'animationEdit',
      schema: animationEditSchema.shape,
    },
    {
      name: 'component_parameters',
      description:
        'Inspect parameter descriptors, defaults, JSON Schema, resolved/evaluated values and numeric animation channels for a native or generated programmable component.',
      method: 'componentParameters',
      schema: {
        sceneId: z.string(),
        nodeId: z.string(),
        path: z.array(z.string()).max(32).default([]),
        contextFrames: contextFramesSchema.default([]),
        frame: z.number().int().nonnegative().default(0),
      },
    },
    {
      name: 'component_parameters_edit',
      description:
        'Edit numeric/string/color/boolean/enum/vector/array/object parameters by relative parameter paths, reset defaults or create numeric leaf keyframes. Materializes defaults and preserves sibling values; creates one undo step and supports generated component overrides.',
      method: 'componentParametersEdit',
      schema: parameterEditSchema.shape,
    },
    {
      name: 'project_schema',
      description:
        'Read one authoritative JSON schema only when needed. Query operationType to get the schema of a specific semantic operation rather than the full operation catalog.',
      method: 'projectSchema',
      schema: {
        name: z.enum([
          'project',
          'scene',
          'sequence',
          'node',
          'operation',
          'drawing',
          'drawingOperation',
          'fileEdit',
          'scene3d',
          'mesh',
          'material3d',
          'effect',
          'motionTemplate',
          'effectGraph',
          'expressions',
          'layout',
          'motionPath',
          'pathText',
          'textAnimator',
          'shapeOperator',
          'tracking',
          'trackingSettings',
          'theme',
          'themeBinding',
          'sceneTemplate',
          'templateAuthor',
        ]),
        operationType: z.string().optional(),
      },
    },
    {
      name: 'project_context',
      description:
        'Start here for concise project metadata, revision, stable IDs, source-file hashes, diagnostics and selection. Paginate files/assets/layers; request a scene or sequence without reading all source code.',
      method: 'projectContext',
      schema: contextOptionsSchema.shape,
    },
    {
      name: 'project_file_read',
      description:
        'Read a bounded line range of a tracked project source file with its exact content hash and revision. Use version=pending to inspect invalid external edits; active returns the last usable source.',
      method: 'projectFileRead',
      schema: fileReadSchema.shape,
    },
    {
      name: 'project_preflight',
      description:
        'Check a candidate batch of semantic operations and hash-checked file edits without replacing active project files or undo history. Includes JSON/type/component checks and optional native sample frames; determinism repeats sampled frames. Returns diagnostics and a contact-sheet image for requested frames.',
      method: 'projectPreflight',
      schema: candidateInput,
    },
    {
      name: 'project_apply',
      description:
        'Validate and atomically commit candidate operations and hash-checked file edits with one undo step. Use revision plus expectedCandidateRevision from project_preflight to commit exactly the inspected candidate. File edits support replace/create, unique exact-text substitutions and delete. New JSON scene/sequence/drawing files must be referenced in the manifest.',
      method: 'projectApply',
      schema: { ...candidateInput, expectedCandidateRevision: z.string().optional() },
    },
    {
      name: 'project_inspect',
      description:
        'Read project files, scene nodes, sequence tracks, selection, diagnostics, conflicts and current revision.',
      method: 'state',
      schema: {},
    },
    {
      name: 'project_validate',
      description: 'Validate references, format and TypeScript component compilation.',
      method: 'validate',
      schema: {},
    },
    {
      name: 'project_transact',
      description:
        'Apply an atomic undoable batch. Supports native node/scene/track/clip operations, writeSource, editFiles, writeDrawing and removeDrawing. Use current revision for optimistic concurrency; project_apply also offers runtime preflight and compact results.',
      method: 'transact',
      schema: {
        operations: z.array(z.record(z.unknown())).min(1).max(1000),
        revision: z.string().optional(),
        save: z.boolean().optional(),
      },
    },
    {
      name: 'project_save',
      description: 'Save valid staged edits atomically.',
      method: 'save',
      schema: {},
    },
    {
      name: 'project_undo',
      description: 'Undo the last accepted transaction.',
      method: 'undo',
      schema: {},
    },
    {
      name: 'project_redo',
      description: 'Redo an undone transaction.',
      method: 'redo',
      schema: {},
    },
    {
      name: 'project_resolve_conflict',
      description: 'Resolve a conflict while preserving both versions until chosen.',
      method: 'resolve',
      schema: { index: z.number().int().nonnegative(), choice: z.enum(['ours', 'theirs']) },
    },
    {
      name: 'project_select',
      description: 'Set selected node IDs in the shared edit session.',
      method: 'selection',
      schema: { ids: z.array(z.string()) },
    },
    {
      name: 'component_describe',
      description: 'Read the editable parameter schema of a TypeScript component.',
      method: 'component',
      schema: { source: z.string() },
    },
    {
      name: 'composition_inspect',
      description:
        'Open an isolated scene/group/component/reference instance graph. path contains stable layer IDs at each navigation level, including scene reference layers. Reports local source coordinates, dimensions, breadcrumbs and edit targets. With path, frame is the isolated content clock; contextFrames pins ancestor clocks. Use frame/contentFrame/contextFrames from composition_interactions when entering or editing a retimed descendant.',
      method: 'compositionInspect',
      schema: {
        sceneId: z.string(),
        frame: z.number().nonnegative().default(0),
        path: z.array(z.string()).max(32).default([]),
        contextFrames: contextFramesSchema.default([]),
      },
    },
    {
      name: 'composition_edit_layer',
      description:
        'Edit a layer inside an isolated group/component/scene-reference instance. Native layers update their scene data; generated or referenced layers persist overrides on the owning instance, preserving shared source JSON/TypeScript and undo history.',
      method: 'compositionTransact',
      schema: {
        sceneId: z.string(),
        frame: z.number().nonnegative().default(0),
        path: z.array(z.string()).max(32).default([]),
        contextFrames: contextFramesSchema.default([]),
        nodeId: z.string(),
        patch: z.record(z.unknown()),
        revision: z.string().optional(),
      },
    },
    {
      name: 'composition_edit_layers',
      description:
        'Atomically edit multiple native or generated layers across groups in one scene. Preserves all component overrides and creates one undo step.',
      method: 'compositionTransactBatch',
      schema: {
        sceneId: z.string(),
        frame: z.number().nonnegative().default(0),
        revision: z.string().optional(),
        edits: z
          .array(
            z.object({
              path: z.array(z.string()).max(32).default([]),
              contextFrames: contextFramesSchema.default([]),
              nodeId: z.string(),
              frame: z.number().finite().nonnegative().optional(),
              patch: z.record(z.unknown()),
            }),
          )
          .min(1)
          .max(1000),
      },
    },
    {
      name: 'composition_structure',
      description:
        'Add, duplicate, delete, group, ungroup or reorder layers in a scene/group/component. Generated structure edits persist on the owning component without rewriting source. Grouping requires a shared parent. Ungrouping preserves appearance and rejects groups with applied transforms/effects.',
      method: 'compositionStructure',
      schema: {
        sceneId: z.string(),
        frame: z.number().nonnegative().default(0),
        path: z.array(z.string()).max(32).default([]),
        contextFrames: contextFramesSchema.default([]),
        action: structureActionSchema,
        revision: z.string().optional(),
      },
    },
    {
      name: 'composition_structure_batch',
      description:
        'Apply structural edits across multiple group/component scopes atomically with one undo step.',
      method: 'compositionStructureBatch',
      schema: {
        sceneId: z.string(),
        frame: z.number().nonnegative().default(0),
        revision: z.string().optional(),
        actions: z
          .array(
            z.object({
              path: z.array(z.string()).max(32).default([]),
              contextFrames: contextFramesSchema.default([]),
              action: structureActionSchema,
              frame: z.number().finite().nonnegative().optional(),
            }),
          )
          .min(1)
          .max(100),
      },
    },
    {
      name: 'composition_interactions',
      description:
        'Inspect actual current-frame geometry and parent transforms for native/generated layers, including group content bounds. Filter nodeIds to inspect selection or drag coordinates.',
      method: 'compositionInteractions',
      schema: {
        sceneId: z.string(),
        frame: z.number().nonnegative().default(0),
        path: z.array(z.string()).max(32).default([]),
        contextFrames: contextFramesSchema.default([]),
        nodeIds: z.array(z.string()).max(1000).optional(),
      },
    },
    {
      name: 'asset_thumbnail',
      description:
        'Get a visual thumbnail of an image, video or drawing asset, including legacy drawings. Returns an image for direct agent inspection.',
      method: 'assetThumbnail',
      schema: {
        assetId: z.string(),
        width: z.number().int().min(16).max(512).default(160),
        height: z.number().int().min(16).max(512).default(100),
        output: z.string().optional(),
      },
    },
    {
      name: 'drawing_list',
      description:
        'List independent drawing documents. Documents are separate from scene layers until published and placed.',
      method: 'drawingList',
      schema: {},
    },
    {
      name: 'drawing_get',
      description:
        'Read editable layers, brush strokes and document size for an independent drawing document.',
      method: 'drawingGet',
      schema: { id: z.string() },
    },
    {
      name: 'drawing_create',
      description:
        'Create a transparent layered drawing document without adding scene layers or publishing assets.',
      method: 'drawingCreate',
      schema: {
        id: z.string().optional(),
        name: z.string().optional(),
        width: z.number().int().min(16).max(8192).optional(),
        height: z.number().int().min(16).max(8192).optional(),
        revision: z.string().optional(),
      },
    },
    {
      name: 'drawing_edit',
      description:
        'Apply brush/eraser strokes, create/edit/delete/copy/order layers, or update document dimensions atomically. Uses the shared undo history and revision checks.',
      method: 'drawingEdit',
      schema: {
        id: z.string(),
        operations: z.array(drawingOperationSchema).min(1).max(1000),
        revision: z.string().optional(),
      },
    },
    {
      name: 'drawing_publish',
      description:
        'Publish the whole drawing or selected layers as an immutable visual asset. The source document remains editable.',
      method: 'drawingPublish',
      schema: {
        id: z.string(),
        layerIds: z.array(z.string()).optional(),
        name: z.string().optional(),
        revision: z.string().optional(),
      },
    },
    {
      name: 'drawing_open_asset',
      description: 'Create an editable drawing document from a published or legacy drawing asset.',
      method: 'drawingOpenAsset',
      schema: { assetId: z.string(), revision: z.string().optional() },
    },
    {
      name: 'drawing_frame',
      description: 'Get the native rendered image of a drawing document for visual checks.',
      method: 'drawingFrame',
      schema: {
        id: z.string(),
        width: z.number().int().min(16).max(2048).optional(),
        height: z.number().int().min(16).max(2048).optional(),
        output: z.string().optional(),
        inline: z.boolean().default(true),
      },
    },
    {
      name: 'asset_place',
      description:
        'Place a visual asset in a scene/group/component, or place visual/audio assets on sequence tracks. Shares the editor command and atomic undo history.',
      method: 'assetPlace',
      schema: {
        assetId: z.string(),
        sceneId: z.string().optional(),
        path: z.array(z.string()).max(32).optional(),
        contextFrames: contextFramesSchema.optional(),
        sequenceId: z.string().optional(),
        trackId: z.string().optional(),
        frame: z.number().nonnegative().optional(),
        duration: z.number().int().positive().optional(),
        x: z.number().finite().optional(),
        y: z.number().finite().optional(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        anchor: z.enum(['top-left', 'center']).optional(),
        revision: z.string().optional(),
      },
    },
    {
      name: 'animation_guide',
      description:
        'Read composable animation/effect helpers, frame/second units, examples and current limits before authoring TypeScript animation.',
      method: 'guide',
      schema: {},
    },
    {
      name: 'frame_sample',
      description:
        'Capture 1–12 pinned-revision animation frames as one labeled contact sheet. Use entrance, middle, transition and exit times to check motion, overlap and effect quality.',
      method: 'sample',
      schema: {
        frames: z.array(z.number().nonnegative()).min(1).max(12),
        sceneId: z.string().optional(),
        path: z.array(z.string()).max(32).optional(),
        contextFrames: contextFramesSchema.optional(),
        width: z.number().int().min(160).max(800).default(640),
        output: z.string().optional(),
      },
    },
    {
      name: 'frame_capture',
      description:
        'Render a deterministic frame using the same native core as export; returns an inline image.',
      method: 'frame',
      schema: {
        frame: z.number().nonnegative().default(0),
        width: z.number().int().min(16).max(3840).optional(),
        height: z.number().int().min(16).max(2160).optional(),
        sceneId: z.string().optional(),
        path: z.array(z.string()).max(32).optional(),
        contextFrames: contextFramesSchema.optional(),
        output: z.string().optional(),
      },
    },
    {
      name: 'effect_import_lut',
      description:
        'Parse a local 3D .cube LUT (size 2–33) and append it to a layer effect stack. LUT data is embedded in project JSON so renders remain pinned and portable.',
      method: 'importLut',
      schema: {
        sceneId: z.string(),
        nodeId: z.string(),
        path: z.string(),
        intensity: z.number().min(0).max(1).default(1),
        revision: z.string().optional(),
      },
    },
    {
      name: 'render_start',
      description:
        'Start a cancellable snapshot-based render with checkpoint resume. Supply revision from the accepted candidate to reject an intervening project change.',
      method: 'render',
      schema: {
        output: z.string(),
        format: z.enum(['mp4', 'png', 'wav']).default('mp4'),
        start: z.number().int().nonnegative().optional(),
        end: z.number().int().positive().optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        encoder: z.string().optional(),
        resume: z.boolean().optional(),
        revision: z.string().optional(),
      },
    },
    {
      name: 'render_list',
      description: 'List render jobs and progress.',
      method: 'jobs',
      schema: {},
    },
    {
      name: 'render_status',
      description: 'Read one render job.',
      method: 'job',
      schema: { id: z.string() },
    },
    {
      name: 'render_cancel',
      description: 'Cancel a queued or running render; completed checkpoints are preserved.',
      method: 'cancel',
      schema: { id: z.string() },
    },
    {
      name: 'asset_import',
      description: 'Import a local asset by reference or copy.',
      method: 'import',
      schema: {
        path: z.string(),
        type: z.enum(['image', 'video', 'audio', 'font', 'drawing']),
        copy: z.boolean().default(false),
      },
    },
    {
      name: 'asset_probe',
      description: 'Inspect media streams and duration.',
      method: 'probe',
      schema: { assetId: z.string() },
    },
    {
      name: 'audio_waveform',
      description: 'Read bounded audio peak samples.',
      method: 'waveform',
      schema: { assetId: z.string() },
    },
    {
      name: 'asset_proxy',
      description:
        'Legacy synchronous 960px lossless FFV1 proxy generation/reuse with registered source/FPS checks. For background progress/cancellation, use media_proxy. Proxy preview is explicit; native evidence and export keep originals.',
      method: 'proxy',
      schema: { assetId: z.string() },
    },
    {
      name: 'audio_analyze',
      description:
        'Analyze a bounded local audio range (default 60s, maximum 600s) for RMS/peak, low/mid/high frequency bands and estimated onsets/BPM. Beat estimates are heuristic; components receive features through audioAssetId and ctx.audio in cached 30s windows.',
      method: 'audioAnalyze',
      schema: {
        assetId: z.string(),
        rate: z.number().int().min(5).max(60).default(30),
        start: z.number().nonnegative().default(0),
        duration: z.number().positive().max(600).default(60),
      },
    },
    {
      name: 'project_pack',
      description: 'Collect project source, assets and fonts into another directory.',
      method: 'pack',
      schema: { output: z.string() },
    },
  ];
  return tools.map((tool) => ({
    ...tool,
    plugin: tool.plugin ?? {
      id: 'vmotion.' + (tool.categories?.[0] ?? toolCategories(tool.name)[0] ?? 'core'),
      version: '1.0.0',
      origin: 'builtin',
    },
  }));
}
