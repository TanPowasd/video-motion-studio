import { editSequence, sequenceActionSchema, type SequenceAction } from '../core/editing.js';
import type { FileEdit } from '../core/file-edits.js';
import {
  compileFlow,
  isVirtualFlowSceneFile,
  resolveFlowBundle,
} from '../core/flow-compiler.js';
import {
  applyTimelineEditToFlow,
  parseFlowClipId,
  writeNodeToBundleFiles,
} from '../core/flow-edit.js';
import { flowDocumentSchema, flowNodeIdSchema, flowNodeSchema } from '../core/flow-schema.js';
import { VmotionError, type Clip, type Operation, type Scene, type Snapshot } from '../core/model.js';
import { sequenceEditSchema } from './editing.js';
import { hash, json } from './project.js';

function baseProjectScenes(snapshot: Snapshot): Scene[] {
  return snapshot.scenes.filter((_, i) => !isVirtualFlowSceneFile(snapshot.project.scenes[i]));
}

function diffFilesToEdits(
  beforeFiles: Record<string, string>,
  afterFiles: Record<string, string>,
): FileEdit[] {
  const edits: FileEdit[] = [];
  const allPaths = [...new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)])].sort();
  for (const file of allPaths) {
    if (isVirtualFlowSceneFile(file)) continue;
    const prev = beforeFiles[file];
    const next = afterFiles[file];
    if (prev === next) continue;
    if (next === undefined) {
      if (prev !== undefined) {
        edits.push({ type: 'delete', path: file, expectedHash: hash(prev) });
      }
    } else {
      edits.push({
        type: 'replace',
        path: file,
        content: next,
        expectedHash: prev === undefined ? null : hash(prev),
      });
    }
  }
  return edits;
}

function maxSourceDurationFrames(
  snapshot: Snapshot,
  visual: { kind: string; sceneId?: string; assetId?: string },
): number | undefined {
  if (visual.kind === 'scene' && visual.sceneId) {
    return snapshot.scenes.find((s) => s.id === visual.sceneId)?.duration;
  }
  if (visual.kind === 'asset' && visual.assetId) {
    const asset = snapshot.project.assets.find((a) => a.id === visual.assetId);
    const seconds = Number(asset?.metadata.duration);
    if (Number.isFinite(seconds) && seconds > 0) {
      return (seconds * snapshot.project.fps.num) / snapshot.project.fps.den;
    }
  }
  return undefined;
}

