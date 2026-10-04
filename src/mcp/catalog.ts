import { z } from 'zod';
import { structureActionSchema } from '../core/structure.js';
import { drawingOperationSchema } from '../core/drawing-model.js';
import { contextOptionsSchema, fileReadSchema } from '../service/agent.js';
import { preflightSchema } from '../service/preflight.js';
import { parameterEditSchema } from '../service/component-parameters.js';
import { animationEditSchema, animationInspectSchema } from '../service/animation.js';
import { audioRangeSchema } from '../media/audio-preview.js';
import { visualAuditSchema } from '../service/visual-audit.js';
import { visualRepairSchema } from '../service/visual-repair.js';
import { motionTemplatesSchema, motionPlanSchema } from '../service/motion-plan.js';
import { particlesInspectSchema, particlesPlanSchema } from '../service/particle-field.js';
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
import { linearAlgebraSchema } from '../service/linear-algebra.js';
import { agentGuideSchema } from '../service/agent-guide.js';
import { matrix3dSchema } from '../service/matrix3d.js';
import { scene3dRenderSchema } from '../service/scene3d.js';
import { meshGenerateSchema, meshImportSchema, meshInspectSchema } from '../service/meshes.js';
import { scene3dMaterialsSchema } from '../service/materials3d.js';
import {
  effectGuideSchema,
  effectsInspectSchema,
  effectsPlanSchema,
} from '../service/effects2d.js';

export interface ToolDefinition {
  name: string;
  description: string;
  method: string;
  schema: Record<string, z.ZodTypeAny>;
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
      name: 'motion_templates',
      description:
        'List builtin and project JSON motion templates with numeric parameter descriptors, schemas, compatible types and channel summaries. Request includeTemplate for reusable normalized keys. Application compiles cues to editable native channels; JSON resources are pinned to project revision.',
      method: 'motionTemplates',
      schema: motionTemplatesSchema.shape,
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
      name: 'effects_guide',
      description:
        'Read concise 2D effect types/fields, units, coordinate spaces and composition workflow. Query individual types with schema=true for exact interfaces, including wave/twirl/bulge/RGB split/linear/radial wipe and existing color/glow stacks.',
      method: 'effectsGuide',
      schema: effectGuideSchema.shape,
    },
    {
      name: 'effects_inspect',
      description:
        'Inspect explicit effect stack IDs/indices, values, enabled flags, numeric channels and current-frame evaluation for selected layers in any group/component/reference scope. No project source dump; legacy blur/color/shadow controls are reported separately.',
      method: 'effectsInspect',
      schema: effectsInspectSchema.shape,
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
      name: 'matrix3d',
      description:
        'Evaluate 4x4 model/view/projection matrices, perspective/orthographic cameras, batch vertices or hierarchical shaded mesh faces. Returns matrices, clip visibility, depth, geometry bounds and paginated stable face IDs for agent inspection. SDK scene3D/mesh3D convert the same clipped, globally depth-sorted geometry into native path layers. Convex planar faces, flat directional lighting; no z-buffer/textures/PBR.',
      method: 'matrix3d',
      schema: { request: matrix3dSchema },
    },
    {
      name: 'agent_guide',
      description:
        'Concise workflow routing for external agents: overview, animation, editing, 3d, math or recovery. Tool names, units, evidence/commit steps and retry guidance; no source or large schemas dumped. Start here, then project_context.',
      method: 'agentGuide',
      schema: agentGuideSchema.shape,
    },
    {
      name: 'linear_algebra',
      description:
        'Deterministic numerical operations for math animation: multiply/transpose/inverse/determinant, scaled-pivot LU solve with residual, pivoted QR least squares, batch affine/homogeneous point transforms, and conjugate-gradient quadratic optimization with optional iteration trace. Row-major matrices, column vectors; bounded to 128 dimensions. Singular/rank-deficient inputs return diagnostics. SDK has reusable LU and prepared point transforms.',
      method: 'linearAlgebra',
      schema: { request: linearAlgebraSchema },
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
      description: 'Generate a local 960px proxy video.',
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
  return tools;
}
