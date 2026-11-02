import { noteNumber } from './sound.js';
import type { SoundDocument, SoundEvent, SoundPattern, SoundTrack } from './sound-schema.js';

/**
 * The music command layer: every edit to a sound document is a pure function
 * `(doc, params) -> { doc, summary }`. The music editor's undo stack, and the `sound` service
 * actions that mirror an editor edit, both go through these. Commands never mutate their input
 * and keep untouched branches by reference, so an undo history of whole documents stays cheap.
 *
 * Commands are lenient about stale ids (an unknown track, note, pattern or clip is a no-op that
 * returns the same document). Callers that must reject bad ids (the service) validate first.
 */
export type SoundBus = SoundDocument['buses'][number];
export type SoundClip = NonNullable<SoundDocument['arrangement']>[number];
export type SoundTempoPoint = SoundDocument['tempo'][number];
export type SoundMaster = SoundDocument['master'];
/** Document-level fields a `setSettings` command may patch (everything but identity and tracks). */
export type SoundSettingsPatch = Partial<Omit<SoundDocument, 'kind' | 'version' | 'id' | 'tracks'>>;
export type SoundTrackPatch = Partial<Omit<SoundTrack, 'id' | 'events'>>;
export type SoundEventPatch = Partial<Omit<SoundEvent, 'id'>>;
export const MAX_SOUND_TRACKS = 64;
export const MAX_SOUND_BUSES = 16;
export const MAX_SOUND_TEMPO_POINTS = 1000;

export type SoundCommand =
  | { type: 'replaceDocument'; document: SoundDocument }
  | { type: 'setSettings'; patch: SoundSettingsPatch }
  | { type: 'setBpm'; bpm: number }
  | { type: 'setTimeSignature'; timeSignature: SoundDocument['timeSignature'] }
  | { type: 'addTempo' }
  | { type: 'updateTempo'; index: number; beat?: number; bpm?: number }
  | { type: 'removeTempo'; index: number }
  | { type: 'addTracks'; tracks: SoundTrack[] }
  | { type: 'upsertTrack'; track: SoundTrack }
  | { type: 'updateTrack'; trackId: string; patch: SoundTrackPatch }
  | { type: 'removeTrack'; trackId: string }
  | { type: 'addBus'; bus: SoundBus }
  | { type: 'updateBus'; busId: string; patch: Partial<Omit<SoundBus, 'id'>> }
  | { type: 'updateMaster'; patch: Partial<SoundMaster> }
  | { type: 'setEvents'; trackId: string; patternId: string; events: SoundEvent[] }
  | { type: 'addNotes'; trackId: string; patternId: string; events: SoundEvent[] }
  | { type: 'removeNotes'; trackId: string; patternId: string; ids: string[] }
  | {
      type: 'updateNotes';
      trackId: string;
      patternId: string;
      updates: Array<{ id: string; patch: SoundEventPatch }>;
    }
  | {
      type: 'moveNotes';
      trackId: string;
      patternId: string;
      ids: string[];
      offset: number;
      transpose: number;
      limit: number;
    }
  | { type: 'upsertEvents'; trackId: string; patternId?: string; events: SoundEvent[] }
  | {
      type: 'transformEvents';
      trackId: string;
      patternId?: string;
      eventIds?: string[];
      offset?: number;
      timeScale?: number;
      transpose?: number;
      velocityScale?: number;
      quantize?: number;
      duplicate?: boolean;
      /** Ids for duplicated events, in order; defaults to `crypto.randomUUID()`. */
      newIds?: string[];
    }
  | { type: 'addPattern'; pattern: SoundPattern }
  | {
      type: 'updatePattern';
      patternId: string;
      patch: Partial<Pick<SoundPattern, 'name' | 'length'>>;
    }
  | { type: 'removePattern'; patternId: string }
  | { type: 'addClip'; clip: SoundClip }
  | { type: 'updateClip'; clipId: string; patch: Partial<Pick<SoundClip, 'at' | 'repeats'>> }
  | { type: 'removeClip'; clipId: string };
export type SoundCommandType = SoundCommand['type'];
export interface SoundCommandResult {
  doc: SoundDocument;
  summary: string;
}

// ---------------------------------------------------------------- event helpers (pure)

