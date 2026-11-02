import { noteNumber, stringSeed, tempoClock } from '../../../core/sound.js';
import {
  automatedTempo,
  expandSoundTracks,
  resolveSoundAutomation,
} from '../../../core/sound-patterns.js';
import type {
  AutomationTarget,
  SoundClip,
  SoundDocument,
  SoundInstrument,
} from '../../../core/sound-schema.js';

/**
 * The realtime engine's view of a score: the SAME expansion the offline renderer uses
 * (`expandSoundTracks`, `resolveSoundAutomation`, the automated tempo clock), flattened to
 * notes and automation keys in timeline seconds. Pure; no Web Audio.
 */
export type RealtimeMode = 'pattern' | 'song';
export interface RtNote {
  /** Stable key (track id + expanded event id); unique within a timeline. */
  key: string;
  trackId: string;
  /** Start in timeline seconds. */
  at: number;
  /** Gate length in seconds (key held). */
  gate: number;
  note: number;
  endNote: number;
  velocity: number;
  pan: number;
  /** Noise seed, computed as the offline renderer does. */
  seed: number;
}
export interface RtLane {
  key: string;
  target: AutomationTarget;
  keys: { seconds: number; value: number }[];
}
export interface RtTrack {
  id: string;
  instrument: SoundInstrument;
  gainDb: number;
  pan: number;
  enabled: boolean;
}
export interface RtTimeline {
  mode: RealtimeMode;
  patternId?: string;
  /** Notes sorted by start (then key). */
  notes: RtNote[];
  lanes: RtLane[];
  tracks: RtTrack[];
  /** Length of the playable range in seconds (song: score duration; pattern: pattern length). */
  length: number;
  /** Document units (beats or seconds) → timeline seconds, and back. */
  toSeconds: (units: number) => number;
  toUnits: (seconds: number) => number;
  /** Quarter-note beats at a timeline second (for bar:beat:tick). */
  beatsAt: (seconds: number) => number;
  timeSignature: [number, number];
}

const PATTERN_CLIP = '__realtime_pattern__';

