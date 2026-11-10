import { noteNumber, soundPreset, tempoClock } from '../../core/sound.js';
import {
  soundDocumentSchema,
  soundTrackSchema,
  type SoundDocument,
} from '../../core/sound-schema.js';
import { applySoundCommand, type SoundCommand } from '../../core/sound-commands.js';
import {
  emptyMusicHistory,
  pushMusicHistory,
  redoMusicHistory,
  undoMusicHistory,
  type MusicHistory,
} from './music-history.js';
// The pure edit helpers live in the command layer; re-exported so existing imports keep working.
export {
  moveMusicNotes,
  musicEvents,
  removeMusicTrack,
  setMusicEvents,
} from '../../core/sound-commands.js';

export const musicUrl = (id = '') => `#/music${id ? '/' + encodeURIComponent(id) : ''}`;
/** The explicit blank-song route. `#/music` alone opens the project's music instead. */
export const NEW_MUSIC_ROUTE = 'new';
/**
 * Which score `#/music` (Ctrl+4 / the mode pill) opens: the first sound asset placed in the
 * active sequence, else the first sound asset in the project. Undefined only when the project
 * has no score yet, and then music mode starts a blank song.
 */
export function defaultMusicAsset(snapshot: {
  project: { activeSequence?: string; assets: Array<{ id: string; soundSource?: string }> };
  sequences?: Array<{ id: string; tracks?: Array<{ clips: Array<{ assetId?: string }> }> }>;
}): string | undefined {
  const sounds = snapshot.project.assets.filter((a) => a.soundSource);
  if (!sounds.length) return undefined;
  const active = snapshot.sequences?.find((s) => s.id === snapshot.project.activeSequence),
    used = new Set(active?.tracks?.flatMap((t) => t.clips.map((c) => c.assetId)) ?? []);
  return (sounds.find((a) => used.has(a.id)) ?? sounds[0]).id;
}
export const noteLabel = (value: string | number) => {
  const n = Math.round(noteNumber(value));
  return (
    ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][n % 12] +
    (Math.floor(n / 12) - 1)
  );
};
export function newMusic(id: string): SoundDocument {
  return soundDocumentSchema.parse({
    kind: 'sound',
    version: 2,
    id,
    name: '新乐曲',
    duration: 16,
    tracks: [
      soundTrackSchema.parse({ id: 'lead', name: '旋律', instrument: soundPreset('pluck') }),
    ],
    patterns: [
      {
        id: 'pattern-1',
        name: 'Pattern 01',
        length: 4,
        channels: [
          {
            trackId: 'lead',
            events: [60, 64, 67, 72].map((note, i) => ({
              id: `note-${i}`,
              at: i,
              duration: 0.75,
              note,
              velocity: 0.7,
            })),
          },
        ],
      },
    ],
    clips: [0, 1, 2, 3].map((r) => ({
      id: `clip-${r + 1}`,
      kind: 'pattern' as const,
      lane: 0,
      at: r * 4,
      length: 4,
      refId: 'pattern-1',
    })),
    master: { effects: [{ type: 'limiter', ceilingDb: -1 }] },
  });
}
export function musicSeconds(doc: SoundDocument, at: number) {
  return doc.unit === 'beats' ? tempoClock(doc.tempo).beatSeconds(at) : at;
}
export function musicTime(doc: SoundDocument, seconds: number) {
  return doc.unit === 'beats' ? tempoClock(doc.tempo).secondsBeat(seconds) : seconds;
}
export interface MusicDraft extends MusicHistory {
  document: SoundDocument | undefined;
  saved: SoundDocument | undefined;
  trackId: string;
  patternId: string;
  selected: string[];
}
export const emptyMusicDraft: MusicDraft = {
  ...emptyMusicHistory,
  document: undefined,
  saved: undefined,
  trackId: '',
  patternId: '',
  selected: [],
};
export type MusicAction =
  | { type: 'load'; document: SoundDocument; saved?: SoundDocument }
  /** Whole-document edit (JSON draft, MIDI recording, plugin state): a `replaceDocument` command. */
  | { type: 'edit'; document: SoundDocument; coalesce?: string; now?: number }
  /** One command from the command layer. Same `coalesce` key within the window merges undo entries. */
  | { type: 'command'; command: SoundCommand; coalesce?: string; now?: number }
  | { type: 'saved'; document: SoundDocument }
  | { type: 'select'; trackId?: string; patternId?: string; selected?: string[] }
  | { type: 'undo' | 'redo' };
export function musicReducer(state: MusicDraft, action: MusicAction): MusicDraft {
  if (action.type === 'load')
    return {
      ...emptyMusicDraft,
      document: action.document,
      saved: action.saved,
      trackId: action.document.tracks[0]?.id ?? '',
      patternId: action.document.patterns?.[0]?.id ?? '',
    };
  if (action.type === 'edit' || action.type === 'command') {
    if (!state.document) return state;
    const command: SoundCommand =
      action.type === 'edit'
        ? { type: 'replaceDocument', document: action.document }
        : action.command;
    const result = applySoundCommand(state.document, command);
    if (
      result.doc === state.document ||
      JSON.stringify(state.document) === JSON.stringify(result.doc)
    )
      return state;
    return {
      ...state,
      ...pushMusicHistory(state, {
        label: result.summary,
        before: state.document,
        after: result.doc,
        key: action.coalesce,
        at: action.now ?? 0,
      }),
      document: result.doc,
    };
  }
  if (action.type === 'saved') return { ...state, ...emptyMusicHistory, saved: action.document };
  if (action.type === 'select')
    return {
      ...state,
      ...('trackId' in action ? { trackId: action.trackId!, selected: [] } : {}),
      ...('patternId' in action ? { patternId: action.patternId!, selected: [] } : {}),
      ...('selected' in action ? { selected: action.selected! } : {}),
    };
  const step =
    action.type === 'undo'
      ? undoMusicHistory(state)
      : action.type === 'redo'
        ? redoMusicHistory(state)
        : undefined;
  if (step) return { ...state, ...step.history, document: step.document };
  return state;
}