/** Events of one track: inside a pattern channel when `patternId` is set, else the track's own. */
export function musicEvents(doc: SoundDocument, trackId: string, patternId: string): SoundEvent[] {
  if (patternId)
    return (
      doc.patterns?.find((p) => p.id === patternId)?.channels.find((c) => c.trackId === trackId)
        ?.events ?? []
    );
  return doc.tracks.find((t) => t.id === trackId)?.events ?? [];
}
export function setMusicEvents(
  doc: SoundDocument,
  trackId: string,
  patternId: string,
  events: SoundEvent[],
): SoundDocument {
  if (!patternId)
    return { ...doc, tracks: doc.tracks.map((t) => (t.id === trackId ? { ...t, events } : t)) };
  return {
    ...doc,
    patterns: doc.patterns?.map((p) => {
      if (p.id !== patternId) return p;
      const exists = p.channels.some((c) => c.trackId === trackId);
      return {
        ...p,
        channels: exists
          ? p.channels.map((c) => (c.trackId === trackId ? { ...c, events } : c))
          : [...p.channels, { trackId, events }],
      };
    }),
  };
}
/** Move/transposes the selected notes as a block, clamped to [0, limit] and MIDI 0–127. */
export function moveMusicNotes(
  events: SoundEvent[],
  ids: string[],
  offset: number,
  transpose: number,
  limit: number,
): SoundEvent[] {
  const selected = events.filter((e) => ids.includes(e.id));
  if (!selected.length) return events;
  const minAt = Math.min(...selected.map((e) => e.at)),
    maxEnd = Math.max(...selected.map((e) => e.at + e.duration));
  const pitches = selected.flatMap((e) => [
    noteNumber(e.note),
    ...(e.endNote === undefined ? [] : [noteNumber(e.endNote)]),
  ]);
  const shift = Math.max(-minAt, Math.min(limit - maxEnd, offset));
  const pitch = Math.max(
    -Math.min(...pitches),
    Math.min(127 - Math.max(...pitches), Math.round(transpose)),
  );
  return events.map((e) =>
    ids.includes(e.id)
      ? {
          ...e,
          at: Number((e.at + shift).toFixed(6)),
          note: noteNumber(e.note) + pitch,
          ...(e.endNote === undefined ? {} : { endNote: noteNumber(e.endNote) + pitch }),
        }
      : e,
  );
}
/** Removes a track and its channels in every pattern. */
export function removeMusicTrack(doc: SoundDocument, trackId: string): SoundDocument {
  return {
    ...doc,
    tracks: doc.tracks.filter((t) => t.id !== trackId),
    patterns: doc.patterns?.map((p) => ({
      ...p,
      channels: p.channels.filter((c) => c.trackId !== trackId),
    })),
  };
}
/** The `sound` service's `transformEvents` arithmetic (scale, offset, quantize, transpose, velocity). */
export function transformMusicEvents(
  events: SoundEvent[],
  options: Omit<
    Extract<SoundCommand, { type: 'transformEvents' }>,
    'type' | 'trackId' | 'patternId'
  >,
): SoundEvent[] {
  const offset = options.offset ?? 0,
    timeScale = options.timeScale ?? 1,
    transpose = options.transpose ?? 0,
    velocityScale = options.velocityScale ?? 1;
  let fresh = 0;
  const next = events
    .filter((e) => !options.eventIds || options.eventIds.includes(e.id))
    .map((e) => ({
      ...e,
      id: options.duplicate ? (options.newIds?.[fresh++] ?? globalThis.crypto.randomUUID()) : e.id,
      at: options.quantize
        ? Math.round((e.at * timeScale + offset) / options.quantize) * options.quantize
        : e.at * timeScale + offset,
      duration: e.duration * timeScale,
      note: noteNumber(e.note) + transpose,
      ...(e.endNote === undefined ? {} : { endNote: noteNumber(e.endNote) + transpose }),
      velocity: Math.min(1, e.velocity * velocityScale),
    }));
  return options.duplicate
    ? [...events, ...next]
    : events.map((e) => next.find((n) => n.id === e.id) ?? e);
}

// ---------------------------------------------------------------- commands

const where = (patternId?: string) => (patternId ? `pattern ${patternId}` : 'score');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
function editEvents(
  doc: SoundDocument,
  trackId: string,
  patternId: string | undefined,
  change: (events: SoundEvent[]) => SoundEvent[],
): SoundDocument {
  if (!doc.tracks.some((t) => t.id === trackId)) return doc;
  if (patternId && !doc.patterns?.some((p) => p.id === patternId)) return doc;
  const before = musicEvents(doc, trackId, patternId ?? ''),
    after = change(before);
  return after === before ? doc : setMusicEvents(doc, trackId, patternId ?? '', after);
}
const mapId = <T extends { id: string }>(list: T[], id: string, change: (item: T) => T) =>
  list.some((item) => item.id === id)
    ? list.map((item) => (item.id === id ? change(item) : item))
    : list;

