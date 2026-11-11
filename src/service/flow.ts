import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import {
  sceneSchema,
  sequenceSchema,
  VmotionError,
  type Operation,
  type Project,
  type Scene,
  type Sequence,
  type Snapshot,
} from '../core/model.js';
import type { FileEdit } from '../core/file-edits.js';
import {
  flowDocumentSchema,
  flowIdSchema,
  flowNodeIdSchema,
  flowNodeSchema,
  flowSoundBedSchema,
  type FlowNode,
} from '../core/flow-schema.js';
import {
  compileFlow,
  compileSingleFlowNode,
  diffFlowCompilations,
  FLOW_TRACK_PREFIX,
  flowNodesDir,
  isVirtualFlowSceneFile,
  resolveFlowBundle,
  type CompiledFlowResult,
} from '../core/flow-compiler.js';
import {
  applyTimelineEditToFlow,
  defaultFlowPath,
  packFlowToSingleFile,
  sequenceToSplitFlow,
  splitFlowToFiles,
  writeNodeToBundleFiles,
  type TimelineFlowEdit,
} from '../core/flow-edit.js';
import { hash, json, validateSnapshot } from './project.js';
import { applyOperations } from './operations.js';
import { builtinCandidate } from '../plugins/candidate.js';
import type { BuiltinPluginHost } from '../plugins/types.js';

function baseProjectScenes(snapshot: Snapshot): Scene[] {
  return snapshot.scenes.filter((_, i) => !isVirtualFlowSceneFile(snapshot.project.scenes[i]));
}

export function discoverFlows(snapshot: Snapshot) {
  const mountedByFlow = new Map<string, string[]>();
  for (const seq of snapshot.sequences) {
    if (!seq.flowSource) continue;
    const list = mountedByFlow.get(seq.flowSource) ?? [];
    list.push(seq.id);
    mountedByFlow.set(seq.flowSource, list);
  }
  const flows: Array<{
    flowPath: string;
    id: string;
    name: string;
    split: boolean;
    spineCount: number;
    overlayCount: number;
    draftCount: number;
    mountedSequences: string[];
  }> = [];

  for (const [file, content] of Object.entries(snapshot.files).sort(([a], [b]) =>
    a.localeCompare(b, 'en'),
  )) {
    if (!file.startsWith('components/') || !file.endsWith('.json')) continue;
    if (file.includes('/nodes/') || file.endsWith('.workflow.json')) continue;
    try {
      const parsed = JSON.parse(content);
      if (parsed?.kind !== 'flow') continue;
      const bundle = resolveFlowBundle(
        snapshot.files,
        file,
        snapshot.project,
        baseProjectScenes(snapshot),
      );
      flows.push({
        flowPath: file,
        id: bundle.document.id,
        name: bundle.document.name,
        split: bundle.split,
        spineCount: bundle.document.spine.length,
        overlayCount: bundle.document.overlays.length,
        draftCount: bundle.draftNodeIds.length,
        mountedSequences: mountedByFlow.get(file) ?? [],
      });
    } catch {
      // Invalid flow files are surfaced by project_diagnostics / validateSnapshot.
    }
  }
  return flows;
}

export function resolveTargetFlowPath(
  snapshot: Snapshot,
  flowPath?: string,
  sequenceId?: string,
): { flowPath: string; sequence?: Sequence } {
  if (flowPath) {
    const normalized = flowPath.replace(/\\/g, '/');
    const seq = sequenceId
      ? snapshot.sequences.find((s) => s.id === sequenceId)
      : snapshot.sequences.find((s) => s.flowSource === normalized);
    return { flowPath: normalized, sequence: seq };
  }
  const targetSeqId = sequenceId ?? snapshot.project.activeSequence;
  const seq = snapshot.sequences.find((s) => s.id === targetSeqId);
  if (seq?.flowSource) {
    return { flowPath: seq.flowSource, sequence: seq };
  }
  const all = discoverFlows(snapshot);
  if (all.length === 1) {
    return { flowPath: all[0].flowPath, sequence: seq };
  }
  throw new VmotionError(
    'FLOW_NOT_FOUND',
    all.length === 0
      ? 'No flow resource exists in this project yet; use flow_plan with op="init" or op="fromSequence"'
      : `Multiple flows exist (${all.map((f) => f.flowPath).join(', ')}); pass flowPath explicitly`,
    { availableFlows: all.map((f) => f.flowPath) },
  );
}

function summarizeNode(node: FlowNode): string {
  if (node.type === 'shot') {
    const vis =
      node.visual.kind === 'scene'
        ? `scene:${node.visual.sceneId}`
        : node.visual.kind === 'component'
          ? `component:${node.visual.source}`
          : node.visual.kind === 'asset'
            ? `asset:${node.visual.assetId}`
            : `workflow(${node.visual.modality}):${node.visual.workflow}${node.visual.bakedAssetId ? `->${node.visual.bakedAssetId}` : ' [pending]'}`;
    const voice = !node.voice
      ? ''
      : node.voice.kind === 'asset'
        ? ` + voice:${node.voice.assetId}`
        : ` + tts(${node.voice.provider})${node.voice.bakedAssetId ? `->${node.voice.bakedAssetId}` : ' [est]'}`;
    return `${vis} [${node.timing.mode}]${voice}`;
  }
  if (node.type === 'transcript-cut') {
    const kept = node.segments.filter((s) => !s.cut).length;
    return `transcript:${node.assetId} (${kept}/${node.segments.length} kept)`;
  }
  if (node.type === 'beat-cut') {
    return `beat-cut:${node.soundAssetId} (${node.items.length} cuts, every ${node.beatsPerCut} beat(s))`;
  }
  return `broll->${node.anchor.nodeId}${node.anchor.segmentId ? `#${node.anchor.segmentId}` : ''} (+${node.anchor.offsetSeconds}s)`;
}

