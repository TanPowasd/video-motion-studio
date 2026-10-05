import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createCanvas } from '@napi-rs/canvas';
import { Renderer } from '../core/renderer.js';
import { visualAudit, visualAuditSchema } from '../service/visual-audit.js';
import { planVisualRepair, visualRepairSchema } from '../service/visual-repair.js';
import { atomicWrite, safePath } from '../service/project.js';
import { contextFramesSchema } from '../core/content-time.js';
import { VmotionError } from '../core/model.js';
import { z } from 'zod';
import { builtinCandidate } from './candidate.js';
import type { BuiltinPluginModule } from './types.js';
import type { ToolDefinition } from '../mcp/catalog.js';
export const reviewPlugin: BuiltinPluginModule = {
  id: 'vmotion.review',
  name: '画面检查与修复',
  version: '1.0.0',
  dependencies: { 'vmotion.render': '^1.0.0' },
  methods: new Set(['visualAudit', 'visualRepairPlan', 'sample', 'frame']),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'visual_audit',
        description:
          'Inspect a scene/group/component across sampled frames for definite text truncation and review hints: text canvas overflow, clipping, overlap, opaque-rectangle coverage and fast/jumping motion. Returns stable IDs, owner paths, times, thresholds, limitations and annotated native frame evidence. Geometry hints require visual judgement and do not modify project/history.',
        method: 'visualAudit',
        schema: visualAuditSchema.omit({ inline: true }).shape,
      },
      {
        name: 'visual_repair_plan',
        description:
          'Plan explicit batch layout repairs from inspected stable layer IDs: fit full text height using native layout, move in canvas/parent coordinates, or place inside a padded canvas. Preserves entire key trajectories by default; currentKey edits a pose. Resolves generated layer scopes automatically, keeps component source intact, audits before/after and returns an exact stored candidate for preflight/apply and one undo. Does not guess artistic fixes for overlap, clipping or motion.',
        method: 'visualRepairPlan',
        schema: visualRepairSchema.shape,
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
    ];
  },
  async dispatch(host, method, params) {
    switch (method) {
      case 'visualAudit':
        return host.withMediaTask(() =>
          visualAudit(host.root, structuredClone(host.snapshot), params),
        );
      case 'visualRepairPlan': {
        const snapshot = structuredClone(host.snapshot),
          planned = await planVisualRepair(
            host.root,
            host.renderer,
            snapshot,
            params,
            (candidate, edits) => host.edit(candidate, params.sceneId, params.frame ?? 0, edits),
          ),
          input = {
            revision: snapshot.revision,
            operations: planned.operations,
            samples: planned.samples,
            visual: true,
            determinism: true,
            width: 320,
          };
        return builtinCandidate(
          host.root,
          input,
          planned.candidate.revision,
          planned.request.delivery,
          {
            changes: planned.changes,
            before: {
              summary: planned.before.summary,
              findings: planned.before.findings,
              diagnostics: planned.before.diagnostics,
            },
            after: {
              summary: planned.after.summary,
              findings: planned.after.findings,
              diagnostics: planned.after.diagnostics,
            },
            limitations: planned.limitations,
          },
        );
      }
      case 'frame': {
        const { buffer, revision, frame } = await host.frame(params),
          output = path.resolve(
            params.output ?? safePath(host.root, `.vmotion/frames/frame-${params.frame ?? 0}.png`),
          );
        await atomicWrite(output, buffer);
        return {
          output,
          revision,
          frame,
          mimeType: 'image/png',
          ...(params.inline ? { data: buffer.toString('base64') } : {}),
        };
      }
      case 'sample': {
        if (
          !Array.isArray(params.frames) ||
          !params.frames.length ||
          params.frames.length > 12 ||
          params.frames.some((n: unknown) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)
        )
          throw new VmotionError('SAMPLE_FRAMES', 'Expected 1–12 finite nonnegative frame numbers');
        return host.withMediaTask(async () => {
          const snapshot = structuredClone(host.snapshot),
            renderer = new Renderer(host.root),
            width = Math.round(params.width ?? 640),
            height = Math.round((width * snapshot.project.height) / snapshot.project.width);
          if (width < 160 || width > 800) {
            await renderer.close();
            throw new VmotionError('SAMPLE_SIZE', 'Contact-sheet frame width must be 160–800px');
          }
          const columns = Math.min(4, params.frames.length),
            sheet = createCanvas(
              columns * width,
              Math.ceil(params.frames.length / columns) * (height + 30),
            ),
            ctx = sheet.getContext('2d');
          ctx.fillStyle = '#151a26';
          ctx.fillRect(0, 0, sheet.width, sheet.height);
          const samples: Array<{ frame: number; seconds: number; elapsedMs: number }> = [];
          try {
            for (const [index, frame] of params.frames.entries()) {
              const start = performance.now(),
                image = await renderer.render(snapshot, frame, {
                  width,
                  height,
                  sceneId: params.sceneId,
                  path: params.path,
                  contextFrames: params.contextFrames,
                }),
                x = (index % columns) * width,
                y = Math.floor(index / columns) * (height + 30);
              ctx.drawImage(image, x, y);
              ctx.font = '14px "Microsoft YaHei"';
              ctx.fillStyle = '#c3ccdf';
              const seconds = (frame * snapshot.project.fps.den) / snapshot.project.fps.num;
              ctx.fillText(`${frame}f · ${seconds.toFixed(2)}s`, x + 10, y + height + 8);
              samples.push({ frame, seconds, elapsedMs: performance.now() - start });
            }
            const buffer = await sheet.encode('png'),
              output = path.resolve(
                params.output ?? safePath(host.root, `.vmotion/frames/sample-${randomUUID()}.png`),
              );
            await atomicWrite(output, buffer);
            return {
              output,
              revision: snapshot.revision,
              samples,
              mimeType: 'image/png',
              ...(params.inline ? { data: buffer.toString('base64') } : {}),
            };
          } finally {
            await renderer.close();
          }
        });
      }
      default:
        throw new VmotionError('METHOD_NOT_FOUND', 'Review module does not handle this method', {
          method,
        });
    }
  },
};
