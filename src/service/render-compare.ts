import path from 'node:path';
import { z } from 'zod';
import { renderProfileSchema, profileRendering } from './render-profile.js';
import { checkAssets, type AssetCheck } from './media-evidence.js';
import { fingerprint } from '../media/ffmpeg.js';
import { soundResource } from '../media/sound-source.js';
import { VmotionError, type Snapshot } from '../core/model.js';
import { hash } from './project.js';
const settings = z
  .object({
    graphOptimize: z.boolean().optional(),
    graphRegions: z.boolean().optional(),
    graphTileRows: z.number().int().min(0).max(512).optional(),
    graphCache: z.boolean().optional(),
    nativeCache: z.boolean().optional(),
  })
  .strict();
type DetailedProfile = Extract<Awaited<ReturnType<typeof profileRendering>>, { samples: unknown }>;
export const renderCompareSchema = renderProfileSchema
  .omit({
    graphOptimize: true,
    graphRegions: true,
    graphTileRows: true,
    graphDetail: true,
    graphNodeLimit: true,
  })
  .extend({
    baseline: settings.default({}),
    optimized: settings.default({}),
    order: z.enum(['baseline-first', 'optimized-first']).default('baseline-first'),
    nodeLimit: z.number().int().min(1).max(32).default(8),
  })
  .strict();
export async function compareRendering(root: string, snapshot: Snapshot, raw: unknown) {
  const p = renderCompareSchema.parse(raw);
  if (p.revision && p.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before paired rendering');
  const checks: AssetCheck[] = [];
  // Fingerprint metadata in bounded batches; retain no source/media buffers.
  for (let offset = 0; offset < snapshot.project.assets.length; offset += 16) {
    const batch = await Promise.all(
      snapshot.project.assets.slice(offset, offset + 16).map(async (asset) => {
        try {
          return {
            assetId: asset.id,
            fingerprint: asset.soundSource
              ? `source:${soundResource(snapshot, asset).hash}`
              : await fingerprint(path.resolve(root, asset.path)),
          };
        } catch {
          throw new VmotionError('ASSET_CHANGED', 'Comparison asset is unavailable', {
            assetId: asset.id,
          });
        }
      }),
    );
    checks.push(...batch);
  }
  const { baseline, optimized, order, nodeLimit, detail, ...common } = p,
    configurations = {
      baseline: { graphOptimize: false, graphRegions: false, graphTileRows: 0, ...baseline },
      optimized: { graphOptimize: true, graphRegions: true, graphTileRows: 128, ...optimized },
    },
    results = {} as Record<'baseline' | 'optimized', DetailedProfile>;
  for (const name of order === 'baseline-first'
    ? (['baseline', 'optimized'] as const)
    : (['optimized', 'baseline'] as const)) {
    await checkAssets(root, snapshot, checks);
    const profile = await profileRendering(root, snapshot, {
      ...common,
      ...configurations[name],
      detail: true,
      graphDetail: true,
      graphNodeLimit: nodeLimit,
    });
    if (!('samples' in profile))
      throw new VmotionError('RENDER_COMPARE', 'Detailed comparison evidence is missing');
    results[name] = profile;
    await checkAssets(root, snapshot, checks);
  }
  const a = results.baseline,
    b = results.optimized,
    pairs = a.samples!.map((sample, i) => ({
      frame: sample.frame,
      round: sample.round,
      match: sample.pixelHash === b.samples![i].pixelHash,
      baselineHash: sample.pixelHash,
      optimizedHash: b.samples![i].pixelHash,
    })),
    mismatches = pairs.filter((row) => !row.match),
    evidence = (profile: typeof a) => ({
      summary: profile.summary,
      graph: profile.cache.graphExecution,
      compilation: profile.cache.effectGraphs,
      nativeAnimation: profile.cache.nativeAnimation,
      surfaces: profile.cache.surfaces,
      graphScratchPeakBytes: profile.cache.graphScratchPeakBytes,
      graphNodes: profile.graphNodes,
      determinism: profile.determinism,
      ...(detail
        ? {
            samples: profile.samples!.map((s) => ({
              frame: s.frame,
              round: s.round,
              renderMs: s.renderMs,
              pixelHash: s.pixelHash,
            })),
          }
        : {}),
    }),
    before = a.summary.warmMeanMs ?? a.summary.meanRenderMs!,
    after = b.summary.warmMeanMs ?? b.summary.meanRenderMs!;
  return {
    revision: snapshot.revision,
    scope: a.scope,
    width: a.width,
    height: a.height,
    frames: p.frames,
    repeat: p.repeat,
    order,
    configurations,
    equivalence: {
      compared: pairs.length,
      mismatches: mismatches.length,
      matched:
        mismatches.length === 0 &&
        a.determinism.mismatchFrames.length === 0 &&
        b.determinism.mismatchFrames.length === 0,
      ...(detail ? { pairs } : { mismatchFrames: [...new Set(mismatches.map((r) => r.frame))] }),
    },
    assets: {
      checked: checks.length,
      fingerprintDigest: hash(JSON.stringify(checks)),
      kind: 'Size/mtime metadata or pinned editable sound source hash; checks before/after both runs',
    },
    baseline: evidence(a),
    optimized: evidence(b),
    difference: {
      basis: a.summary.warmMeanMs !== null ? 'warmMeanMs' : 'meanRenderMs',
      beforeMs: before,
      afterMs: after,
      savedMs: before - after,
      savedRatio: before > 0 ? 1 - after / before : null,
    },
    coverage: {
      frames: p.frames.length,
      rounds: p.repeat,
      graphTrackingLimit: 256,
      baselineOmittedExecutions: a.graphNodes?.omittedExecutions ?? 0,
      optimizedOmittedExecutions: b.graphNodes?.omittedExecutions ?? 0,
    },
    interpretation:
      'Paired sampled evidence on one project snapshot. Includes graph tracing; excludes PNG/hash/IPC. Timing is local and order/device/load dependent. Asset checks are metadata, not cryptographic proof of media contents. Matching samples do not prove an unsampled trajectory or realtime/4K acceptance.',
  };
}
