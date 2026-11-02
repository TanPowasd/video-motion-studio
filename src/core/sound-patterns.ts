import { VmotionError } from './model.js';
import type {
  AutomationClip,
  AutomationPoint,
  AutomationTarget,
  SoundClip,
  SoundDocument,
  SoundTrack,
} from './sound-schema.js';

/** Playlist clips that sound: not muted and on an unmuted playlist track. */
function audibleClips(document: SoundDocument, kind: SoundClip['kind']) {
  return document.clips.filter(
    (c) => c.kind === kind && !c.muted && !document.playlistTracks[c.lane]?.muted,
  );
}
/**
 * Seed key of an expanded pattern note: a clip id `x#r` (r > 0, as written by the v1 → v2
 * migration for repeat r) keys as [x, r]; any other id as [id, 0]. This keeps every note's
 * noise seed, and so the render, identical across the migration.
 */
function occurrence(clipId: string): [string, number] {
  const m = /^(.*)#([1-9]\d*)$/.exec(clipId);
  return m ? [m[1], Number(m[2])] : [clipId, 0];
}
function checkClip(document: SoundDocument, clip: SoundClip) {
  if (clip.lane >= document.playlistTracks.length)
    throw new VmotionError('SOUND_LANE', 'Clip lane has no playlist track', {
      clipId: clip.id,
      lane: clip.lane,
    });
  if (clip.at + clip.length > document.duration + 1e-8)
    throw new VmotionError('SOUND_RANGE', 'Clip extends beyond the score', { clipId: clip.id });
}

/** Resolve reusable patterns for every consumer; the canonical document stays editable. */
export function expandSoundTracks(document: SoundDocument): SoundTrack[] {
  const patterns = document.patterns ?? [],
    clips = document.clips,
    autos = document.automationClips;
  if (
    new Set(patterns.map((p) => p.id)).size !== patterns.length ||
    new Set(clips.map((c) => c.id)).size !== clips.length ||
    new Set(autos.map((a) => a.id)).size !== autos.length
  )
    throw new VmotionError('SOUND_ID', 'Pattern, clip and automation clip IDs must be unique');
  const byId = new Map(patterns.map((p) => [p.id, p])),
    tracks = new Map(document.tracks.map((t) => [t.id, t]));
  let declared = document.tracks.reduce((sum, t) => sum + t.events.length, 0);
  for (const pattern of patterns) {
    if (new Set(pattern.channels.map((c) => c.trackId)).size !== pattern.channels.length)
      throw new VmotionError('SOUND_PATTERN', 'Duplicate pattern channel', {
        patternId: pattern.id,
      });
    for (const channel of pattern.channels) {
      if (!tracks.has(channel.trackId))
        throw new VmotionError('SOUND_TRACK', 'Pattern channel references a missing track', {
          patternId: pattern.id,
          trackId: channel.trackId,
        });
      declared += channel.events.length;
      if (new Set(channel.events.map((e) => e.id)).size !== channel.events.length)
        throw new VmotionError('SOUND_ID', 'Duplicate pattern note IDs', {
          patternId: pattern.id,
          trackId: channel.trackId,
        });
      if (channel.events.some((e) => e.at + e.duration > pattern.length + 1e-8))
        throw new VmotionError('SOUND_RANGE', 'Pattern note extends beyond its length', {
          patternId: pattern.id,
        });
    }
  }
  if (declared > 20000)
    throw new VmotionError('SOUND_BUDGET', 'Declared score and pattern notes exceed 20000');
  for (const clip of clips) {
    checkClip(document, clip);
    if (clip.kind === 'pattern' && !byId.has(clip.refId))
      throw new VmotionError('SOUND_PATTERN', 'Clip references a missing pattern', {
        clipId: clip.id,
      });
  }
  const audio = audibleClips(document, 'audio');
  if (audio.length)
    throw new VmotionError(
      'SOUND_CLIP_KIND',
      'Audio clips are stored but not rendered yet; mute them or use a sample instrument',
      { clipIds: audio.map((c) => c.id) },
    );
  const placed = audibleClips(document, 'pattern');
  let total = document.tracks.reduce((sum, t) => sum + t.events.length, 0);
  for (const clip of placed) {
    const p = byId.get(clip.refId)!;
    total += p.channels.reduce((sum, c) => sum + c.events.length, 0);
    if (total > 20000)
      throw new VmotionError('SOUND_BUDGET', 'Expanded pattern notes exceed 20000');
  }
  if (!placed.length) return document.tracks;
  const expanded = new Map(document.tracks.map((t) => [t.id, { ...t, events: [...t.events] }]));
  for (const clip of placed) {
    const p = byId.get(clip.refId)!,
      [key, repeat] = occurrence(clip.id),
      start = clip.offset,
      end = clip.offset + clip.length;
    for (const channel of p.channels) {
      const t = expanded.get(channel.trackId)!;
      for (const event of channel.events) {
        if (event.at < start - 1e-9 || event.at >= end - 1e-9) continue;
        t.events.push({
          ...event,
          id: `pattern:${JSON.stringify([key, repeat, event.id])}`,
          at: clip.at + (event.at - start),
          duration: event.at + event.duration > end ? end - event.at : event.duration,
        });
      }
    }
  }
  return [...expanded.values()];
}

// ---------------------------------------------------------------- automation

