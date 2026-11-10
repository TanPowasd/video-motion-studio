import type {
  AutomationClip,
  PlaylistTrack,
  SoundClip,
  SoundDocument,
  SoundPattern,
} from './sound-schema.js';
import { MAX_PLAYLIST_TRACKS, playlistColors } from './sound-schema.js';

/**
 * Pure Playlist operations (P3): snapping, move, slice, trim, duplicate, paint, make unique,
 * and lane (playlist track) edits. All times are document units (beats or seconds). These do
 * the arithmetic; `sound-commands.ts` turns the results into undoable commands.
 */
export type PlaylistSnap = 'bar' | 'beat' | 'step' | 'none';
const EPS = 1e-9;
const round6 = (v: number) => Number(v.toFixed(6));

/** Size of one snap step in document units (0 for 'none'). Seconds documents: 1 s / 0.5 s / 0.125 s. */
export function snapSize(doc: Pick<SoundDocument, 'unit' | 'timeSignature'>, snap: PlaylistSnap) {
  if (snap === 'none') return 0;
  if (doc.unit !== 'beats') return snap === 'bar' ? 1 : snap === 'beat' ? 0.5 : 0.125;
  const [num, den] = doc.timeSignature,
    beat = 4 / den;
  return snap === 'bar' ? num * beat : snap === 'beat' ? beat : beat / 4;
}
/** Rounds `at` to the nearest multiple of `size` (no-op for size 0). */
export function snapTime(at: number, size: number) {
  return size > 0 ? round6(Math.round(at / size) * size) : round6(at);
}
/** Snaps down (floor) — used when placing a clip under the cursor. */
export function snapFloor(at: number, size: number) {
  return size > 0 ? round6(Math.floor(at / size + EPS) * size) : round6(at);
}

export interface ClipPatch {
  id: string;
  patch: Partial<
    Pick<SoundClip, 'at' | 'lane' | 'length' | 'offset' | 'muted' | 'color' | 'gainDb'>
  >;
}

/**
 * Moves the clips `ids` together by a pointer delta. The first selected clip (the anchor) lands
 * on the grid; the others keep their distance to it. The block is clamped to [0, duration] and
 * to the existing lanes.
 */
export function moveClips(
  doc: Pick<SoundDocument, 'clips' | 'duration' | 'playlistTracks'>,
  ids: string[],
  delta: { at: number; lane: number },
  grid: number,
  anchorId = ids[0],
): ClipPatch[] {
  const chosen = doc.clips.filter((c) => ids.includes(c.id));
  if (!chosen.length) return [];
  const anchor = chosen.find((c) => c.id === anchorId) ?? chosen[0],
    minAt = Math.min(...chosen.map((c) => c.at)),
    maxEnd = Math.max(...chosen.map((c) => c.at + c.length)),
    minLane = Math.min(...chosen.map((c) => c.lane)),
    maxLane = Math.max(...chosen.map((c) => c.lane));
  let shift = snapTime(anchor.at + delta.at, grid) - anchor.at;
  shift = Math.max(-minAt, Math.min(doc.duration - maxEnd, shift));
  const lanes = Math.max(-minLane, Math.min(doc.playlistTracks.length - 1 - maxLane, delta.lane));
  if (Math.abs(shift) < EPS && !lanes) return [];
  return chosen.map((c) => ({
    id: c.id,
    patch: { at: round6(c.at + shift), lane: c.lane + lanes },
  }));
}

/**
 * Splits a clip at document time `at` into two clips that play exactly what the original did:
 * the left keeps the id, the right gets `newId` and a larger offset. Undefined when `at` is not
 * strictly inside the clip.
 */
export function sliceClip(
  clip: SoundClip,
  at: number,
  newId: string,
): [SoundClip, SoundClip] | undefined {
  const cut = round6(at - clip.at);
  if (cut <= EPS || cut >= clip.length - EPS) return undefined;
  return [
    { ...clip, length: cut },
    {
      ...clip,
      id: newId,
      at: round6(clip.at + cut),
      offset: round6(clip.offset + cut),
      length: round6(clip.length - cut),
    },
  ];
}

/**
 * Trims one edge to document time `to`. Left trims move `at` and `offset` together (the content
 * stays put) and cannot reveal source before 0; right trims change `length`. `minLength` keeps
 * the clip at least that long; `sourceLength` (audio) caps offset+length.
 */