function uniqueSplitNodeId(baseId: string, used: Set<string>): string {
  const stem = baseId.slice(0, 42);
  let suffix = 2;
  let candidate = `${stem}-${suffix}`;
  while (used.has(candidate) || !flowNodeIdSchema.safeParse(candidate).success) {
    suffix++;
    candidate = `${stem}-${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

function findFlowClipInTracks(
  tracks: Array<{ id: string; locked?: boolean; clips: Clip[] }>,
  clipId: string,
): { trackId: string; locked: boolean; clip: Clip } | undefined {
  for (const track of tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { trackId: track.id, locked: Boolean(track.locked), clip };
  }
  return undefined;
}

export interface FlowTimelineBridgeResult {
  operations: Operation[];
  expectedRevision: string;
  selection: string[];
  changes: Array<{ action: string; ids: string[] }>;
}

/**
 * Intercepts `sequenceEdit` when the target sequence mounts `flowSource` and one or more actions
 * target `flow/<flowId>/<nodeId>/*` clips. Translates those timeline interactions into pinpoint
 * `editFiles` operations on `nodes/<nodeId>.json` / `flow.json` (1 undo step), while preserving
 * non-flow actions on user tracks/markers.
 *
 * Returns `null` when the sequence has no `flowSource` or none of the actions touch `flow/*` clips.
 */
export function translateSequenceEditsForMountedFlow(
  snapshot: Snapshot,
  raw: unknown,
): FlowTimelineBridgeResult | null {
  const request = sequenceEditSchema.parse(raw);
  const seqId = request.sequenceId ?? snapshot.project.activeSequence;
  const sequence = snapshot.sequences.find((s) => s.id === seqId);
  if (!sequence?.flowSource) return null;

  const flowPath = sequence.flowSource;
  const baseScenes = baseProjectScenes(snapshot);
  const fps = snapshot.project.fps;

  const parsedActions = request.actions.map((a) => sequenceActionSchema.parse(a));

  const touchesFlow = parsedActions.some((action) => {
    if (action.type === 'trim') return parseFlowClipId(action.clipId) !== null;
    if (
      action.type === 'slip' ||
      action.type === 'move' ||
      action.type === 'remove' ||
      action.type === 'link' ||
      action.type === 'unlink'
    ) {
      return action.clipIds.some((id) => parseFlowClipId(id) !== null);
    }
    if (action.type === 'trackLock') return action.trackId.startsWith('flow/');
    if (action.type === 'split') {
      if (action.clipIds) return action.clipIds.some((id) => parseFlowClipId(id) !== null);
      return sequence.tracks.some(
        (t) =>
          t.id.startsWith('flow/') &&
          !t.locked &&
          t.clips.some((c) => action.frame > c.start && action.frame < c.start + c.duration),
      );
    }
    return false;
  });

  if (!touchesFlow) return null;

  let workingFiles: Record<string, string> = { ...snapshot.files };
  const nonFlowActions: SequenceAction[] = [];
  const selection: string[] = [];
  const changes: Array<{ action: string; ids: string[] }> = [];

  const recompile = () => {
    const bundle = resolveFlowBundle(workingFiles, flowPath, snapshot.project, baseScenes);
    const compiled = compileFlow(bundle, {
      project: snapshot.project,
      scenes: baseScenes,
      files: workingFiles,
    });
    return { bundle, compiled };
  };

  for (const action of parsedActions) {
    if (action.type === 'trackLock' && action.trackId.startsWith('flow/')) {
      throw new VmotionError(
        'FLOW_MANAGED_TRACK',
        `Track "${action.trackId}" is managed by Flow "${flowPath}"; lock or disable individual flow capsules instead`,
        { trackId: action.trackId, flowPath },
      );
    }
    if (
      (action.type === 'link' || action.type === 'unlink') &&
      action.clipIds.some((id) => parseFlowClipId(id) !== null)
    ) {
      throw new VmotionError(
        'FLOW_MANAGED_LINK',
        'Flow clips are automatically linked by capsule nodeId; edit voice/subtitle fields inside the capsule instead',
        { flowPath, clipIds: action.clipIds },
      );
    }

    if (action.type === 'trim') {
      const ref = parseFlowClipId(action.clipId);
      if (!ref) {
        nonFlowActions.push(action);
        continue;
      }
      const { bundle, compiled } = recompile();
      const hit = findFlowClipInTracks(compiled.tracks, action.clipId);
      if (!hit) throw new VmotionError('NOT_FOUND', `Clip ${action.clipId} not found`);
      const placement = compiled.placements.find((p) => p.nodeId === ref.nodeId);
      const entry = bundle.entries.get(ref.nodeId);
      if (!placement || !entry) {
        throw new VmotionError('FLOW_MISSING_NODE', `Flow node "${ref.nodeId}" not found`, {
          flowPath,
          nodeId: ref.nodeId,
        });
      }

      if (action.edge === 'out') {
        const nextDurationFrames = action.frame - placement.startFrame;
        if (nextDurationFrames <= 0) {
          throw new VmotionError(
            'EDIT_TRIM',
            'Trim would remove the entire clip or cross sequence start',
          );
        }
        if (entry.rawNode.type === 'shot' || entry.rawNode.type === 'broll-overlay') {
          const vis = entry.rawNode.visual;
          const speed = vis.kind === 'asset' ? (vis.speed ?? 1) : 1;
          const srcInFrames =
            vis.kind === 'scene' || vis.kind === 'asset'
              ? ((vis.sourceIn ?? 0) * fps.num) / fps.den
              : 0;
          const maxLen = maxSourceDurationFrames(snapshot, vis);
          if (
            maxLen !== undefined &&
            srcInFrames + (nextDurationFrames - 1) * speed >= maxLen + 1e-6
          ) {
            throw new VmotionError('EDIT_HANDLES', 'The edit exceeds the available source frames');
          }
        }
        const res = applyTimelineEditToFlow(
          workingFiles,
          flowPath,
          { op: 'trimNode', nodeId: ref.nodeId, durationFrames: nextDurationFrames },
          fps,
        );
        workingFiles = res.files;
      } else {
        // edge === 'in'
        if (action.frame < 0 || action.frame >= placement.endFrame) {
          throw new VmotionError(
            'EDIT_TRIM',
            'Trim would remove the entire clip or cross sequence start',
          );
        }
        const deltaFrames = action.frame - placement.startFrame;
        const nextDurationFrames = placement.endFrame - action.frame;
        let nextSourceInSeconds: number | undefined;

        if (entry.rawNode.type === 'shot' || entry.rawNode.type === 'broll-overlay') {
          const vis = entry.rawNode.visual;
          if (vis.kind === 'scene' || vis.kind === 'asset') {
            const speed = vis.kind === 'asset' ? (vis.speed ?? 1) : 1;
            const oldSrcIn = vis.sourceIn ?? 0;
            const candidateSrcIn = oldSrcIn + (deltaFrames * speed * fps.den) / fps.num;
            if (candidateSrcIn < -1e-6) {
              throw new VmotionError(
                'EDIT_HANDLES',
                'The edit exceeds the available source frames',
              );
            }
            const maxLen = maxSourceDurationFrames(snapshot, vis);
            const candidateSrcInFrames = (Math.max(0, candidateSrcIn) * fps.num) / fps.den;
            if (
              maxLen !== undefined &&
              candidateSrcInFrames + (nextDurationFrames - 1) * speed >= maxLen + 1e-6
            ) {
              throw new VmotionError(
                'EDIT_HANDLES',
                'The edit exceeds the available source frames',
              );
            }
            nextSourceInSeconds = Number(Math.max(0, candidateSrcIn).toFixed(4));
          }
        }

        let res = applyTimelineEditToFlow(
          workingFiles,
          flowPath,
          {
            op: 'trimNode',
            nodeId: ref.nodeId,
            durationFrames: nextDurationFrames,
            ...(nextSourceInSeconds !== undefined ? { sourceInSeconds: nextSourceInSeconds } : {}),
          },
          fps,
        );
        workingFiles = res.files;

        if (entry.rawNode.type === 'broll-overlay') {
          const nextOffset = Math.max(
            0,
            Number((entry.rawNode.anchor.offsetSeconds + (deltaFrames * fps.den) / fps.num).toFixed(4)),
          );
          res = applyTimelineEditToFlow(
            workingFiles,
            flowPath,
            {
              op: 'moveOverlay',
              nodeId: ref.nodeId,
              anchorNodeId: entry.rawNode.anchor.nodeId,
              ...(entry.rawNode.anchor.segmentId
                ? { segmentId: entry.rawNode.anchor.segmentId }
                : {}),
              offsetSeconds: nextOffset,
              durationSeconds: Number(((nextDurationFrames * fps.den) / fps.num).toFixed(4)),
            },
            fps,
          );
          workingFiles = res.files;
        }
      }

      selection.push(action.clipId);
      changes.push({ action: 'trim', ids: [action.clipId] });
      continue;
    }

    if (action.type === 'slip') {
      const flowClipIds = action.clipIds.filter((id) => parseFlowClipId(id) !== null);
      const userClipIds = action.clipIds.filter((id) => parseFlowClipId(id) === null);
      if (userClipIds.length) {
        nonFlowActions.push({ ...action, clipIds: userClipIds });
      }
      if (flowClipIds.length) {
        const { bundle, compiled } = recompile();
        const touchedNodes = new Set<string>();
        const touchedIds: string[] = [];
        for (const clipId of flowClipIds) {
          const ref = parseFlowClipId(clipId)!;
          if (touchedNodes.has(ref.nodeId)) {
            touchedIds.push(clipId);
            continue;
          }
          touchedNodes.add(ref.nodeId);
          const entry = bundle.entries.get(ref.nodeId);
          const placement = compiled.placements.find((p) => p.nodeId === ref.nodeId);
          if (!entry || !placement) {
            throw new VmotionError('NOT_FOUND', `Clip ${clipId} not found`);
          }
          if (entry.rawNode.type !== 'shot' && entry.rawNode.type !== 'broll-overlay') {
            throw new VmotionError(
              'FLOW_SLIP_UNSUPPORTED',
              `Slip is only supported on shot or broll-overlay nodes (got "${entry.rawNode.type}")`,
            );
          }
          const vis = entry.rawNode.visual;
          if (vis.kind !== 'scene' && vis.kind !== 'asset') {
            throw new VmotionError(
              'FLOW_SLIP_UNSUPPORTED',
              `Slip requires scene or asset visual source (got "${vis.kind}")`,
            );
          }
          const speed = vis.kind === 'asset' ? (vis.speed ?? 1) : 1;
          const oldSrcInFrames = ((vis.sourceIn ?? 0) * fps.num) / fps.den;
          const nextSrcInFrames = oldSrcInFrames + action.delta;
          const maxLen = maxSourceDurationFrames(snapshot, vis);
          if (
            nextSrcInFrames < -1e-6 ||
            (maxLen !== undefined &&
              nextSrcInFrames + (placement.durationFrames - 1) * speed >= maxLen + 1e-6)
          ) {
            throw new VmotionError('EDIT_HANDLES', 'The edit exceeds the available source frames');
          }
          const nextSourceInSeconds = Number(
            Math.max(0, (nextSrcInFrames * fps.den) / fps.num).toFixed(4),
          );
          const res = applyTimelineEditToFlow(
            workingFiles,
            flowPath,
            {
              op: 'trimNode',
              nodeId: ref.nodeId,
              durationFrames: placement.durationFrames,
              sourceInSeconds: nextSourceInSeconds,
            },
            fps,
          );
          workingFiles = res.files;
          touchedIds.push(clipId);
          selection.push(clipId);
        }
        changes.push({ action: 'slip', ids: touchedIds });
      }
      continue;
    }

    if (action.type === 'move') {
      const flowClipIds = action.clipIds.filter((id) => parseFlowClipId(id) !== null);
      const userClipIds = action.clipIds.filter((id) => parseFlowClipId(id) === null);
      if (userClipIds.length) {
        nonFlowActions.push({ ...action, clipIds: userClipIds });
      }
      if (flowClipIds.length) {
        const { bundle, compiled } = recompile();
        const touchedNodes = new Set<string>();
        const touchedIds: string[] = [];
        for (const clipId of flowClipIds) {
          const ref = parseFlowClipId(clipId)!;
          if (touchedNodes.has(ref.nodeId)) {
            touchedIds.push(clipId);
            continue;
          }
          touchedNodes.add(ref.nodeId);
          const placement = compiled.placements.find((p) => p.nodeId === ref.nodeId);
          const entry = bundle.entries.get(ref.nodeId);
          if (!placement || !entry) {
            throw new VmotionError('NOT_FOUND', `Clip ${clipId} not found`);
          }
          if (placement.startFrame + action.delta < 0) {
            throw new VmotionError('EDIT_RANGE', 'Move would cross sequence start');
          }

          if (placement.role === 'overlay' && entry.rawNode.type === 'broll-overlay') {
            const targetStartFrame = placement.startFrame + action.delta;
            const spinePlacements = compiled.placements.filter((p) => p.role === 'spine');
            const anchor =
              spinePlacements.find(
                (p) => targetStartFrame >= p.startFrame && targetStartFrame < p.endFrame,
              ) ??
              spinePlacements.at(-1);
            if (!anchor) {
              throw new VmotionError(
                'FLOW_ANCHOR_MISSING',
                'Cannot place B-roll overlay when spine has no active nodes',
              );
            }
            const offsetSeconds = Math.max(
              0,
              Number((((targetStartFrame - anchor.startFrame) * fps.den) / fps.num).toFixed(4)),
            );
            const res = applyTimelineEditToFlow(
              workingFiles,
              flowPath,
              {
                op: 'moveOverlay',
                nodeId: ref.nodeId,
                anchorNodeId: anchor.nodeId,
                offsetSeconds,
              },
              fps,
            );
            workingFiles = res.files;
          } else {
            // Reorder spine by comparing shifted midpoint against other spine nodes
            const currentSpine = [...bundle.document.spine];
            const spineMidpoints = currentSpine.map((id) => {
              const p = compiled.placements.find((sp) => sp.nodeId === id);
              if (!p) return { id, mid: Number.MAX_SAFE_INTEGER };
              const mid = (p.startFrame + p.endFrame) / 2 + (id === ref.nodeId ? action.delta : 0);
              return { id, mid };
            });
            spineMidpoints.sort((a, b) => a.mid - b.mid);
            const nextSpine = spineMidpoints.map((x) => x.id);
            const res = applyTimelineEditToFlow(
              workingFiles,
              flowPath,
              { op: 'reorderSpine', spine: nextSpine },
              fps,
            );
            workingFiles = res.files;
          }

          touchedIds.push(clipId);
          selection.push(clipId);
        }
        changes.push({ action: 'move', ids: touchedIds });
      }
      continue;
    }

    if (action.type === 'remove') {
      const flowClipIds = action.clipIds.filter((id) => parseFlowClipId(id) !== null);
      const userClipIds = action.clipIds.filter((id) => parseFlowClipId(id) === null);
      if (userClipIds.length) {
        nonFlowActions.push({ ...action, clipIds: userClipIds });
      }
      if (flowClipIds.length) {
        const { bundle } = recompile();
        const touchedIds: string[] = [];
        let nextSpine = [...bundle.document.spine];
        let nextOverlays = [...bundle.document.overlays];
        let topologyChanged = false;

        for (const clipId of flowClipIds) {
          const ref = parseFlowClipId(clipId)!;
          const entry = bundle.entries.get(ref.nodeId);
          if (!entry) throw new VmotionError('NOT_FOUND', `Clip ${clipId} not found`);

          if (!action.linked && ref.part === 'voice' && entry.rawNode.type === 'shot') {
            const rawClone = structuredClone(entry.rawNode) as Record<string, unknown>;
            delete rawClone.voice;
            const res = writeNodeToBundleFiles(
              workingFiles,
              flowPath,
              flowNodeSchema.parse(rawClone),
              bundle.split,
            );
            workingFiles = res.files;
            touchedIds.push(clipId);
            continue;
          }

          if (!action.linked && ref.part.startsWith('sub') && entry.rawNode.type === 'shot') {
            const updated = flowNodeSchema.parse({
              ...entry.rawNode,
              subtitle: { mode: 'none' },
            });
            const res = writeNodeToBundleFiles(workingFiles, flowPath, updated, bundle.split);
            workingFiles = res.files;
            touchedIds.push(clipId);
            continue;
          }

          if (nextSpine.includes(ref.nodeId)) {
            nextSpine = nextSpine.filter((id) => id !== ref.nodeId);
            topologyChanged = true;
          }
          if (nextOverlays.includes(ref.nodeId)) {
            nextOverlays = nextOverlays.filter((id) => id !== ref.nodeId);
            topologyChanged = true;
          }
          touchedIds.push(clipId);
        }

        if (topologyChanged) {
          const activeSpineSet = new Set(nextSpine);
          nextOverlays = nextOverlays.filter((ovId) => {
            const ovEntry = bundle.entries.get(ovId);
            if (ovEntry?.rawNode.type === 'broll-overlay') {
              return activeSpineSet.has(ovEntry.rawNode.anchor.nodeId);
            }
            return true;
          });
          const nextDoc = flowDocumentSchema.parse({
            ...bundle.document,
            spine: nextSpine,
            overlays: nextOverlays,
          });
          workingFiles[bundle.flowPath] = json(nextDoc);
        }
        changes.push({ action: 'remove', ids: touchedIds });
      }
      continue;
    }

    if (action.type === 'split') {
      const { bundle, compiled } = recompile();
      const targetFlowClips: Clip[] = [];
      const userClipIds: string[] = [];

      if (action.clipIds) {
        for (const id of action.clipIds) {
          if (parseFlowClipId(id)) {
            const hit = findFlowClipInTracks(compiled.tracks, id);
            if (!hit) throw new VmotionError('NOT_FOUND', `Clip ${id} not found`);
            targetFlowClips.push(hit.clip);
          } else {
            userClipIds.push(id);
          }
        }
        if (userClipIds.length) {
          nonFlowActions.push({ ...action, clipIds: userClipIds });
        }
      } else {
        for (const t of compiled.tracks) {
          if (t.locked || !t.id.includes('/video')) continue;
          for (const c of t.clips) {
            if (action.frame > c.start && action.frame < c.start + c.duration) {
              targetFlowClips.push(c);
            }
          }
        }
        const hasUserClipsAtFrame = sequence.tracks.some(
          (t) =>
            !t.id.startsWith('flow/') &&
            !t.locked &&
            t.clips.some((c) => action.frame > c.start && action.frame < c.start + c.duration),
        );
        if (hasUserClipsAtFrame) {
          const explicitUserIds = sequence.tracks
            .filter((t) => !t.id.startsWith('flow/') && !t.locked)
            .flatMap((t) =>
              t.clips
                .filter((c) => action.frame > c.start && action.frame < c.start + c.duration)
                .map((c) => c.id),
            );
          if (explicitUserIds.length) {
            nonFlowActions.push({ ...action, clipIds: explicitUserIds });
          }
        }
      }

      if (!targetFlowClips.length && !nonFlowActions.length) {
        throw new VmotionError('EDIT_SPLIT', 'The playhead is not inside a clip');
      }

      if (targetFlowClips.length) {
        const usedIds = new Set<string>(bundle.entries.keys());
        let nextSpine = [...bundle.document.spine];
        const touchedIds: string[] = [];

        const seenNodes = new Set<string>();
        for (const clip of targetFlowClips) {
          const ref = parseFlowClipId(clip.id);
          if (!ref || seenNodes.has(ref.nodeId)) continue;
          seenNodes.add(ref.nodeId);

          const placement = compiled.placements.find((p) => p.nodeId === ref.nodeId);
          const entry = bundle.entries.get(ref.nodeId);
          if (!placement || !entry) {
            throw new VmotionError('NOT_FOUND', `Flow node ${ref.nodeId} not found`);
          }
          if (action.frame <= placement.startFrame || action.frame >= placement.endFrame) {
            throw new VmotionError('EDIT_SPLIT', 'Split must be strictly inside each linked clip');
          }
          if (entry.rawNode.type !== 'shot') {
            throw new VmotionError(
              'FLOW_SPLIT_UNSUPPORTED',
              `Split at playhead is supported for "shot" nodes; "${ref.nodeId}" is "${entry.rawNode.type}"`,
            );
          }

          const leftFrames = action.frame - placement.startFrame;
          const rightFrames = placement.endFrame - action.frame;
          const rightId = uniqueSplitNodeId(ref.nodeId, usedIds);

          const leftNode = structuredClone(entry.rawNode);
          leftNode.timing = {
            ...leftNode.timing,
            mode: 'fixed',
            frames: leftFrames,
          };
          delete (leftNode.timing as Record<string, unknown>).seconds;

          const rightRaw: Record<string, unknown> = structuredClone(entry.rawNode) as unknown as Record<
            string,
            unknown
          >;
          rightRaw.id = rightId;
          if (typeof rightRaw.name === 'string' && rightRaw.name) {
            rightRaw.name = `${rightRaw.name} (2)`;
          }
          delete rightRaw.transitionIn;
          delete rightRaw.voice;
          rightRaw.overlays = [];
          rightRaw.timing = {
            mode: 'fixed',
            frames: rightFrames,
            padStart: 0,
            padEnd: 0,
          };

          if (
            entry.rawNode.visual.kind === 'scene' ||
            entry.rawNode.visual.kind === 'asset'
          ) {
            const speed =
              entry.rawNode.visual.kind === 'asset' ? (entry.rawNode.visual.speed ?? 1) : 1;
            const rightSourceIn = Number(
              (
                (entry.rawNode.visual.sourceIn ?? 0) +
                (leftFrames * speed * fps.den) / fps.num
              ).toFixed(4),
            );
            rightRaw.visual = {
              ...entry.rawNode.visual,
              sourceIn: rightSourceIn,
            };
          }

          let writeRes = writeNodeToBundleFiles(
            workingFiles,
            flowPath,
            flowNodeSchema.parse(leftNode),
            bundle.split,
          );
          workingFiles = writeRes.files;
          writeRes = writeNodeToBundleFiles(
            workingFiles,
            flowPath,
            flowNodeSchema.parse(rightRaw),
            bundle.split,
          );
          workingFiles = writeRes.files;

          const spineIdx = nextSpine.indexOf(ref.nodeId);
          if (spineIdx >= 0) {
            nextSpine.splice(spineIdx + 1, 0, rightId);
          }
          const rightClipId = `flow/${compiled.flowId}/${rightId}/v`;
          selection.push(rightClipId);
          touchedIds.push(clip.id, rightClipId);
        }

        const nextDoc = flowDocumentSchema.parse({
          ...bundle.document,
          spine: nextSpine,
        });
        workingFiles[bundle.flowPath] = json(nextDoc);
        changes.push({ action: 'split', ids: touchedIds });
      }
      continue;
    }

    nonFlowActions.push(action);
  }

  const operations: Operation[] = [];
  const fileEdits = diffFilesToEdits(snapshot.files, workingFiles);
  if (fileEdits.length > 0) {
    operations.push({ type: 'editFiles', edits: fileEdits });
  }

  if (nonFlowActions.length > 0) {
    const edited = editSequence(snapshot, sequence, nonFlowActions);
    operations.push({
      type: 'updateSequence',
      sequenceId: edited.sequence.id,
      patch: edited.sequence,
    });
    selection.push(...edited.selection);
    changes.push(...edited.changes);
  }

  return {
    operations,
    expectedRevision: request.revision ?? snapshot.revision,
    selection: [...new Set(selection)],
    changes,
  };
}
