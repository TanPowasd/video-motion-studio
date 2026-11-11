import path from 'node:path';
import { json } from '../platform/project-files.js';
import { sequenceSchema, VmotionError, type Clip, type Snapshot } from './model.js';
import {
  flowDocumentSchema,
  flowIdSchema,
  flowNodeIdSchema,
  flowNodeSchema,
  type FlowBRollOverlayNode,
  type FlowDocument,
  type FlowNode,
  type FlowShotNode,
} from './flow-schema.js';
import { FLOW_TRACK_PREFIX, flowNodesDir, resolveFlowBundle } from './flow-compiler.js';

export interface ParsedFlowClipRef {
  flowId: string;
  nodeId: string;
  part: string;
}

export type TimelineFlowEdit =
  | {
      op: 'trimNode';
      nodeId: string;
      durationFrames?: number;
      durationSeconds?: number;
      sourceInSeconds?: number;
    }
  | {
      op: 'reorderSpine';
      spine: string[];
    }
  | {
      op: 'moveOverlay';
      nodeId: string;
      anchorNodeId: string;
      segmentId?: string;
      offsetSeconds: number;
      durationSeconds?: number;
    }
  | {
      op: 'toggleNode';
      nodeId: string;
      enabled: boolean;
    };

export function defaultFlowPath(flowId: string, split = true): string {
  const safeId = flowIdSchema.parse(flowId);
  return split
    ? `components/flows/${safeId}/flow.json`
    : `components/flows/${safeId}.flow.json`;
}

export function parseFlowClipId(clipId: string): ParsedFlowClipRef | null {
  if (!clipId.startsWith(FLOW_TRACK_PREFIX)) return null;
  const rest = clipId.slice(FLOW_TRACK_PREFIX.length);
  const parts = rest.split('/');
  if (parts.length < 3) return null;
  const [flowId, nodeId, ...partRest] = parts;
  if (!flowId || !nodeId || nodeId === 'bed' || nodeId === 'chapter') return null;
  return { flowId, nodeId, part: partRest.join('/') };
}

function updateSequenceFlowSourcePointers(
  nextFiles: Record<string, string>,
  oldFlowPath: string,
  newFlowPath: string,
): void {
  if (oldFlowPath === newFlowPath) return;
  for (const [file, content] of Object.entries(nextFiles)) {
    if (!file.startsWith('sequences/') || !file.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.flowSource === oldFlowPath) {
        parsed.flowSource = newFlowPath;
        nextFiles[file] = json(parsed);
      }
    } catch {
      // Preserve invalid JSON untouched for diagnostics.
    }
  }
}

export function writeNodeToBundleFiles(
  files: Record<string, string>,
  flowPath: string,
  node: FlowNode,
  preferSplit?: boolean,
): { files: Record<string, string>; nodeFile: string } {
  const validated = flowNodeSchema.parse(node);
  const bundle = resolveFlowBundle(files, flowPath);
  const nextFiles = { ...files };
  const useSplit = preferSplit ?? bundle.split;

  if (useSplit) {
    const nodeFile = path.posix.join(bundle.nodesDir, `${validated.id}.json`);
    nextFiles[nodeFile] = json(validated);
    if (bundle.document.nodes && Object.hasOwn(bundle.document.nodes, validated.id)) {
      const nextInline = { ...bundle.document.nodes };
      delete nextInline[validated.id];
      const nextDoc: FlowDocument = {
        ...bundle.document,
        ...(Object.keys(nextInline).length > 0 ? { nodes: nextInline } : { nodes: undefined }),
      };
      if (!nextDoc.nodes) delete (nextDoc as Record<string, unknown>).nodes;
      nextFiles[bundle.flowPath] = json(nextDoc);
    }
    return { files: nextFiles, nodeFile };
  }

  const nextInline = { ...(bundle.document.nodes ?? {}), [validated.id]: validated };
  const nextDoc = flowDocumentSchema.parse({
    ...bundle.document,
    nodes: nextInline,
  });
  nextFiles[bundle.flowPath] = json(nextDoc);
  return { files: nextFiles, nodeFile: bundle.flowPath };
}