function lowerBound<T>(list: T[], value: number, key: (v: T) => number) {
  let lo = 0,
    hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(list[mid]) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
export { lowerBound };

/** The document a pattern-mode timeline expands: that one pattern placed once at 0. */
function patternDocument(document: SoundDocument, patternId: string): SoundDocument {
  const pattern = (document.patterns ?? []).find((p) => p.id === patternId)!;
  const clip: SoundClip = {
    id: PATTERN_CLIP,
    kind: 'pattern',
    lane: 0,
    at: 0,
    length: pattern.length,
    offset: 0,
    muted: false,
    refId: pattern.id,
  } as SoundClip;
  return {
    ...document,
    duration: Math.max(document.duration, pattern.length),
    tracks: document.tracks.map((t) => ({ ...t, events: [] })),
    playlistTracks: [{ ...document.playlistTracks[0], muted: false }],
    clips: [clip],
    automationClips: [],
  };
}

export function buildRealtimeTimeline(
  document: SoundDocument,
  options: { mode: RealtimeMode; patternId?: string } = { mode: 'song' },
): RtTimeline {
  const patternId =
    options.mode === 'pattern'
      ? ((document.patterns ?? []).find((p) => p.id === options.patternId) ?? (document.patterns ?? [])[0])?.id
      : undefined;
  const mode: RealtimeMode = patternId ? 'pattern' : 'song';
  const source = patternId ? patternDocument(document, patternId) : document;
  // Pattern mode plays at the base tempo; song mode follows tempo automation like the render.
  const automation = mode === 'song' ? resolveSoundAutomation(source) : new Map();
  const clock = tempoClock(
    mode === 'song'
      ? automatedTempo(source, automation.get('tempo')?.keys)
      : [{ beat: 0, bpm: document.tempo[0].bpm }],
  );
  const beats = source.unit === 'beats';
  const toSeconds = (u: number) => (beats ? clock.beatSeconds(u) : u),
    toUnits = (s: number) => (beats ? clock.secondsBeat(s) : s),
    beatsAt = (s: number) => (beats ? clock.secondsBeat(s) : (s * document.tempo[0].bpm) / 60);
  const solo = source.tracks.some((t) => t.solo && !t.muted);
  const notes: RtNote[] = [];
  const tracks: RtTrack[] = [];
  for (const track of expandSoundTracks(source)) {
    const enabled = !track.muted && (!solo || !!track.solo);
    tracks.push({
      id: track.id,
      instrument: track.instrument,
      gainDb: track.gainDb,
      pan: track.pan,
      enabled,
    });
    if (!enabled) continue;
    for (const event of track.events) {
      const at = toSeconds(event.at),
        note = noteNumber(event.note);
      notes.push({
        key: `${track.id}\u0000${event.id}`,
        trackId: track.id,
        at,
        gate: toSeconds(event.at + event.duration) - at,
        note,
        endNote: event.endNote === undefined ? note : noteNumber(event.endNote),
        velocity: event.velocity,
        pan: event.pan,
        seed: stringSeed(`${document.seed}:${track.id}:${event.id}`),
      });
    }
  }
  notes.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const lanes: RtLane[] = [];
  for (const [key, entry] of automation) {
    // Only track gain/pan are voiced realtime (as offline); other targets are TODO.
    if (entry.target.type !== 'track') continue;
    lanes.push({
      key,
      target: entry.target,
      keys: entry.keys.map((k: { at: number; value: number }) => ({
        seconds: toSeconds(k.at),
        value: k.value,
      })),
    });
  }
  const length = patternId
    ? toSeconds((document.patterns ?? []).find((p) => p.id === patternId)!.length)
    : toSeconds(document.duration);
  return {
    mode,
    patternId,
    notes,
    lanes,
    tracks,
    length,
    toSeconds,
    toUnits,
    beatsAt,
    timeSignature: [document.timeSignature[0], document.timeSignature[1]],
  };
}

/** Linear value of a lane at a timeline second (holds outside its keys), as offline. */
export function laneValue(lane: RtLane, seconds: number) {
  const keys = lane.keys;
  if (!keys.length) return 0;
  if (seconds <= keys[0].seconds) return keys[0].value;
  const i = lowerBound(keys, seconds, (k) => k.seconds);
  if (i >= keys.length) return keys[keys.length - 1].value;
  const a = keys[i - 1],
    b = keys[i];
  return b.seconds === a.seconds
    ? b.value
    : a.value + ((b.value - a.value) * (seconds - a.seconds)) / (b.seconds - a.seconds);
}

export const TICKS_PER_BEAT = 96;
export interface RtPosition {
  seconds: number;
  /** Document units (beats or seconds). */
  units: number;
  bar: number;
  beat: number;
  tick: number;
  /** "bar:beat:tick", 1-based bar and beat, tick zero-padded to 2 digits. */
  label: string;
}
/** Bar:beat:tick at a timeline second; beats counted in the time signature's denominator. */
export function positionAt(timeline: RtTimeline, seconds: number): RtPosition {
  const [num, den] = timeline.timeSignature,
    quarter = Math.max(0, timeline.beatsAt(seconds)),
    beatLength = 4 / den,
    beatsTotal = quarter / beatLength + 1e-9,
    bar = Math.floor(beatsTotal / num) + 1,
    inBar = beatsTotal - (bar - 1) * num,
    beat = Math.floor(inBar) + 1,
    tick = Math.min(TICKS_PER_BEAT - 1, Math.floor((inBar - (beat - 1)) * TICKS_PER_BEAT));
  return {
    seconds,
    units: timeline.toUnits(seconds),
    bar,
    beat,
    tick,
    label: `${bar}:${beat}:${String(tick).padStart(2, '0')}`,
  };
}