export const flowOutlineSchema = z
  .object({
    flowPath: z.string().min(1).max(300).optional(),
    sequenceId: z.string().min(1).max(200).optional(),
    listAll: z.boolean().default(false),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(200).default(50),
    includeVariables: z.boolean().default(true),
  })
  .strict();

export function flowOutline(snapshot: Snapshot, raw: unknown) {
  const req = flowOutlineSchema.parse(raw ?? {});
  const allFlows = discoverFlows(snapshot);
  if (req.listAll || (!req.flowPath && !req.sequenceId && allFlows.length === 0)) {
    return {
      revision: snapshot.revision,
      flows: allFlows,
      totalFlows: allFlows.length,
    };
  }
  const { flowPath } = resolveTargetFlowPath(snapshot, req.flowPath, req.sequenceId);
  const baseScenes = baseProjectScenes(snapshot);
  const bundle = resolveFlowBundle(snapshot.files, flowPath, snapshot.project, baseScenes);
  const compiled = compileFlow(bundle, {
    project: snapshot.project,
    scenes: baseScenes,
    files: snapshot.files,
  });
  const placementMap = new Map(compiled.placements.map((p) => [p.nodeId, p]));
  const orderedIds = [
    ...bundle.document.spine,
    ...bundle.document.overlays,
    ...bundle.draftNodeIds,
  ];
  const pageIds = orderedIds.slice(req.offset, req.offset + req.limit);
  let unbakedVisual = 0;
  let unbakedVoice = 0;
  for (const e of bundle.entries.values()) {
    if (e.unbaked.visual) unbakedVisual++;
    if (e.unbaked.voice) unbakedVoice++;
  }

  return {
    revision: snapshot.revision,
    flowPath: bundle.flowPath,
    flowId: bundle.document.id,
    name: bundle.document.name,
    split: bundle.split,
    nodesDir: bundle.nodesDir,
    mountedSequences: snapshot.sequences
      .filter((s) => s.flowSource === bundle.flowPath)
      .map((s) => s.id),
    durationFrames: compiled.durationFrames,
    durationSeconds: compiled.durationSeconds,
    counts: {
      total: orderedIds.length,
      spine: bundle.document.spine.length,
      overlays: bundle.document.overlays.length,
      drafts: bundle.draftNodeIds.length,
      unbakedVisual,
      unbakedVoice,
    },
    ...(bundle.document.soundBed
      ? {
          soundBed: {
            assetId: bundle.document.soundBed.assetId,
            volume: bundle.document.soundBed.volume,
            ducking: Boolean(bundle.document.soundBed.ducking?.enabled),
          },
        }
      : {}),
    ...(req.includeVariables ? { variables: bundle.document.variables } : {}),
    offset: req.offset,
    hasMore: req.offset + pageIds.length < orderedIds.length,
    items: pageIds.map((id) => {
      const entry = bundle.entries.get(id)!;
      const placement = placementMap.get(id);
      return {
        id,
        role: entry.role,
        type: entry.node.type,
        name: entry.node.name ?? id,
        enabled: entry.node.enabled,
        ...(entry.node.chapter ? { chapter: entry.node.chapter } : {}),
        file: entry.file,
        ...(placement
          ? {
              startSeconds: Number(placement.startSeconds.toFixed(3)),
              endSeconds: Number(placement.endSeconds.toFixed(3)),
              startFrame: placement.startFrame,
              durationFrames: placement.durationFrames,
            }
          : {}),
        contentHash: entry.contentHash,
        unbaked: entry.unbaked,
        summary: summarizeNode(entry.node),
      };
    }),
  };
}

export const flowFocusSchema = z
  .object({
    flowPath: z.string().min(1).max(300).optional(),
    sequenceId: z.string().min(1).max(200).optional(),
    nodeId: flowNodeIdSchema.optional(),
    atFrame: z.number().int().nonnegative().optional(),
    atSeconds: z.number().finite().nonnegative().optional(),
    neighbors: z.number().int().min(0).max(3).default(1),
  })
  .strict();

