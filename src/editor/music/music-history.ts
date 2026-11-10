import type { SoundDocument } from '../../core/sound-schema.js';

/**
 * Command-level undo for the music editor. Each entry is one applied command (or one coalesced
 * run of them, such as a fader drag or typing a name) with the documents on either side of it.
 * Commands return structurally shared documents, so keeping both sides is cheap.
 * Selection, clipboard and view state (zoom, scroll, snap) never enter this stack.
 */
export const MUSIC_HISTORY_DEPTH = 200;
/** Consecutive commands with the same coalesce key closer than this merge into one entry. */
export const MUSIC_COALESCE_MS = 500;
export interface MusicHistoryEntry {
  /** Short description of the command(s), from the command layer's summary. */
  label: string;
  before: SoundDocument;
  after: SoundDocument;
  /** Coalesce key of the command that produced this entry, if any. */
  key?: string;
  /** Time of the last command merged into this entry (ms, caller's clock). */
  at: number;
}
export interface MusicHistory {
  past: MusicHistoryEntry[];
  future: MusicHistoryEntry[];
  /** False once undo/redo/save sealed the last entry, so a later command never merges into it. */
  open: boolean;
}
export const emptyMusicHistory: MusicHistory = { past: [], future: [], open: false };

/** Records a command. Merges into the last entry when the key matches within the window. */
export function pushMusicHistory(
  history: MusicHistory,
  entry: MusicHistoryEntry,
  depth = MUSIC_HISTORY_DEPTH,
  windowMs = MUSIC_COALESCE_MS,
): MusicHistory {
  const last = history.past.at(-1);
  if (
    history.open &&
    last &&
    entry.key !== undefined &&
    last.key === entry.key &&
    entry.at - last.at <= windowMs
  )
    return {
      past: [...history.past.slice(0, -1), { ...last, after: entry.after, at: entry.at }],
      future: [],
      open: true,
    };
  return {
    past: [...history.past, entry].slice(-depth),
    future: [],
    open: true,
  };
}
export function undoMusicHistory(
  history: MusicHistory,
): { history: MusicHistory; document: SoundDocument } | undefined {
  const last = history.past.at(-1);
  if (!last) return undefined;
  return {
    document: last.before,
    history: { past: history.past.slice(0, -1), future: [last, ...history.future], open: false },
  };
}
export function redoMusicHistory(
  history: MusicHistory,
): { history: MusicHistory; document: SoundDocument } | undefined {
  const next = history.future[0];
  if (!next) return undefined;
  return {
    document: next.after,
    history: { past: [...history.past, next], future: history.future.slice(1), open: false },
  };
}