export function trimClip(
  clip: SoundClip,
  edge: 'left' | 'right',
  to: number,
  options: { minLength: number; duration: number; sourceLength?: number },
): ClipPatch['patch'] {
  const end = clip.at + clip.length,
    min = Math.max(options.minLength, 1e-6);
  if (edge === 'left') {
    // offset + length is constant on a left trim, so only offset >= 0 bounds it.
    let at = Math.max(0, clip.at - clip.offset, Math.min(end - min, to));
    at = round6(at);
    return { at, offset: round6(clip.offset + (at - clip.at)), length: round6(end - at) };
  }
  let length = Math.max(min, Math.min(options.duration - clip.at, to - clip.at));
  if (options.sourceLength !== undefined)
    length = Math.min(length, Math.max(min, options.sourceLength - clip.offset));
  return { length: round6(length) };
}

/** Span of a selection (min start → max end); Ctrl+D shifts the copies by it. */
export function selectionSpan(clips: SoundClip[]) {
  if (!clips.length) return { start: 0, end: 0, length: 0 };
  const start = Math.min(...clips.map((c) => c.at)),
    end = Math.max(...clips.map((c) => c.at + c.length));
  return { start, end, length: end - start };
}

/**
 * Copies of `clips` shifted by `shift` units and `laneShift` lanes, with fresh ids. Copies that
 * would leave the score or the lanes are dropped.
 */
export function duplicateClips(
  doc: Pick<SoundDocument, 'duration' | 'playlistTracks'>,
  clips: SoundClip[],
  shift: number,
  newId: () => string,
  laneShift = 0,
): SoundClip[] {
  return clips
    .map((c) => ({ ...c, id: newId(), at: round6(c.at + shift), lane: c.lane + laneShift }))
    .filter(
      (c) =>
        c.at >= -EPS &&
        c.at + c.length <= doc.duration + EPS &&
        c.lane >= 0 &&
        c.lane < doc.playlistTracks.length,
    );
}
/** Clips placed by a paste at `at` on `lane`: the clipboard keeps relative time/lane. */
export function pasteClips(
  doc: Pick<SoundDocument, 'duration' | 'playlistTracks'>,
  clipboard: SoundClip[],
  at: number,
  lane: number,
  newId: () => string,
): SoundClip[] {
  if (!clipboard.length) return [];
  const span = selectionSpan(clipboard),
    top = Math.min(...clipboard.map((c) => c.lane));
  return duplicateClips(doc, clipboard, at - span.start, newId, lane - top);
}

function overlaps(a: { at: number; length: number }, b: { at: number; length: number }) {
  return a.at < b.at + b.length - EPS && b.at < a.at + a.length - EPS;
}
/**
 * Paint (draw-drag): repeats of a source `length` long from `from` towards `to` on `lane`, each
 * starting where the previous ended. Slots overlapping an existing clip on that lane, or running
 * past the score, are skipped. Dragging left paints leftwards from `from`.
 */
export function paintClips(
  doc: Pick<SoundDocument, 'clips' | 'duration'>,
  source: { kind: SoundClip['kind']; refId: string; length: number },
  lane: number,
  from: number,
  to: number,
  newId: () => string,
): SoundClip[] {
  const step = source.length,
    out: SoundClip[] = [];
  if (step <= 0) return out;
  const count = Math.floor(Math.abs(to - from) / step + EPS) + 1,
    dir = to >= from ? 1 : -1;
  for (let i = 0; i < count && out.length < 4096; i++) {
    const at = round6(from + dir * i * step),
      slot = { at, length: step };
    if (at < -EPS || at + step > doc.duration + EPS) continue;
    if ([...doc.clips, ...out].some((c) => c.lane === lane && overlaps(c, slot))) continue;
    out.push({
      id: newId(),
      kind: source.kind,
      lane,
      at,
      length: step,
      offset: 0,
      muted: false,
      refId: source.refId,
    });
  }
  return out;
}