export function flowFocus(snapshot: Snapshot, raw: unknown) {
  const req = flowFocusSchema.parse(raw ?? {});
  const { flowPath } = resolveTargetFlowPath(snapshot, req.flowPath, req.sequenceId);
  const baseScenes = baseProjectScenes(snapshot);
  const bundle = resolveFlowBundle(snapshot.files, flowPath, snapshot.project, baseScenes);
  const compiled = compileFlow(bundle, {
    project: snapshot.project,
    scenes: baseScenes,
    files: snapshot.files,
  });

  let targetId = req.nodeId;
  let querySeconds: number | undefined = req.atSeconds;
  if (!targetId) {
    if (req.atFrame !== undefined) {
      querySeconds = (req.atFrame * snapshot.project.fps.den) / snapshot.project.fps.num;
    }
    if (querySeconds !== undefined) {
      const spineHit = compiled.placements.find(
        (p) => p.role === 'spine' && querySeconds! >= p.startSeconds && querySeconds! < p.endSeconds,
      );
      const anyHit =
        spineHit ??
        compiled.placements.find(
          (p) => querySeconds! >= p.startSeconds && querySeconds! <= p.endSeconds,
        ) ??
        compiled.placements.at(-1);
      targetId = anyHit?.nodeId;
    } else {
      targetId = bundle.document.spine[0] ?? bundle.document.overlays[0] ?? bundle.draftNodeIds[0];
    }
  }
  if (!targetId) {
    throw new VmotionError('FLOW_EMPTY', `Flow "${flowPath}" has no nodes to focus`, { flowPath });
  }
  const entry = bundle.entries.get(targetId);
  if (!entry) {
    throw new VmotionError('FLOW_MISSING_NODE', `Flow node "${targetId}" does not exist`, {
      flowPath,
      nodeId: targetId,
    });
  }
  const placement = compiled.placements.find((p) => p.nodeId === targetId);
  const spineIdx = bundle.document.spine.indexOf(targetId);
  const prevIds =
    spineIdx > 0
      ? bundle.document.spine.slice(Math.max(0, spineIdx - req.neighbors), spineIdx)
      : [];
  const nextIds =
    spineIdx >= 0
      ? bundle.document.spine.slice(spineIdx + 1, spineIdx + 1 + req.neighbors)
      : [];

  const anchoredOverlays = bundle.document.overlays
    .map((oid) => bundle.entries.get(oid)!)
    .filter((e) => e.node.type === 'broll-overlay' && e.node.anchor.nodeId === targetId)
    .map((e) => {
      const n = e.node as Extract<FlowNode, { type: 'broll-overlay' }>;
      return {
        id: n.id,
        file: e.file,
        segmentId: n.anchor.segmentId,
        offsetSeconds: n.anchor.offsetSeconds,
        durationSeconds: n.anchor.durationSeconds,
        summary: summarizeNode(n),
      };
    });

  const rawJson = JSON.stringify(entry.rawNode);
  const resolvedJson = JSON.stringify(entry.node);
  const nodeFileText = snapshot.files[entry.file];

  return {
    revision: snapshot.revision,
    flowPath: bundle.flowPath,
    nodeId: targetId,
    role: entry.role,
    nodeFile: entry.file,
    nodeFileHash: nodeFileText !== undefined ? hash(nodeFileText) : undefined,
    contentHash: entry.contentHash,
    unbaked: entry.unbaked,
    ...(placement
      ? {
          placement: {
            startSeconds: Number(placement.startSeconds.toFixed(4)),
            endSeconds: Number(placement.endSeconds.toFixed(4)),
            startFrame: placement.startFrame,
            endFrame: placement.endFrame,
            durationFrames: placement.durationFrames,
            ...(querySeconds !== undefined
              ? {
                  localSeconds: Number(
                    Math.max(0, querySeconds - placement.startSeconds).toFixed(4),
                  ),
                }
              : {}),
            ...(placement.segmentSpans ? { segmentSpans: placement.segmentSpans } : {}),
          },
        }
      : {}),
    node: entry.rawNode,
    ...(rawJson !== resolvedJson ? { resolvedNode: entry.node } : {}),
    neighbors: {
      previous: prevIds.map((id) => {
        const e = bundle.entries.get(id)!;
        const p = compiled.placements.find((x) => x.nodeId === id);
        return {
          id,
          name: e.node.name ?? id,
          type: e.node.type,
          endSeconds: p ? Number(p.endSeconds.toFixed(3)) : undefined,
          summary: summarizeNode(e.node),
        };
      }),
      next: nextIds.map((id) => {
        const e = bundle.entries.get(id)!;
        const p = compiled.placements.find((x) => x.nodeId === id);
        return {
          id,
          name: e.node.name ?? id,
          type: e.node.type,
          startSeconds: p ? Number(p.startSeconds.toFixed(3)) : undefined,
          transitionIn: e.node.transitionIn,
          summary: summarizeNode(e.node),
        };
      }),
      anchoredOverlays,
    },
  };
}

const timelineFlowEditSchema: z.ZodType<TimelineFlowEdit> = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('trimNode'),
      nodeId: flowNodeIdSchema,
      durationFrames: z.number().int().positive().max(216000).optional(),
      durationSeconds: z.number().finite().positive().max(3600).optional(),
      sourceInSeconds: z.number().finite().nonnegative().max(7200).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('reorderSpine'),
      spine: z.array(flowNodeIdSchema).max(500),
    })
    .strict(),
  z
    .object({
      op: z.literal('moveOverlay'),
      nodeId: flowNodeIdSchema,
      anchorNodeId: flowNodeIdSchema,
      segmentId: z.string().min(1).max(120).optional(),
      offsetSeconds: z.number().finite().nonnegative().max(3600),
      durationSeconds: z.number().finite().positive().max(3600).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('toggleNode'),
      nodeId: flowNodeIdSchema,
      enabled: z.boolean(),
    })
    .strict(),
]);

