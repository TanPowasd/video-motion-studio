import { trackingAnalyzeSchema } from '../service/tracking-jobs.js';
import {
  trackingInspectSchema,
  trackingPlanSchema,
  trackingEvidenceSchema,
  inspectTracking,
  planTracking,
  trackingEvidence,
} from '../service/tracking.js';
import { VmotionError } from '../core/model.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import type { BuiltinPluginModule } from './types.js';
export const trackingPlugin: BuiltinPluginModule = {
  id: 'vmotion.tracking',
  name: '运动跟踪与稳定',
  version: '1.0.0',
  dependencies: { 'vmotion.media': '^1.0.0' },
  methods: new Set(['trackingAnalyze', 'trackingInspect', 'trackingPlan', 'trackingEvidence']),
  tools(): ToolDefinition[] {
    return [
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
    ];
  },
  async dispatch(host, method, params) {
    switch (method) {
      case 'trackingAnalyze': {
        const p = trackingAnalyzeSchema.parse(params);
        if (p.action === 'status') return host.tracking.status(p.id);
        if (p.action === 'cancel') {
          if (!p.id) throw new VmotionError('TRACKING_JOB', 'Cancel requires a job ID');
          return host.tracking.cancel(p.id);
        }
        if (!p.request)
          throw new VmotionError('TRACKING_REQUEST', 'Start requires an analysis request');
        const job = host.tracking.start(host.snapshot, p.request);
        return p.wait ? host.tracking.wait(job.id) : job;
      }
      case 'trackingInspect':
        return inspectTracking(host.root, host.snapshot, params);
      case 'trackingPlan':
        return planTracking(
          host.root,
          host.renderer,
          structuredClone(host.snapshot),
          params,
          host.edit,
        );
      case 'trackingEvidence':
        return host.withMediaTask(() =>
          trackingEvidence(host.root, structuredClone(host.snapshot), params),
        );
      default:
        throw new VmotionError('METHOD_NOT_FOUND', 'Tracking module does not handle this method', {
          method,
        });
    }
  },
};