/** "Pattern 01" → "Pattern 01 #2" (first free suffix among `names`). */
export function uniqueName(name: string, names: string[]) {
  const base = name.replace(/ #\d+$/, '');
  for (let k = 2; ; k++) if (!names.includes(`${base} #${k}`)) return `${base} #${k}`;
}
/**
 * Make unique: clones the pattern a clip plays into `newPatternId` (same notes, length and
 * channels) and points just that clip at the clone, so later edits leave other instances alone.
 */
export function makeClipUnique(
  doc: SoundDocument,
  clipId: string,
  newPatternId: string,
): SoundDocument {
  const clip = doc.clips.find((c) => c.id === clipId);
  const pattern =
    clip?.kind === 'pattern' ? doc.patterns?.find((p) => p.id === clip.refId) : undefined;
  if (!clip || !pattern || (doc.patterns?.length ?? 0) >= 128) return doc;
  const clone: SoundPattern = {
    ...structuredClone(pattern),
    id: newPatternId,
    name: uniqueName(
      pattern.name,
      (doc.patterns ?? []).map((p) => p.name),
    ),
  };
  if (clone.autoLength) delete clone.autoLength;
  return {
    ...doc,
    patterns: [...(doc.patterns ?? []), clone],
    clips: doc.clips.map((c) => (c.id === clipId ? { ...c, refId: newPatternId } : c)),
  };
}

// ---------------------------------------------------------------- lanes

export function newPlaylistTrack(
  doc: Pick<SoundDocument, 'playlistTracks'>,
  id: string,
): PlaylistTrack {
  const n = doc.playlistTracks.length;
  return {
    id,
    name: `Track ${n + 1}`,
    color: playlistColors[n % playlistColors.length],
    muted: false,
    height: 56,
  };
}
/** Inserts lanes at `index`; clips on lanes ≥ index move down with them. */
export function insertPlaylistTracks(
  doc: SoundDocument,
  index: number,
  tracks: PlaylistTrack[],
): SoundDocument {
  const room = MAX_PLAYLIST_TRACKS - doc.playlistTracks.length,
    added = tracks.slice(0, Math.max(0, room));
  if (!added.length) return doc;
  const at = Math.max(0, Math.min(doc.playlistTracks.length, index));
  return {
    ...doc,
    playlistTracks: [...doc.playlistTracks.slice(0, at), ...added, ...doc.playlistTracks.slice(at)],
    clips: doc.clips.some((c) => c.lane >= at)
      ? doc.clips.map((c) => (c.lane >= at ? { ...c, lane: c.lane + added.length } : c))
      : doc.clips,
  };
}
/** Removes a lane and its clips; lanes below move up. The last lane cannot be removed. */
export function removePlaylistTrack(doc: SoundDocument, index: number): SoundDocument {
  if (doc.playlistTracks.length <= 1 || !doc.playlistTracks[index]) return doc;
  const droppedAutos = new Set(
    doc.clips.filter((c) => c.lane === index && c.kind === 'automation').map((c) => c.refId),
  );
  const clips = doc.clips
    .filter((c) => c.lane !== index)
    .map((c) => (c.lane > index ? { ...c, lane: c.lane - 1 } : c));
  // Automation sources no other clip places are dropped with their last placement.
  const stillPlaced = new Set(clips.filter((c) => c.kind === 'automation').map((c) => c.refId));
  return {
    ...doc,
    playlistTracks: doc.playlistTracks.filter((_, i) => i !== index),
    clips,
    automationClips: droppedAutos.size
      ? doc.automationClips.filter((a) => !droppedAutos.has(a.id) || stillPlaced.has(a.id))
      : doc.automationClips,
  };
}
/** Moves lane `from` to position `to`; clips follow their lane. */
export function movePlaylistTrack(doc: SoundDocument, from: number, to: number): SoundDocument {
  const n = doc.playlistTracks.length;
  if (from === to || !doc.playlistTracks[from] || to < 0 || to >= n) return doc;
  const order = doc.playlistTracks.map((_, i) => i);
  order.splice(to, 0, order.splice(from, 1)[0]);
  const where = new Map(order.map((old, i) => [old, i]));
  return {
    ...doc,
    playlistTracks: order.map((i) => doc.playlistTracks[i]),
    clips: doc.clips.map((c) =>
      where.get(c.lane) === c.lane ? c : { ...c, lane: where.get(c.lane)! },
    ),
  };
}

// ---------------------------------------------------------------- automation points

/** Points sorted by time with at clamped ≥ 0; the editor's normalisation after a drag. */
export function sortAutomationPoints(points: AutomationClip['points']) {
  return [...points]
    .map((p) => ({ ...p, at: Math.max(0, round6(p.at)) }))
    .sort((a, b) => a.at - b.at);
}
/** Value range used to draw/edit an automation target. */
export function automationRange(target: AutomationClip['target']): [number, number] {
  if (target.type === 'tempo') return [20, 400];
  if ('param' in target && target.param === 'pan') return [-1, 1];
  if ('param' in target && target.param === 'gainDb') return [-80, 24];
  return [0, 1];
}
