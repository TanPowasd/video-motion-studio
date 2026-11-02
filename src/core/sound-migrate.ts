import { VmotionError } from './model.js';
import {
  DEFAULT_PLAYLIST_TRACKS,
  MAX_PLAYLIST_TRACKS,
  MAX_SOUND_CLIPS,
  defaultPlaylistTracks,
  soundDocumentSchema,
  type SoundDocumentV1,
  type SoundInputV2,
} from './sound-schema.js';

/**
 * Sound document version 1 → version 2. Pure; takes a parsed (defaults applied) v1 document.
 *
 * Rules:
 * - `arrangement[{id, patternId, at, repeats}]` → `clips` of kind 'pattern', one per repeat,
 *   each `length = pattern.length`, `offset = 0`, at `at + r * pattern.length`. Repeat 0 keeps
 *   the clip id; repeat r > 0 is `${id}#${r}`. The expanded note id (and so each note's noise
 *   seed) is derived from that id, so a migrated document renders byte-identically.
 * - Lane = the pattern's index in `patterns` (the old Playlist drew one row per pattern).
 * - Track `automation[{property, keys}]` → one `automationClips` entry per track property
 *   (`auto-<trackId>-<property>`, linear points at the same times) and one 'automation'
 *   playlist clip at 0 spanning the score, on the lanes after the pattern lanes.
 * - `playlistTracks` = max(16, lanes used) default tracks; markers/timeSignatureChanges empty.
 */
export function migrateSoundV1(v1: SoundDocumentV1): SoundInputV2 {
  const { arrangement, patterns, tracks, version: _version, ...rest } = v1;
  void _version;
  const laneOf = new Map((patterns ?? []).map((p, i) => [p.id, i])),
    byId = new Map((patterns ?? []).map((p) => [p.id, p])),
    clips: NonNullable<SoundInputV2['clips']> = [],
    automationClips: NonNullable<SoundInputV2['automationClips']> = [];
  for (const clip of arrangement ?? []) {
    const p = byId.get(clip.patternId);
    if (!p)
      throw new VmotionError('SOUND_PATTERN', 'Arrangement references a missing pattern', {
        clipId: clip.id,
        patternId: clip.patternId,
      });
    for (let r = 0; r < clip.repeats; r++)
      clips.push({
        id: r ? `${clip.id}#${r}` : clip.id,
        kind: 'pattern',
        lane: laneOf.get(p.id)!,
        at: clip.at + r * p.length,
        length: p.length,
        offset: 0,
        muted: false,
        refId: p.id,
      });
  }
  let lane = patterns?.length ?? 0;
  const used = new Set(clips.map((c) => c.id));
  for (const track of tracks)
    for (const a of track.automation) {
      let autoId = `auto-${track.id}-${a.property}`;
      for (let k = 2; used.has(autoId); k++) autoId = `auto-${track.id}-${a.property}-${k}`;
      used.add(autoId);
      automationClips.push({
        id: autoId,
        target: { type: 'track', trackId: track.id, param: a.property },
        points: a.keys.map((k) => ({ at: k.at, value: k.value, curve: 'linear', tension: 0 })),
      });
      clips.push({
        id: autoId,
        kind: 'automation',
        lane: Math.min(lane++, MAX_PLAYLIST_TRACKS - 1),
        at: 0,
        length: v1.duration,
        offset: 0,
        muted: false,
        refId: autoId,
      });
    }
  if (clips.length > MAX_SOUND_CLIPS)
    throw new VmotionError(
      'SOUND_BUDGET',
      `Arrangement repeats expand to ${clips.length} clips; version 2 allows ${MAX_SOUND_CLIPS}`,
    );
  const lanes = Math.max(
    DEFAULT_PLAYLIST_TRACKS,
    Math.min(MAX_PLAYLIST_TRACKS, clips.reduce((m, c) => Math.max(m, (c.lane ?? 0) + 1), 0)),
  );
  return {
    ...rest,
    version: 2,
    timeSignatureChanges: [],
    tracks: tracks.map(({ automation: _a, ...t }) => (void _a, t)),
    ...(patterns ? { patterns } : {}),
    playlistTracks: defaultPlaylistTracks(lanes),
    clips,
    automationClips,
    markers: [],
  };
}

/** Parse any accepted sound input (version 1 or 2) and return the version-2 document. */
export function upgradeSoundDocument(raw: unknown) {
  return soundDocumentSchema.parse(raw);
}