export const flowPlanActionSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('init'),
      flowId: flowIdSchema,
      name: z.string().min(1).max(240).optional(),
      split: z.boolean().default(true),
      mountSequenceId: z.string().min(1).max(200).optional(),
      variables: z.record(z.union([z.string(), z.number().finite(), z.boolean()])).default({}),
      soundBed: flowSoundBedSchema.optional(),
      nodes: z.array(flowNodeSchema).max(500).default([]),
      spine: z.array(flowNodeIdSchema).max(500).optional(),
      overlays: z.array(flowNodeIdSchema).max(200).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('fromSequence'),
      sequenceId: z.string().min(1).max(200).optional(),
      flowId: flowIdSchema.optional(),
      split: z.boolean().default(true),
      mount: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      op: z.literal('upsertNode'),
      node: flowNodeSchema,
      role: z.enum(['spine', 'overlay', 'draft']).optional(),
      index: z.number().int().nonnegative().optional(),
      afterNodeId: flowNodeIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('patchNode'),
      nodeId: flowNodeIdSchema,
      patch: z.record(z.unknown()),
    })
    .strict(),
  z
    .object({
      op: z.literal('removeNode'),
      nodeId: flowNodeIdSchema,
      deleteFile: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      op: z.literal('reorder'),
      spine: z.array(flowNodeIdSchema).max(500).optional(),
      overlays: z.array(flowNodeIdSchema).max(200).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('setVariables'),
      variables: z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])),
      merge: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      op: z.literal('setSoundBed'),
      soundBed: flowSoundBedSchema.nullable(),
    })
    .strict(),
  z
    .object({
      op: z.literal('mountSequence'),
      sequenceId: z.string().min(1).max(200).optional(),
      unmount: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      op: z.literal('timelineEdit'),
      edit: timelineFlowEditSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal('split'),
    })
    .strict(),
  z
    .object({
      op: z.literal('pack'),
      targetPath: z.string().min(1).max(300).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('bakeSequence'),
      sequenceId: z.string().min(1).max(200).optional(),
      keepFlowFiles: z.boolean().default(true),
    })
    .strict(),
]);

export const flowPlanSchema = z
  .object({
    revision: z.string().optional(),
    flowPath: z.string().min(1).max(300).optional(),
    sequenceId: z.string().min(1).max(200).optional(),
    action: flowPlanActionSchema,
    operations: z.array(z.record(z.unknown())).max(500).default([]),
    inline: z.boolean().default(false),
  })
  .strict();

function diffToFileEdits(
  beforeFiles: Record<string, string>,
  afterFiles: Record<string, string>,
): FileEdit[] {
  const edits: FileEdit[] = [];
  const allKeys = [...new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)])].sort();
  for (const path of allKeys) {
    if (isVirtualFlowSceneFile(path)) continue;
    const prev = beforeFiles[path];
    const next = afterFiles[path];
    if (prev === next) continue;
    if (next === undefined) {
      if (prev !== undefined) {
        edits.push({
          type: 'delete',
          path,
          expectedHash: hash(prev),
        });
      }
    } else {
      edits.push({
        type: 'replace',
        path,
        content: next,
        expectedHash: prev === undefined ? null : hash(prev),
      });
    }
  }
  return edits;
}