export interface AutomationKey {
  at: number;
  value: number;
}
export function automationTargetKey(target: AutomationTarget): string {
  switch (target.type) {
    case 'track':
      return `track:${target.trackId}:${target.param}`;
    case 'bus':
      return `bus:${target.busId}:${target.param}`;
    case 'effect':
      return `effect:${target.ownerId}:${target.index}:${target.param}`;
    case 'synth':
      return `synth:${target.trackId}:${target.param}`;
    case 'plugin':
      return `plugin:${target.ownerId}:${target.slot}:${target.index}`;
    case 'tempo':
      return 'tempo';
  }
}
const CURVE_STEPS = 16;
function shape(point: AutomationPoint, t: number) {
  if (point.curve === 'smooth') return 0.5 - 0.5 * Math.cos(Math.PI * t);
  if (point.curve === 'tension') {
    const k = 1 + Math.abs(point.tension) * 4;
    return point.tension >= 0 ? t ** k : 1 - (1 - t) ** k;
  }
  return t;
}
/**
 * Automation points as linear keys in source time. 'linear' points pass through unchanged;
 * 'hold' adds a key just before the next point; 'smooth' and 'tension' segments are sampled
 * into 16 linear pieces (the renderer interpolates linearly between keys).
 */
export function automationLinearKeys(points: AutomationPoint[]): AutomationKey[] {
  const keys: AutomationKey[] = [];
  points.forEach((p, i) => {
    keys.push({ at: p.at, value: p.value });
    const next = points[i + 1];
    if (!next || next.at <= p.at || p.curve === 'linear') return;
    if (p.curve === 'hold') {
      keys.push({ at: next.at - Math.min(1e-6, (next.at - p.at) / 2), value: p.value });
      return;
    }
    for (let s = 1; s < CURVE_STEPS; s++) {
      const t = s / CURVE_STEPS;
      keys.push({ at: p.at + (next.at - p.at) * t, value: p.value + (next.value - p.value) * shape(p, t) });
    }
  });
  return keys;
}
function valueAt(keys: AutomationKey[], at: number) {
  if (at <= keys[0].at) return keys[0].value;
  for (let i = 1; i < keys.length; i++)
    if (at <= keys[i].at) {
      const a = keys[i - 1],
        b = keys[i];
      return b.at === a.at ? b.value : a.value + ((b.value - a.value) * (at - a.at)) / (b.at - a.at);
    }
  return keys[keys.length - 1].value;
}
/** Keys of one placed clip, trimmed to its window and moved to document time. */
function clipKeys(clip: SoundClip, auto: AutomationClip): AutomationKey[] {
  const keys = automationLinearKeys(auto.points),
    start = clip.offset,
    end = clip.offset + clip.length,
    inside = keys.filter((k) => k.at >= start && k.at <= end);
  if (keys[0].at < start && !inside.some((k) => k.at === start))
    inside.unshift({ at: start, value: valueAt(keys, start) });
  if (keys[keys.length - 1].at > end && !inside.some((k) => k.at === end))
    inside.push({ at: end, value: valueAt(keys, end) });
  return inside.map((k) => ({ at: clip.at + (k.at - start), value: k.value }));
}
/**
 * Placed automation, merged per target into linear keys in document time. Outside clips a
 * target holds its nearest key (as version-1 track automation did); where clips overlap the
 * later-starting clip wins.
 */
export function resolveSoundAutomation(document: SoundDocument) {
  const autos = new Map(document.automationClips.map((a) => [a.id, a])),
    out = new Map<string, { target: AutomationTarget; keys: AutomationKey[] }>();
  const placed = audibleClips(document, 'automation')
    .map((clip, index) => ({ clip, index }))
    .sort((a, b) => a.clip.at - b.clip.at || a.index - b.index);
  for (const { clip } of placed) {
    checkClip(document, clip);
    const auto = autos.get(clip.refId);
    if (!auto)
      throw new VmotionError('SOUND_AUTOMATION', 'Clip references a missing automation clip', {
        clipId: clip.id,
      });
    const keys = clipKeys(clip, auto);
    if (!keys.length) continue;
    const key = automationTargetKey(auto.target),
      entry = out.get(key) ?? { target: auto.target, keys: [] };
    entry.keys = [...entry.keys.filter((k) => k.at < keys[0].at), ...keys];
    out.set(key, entry);
  }
  return out;
}
/** Linear keys for a track's gain/pan, or undefined; editor helper. */
export function trackAutomationKeys(
  document: SoundDocument,
  trackId: string,
  param: 'gainDb' | 'pan',
): AutomationKey[] | undefined {
  return resolveSoundAutomation(document).get(`track:${trackId}:${param}`)?.keys;
}
/**
 * Tempo map with bpm automation applied (beats unit only): before the first automation key the
 * document tempo holds; from it on, automation keys become step changes, with sloped segments
 * stepped every quarter beat at their midpoint value.
 */
export function automatedTempo(
  document: SoundDocument,
  keys: AutomationKey[] | undefined,
): SoundDocument['tempo'] {
  if (!keys?.length || document.unit !== 'beats') return document.tempo;
  const tempo = document.tempo.filter((t) => t.beat < keys[0].at);
  for (let i = 0; i < keys.length; i++) {
    const a = keys[i],
      b = keys[i + 1];
    if (!b || b.value === a.value || b.at <= a.at) {
      tempo.push({ beat: a.at, bpm: a.value });
      continue;
    }
    const steps = Math.max(1, Math.ceil((b.at - a.at) / 0.25));
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps;
      tempo.push({ beat: a.at + ((b.at - a.at) * s) / steps, bpm: a.value + (b.value - a.value) * t });
    }
  }
  if (!tempo.length || tempo[0].beat !== 0) tempo.unshift({ beat: 0, bpm: keys[0].value });
  return tempo;
}