/**
 * Splits a Flow into `components/flows/<id>/flow.json` + per-node `nodes/<nodeId>.json` capsules.
 * Preserves `$var.*` expressions via `entry.rawNode`.
 */
export function splitFlowToFiles(
  files: Record<string, string>,
  flowPath: string,
): {
  files: Record<string, string>;
  flowPath: string;
  nodeFiles: string[];
  removedFiles: string[];
} {
  const bundle = resolveFlowBundle(files, flowPath);
  const nextFiles = { ...files };
  const targetFlowPath = bundle.flowPath.endsWith('/flow.json')
    ? bundle.flowPath
    : defaultFlowPath(bundle.document.id, true);
  const targetNodesDir = flowNodesDir(targetFlowPath);

  const manifestObj: Record<string, unknown> = {
    kind: 'flow',
    version: 1,
    id: bundle.document.id,
    name: bundle.document.name,
    spine: bundle.document.spine,
    overlays: bundle.document.overlays,
    variables: bundle.document.variables,
    ...(bundle.document.soundBed ? { soundBed: bundle.document.soundBed } : {}),
  };
  nextFiles[targetFlowPath] = json(flowDocumentSchema.parse(manifestObj));

  const nodeFiles: string[] = [];
  const removedFiles: string[] = [];
  for (const [id, entry] of bundle.entries.entries()) {
    const outNodeFile = path.posix.join(targetNodesDir, `${id}.json`);
    nextFiles[outNodeFile] = json(flowNodeSchema.parse(entry.rawNode));
    nodeFiles.push(outNodeFile);
    if (entry.file !== bundle.flowPath && entry.file !== outNodeFile) {
      delete nextFiles[entry.file];
      removedFiles.push(entry.file);
    }
  }

  if (targetFlowPath !== bundle.flowPath) {
    delete nextFiles[bundle.flowPath];
    removedFiles.push(bundle.flowPath);
    updateSequenceFlowSourcePointers(nextFiles, bundle.flowPath, targetFlowPath);
  }

  return { files: nextFiles, flowPath: targetFlowPath, nodeFiles, removedFiles };
}

/**
 * Packs a split Flow (`flow.json` + `nodes/*.json`) back into a single self-contained Flow JSON file.
 */
export function packFlowToSingleFile(
  files: Record<string, string>,
  flowPath: string,
  targetPath?: string,
): {
  files: Record<string, string>;
  flowPath: string;
  removedFiles: string[];
} {
  const bundle = resolveFlowBundle(files, flowPath);
  const nextFiles = { ...files };
  const outPath = (targetPath ?? defaultFlowPath(bundle.document.id, false)).replace(/\\/g, '/');

  const orderedIds = [
    ...bundle.document.spine,
    ...bundle.document.overlays,
    ...bundle.draftNodeIds,
  ];
  const inlineNodes: Record<string, FlowNode> = {};
  for (const id of orderedIds) {
    const entry = bundle.entries.get(id);
    if (entry) inlineNodes[id] = flowNodeSchema.parse(entry.rawNode);
  }

  const packedDoc = flowDocumentSchema.parse({
    kind: 'flow',
    version: 1,
    id: bundle.document.id,
    name: bundle.document.name,
    spine: bundle.document.spine,
    overlays: bundle.document.overlays,
    variables: bundle.document.variables,
    ...(bundle.document.soundBed ? { soundBed: bundle.document.soundBed } : {}),
    nodes: inlineNodes,
  });
  nextFiles[outPath] = json(packedDoc);

  const removedFiles: string[] = [];
  for (const entry of bundle.entries.values()) {
    if (entry.file !== bundle.flowPath && entry.file !== outPath && nextFiles[entry.file] !== undefined) {
      delete nextFiles[entry.file];
      removedFiles.push(entry.file);
    }
  }
  if (outPath !== bundle.flowPath && nextFiles[bundle.flowPath] !== undefined) {
    delete nextFiles[bundle.flowPath];
    removedFiles.push(bundle.flowPath);
    updateSequenceFlowSourcePointers(nextFiles, bundle.flowPath, outPath);
  }

  return { files: nextFiles, flowPath: outPath, removedFiles };
}

