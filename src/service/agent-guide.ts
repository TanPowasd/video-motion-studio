import { z } from 'zod';
export const agentGuideSchema = z
  .object({
    topic: z
      .enum([
        'overview',
        'review',
        'animation',
        'effects',
        'editing',
        'sound',
        'performance',
        '3d',
        'math',
        'recovery',
      ])
      .default('overview'),
  })
  .strict();
const workflows = {
  performance: {
    tools: [
      'render_profile',
      'project_context',
      'project_file_read',
      'project_preflight',
      'project_apply',
      'frame_capture',
      'render_start',
    ],
    steps: [
      'Measure scene/sequence/focused frames with render_profile. Separate cold compilation, warm rendering, PNG encoding and IPC using real device/resolution evidence.',
      'Inspect surface allocations/reuses/retained bytes and component compiles/hits. Compilation tracks imports and missing resolution probes; unrelated resources retain valid workers, while changed JSON imports invalidate runtime/type checks.',
      'Repeat frames to detect stateful code. surfacePoolMb=0 offers an explicit allocation baseline with identical pixels and export dimensions. No frame-result cache hides nondeterminism.',
      'Optimize measured bottlenecks and preserve stable IDs/random-seek semantics; preflight/apply the exact candidate. One small benchmark does not prove realtime/4K/two-hour acceptance.',
    ],
    reference: 'docs/PERFORMANCE-TRANSITIONS.md',
  },
  sound: {
    tools: [
      'sound_library',
      'sound_inspect',
      'sound_plan',
      'sound_preview',
      'sound_midi',
      'project_schema',
      'project_preflight',
      'project_apply',
      'audio_preview',
      'render_start',
    ],
    steps: [
      'Query sound_library for local synth/FM/noise/drum/sample presets, then project_schema sound/soundInstrument/soundEffect only when exact fields are needed. Editable score JSON under components/sounds is the source; synthesis contains no model calls.',
      'Compose stable-ID note events in beats/seconds, tempo maps, track gain/pan automation, ordered effects and acyclic buses/sends. Sample instruments reference imported audio/video IDs and explicit second windows; long samples use bounded disk paging.',
      'sound_plan accepts complete scores or short stable-ID track/event edits, transpose/quantize/duplicate, and optional timeline placement. Read locked tracks and duration before placing. Samples are fingerprint-pinned, source code and media stay intact.',
      'Audition sound_preview with the stored planId before applying. It uses the exact candidate and retains effect history from origin when seeking. Inspect fullMix peak/clipping evidence, then preflight/apply the same candidate for one undo. Structural preflight does not replace listening.',
      'Import/export MIDI with sound_midi; read warnings for omitted controls/plugins/effects. Verify audio_preview in the video timeline and export WAV/MP4 with the reviewed revision.',
    ],
    reference: 'docs/SOUND-MUSIC.md',
  },
  review: {
    tools: [
      'project_context',
      'visual_audit',
      'composition_interactions',
      'visual_repair_plan',
      'project_preflight',
      'project_apply',
      'frame_capture',
      'render_start',
      'render_status',
    ],
    steps: [
      'Audit explicit scene frames, including entrances, final poses and adjacent suspected jumps. Findings carry revision-bound IDs and locators with local frames/context frames.',
      'Choose explicit layout intents: fitText grows complete revealed/unrevealed text height using native measurements; move uses canvas or parent coordinates; insideCanvas moves raw content bounds within padding. visual_repair_plan resolves owner scopes from expanded IDs and reports before/after findings without modifying project source.',
      'allKeys preserves existing motion by shifting entire value trajectories; currentKey edits one rounded local-frame pose. Review unresolved overlap/clipping/motion deliberately rather than automatically moving everything.',
      'Preflight the stored candidate for native pictures, visual diagnostics and determinism, then apply unchanged for one undo. Source code stays intact for generated layers.',
      'Pass the applied revision to render_start. An intervening edit causes REVISION_CONFLICT; re-audit before starting a new export. Poll render_status and inspect the result.',
    ],
    reference: 'docs/AGENT-REVIEW.md',
  },
  effects: {
    tools: [
      'visual_templates',
      'visual_plan',
      'render_profile',
      'effect_graph_inspect',
      'effect_graph_plan',
      'particles_inspect',
      'particles_plan',
      'effects_guide',
      'effects_inspect',
      'effects_plan',
      'project_preflight',
      'project_apply',
      'visual_audit',
    ],
    steps: [
      'Read selected layer effect IDs and channels before editing. effects_guide reports schemas only for chosen types.',
      'Use visual_templates for short texture/displacement/light/color recipes, selecting one graph only when needed. visual_plan materializes/reuses editable resources and animates parameters across scopes in one candidate; layerDisplace binds same-parent map IDs. Existing edited resources are preserved. Compare render_profile fieldScan=bounded/full pixel hashes and actual scalar counts for region optimizations.',
      'Use effect_graph_inspect for reachable topology, parameter schemas, resource hashes and selected node values. effect_graph_plan authors branched raster/mix/mask/map pipelines, typed parameter links, sibling inputs and subgraph resources; stable-ID actions edit short patches. Preserve input coordinate spaces and inspect source cycles. resetParams/resetKeys explicitly upgrades obsolete channels.',
      'Use motionBlur/echo on the layer or emitter group to resample its earlier graph/TypeScript, including pure particle births. Use particles_inspect for bounded birth/velocity evidence and particles_plan for a fully parameterized component with exact preflight/apply. Exceeding temporal budgets reports an error; do not silently reduce export dimensions.',
      'Use effects_plan for ordered multi-layer append/update/copy/move/toggle/remove/keys. IDs stay with effects and index channels follow them; copies include current keys.',
      'Spatial effects use layer-local coordinates; choose region explicitly or keep fitToContent for a stable current-content frame. Wipe progress 0/1 is exactly hidden/visible.',
      'Inspect the planned contact sheet and determinism checks, then apply the stored plan unchanged. Generated layers keep source code and persist effect overrides.',
    ],
    reference: 'docs/EFFECT-GRAPHS.md; docs/EFFECTS2D.md; docs/TEMPORAL-PARTICLES.md',
  },
  '3d': {
    tools: [
      'matrix3d',
      'scene3d_render',
      'mesh_generate',
      'mesh_import',
      'mesh_inspect',
      'scene3d_materials',
      'project_preflight',
      'frame_sample',
      'visual_audit',
      'project_apply',
    ],
    steps: [
      'Inspect or plan instance material/light edits with scene3d_materials. Standard materials use smooth normals and GGX metallic/roughness direct lighting; preflight the planId before applying. Model resources remain shared geometry.',
      'Create reusable geometry with mesh_generate or import OBJ through mesh_import. Optional placement fits the camera; preflight/apply the returned planId unchanged. meshSource uses JSON pinned to the project revision; mesh_inspect reports topology and face ranges.',
      'Use matrix3d for model/view/projection and clipped geometry evidence before editing.',
      'Use mat4Compose and hierarchical scene3D instances. Prepare camera matrices once per frame and project vertex batches once per object.',
      'The world is right-handed; matrices are row-major and multiply column vectors. View looks down -Z, rotations use degrees; projection clips all six frustum planes.',
      'Use scene3DLayer for a persistent native depth-buffer scene, which correctly resolves intersecting opaque meshes; use scene3D for separately editable vector faces. scene3d_render returns color/depth/face-ID images and visible pixel picks. Inspect extreme rotations/camera moves, then preflight/apply the exact candidate.',
    ],
    reference: 'docs/MATRIX3D.md',
  },
  animation: {
    tools: [
      'drivers_inspect',
      'drivers_plan',
      'curve_path',
      'motion_templates',
      'motion_plan',
      'project_context',
      'project_file_read',
      'component_parameters',
      'animation_inspect',
      'animation_edit',
      'project_preflight',
      'project_apply',
      'visual_audit',
    ],
    steps: [
      'Use motion_templates for builtin/project parameterized motions, then motion_plan to sequence cues across scene/scoped targets with individual timing offsets and cue bindings. Existing channels are protected unless an explicit collision policy is chosen. Review reported sample coverage and preflight extra scopes when incomplete.',
      'Use drivers_inspect/plan for a combined expression+layout+curve-motion batch. Numeric expressions resolve final property dependencies with value/base for keyframed inputs; layout uses declared boxes and anchors/insets, motionPath uses SVG arc length/tangents. curve_path provides numerical evidence. Preflight after all edits, preserve stable references, and remove config channels explicitly when disabling a driver.',
      'Read IDs and source hashes using project_context, then only the relevant source ranges.',
      'Expose editable parameters; keep component render(ctx) pure and stable IDs across frames.',
      'Batch source/file changes into a candidate. Inspect entrance, motion extremes, transitions and exit; include adjacent frames for jitter.',
      'Use project_preflight with determinism=true; inspect images and diagnostics, then project_apply with the same payload and expectedCandidateRevision.',
    ],
    reference:
      'docs/PROPERTY-DRIVERS.md; docs/AGENT-WORKFLOW.md; docs/KEYFRAMES.md; animation_guide',
  },
  editing: {
    tools: [
      'storyboard_plan',
      'storyboard_inspect',
      'sequence_audit',
      'media_inspect',
      'media_sample',
      'sequence_plan',
      'project_preflight',
      'project_apply',
      'sequence_edit',
      'captions_import',
      'audio_preview',
      'render_start',
      'render_status',
    ],
    steps: [
      'Import media once, then media_inspect/media_sample to inspect real source frames. Times are project-source frames at rational project FPS; sourceOut is exclusive.',
      'Use storyboard_plan for stable chapter/shot/narration documents and generated clip bindings. Cumulative frame/second boundaries avoid per-shot rounding drift; edits replace only the owned generated clips/markers and reject overlap with preserved manual content. Optional operations author scenes/code/sound in the same exact candidate. Read storyboard_inspect with paging for long scripts.',
      'Run sequence_audit on the stored candidate for structural clips and stratified boundary/marker/composite evidence with source object locators. Check sampled/omitted/fullFrameCoverage and findings; a few clear frames do not prove a clear full film. Use audio_preview/audit separately for sound evidence.',
      'Pass assetCheck from source evidence to sequence_plan. Select existing target tracks, source ranges, speeds and append/insert/overwrite. audioTrackId separates linked sound and disables video sound to avoid doubling.',
      'The plan returns exact candidate/apply requests with fixed IDs. Preflight candidate and inspect its contact sheet; submit apply unchanged after it passes. Do not regenerate a reviewed plan.',
      'Use audio_preview for a short mixed range, then render_start. Poll render_status; cancel explicitly when required.',
    ],
    reference: 'docs/AGENT-MEDIA.md; docs/FILM-REMIX.md; docs/AUDIO.md',
  },
  math: {
    tools: ['linear_algebra', 'project_preflight', 'frame_sample', 'visual_audit'],
    steps: [
      'Use linear_algebra for numerical evidence before authoring a mathematical scene. Inspect residualNorm, rank or converged rather than assuming a result is valid.',
      'Import matrixMultiply/matrixLU/leastSquares/preparePointTransform/conjugateGradient from @vmotion/sdk. Factor constant matrices and prepare point transforms outside render(ctx).',
      'Matrices are row-major; vectors are columns; A*B applies B first. Native affine coefficients [a,b,c,d,e,f] correspond to [[a,c,e],[b,d,f]].',
      'Use optimization steps as deterministic animation data. Check representative native frames; expose time, basis and target values as component parameters.',
    ],
    reference: 'docs/LINEAR-ALGEBRA.md',
  },
  recovery: {
    tools: [
      'project_context',
      'project_file_read',
      'project_preflight',
      'project_apply',
      'project_resolve_conflict',
      'project_undo',
    ],
    steps: [
      'If pendingFiles is true, read version=pending and repair using hash-checked file edits with version=pending.',
      'Resolve reported conflicts before unrelated changes. Never silently overwrite future project formats.',
      'On REVISION_CONFLICT reread context. On FILE_HASH_CONFLICT reread the file. On ASSET_CHANGED resample media. On CANDIDATE_REVISION recheck the exact operations and files.',
      'Preflight errors save nothing; repair the candidate, obtain new evidence, then commit once. Undo uses the same shared history.',
    ],
    reference: 'docs/AGENT-WORKFLOW.md',
  },
};
export function agentGuide(raw: unknown = {}) {
  const { topic } = agentGuideSchema.parse(raw);
  return {
    protocolVersion: 1,
    aiIntegration: false,
    topic,
    defaults: {
      units: 'frames unless a field says seconds/samples',
      revision: 'project_context.revision',
      sourceAuthority: 'scene/sequence JSON and component TypeScript',
      commit: 'preflight, inspect, exact apply, one undo',
    },
    discovery: {
      initialTools: 10,
      availableCapabilities: 102,
      search:
        'tools_search returns paginated capability summaries; tool_schema returns one exact interface.',
      invoke:
        'Use tool_call {name,arguments} for any capability, even when absent from tools/list. Returns structured JSON/native media; response=full requests legacy data.',
      load: 'Use categories returned by tools_search or names from workflow.tools with tools_load to enable direct tools; replace unloads optional tools. Guide topics are not always category names. Use tool_call when your client does not refresh tool lists.',
      cli: 'vmotion tools-search / tool-schema / tool-call; vmotion mcp --tools all exposes all direct tools for legacy clients.',
    },
    ...(topic === 'overview'
      ? {
          routing: Object.entries(workflows).map(([name, workflow]) => ({
            topic: name,
            tools: workflow.tools,
          })),
          start:
            'Use project_context for the current project, then agent_guide for the topic (3d for matrix scenes). Find tools with tools_search, read individual schemas with tool_schema, and invoke with tool_call. Load direct tools only when useful.',
        }
      : { workflow: workflows[topic] }),
  };
}