/** Applies one command. Pure: the input document is never mutated. */
export function applySoundCommand(doc: SoundDocument, command: SoundCommand): SoundCommandResult {
  switch (command.type) {
    case 'replaceDocument':
      return { doc: command.document, summary: 'Replace document' };
    case 'setSettings':
      return {
        doc: { ...doc, ...command.patch },
        summary: `Set ${Object.keys(command.patch).join(', ') || 'nothing'}`,
      };
    case 'setBpm':
      return {
        doc: {
          ...doc,
          tempo: doc.tempo.map((t, i) => (i === 0 ? { ...t, bpm: command.bpm } : t)),
        },
        summary: `Set BPM to ${command.bpm}`,
      };
    case 'setTimeSignature':
      return {
        doc: { ...doc, timeSignature: command.timeSignature },
        summary: `Set time signature to ${command.timeSignature.join('/')}`,
      };
    case 'addTempo': {
      if (doc.tempo.length >= MAX_SOUND_TEMPO_POINTS) return { doc, summary: 'Tempo map is full' };
      const last = doc.tempo.at(-1)!;
      return {
        doc: { ...doc, tempo: [...doc.tempo, { beat: last.beat + 4, bpm: last.bpm }] },
        summary: `Add tempo point at beat ${last.beat + 4}`,
      };
    }
    case 'updateTempo': {
      const point = doc.tempo[command.index];
      if (!point) return { doc, summary: 'No such tempo point' };
      // The first point stays anchored at beat 0.
      const beat = command.index && command.beat !== undefined ? command.beat : point.beat;
      if (beat === point.beat && (command.bpm ?? point.bpm) === point.bpm)
        return { doc, summary: 'Tempo point unchanged' };
      const tempo = doc.tempo.map((t, i) =>
        i === command.index ? { beat, bpm: command.bpm ?? t.bpm } : t,
      );
      if (beat !== point.beat) tempo.sort((a, b) => a.beat - b.beat);
      return { doc: { ...doc, tempo }, summary: `Update tempo point ${command.index}` };
    }
    case 'removeTempo':
      if (!command.index || !doc.tempo[command.index])
        return { doc, summary: 'The first tempo point cannot be removed' };
      return {
        doc: { ...doc, tempo: doc.tempo.filter((_, i) => i !== command.index) },
        summary: `Remove tempo point ${command.index}`,
      };
    case 'addTracks': {
      const room = Math.max(0, MAX_SOUND_TRACKS - doc.tracks.length),
        added = command.tracks.slice(0, room);
      if (!added.length) return { doc, summary: 'No track added' };
      return {
        doc: { ...doc, tracks: [...doc.tracks, ...added] },
        summary: `Add ${plural(added.length, 'track')}`,
      };
    }
    case 'upsertTrack': {
      const exists = doc.tracks.some((t) => t.id === command.track.id);
      return {
        doc: {
          ...doc,
          tracks: exists
            ? doc.tracks.map((t) => (t.id === command.track.id ? command.track : t))
            : [...doc.tracks, command.track],
        },
        summary: `${exists ? 'Replace' : 'Add'} track ${command.track.id}`,
      };
    }
    case 'updateTrack':
      return {
        doc: {
          ...doc,
          tracks: mapId(doc.tracks, command.trackId, (t) => ({ ...t, ...command.patch })),
        },
        summary: `Set ${Object.keys(command.patch).join(', ')} on track ${command.trackId}`,
      };
    case 'removeTrack':
      if (!doc.tracks.some((t) => t.id === command.trackId))
        return { doc, summary: 'No such track' };
      return {
        doc: removeMusicTrack(doc, command.trackId),
        summary: `Remove track ${command.trackId}`,
      };
    case 'addBus':
      if (doc.buses.length >= MAX_SOUND_BUSES) return { doc, summary: 'No bus added' };
      return {
        doc: { ...doc, buses: [...doc.buses, command.bus] },
        summary: `Add bus ${command.bus.id}`,
      };
    case 'updateBus':
      return {
        doc: {
          ...doc,
          buses: mapId(doc.buses, command.busId, (b) => ({ ...b, ...command.patch })),
        },
        summary: `Set ${Object.keys(command.patch).join(', ')} on bus ${command.busId}`,
      };
    case 'updateMaster':
      return {
        doc: { ...doc, master: { ...doc.master, ...command.patch } },
        summary: `Set ${Object.keys(command.patch).join(', ')} on master`,
      };
    case 'setEvents':
      return {
        doc: editEvents(doc, command.trackId, command.patternId, () => command.events),
        summary: `Set ${plural(command.events.length, 'note')} on ${command.trackId} in ${where(command.patternId)}`,
      };
    case 'addNotes':
      return {
        doc: editEvents(doc, command.trackId, command.patternId, (events) =>
          command.events.length ? [...events, ...command.events] : events,
        ),
        summary: `Add ${plural(command.events.length, 'note')} to ${command.trackId} in ${where(command.patternId)}`,
      };
    case 'removeNotes':
      return {
        doc: editEvents(doc, command.trackId, command.patternId, (events) =>
          events.some((e) => command.ids.includes(e.id))
            ? events.filter((e) => !command.ids.includes(e.id))
            : events,
        ),
        summary: `Remove ${plural(command.ids.length, 'note')} from ${command.trackId}`,
      };
    case 'updateNotes':
      return {
        doc: editEvents(doc, command.trackId, command.patternId, (events) =>
          events.map((e) => {
            const update = command.updates.find((u) => u.id === e.id);
            return update ? { ...e, ...update.patch } : e;
          }),
        ),
        summary: `Update ${plural(command.updates.length, 'note')} on ${command.trackId}`,
      };
    case 'moveNotes':
      return {
        doc: editEvents(doc, command.trackId, command.patternId, (events) =>
          moveMusicNotes(events, command.ids, command.offset, command.transpose, command.limit),
        ),
        summary: `Move ${plural(command.ids.length, 'note')} by ${command.offset} / ${command.transpose} st`,
      };
    case 'upsertEvents':
      return {
        doc: editEvents(doc, command.trackId, command.patternId, (events) => {
          const next = [...events];
          for (const event of command.events) {
            const i = next.findIndex((e) => e.id === event.id);
            if (i < 0) next.push(event);
            else next[i] = event;
          }
          return next;
        }),
        summary: `Upsert ${plural(command.events.length, 'event')} on ${command.trackId}`,
      };
    case 'transformEvents': {
      const { type: _type, trackId, patternId, ...options } = command;
      return {
        doc: editEvents(doc, trackId, patternId, (events) => transformMusicEvents(events, options)),
        summary: `${options.duplicate ? 'Duplicate' : 'Transform'} events on ${trackId}`,
      };
    }
    case 'addPattern':
      return {
        doc: { ...doc, patterns: [...(doc.patterns ?? []), command.pattern] },
        summary: `Add pattern ${command.pattern.name}`,
      };
    case 'updatePattern':
      if (!doc.patterns?.some((p) => p.id === command.patternId))
        return { doc, summary: 'No such pattern' };
      return {
        doc: {
          ...doc,
          patterns: mapId(doc.patterns, command.patternId, (p) => ({ ...p, ...command.patch })),
        },
        summary: `Set ${Object.keys(command.patch).join(', ')} on pattern ${command.patternId}`,
      };
    case 'removePattern':
      if (!doc.patterns?.some((p) => p.id === command.patternId))
        return { doc, summary: 'No such pattern' };
      return {
        doc: {
          ...doc,
          patterns: doc.patterns.filter((p) => p.id !== command.patternId),
          arrangement: doc.arrangement?.filter((c) => c.patternId !== command.patternId),
        },
        summary: `Remove pattern ${command.patternId} and its clips`,
      };
    case 'addClip':
      return {
        doc: { ...doc, arrangement: [...(doc.arrangement ?? []), command.clip] },
        summary: `Place ${command.clip.patternId} at ${command.clip.at}`,
      };
    case 'updateClip':
      if (!doc.arrangement?.some((c) => c.id === command.clipId))
        return { doc, summary: 'No such clip' };
      return {
        doc: {
          ...doc,
          arrangement: mapId(doc.arrangement, command.clipId, (c) => ({ ...c, ...command.patch })),
        },
        summary: `Set ${Object.keys(command.patch).join(', ')} on clip ${command.clipId}`,
      };
    case 'removeClip':
      if (!doc.arrangement?.some((c) => c.id === command.clipId))
        return { doc, summary: 'No such clip' };
      return {
        doc: { ...doc, arrangement: doc.arrangement.filter((c) => c.id !== command.clipId) },
        summary: `Remove clip ${command.clipId}`,
      };
  }
}
/** Applies commands in order; the summary joins each step's summary. */
export function applySoundCommands(
  doc: SoundDocument,
  commands: SoundCommand[],
): SoundCommandResult {
  const summaries: string[] = [];
  for (const command of commands) {
    const result = applySoundCommand(doc, command);
    doc = result.doc;
    summaries.push(result.summary);
  }
  return { doc, summary: summaries.join('; ') };
}