function sanitizeFlowNodeId(raw: string, fallbackIndex: number, used: Set<string>): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .slice(0, 48);
  const base = cleaned || `shot-${String(fallbackIndex + 1).padStart(2, '0')}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate) || !flowNodeIdSchema.safeParse(candidate).success) {
    candidate = `${base}-${suffix++}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Converts an existing traditional timeline Sequence into a split (or packed) Flow graph
 * and optionally mounts it via `sequence.flowSource`.
 */
export function sequenceToSplitFlow(
  snapshot: Snapshot,
  sequenceId: string,
  options: {
    flowId?: string;
    flowPath?: string;
    split?: boolean;
    mount?: boolean;
  } = {},
): {
  files: Record<string, string>;
  flowId: string;
  flowPath: string;
  createdNodes: string[];
} {
  const seqIndex = snapshot.sequences.findIndex((s) => s.id === sequenceId);
  if (seqIndex < 0) {
    throw new VmotionError('MISSING_SEQUENCE', `Sequence "${sequenceId}" does not exist`, {
      sequenceId,
    });
  }
  const seq = snapshot.sequences[seqIndex];
  const seqFile = snapshot.project.sequences[seqIndex];
  if (seq.flowSource) {
    throw new VmotionError(
      'FLOW_ALREADY_MOUNTED',
      `Sequence "${sequenceId}" already mounts flow "${seq.flowSource}"`,
      { sequenceId, flowSource: seq.flowSource },
    );
  }

  const split = options.split ?? true;
  const flowId = flowIdSchema.parse(options.flowId ?? seq.id);
  const outFlowPath = (options.flowPath ?? defaultFlowPath(flowId, split)).replace(/\\/g, '/');
  if (snapshot.files[outFlowPath] !== undefined) {
    throw new VmotionError('DUPLICATE_ID', `Flow file "${outFlowPath}" already exists`, {
      file: outFlowPath,
    });
  }

  const fps = snapshot.project.fps;
  const framesToSec = (f: number) => Number(((f * fps.den) / fps.num).toFixed(4));

  const convertibleVideoTracks = seq.tracks.filter(
    (t) =>
      t.type === 'video' &&
      !t.muted &&
      !t.locked &&
      t.clips.length > 0 &&
      t.clips.every((c) => !c.sequenceId),
  );
  const primaryVideoTrack = convertibleVideoTracks[0];
  const secondaryVideoTracks = convertibleVideoTracks.slice(1);

  const usedNodeIds = new Set<string>();
  const nodesById = new Map<string, FlowNode>();
  const spine: string[] = [];
  const overlays: string[] = [];
  const convertedTrackIds = new Set<string>();

  interface SpineSpan {
    nodeId: string;
    startFrame: number;
    endFrame: number;
    shot: FlowShotNode;
  }
  const spineSpans: SpineSpan[] = [];

  if (primaryVideoTrack) {
    convertedTrackIds.add(primaryVideoTrack.id);
    const sortedClips = [...primaryVideoTrack.clips].sort((a, b) => a.start - b.start);
    let prevEndFrame = 0;

    sortedClips.forEach((clip: Clip, idx: number) => {
      const nodeId = sanitizeFlowNodeId(clip.id, idx, usedNodeIds);
      const overlapFrames = idx > 0 && prevEndFrame > clip.start ? prevEndFrame - clip.start : 0;
      const visual = clip.sceneId
        ? {
            kind: 'scene' as const,
            sceneId: clip.sceneId,
            sourceIn: framesToSec(clip.sourceIn),
            speed: clip.speed,
          }
        : {
            kind: 'asset' as const,
            assetId: clip.assetId!,
            sourceIn: framesToSec(clip.sourceIn),
            speed: clip.speed,
            audioEnabled: clip.audioEnabled ?? true,
            volume: clip.volume,
          };

      const chapterMarker = seq.markers.find(
        (m) => m.kind === 'chapter' && Math.abs(m.frame - clip.start) <= 1,
      );

      const shot = flowNodeSchema.parse({
        kind: 'flow-node',
        version: 1,
        id: nodeId,
        type: 'shot',
        name: clip.name || nodeId,
        ...(chapterMarker ? { chapter: chapterMarker.label } : {}),
        visual,
        timing: {
          mode: 'fixed',
          frames: clip.duration,
        },
        ...(overlapFrames > 0
          ? {
              transitionIn: {
                type: 'dissolve',
                seconds: framesToSec(overlapFrames),
              },
            }
          : {}),
      }) as FlowShotNode;

      nodesById.set(nodeId, shot);
      spine.push(nodeId);
      spineSpans.push({
        nodeId,
        startFrame: clip.start,
        endFrame: clip.start + clip.duration,
        shot,
      });
      prevEndFrame = Math.max(prevEndFrame, clip.start + clip.duration);
    });
  }

  // Map secondary video tracks onto anchored B-Roll overlay nodes when a spine exists
  if (spineSpans.length > 0) {
    for (const track of secondaryVideoTracks) {
      convertedTrackIds.add(track.id);
      const sorted = [...track.clips].sort((a, b) => a.start - b.start);
      sorted.forEach((clip, idx) => {
        const anchor =
          spineSpans.find((s) => clip.start >= s.startFrame && clip.start < s.endFrame) ??
          spineSpans[spineSpans.length - 1];
        const nodeId = sanitizeFlowNodeId(`broll-${clip.id}`, idx, usedNodeIds);
        const visual = clip.sceneId
          ? {
              kind: 'scene' as const,
              sceneId: clip.sceneId,
              sourceIn: framesToSec(clip.sourceIn),
              speed: clip.speed,
            }
          : {
              kind: 'asset' as const,
              assetId: clip.assetId!,
              sourceIn: framesToSec(clip.sourceIn),
              speed: clip.speed,
              audioEnabled: false,
              volume: clip.volume,
            };
        const overlayNode = flowNodeSchema.parse({
          kind: 'flow-node',
          version: 1,
          id: nodeId,
          type: 'broll-overlay',
          name: clip.name || nodeId,
          anchor: {
            nodeId: anchor.nodeId,
            offsetSeconds: Math.max(0, framesToSec(clip.start - anchor.startFrame)),
            durationSeconds: Math.max(framesToSec(1), framesToSec(clip.duration)),
          },
          visual,
        }) as FlowBRollOverlayNode;
        nodesById.set(nodeId, overlayNode);
        overlays.push(nodeId);
      });
    }
  }

  // Map simple BGM / aligned voice audio tracks
  let soundBed: FlowDocument['soundBed'] | undefined;
  for (const track of seq.tracks) {
    if (track.type !== 'audio' || track.muted || track.locked || track.clips.length === 0) continue;
    if (
      !soundBed &&
      track.clips.length === 1 &&
      track.clips[0].assetId &&
      track.clips[0].start === 0 &&
      track.clips[0].duration >= Math.floor(seq.duration * 0.8)
    ) {
      const bgm = track.clips[0];
      soundBed = {
        assetId: bgm.assetId!,
        volume: bgm.volume,
        sourceIn: framesToSec(bgm.sourceIn),
        fadeInSeconds: framesToSec(bgm.fadeIn),
        fadeOutSeconds: framesToSec(bgm.fadeOut),
        ducking: {
          enabled: true,
          thresholdDb: -26,
          reductionDb: -10,
          attackMs: 60,
          releaseMs: 320,
        },
      };
      convertedTrackIds.add(track.id);
      continue;
    }

    // Check if every audio clip aligns cleanly inside a distinct spine shot without voice yet
    if (
      spineSpans.length > 0 &&
      track.clips.every((c) => Boolean(c.assetId)) &&
      track.clips.every((c) => {
        const owner = spineSpans.find(
          (s) => c.start >= s.startFrame && c.start < s.endFrame && !s.shot.voice,
        );
        return Boolean(owner);
      })
    ) {
      const assigned = new Set<string>();
      let canConvertAll = true;
      for (const c of track.clips) {
        const owner = spineSpans.find(
          (s) => c.start >= s.startFrame && c.start < s.endFrame && !assigned.has(s.nodeId),
        );
        if (!owner) {
          canConvertAll = false;
          break;
        }
        assigned.add(owner.nodeId);
      }
      if (canConvertAll) {
        for (const c of track.clips) {
          const owner = spineSpans.find((s) => c.start >= s.startFrame && c.start < s.endFrame)!;
          owner.shot = flowNodeSchema.parse({
            ...owner.shot,
            timing: {
              ...owner.shot.timing,
              padStart: Math.max(0, framesToSec(c.start - owner.startFrame)),
            },
            voice: {
              kind: 'asset',
              assetId: c.assetId!,
              sourceIn: framesToSec(c.sourceIn),
              duration: Math.max(framesToSec(1), framesToSec(c.duration)),
              volume: c.volume,
              fadeIn: framesToSec(c.fadeIn),
              fadeOut: framesToSec(c.fadeOut),
            },
          }) as FlowShotNode;
          nodesById.set(owner.nodeId, owner.shot);
        }
        convertedTrackIds.add(track.id);
      }
    }
  }

  const nextFiles = { ...snapshot.files };
  const createdNodes = [...nodesById.keys()];

  if (split) {
    const nodesDir = flowNodesDir(outFlowPath);
    const doc = flowDocumentSchema.parse({
      kind: 'flow',
      version: 1,
      id: flowId,
      name: seq.name,
      spine,
      overlays,
      variables: {},
      ...(soundBed ? { soundBed } : {}),
    });
    nextFiles[outFlowPath] = json(doc);
    for (const [id, node] of nodesById.entries()) {
      nextFiles[path.posix.join(nodesDir, `${id}.json`)] = json(node);
    }
  } else {
    const inlineNodes: Record<string, FlowNode> = {};
    for (const [id, node] of nodesById.entries()) inlineNodes[id] = node;
    const doc = flowDocumentSchema.parse({
      kind: 'flow',
      version: 1,
      id: flowId,
      name: seq.name,
      spine,
      overlays,
      variables: {},
      ...(soundBed ? { soundBed } : {}),
      nodes: inlineNodes,
    });
    nextFiles[outFlowPath] = json(doc);
  }

  if (options.mount ?? true) {
    const remainingTracks = seq.tracks.filter((t) => !convertedTrackIds.has(t.id));
    const remainingDuration = Math.max(
      1,
      seq.workArea?.end ?? 1,
      ...remainingTracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)),
    );
    const mountedSeq = sequenceSchema.parse({
      ...seq,
      duration: remainingDuration,
      tracks: remainingTracks,
      flowSource: outFlowPath,
    });
    nextFiles[seqFile] = json(mountedSeq);
  }

  return {
    files: nextFiles,
    flowId,
    flowPath: outFlowPath,
    createdNodes,
  };
}