export async function flowPlan(root: string, snapshot: Snapshot, raw: unknown) {
  const req = flowPlanSchema.parse(raw);
  if (req.revision && req.revision !== snapshot.revision) {
    throw new VmotionError(
      'REVISION_CONFLICT',
      'Project revision changed before planning flow edit; reload and retry',
      { expected: req.revision, actual: snapshot.revision },
    );
  }

  const preOps = req.operations as Operation[];
  const working = preOps.length
    ? applyOperations(root, snapshot, preOps)
    : structuredClone(snapshot);
  const baseScenes = baseProjectScenes(working);

  let targetFlowPath = req.flowPath?.replace(/\\/g, '/');
  let beforeCompiled: CompiledFlowResult | undefined;
  let nextFiles: Record<string, string> = { ...working.files };
  let summary = '';

  const act = req.action;

  if (act.op === 'init') {
    targetFlowPath = targetFlowPath ?? defaultFlowPath(act.flowId, act.split);
    if (nextFiles[targetFlowPath] !== undefined) {
      throw new VmotionError('DUPLICATE_ID', `Flow "${targetFlowPath}" already exists`, {
        file: targetFlowPath,
      });
    }
    const inferredSpine =
      act.spine ?? act.nodes.filter((n) => n.type !== 'broll-overlay').map((n) => n.id);
    const inferredOverlays =
      act.overlays ?? act.nodes.filter((n) => n.type === 'broll-overlay').map((n) => n.id);

    if (act.split) {
      const nodesDir = flowNodesDir(targetFlowPath);
      for (const node of act.nodes) {
        const parsedNode = flowNodeSchema.parse(node);
        nextFiles[`${nodesDir}/${parsedNode.id}.json`] = json(parsedNode);
      }
      const doc = flowDocumentSchema.parse({
        kind: 'flow',
        version: 1,
        id: act.flowId,
        name: act.name ?? act.flowId,
        spine: inferredSpine,
        overlays: inferredOverlays,
        variables: act.variables,
        ...(act.soundBed ? { soundBed: act.soundBed } : {}),
      });
      nextFiles[targetFlowPath] = json(doc);
    } else {
      const inlineNodes = Object.fromEntries(act.nodes.map((n) => [n.id, n]));
      const doc = flowDocumentSchema.parse({
        kind: 'flow',
        version: 1,
        id: act.flowId,
        name: act.name ?? act.flowId,
        spine: inferredSpine,
        overlays: inferredOverlays,
        variables: act.variables,
        ...(act.soundBed ? { soundBed: act.soundBed } : {}),
        nodes: inlineNodes,
      });
      nextFiles[targetFlowPath] = json(doc);
    }

    if (act.mountSequenceId) {
      const seqIdx = working.sequences.findIndex((s) => s.id === act.mountSequenceId);
      if (seqIdx < 0) {
        throw new VmotionError(
          'MISSING_SEQUENCE',
          `Sequence "${act.mountSequenceId}" does not exist`,
          { sequenceId: act.mountSequenceId },
        );
      }
      const seqFile = working.project.sequences[seqIdx];
      const diskSeq = sequenceSchema.parse(JSON.parse(nextFiles[seqFile]));
      nextFiles[seqFile] = json({ ...diskSeq, flowSource: targetFlowPath });
    }
    summary = `Initialized ${act.split ? 'split' : 'packed'} flow "${act.flowId}" at ${targetFlowPath}`;
  } else if (act.op === 'fromSequence') {
    const seqId = act.sequenceId ?? req.sequenceId ?? working.project.activeSequence;
    const converted = sequenceToSplitFlow(working, seqId, {
      flowId: act.flowId,
      flowPath: targetFlowPath,
      split: act.split,
      mount: act.mount,
    });
    nextFiles = converted.files;
    targetFlowPath = converted.flowPath;
    summary = `Converted sequence "${seqId}" to ${act.split ? 'split' : 'packed'} flow (${converted.createdNodes.length} nodes)`;
  } else {
    const resolved = resolveTargetFlowPath(working, targetFlowPath, req.sequenceId);
    targetFlowPath = resolved.flowPath;
    const beforeBundle = resolveFlowBundle(nextFiles, targetFlowPath, working.project, baseScenes);
    beforeCompiled = compileFlow(beforeBundle, {
      project: working.project,
      scenes: baseScenes,
      files: nextFiles,
    });

    if (act.op === 'upsertNode') {
      const res = writeNodeToBundleFiles(nextFiles, targetFlowPath, act.node, beforeBundle.split);
      nextFiles = res.files;

      const defaultRole = act.node.type === 'broll-overlay' ? 'overlay' : 'spine';
      const existingRole = beforeBundle.entries.get(act.node.id)?.role;
      const desiredRole = act.role ?? existingRole ?? defaultRole;

      let nextSpine = beforeBundle.document.spine.filter((id) => id !== act.node.id);
      let nextOverlays = beforeBundle.document.overlays.filter((id) => id !== act.node.id);

      if (desiredRole === 'spine') {
        if (act.node.type === 'broll-overlay') {
          throw new VmotionError(
            'FLOW_ROLE_MISMATCH',
            `Node "${act.node.id}" of type "broll-overlay" must use role="overlay" or "draft"`,
          );
        }
        if (beforeBundle.document.spine.includes(act.node.id) && act.index === undefined && !act.afterNodeId) {
          nextSpine = [...beforeBundle.document.spine];
        } else if (act.afterNodeId) {
          const idx = nextSpine.indexOf(act.afterNodeId);
          if (idx < 0) {
            throw new VmotionError(
              'FLOW_MISSING_NODE',
              `afterNodeId "${act.afterNodeId}" is not in spine`,
            );
          }
          nextSpine.splice(idx + 1, 0, act.node.id);
        } else if (act.index !== undefined) {
          nextSpine.splice(Math.min(nextSpine.length, act.index), 0, act.node.id);
        } else {
          nextSpine.push(act.node.id);
        }
      } else if (desiredRole === 'overlay') {
        if (act.node.type !== 'broll-overlay') {
          throw new VmotionError(
            'FLOW_ROLE_MISMATCH',
            `Node "${act.node.id}" of type "${act.node.type}" cannot be placed in overlays[]`,
          );
        }
        if (beforeBundle.document.overlays.includes(act.node.id) && act.index === undefined) {
          nextOverlays = [...beforeBundle.document.overlays];
        } else if (act.index !== undefined) {
          nextOverlays.splice(Math.min(nextOverlays.length, act.index), 0, act.node.id);
        } else {
          nextOverlays.push(act.node.id);
        }
      }

      if (
        JSON.stringify(nextSpine) !== JSON.stringify(beforeBundle.document.spine) ||
        JSON.stringify(nextOverlays) !== JSON.stringify(beforeBundle.document.overlays)
      ) {
        const currentManifest = flowDocumentSchema.parse(JSON.parse(nextFiles[targetFlowPath]));
        nextFiles[targetFlowPath] = json(
          flowDocumentSchema.parse({
            ...currentManifest,
            spine: nextSpine,
            overlays: nextOverlays,
          }),
        );
      }
      summary = `Upserted flow node "${act.node.id}" (${desiredRole}) in ${res.nodeFile}`;
    } else if (act.op === 'patchNode') {
      const existing = beforeBundle.entries.get(act.nodeId);
      if (!existing) {
        throw new VmotionError('FLOW_MISSING_NODE', `Flow node "${act.nodeId}" does not exist`, {
          flowPath: targetFlowPath,
          nodeId: act.nodeId,
        });
      }
      const merged = flowNodeSchema.parse({
        ...existing.rawNode,
        ...act.patch,
        id: act.nodeId,
        kind: 'flow-node',
        version: 1,
      });
      const res = writeNodeToBundleFiles(nextFiles, targetFlowPath, merged, beforeBundle.split);
      nextFiles = res.files;
      summary = `Patched flow node "${act.nodeId}" in ${res.nodeFile}`;
    } else if (act.op === 'removeNode') {
      const existing = beforeBundle.entries.get(act.nodeId);
      if (!existing) {
        throw new VmotionError('FLOW_MISSING_NODE', `Flow node "${act.nodeId}" does not exist`, {
          flowPath: targetFlowPath,
          nodeId: act.nodeId,
        });
      }
      const nextSpine = beforeBundle.document.spine.filter((id) => id !== act.nodeId);
      const nextOverlays = beforeBundle.document.overlays.filter((id) => id !== act.nodeId);
      const nextInline = beforeBundle.document.nodes
        ? { ...beforeBundle.document.nodes }
        : undefined;
      if (nextInline) delete nextInline[act.nodeId];

      const docObj: Record<string, unknown> = {
        ...beforeBundle.document,
        spine: nextSpine,
        overlays: nextOverlays,
      };
      if (nextInline && Object.keys(nextInline).length > 0) docObj.nodes = nextInline;
      else delete docObj.nodes;
      nextFiles[targetFlowPath] = json(flowDocumentSchema.parse(docObj));

      if (act.deleteFile && existing.file !== targetFlowPath) {
        delete nextFiles[existing.file];
      }
      summary = `Removed flow node "${act.nodeId}"${act.deleteFile ? '' : ' (kept as draft file)'}`;
    } else if (act.op === 'reorder') {
      const nextDoc = flowDocumentSchema.parse({
        ...beforeBundle.document,
        ...(act.spine !== undefined ? { spine: act.spine } : {}),
        ...(act.overlays !== undefined ? { overlays: act.overlays } : {}),
      });
      nextFiles[targetFlowPath] = json(nextDoc);
      summary = `Reordered topology in ${targetFlowPath}`;
    } else if (act.op === 'setVariables') {
      const nextVars = act.merge ? { ...beforeBundle.document.variables } : {};
      for (const [k, v] of Object.entries(act.variables)) {
        if (v === null) delete nextVars[k];
        else nextVars[k] = v;
      }
      const nextDoc = flowDocumentSchema.parse({
        ...beforeBundle.document,
        variables: nextVars,
      });
      nextFiles[targetFlowPath] = json(nextDoc);
      summary = `Updated flow variables in ${targetFlowPath}`;
    } else if (act.op === 'setSoundBed') {
      const docObj: Record<string, unknown> = { ...beforeBundle.document };
      if (act.soundBed === null) delete docObj.soundBed;
      else docObj.soundBed = act.soundBed;
      nextFiles[targetFlowPath] = json(flowDocumentSchema.parse(docObj));
      summary = act.soundBed ? `Set flow soundBed (${act.soundBed.assetId})` : 'Cleared flow soundBed';
    } else if (act.op === 'mountSequence') {
      const seqId = act.sequenceId ?? req.sequenceId ?? working.project.activeSequence;
      const seqIdx = working.sequences.findIndex((s) => s.id === seqId);
      if (seqIdx < 0) {
        throw new VmotionError('MISSING_SEQUENCE', `Sequence "${seqId}" does not exist`, {
          sequenceId: seqId,
        });
      }
      const seqFile = working.project.sequences[seqIdx];
      const diskSeq = sequenceSchema.parse(JSON.parse(nextFiles[seqFile]));
      const nextSeq: Record<string, unknown> = { ...diskSeq };
      if (act.unmount) delete nextSeq.flowSource;
      else nextSeq.flowSource = targetFlowPath;
      nextFiles[seqFile] = json(sequenceSchema.parse(nextSeq));
      summary = act.unmount
        ? `Unmounted flow from sequence "${seqId}"`
        : `Mounted "${targetFlowPath}" onto sequence "${seqId}"`;
    } else if (act.op === 'timelineEdit') {
      const res = applyTimelineEditToFlow(
        nextFiles,
        targetFlowPath,
        act.edit,
        working.project.fps,
      );
      nextFiles = res.files;
      summary = res.summary;
    } else if (act.op === 'split') {
      const res = splitFlowToFiles(nextFiles, targetFlowPath);
      nextFiles = res.files;
      targetFlowPath = res.flowPath;
      summary = `Split flow into ${res.flowPath} + ${res.nodeFiles.length} node capsules`;
    } else if (act.op === 'pack') {
      const res = packFlowToSingleFile(nextFiles, targetFlowPath, act.targetPath);
      nextFiles = res.files;
      targetFlowPath = res.flowPath;
      summary = `Packed flow into single file ${res.flowPath}`;
    } else if (act.op === 'bakeSequence') {
      const seqId = act.sequenceId ?? req.sequenceId ?? working.project.activeSequence;
      const seqIdx = working.sequences.findIndex((s) => s.id === seqId);
      if (seqIdx < 0) {
        throw new VmotionError('MISSING_SEQUENCE', `Sequence "${seqId}" does not exist`, {
          sequenceId: seqId,
        });
      }
      const seqFile = working.project.sequences[seqIdx];
      const manifest = JSON.parse(nextFiles['project.vmotion.json']) as Project;
      const cleanManifestScenes = manifest.scenes.filter((f) => !isVirtualFlowSceneFile(f));
      const sceneIdRemap = new Map<string, string>();

      // Materialize virtual scenes into real scenes/flow-*.json files
      for (const vs of beforeCompiled.virtualScenes) {
        const cleanId = vs.scene.id.replace(/[^a-zA-Z0-9_-]+/g, '-');
        const outSceneFile = `scenes/${cleanId}.json`;
        const bakedScene = sceneSchema.parse({ ...vs.scene, id: cleanId });
        nextFiles[outSceneFile] = json(bakedScene);
        if (!cleanManifestScenes.includes(outSceneFile)) cleanManifestScenes.push(outSceneFile);
        sceneIdRemap.set(vs.scene.id, cleanId);
      }
      nextFiles['project.vmotion.json'] = json({ ...manifest, scenes: cleanManifestScenes });

      const diskSeq = sequenceSchema.parse(JSON.parse(nextFiles[seqFile]));
      const manualTracks = diskSeq.tracks.filter((t) => !t.id.startsWith(FLOW_TRACK_PREFIX));
      const manualMarkers = diskSeq.markers.filter((m) => !m.id.startsWith(FLOW_TRACK_PREFIX));
      const bakedTracks = beforeCompiled.tracks.map((t) => ({
        ...t,
        id: t.id.replace(/^flow\//, 'baked-'),
        clips: t.clips.map((c) => ({
          ...c,
          id: c.id.replace(/^flow\//, 'baked-'),
          ...(c.sceneId && sceneIdRemap.has(c.sceneId)
            ? { sceneId: sceneIdRemap.get(c.sceneId)! }
            : {}),
        })),
      }));
      const bakedMarkers = beforeCompiled.markers.map((m) => ({
        ...m,
        id: m.id.replace(/^flow\//, 'baked-'),
      }));
      const nextSeqObj: Record<string, unknown> = {
        ...diskSeq,
        duration: Math.max(diskSeq.duration, beforeCompiled.durationFrames),
        tracks: [...bakedTracks, ...manualTracks],
        markers: [...bakedMarkers, ...manualMarkers],
      };
      delete nextSeqObj.flowSource;
      if (beforeCompiled.mix) {
        const remappedMixTracks = Object.fromEntries(
          Object.entries(beforeCompiled.mix.tracks).map(([k, v]) => [
            k.replace(/^flow\//, 'baked-'),
            v.ducking
              ? {
                  ...v,
                  ducking: {
                    ...v.ducking,
                    source: {
                      ...v.ducking.source,
                      id: v.ducking.source.id.replace(/^flow\//, 'baked-'),
                    },
                  },
                }
              : v,
          ]),
        );
        nextSeqObj.mix = {
          ...(diskSeq.mix ?? beforeCompiled.mix),
          tracks: {
            ...remappedMixTracks,
            ...(diskSeq.mix?.tracks ?? {}),
          },
        };
      }
      nextFiles[seqFile] = json(sequenceSchema.parse(nextSeqObj));

      if (!act.keepFlowFiles) {
        delete nextFiles[targetFlowPath];
        for (const entry of beforeBundle.entries.values()) {
          if (entry.file !== targetFlowPath) delete nextFiles[entry.file];
        }
      }
      summary = `Baked flow "${beforeBundle.document.id}" into standalone sequence "${seqId}"`;
    }
  }

  const fileEdits = diffToFileEdits(working.files, nextFiles);
  if (fileEdits.length === 0 && preOps.length === 0) {
    throw new VmotionError('NO_CHANGES', 'Flow plan produced no file changes');
  }

  const finalOps: Operation[] = [
    ...preOps,
    ...(fileEdits.length > 0 ? [{ type: 'editFiles' as const, edits: fileEdits }] : []),
  ];
  const finalSnapshot = applyOperations(root, snapshot, finalOps);
  const diagnostics = await validateSnapshot(root, finalSnapshot);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    throw new VmotionError(
      'VALIDATION_FAILED',
      `Flow candidate failed validation: ${errors.map((d) => `${d.code}: ${d.message}`).join('; ')}`,
      errors,
    );
  }

  let afterCompiled: CompiledFlowResult | undefined;
  if (targetFlowPath && Object.hasOwn(finalSnapshot.files, targetFlowPath)) {
    const afterBaseScenes = baseProjectScenes(finalSnapshot);
    const afterBundle = resolveFlowBundle(
      finalSnapshot.files,
      targetFlowPath,
      finalSnapshot.project,
      afterBaseScenes,
    );
    afterCompiled = compileFlow(afterBundle, {
      project: finalSnapshot.project,
      scenes: afterBaseScenes,
      files: finalSnapshot.files,
    });
  }

  const diff = afterCompiled
    ? diffFlowCompilations(beforeCompiled, afterCompiled)
    : {
        dirtyNodes: [],
        shiftedNodes: [],
        addedNodes: [],
        removedNodes: [],
        unbakedNodes: [],
        dirtyFrameRanges: [],
      };

  const mountedSeq =
    finalSnapshot.sequences.find((s) => s.flowSource === targetFlowPath) ??
    finalSnapshot.sequences.find((s) => s.id === (req.sequenceId ?? finalSnapshot.project.activeSequence));

  // Pinpoint sample frames: ONLY dirty nodes (never mere downstream shifted nodes!)
  const sampleFrames: Array<{ sequenceId: string; frame: number }> = [];
  if (mountedSeq && diff.dirtyFrameRanges.length > 0) {
    const seen = new Set<number>();
    for (const r of diff.dirtyFrameRanges) {
      const mid = Math.min(
        Math.max(0, mountedSeq.duration - 1),
        Math.floor((r.startFrame + Math.max(r.startFrame, r.endFrame - 1)) / 2),
      );
      if (!seen.has(mid)) {
        seen.add(mid);
        sampleFrames.push({ sequenceId: mountedSeq.id, frame: mid });
      }
      if (sampleFrames.length >= 8) break;
    }
  }

  const candidateInput = {
    revision: snapshot.revision,
    operations: finalOps,
    assetChecks: [],
    samples: sampleFrames,
    width: 320,
    visual: sampleFrames.length > 0,
    determinism: true,
  };

  return builtinCandidate(
    root,
    candidateInput,
    finalSnapshot.revision,
    req.inline ? 'inline' : 'stored',
    {
      flowPath: targetFlowPath,
      summary,
      touchedFiles: fileEdits.map((e) => ({ path: e.path, type: e.type })),
      diff,
      warnings: diagnostics.filter((d) => d.severity === 'warning'),
      ...(afterCompiled
        ? {
            durationFrames: afterCompiled.durationFrames,
            durationSeconds: afterCompiled.durationSeconds,
          }
        : {}),
    },
  );
}

export const flowPreviewNodeSchema = z
  .object({
    flowPath: z.string().min(1).max(300).optional(),
    sequenceId: z.string().min(1).max(200).optional(),
    nodeId: flowNodeIdSchema,
    localSeconds: z.number().finite().nonnegative().optional(),
    progress: z.number().finite().min(0).max(1).default(0.5),
    width: z.number().int().min(64).max(1920).default(480),
    media: z.boolean().default(true),
    inline: z.boolean().default(true),
  })
  .strict();

export async function flowPreviewNode(host: BuiltinPluginHost, raw: unknown) {
  const req = flowPreviewNodeSchema.parse(raw);
  const snapshot = host.snapshot;
  const { flowPath } = resolveTargetFlowPath(snapshot, req.flowPath, req.sequenceId);
  const baseScenes = baseProjectScenes(snapshot);
  const bundle = resolveFlowBundle(snapshot.files, flowPath, snapshot.project, baseScenes);
  const single = compileSingleFlowNode(bundle, req.nodeId, {
    project: snapshot.project,
    scenes: baseScenes,
    files: snapshot.files,
  });

  const fps = snapshot.project.fps;
  const targetFrame =
    req.localSeconds !== undefined
      ? Math.min(
          single.durationFrames - 1,
          Math.max(0, Math.round((req.localSeconds * fps.num) / fps.den)),
        )
      : Math.min(
          single.durationFrames - 1,
          Math.max(0, Math.floor((single.durationFrames - 1) * req.progress)),
        );

  const previewSeqId = '__flow_node_preview__';
  const isolatedProject: Project = {
    ...snapshot.project,
    activeSequence: previewSeqId,
    scenes: [
      ...snapshot.project.scenes.filter((f) => !isVirtualFlowSceneFile(f)),
      ...single.virtualScenes.map((vs) => vs.file),
    ],
    sequences: [...snapshot.project.sequences, '__virtual/flow/preview-seq.json'],
  };
  const isolatedSequence: Sequence = sequenceSchema.parse({
    id: previewSeqId,
    name: `Preview ${req.nodeId}`,
    duration: single.durationFrames,
    tracks: single.tracks,
    markers: single.markers,
  });
  const isolatedSnapshot: Snapshot = {
    project: isolatedProject,
    scenes: [...baseScenes, ...single.virtualScenes.map((vs) => vs.scene)],
    sequences: [...snapshot.sequences, isolatedSequence],
    files: snapshot.files,
    revision: `${snapshot.revision}:flow-node:${req.nodeId}:${bundle.bundleHash}`,
  };

  const rendered = await host.withMediaTask(async () => {
    const start = performance.now();
    const canvas = await host.renderer.render(isolatedSnapshot, targetFrame, {
      sequenceId: previewSeqId,
      width: req.width,
    });
    const renderMs = Number((performance.now() - start).toFixed(2));
    const png = req.media && req.inline ? await canvas.encode('png') : undefined;
    return {
      width: canvas.width,
      height: canvas.height,
      renderMs,
      png,
    };
  });

  const entry = bundle.entries.get(req.nodeId)!;
  return {
    revision: snapshot.revision,
    flowPath: bundle.flowPath,
    nodeId: req.nodeId,
    nodeFile: entry.file,
    contentHash: entry.contentHash,
    unbaked: entry.unbaked,
    durationFrames: single.durationFrames,
    durationSeconds: single.durationSeconds,
    localFrame: targetFrame,
    localSeconds: Number(((targetFrame * fps.den) / fps.num).toFixed(4)),
    width: rendered.width,
    height: rendered.height,
    renderMs: rendered.renderMs,
    ...(rendered.png ? { data: rendered.png.toString('base64') } : {}),
  };
}
