import path from 'node:path';
import { z } from 'zod';
import { renderProfileSchema, profileRendering } from '../service/render-profile.js';
import { VmotionError } from '../core/model.js';
import type { RenderOptions, RenderJob } from '../media/export.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import type { BuiltinPluginModule } from './types.js';

const renderStatus = z.enum(['queued', 'running', 'completed', 'cancelled', 'failed']);
export const renderQuerySchema = z
  .object({
    ids: z.array(z.string().min(1).max(200)).max(100).optional(),
    statuses: z.array(renderStatus).max(5).optional(),
    revision: z.string().optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(20),
    order: z.enum(['newest', 'oldest']).default('newest'),
    detail: z.boolean().default(false),
  })
  .strict();

export function queryRenderJobs(jobs: ReadonlyMap<string, RenderJob>, raw: unknown) {
  const request = renderQuerySchema.parse(raw),
    all = [...jobs.values()];
  for (const id of request.ids ?? [])
    if (!jobs.has(id))
      throw new VmotionError('NOT_FOUND', 'Requested render job is missing', { id });
  const selected = all.filter(
    (job) =>
      (!request.ids || request.ids.includes(job.id)) &&
      (!request.statuses || request.statuses.includes(job.status)) &&
      (!request.revision || request.revision === job.revision),
  );
  if (request.order === 'newest') selected.reverse();
  const page = selected.slice(request.offset, request.offset + request.limit);
  return {
    total: selected.length,
    offset: request.offset,
    nextOffset:
      request.offset + page.length < selected.length ? request.offset + page.length : undefined,
    counts: Object.fromEntries(
      renderStatus.options.map((status) => [
        status,
        all.filter((job) => job.status === status).length,
      ]),
    ),
    items: page.map((job) =>
      request.detail
        ? { ...job }
        : {
            id: job.id,
            status: job.status,
            revision: job.revision,
            stage: job.stage,
            progress: job.progress,
            frame: job.frame,
            totalFrames: job.totalFrames,
            hasError: !!job.error,
          },
    ),
    detail: request.detail,
    order: request.order,
  };
}

export const renderPlugin: BuiltinPluginModule = {
  id: 'vmotion.render',
  name: '渲染、性能与导出',
  version: '1.0.0',
  dependencies: { 'vmotion.effects': '^1.0.0', 'vmotion.audio': '^1.0.0' },
  methods: new Set(['renderProfile', 'render', 'jobs', 'job', 'cancel', 'renderQuery']),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'render_query',
        method: 'renderQuery',
        schema: renderQuerySchema.shape,
        description:
          'Read paged compact render progress by task IDs, statuses and project revision, with queue counts and explicit nextOffset. Defaults to 20 summaries without output paths or full error text; detail=true or render_status reads full evidence. Legacy render_list is unchanged.',
        categories: ['render'],
        keywords: '渲染 任务 查询 分页 队列 进度 取消 checkpoint export job progress',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'render_profile',
        method: 'renderProfile',
        schema: renderProfileSchema.shape,
        description:
          'Measure real cold/warm render performance for scene/sequence/focused frames or an exact candidate. Returns wall-clock rendering/optional PNG encoding, component compilation hits, bounded surface-pool reuse/memory, native evaluation work and repeated-frame pixel hashes. Compact summaries by default; detail opts into per-round records. Does not lower export quality or hide nondeterministic code behind a frame cache.',
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
    ];
  },
  async dispatch(host, method, params) {
    switch (method) {
      case 'renderProfile': {
        const snapshot = await host.candidateSnapshot(params);
        return host.withMediaTask(() =>
          profileRendering(host.root, snapshot, { ...params, revision: snapshot.revision }),
        );
      }
      case 'render': {
        const { pendingFiles, diagnostics } = host.exportState();
        if (pendingFiles || diagnostics.some((d) => d.severity === 'error'))
          throw new VmotionError(
            'VALIDATION_FAILED',
            'Fix project diagnostics before exporting; the last valid preview is preserved',
            diagnostics,
          );
        return host.renders.start(host.snapshot, {
          output: path.resolve(
            params.output ?? path.join(host.root, 'exports', host.snapshot.project.name + '.mp4'),
          ),
          format: params.format ?? 'mp4',
          start: params.start,
          end: params.end,
          width: params.width,
          height: params.height,
          encoder: params.encoder,
          resume: params.resume,
          revision: params.revision,
        } as RenderOptions);
      }
      case 'jobs':
        return Array.from(host.renders.jobs.values());
      case 'renderQuery':
        return queryRenderJobs(host.renders.jobs, params);
      case 'job': {
        const job = host.renders.jobs.get(params.id);
        if (!job) throw new VmotionError('NOT_FOUND', 'Job not found');
        return job;
      }
      case 'cancel':
        return host.renders.cancel(params.id);
      default:
        throw new VmotionError('METHOD_NOT_FOUND', 'Render module does not handle this method', {
          method,
        });
    }
  },
};