/**
 * Maps a traditional timeline clip edit (trim, reorder, overlay move, enable/disable)
 * on a Flow-managed track back into a pinpoint edit on ONLY the affected `nodes/<id>.json` or `flow.json`.
 */
export function applyTimelineEditToFlow(
  files: Record<string, string>,
  flowPath: string,
  edit: TimelineFlowEdit,
  fps: { num: number; den: number },
): {
  files: Record<string, string>;
  touchedFiles: string[];
  summary: string;
} {
  const bundle = resolveFlowBundle(files, flowPath);
  const nextFiles = { ...files };

  if (edit.op === 'reorderSpine') {
    for (const id of edit.spine) {
      const entry = bundle.entries.get(id);
      if (!entry) {
        throw new VmotionError('FLOW_MISSING_NODE', `Cannot reorder missing flow node "${id}"`, {
          flowPath,
          nodeId: id,
        });
      }
      if (entry.rawNode.type === 'broll-overlay') {
        throw new VmotionError(
          'FLOW_ROLE_MISMATCH',
          `Overlay node "${id}" cannot be placed in spine[]`,
          { flowPath, nodeId: id },
        );
      }
    }
    const nextDoc = flowDocumentSchema.parse({
      ...bundle.document,
      spine: edit.spine,
    });
    nextFiles[bundle.flowPath] = json(nextDoc);
    return {
      files: nextFiles,
      touchedFiles: [bundle.flowPath],
      summary: `Reordered ${edit.spine.length} spine nodes in ${bundle.flowPath}`,
    };
  }

  const entry = bundle.entries.get(edit.nodeId);
  if (!entry) {
    throw new VmotionError(
      'FLOW_MISSING_NODE',
      `Flow node "${edit.nodeId}" does not exist in ${flowPath}`,
      { flowPath, nodeId: edit.nodeId },
    );
  }

  if (edit.op === 'toggleNode') {
    const updated = flowNodeSchema.parse({
      ...entry.rawNode,
      enabled: edit.enabled,
    });
    const res = writeNodeToBundleFiles(nextFiles, flowPath, updated, bundle.split);
    return {
      files: res.files,
      touchedFiles: [res.nodeFile],
      summary: `${edit.enabled ? 'Enabled' : 'Disabled'} flow node "${edit.nodeId}"`,
    };
  }

  if (edit.op === 'moveOverlay') {
    if (entry.rawNode.type !== 'broll-overlay') {
      throw new VmotionError(
        'FLOW_ROLE_MISMATCH',
        `moveOverlay requires a "broll-overlay" node, got "${entry.rawNode.type}"`,
        { flowPath, nodeId: edit.nodeId },
      );
    }
    const updated = flowNodeSchema.parse({
      ...entry.rawNode,
      anchor: {
        nodeId: edit.anchorNodeId,
        ...(edit.segmentId ? { segmentId: edit.segmentId } : {}),
        offsetSeconds: Math.max(0, edit.offsetSeconds),
        ...(edit.durationSeconds !== undefined
          ? { durationSeconds: edit.durationSeconds }
          : entry.rawNode.anchor.durationSeconds !== undefined
            ? { durationSeconds: entry.rawNode.anchor.durationSeconds }
            : {}),
      },
    });
    const res = writeNodeToBundleFiles(nextFiles, flowPath, updated, bundle.split);
    return {
      files: res.files,
      touchedFiles: [res.nodeFile],
      summary: `Moved B-roll node "${edit.nodeId}" onto "${edit.anchorNodeId}" (+${edit.offsetSeconds}s)`,
    };
  }

  // edit.op === 'trimNode'
  const raw = structuredClone(entry.rawNode);
  const seconds =
    edit.durationSeconds ??
    (edit.durationFrames !== undefined
      ? Number(((edit.durationFrames * fps.den) / fps.num).toFixed(4))
      : undefined);

  if (raw.type === 'shot') {
    const nextTiming: Record<string, unknown> = {
      ...raw.timing,
      mode: 'fixed',
    };
    if (edit.durationFrames !== undefined) {
      nextTiming.frames = edit.durationFrames;
      delete nextTiming.seconds;
    } else if (seconds !== undefined) {
      nextTiming.seconds = seconds;
      delete nextTiming.frames;
    }
    raw.timing = nextTiming as FlowShotNode['timing'];
    if (
      edit.sourceInSeconds !== undefined &&
      (raw.visual.kind === 'scene' || raw.visual.kind === 'asset')
    ) {
      raw.visual.sourceIn = Math.max(0, edit.sourceInSeconds);
    }
  } else if (raw.type === 'broll-overlay') {
    if (seconds !== undefined) {
      raw.anchor = { ...raw.anchor, durationSeconds: seconds };
    }
    if (
      edit.sourceInSeconds !== undefined &&
      (raw.visual.kind === 'scene' || raw.visual.kind === 'asset')
    ) {
      raw.visual.sourceIn = Math.max(0, edit.sourceInSeconds);
    }
  } else {
    throw new VmotionError(
      'FLOW_TRIM_UNSUPPORTED',
      `Node "${edit.nodeId}" of type "${raw.type}" uses segment/beat durations; edit its segments or beats instead of fixed frame trim`,
      { flowPath, nodeId: edit.nodeId, nodeType: raw.type },
    );
  }

  const updated = flowNodeSchema.parse(raw);
  const res = writeNodeToBundleFiles(nextFiles, flowPath, updated, bundle.split);
  return {
    files: res.files,
    touchedFiles: [res.nodeFile],
    summary: `Trimmed flow node "${edit.nodeId}" in ${res.nodeFile}`,
  };
}
