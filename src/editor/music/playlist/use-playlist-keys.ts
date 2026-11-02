import { useEffect, useRef } from 'react';
import type { SoundDocument } from '../../../core/sound-schema.js';
import { duplicateClips, pasteClips, selectionSpan } from '../../../core/sound-playlist.js';
import type { MusicRun } from '../music-panel-types.js';
import { PLAYLIST_TOOLS, playlistViewMemory, type PlaylistTool } from './playlist-view.js';

/**
 * Playlist shortcuts while the Playlist tab is open: Delete/Backspace, Ctrl+C / Ctrl+V (at the
 * playhead, on the focused lane) / Ctrl+D (after the selection) / Ctrl+A, M (mute selection),
 * Escape, and tool keys E P B C D T. Inputs, selects and editable content are ignored, as is
 * a key another handler already consumed (e.g. the computer-keyboard MIDI performance).
 */
export function usePlaylistKeys(o: {
  doc: SoundDocument;
  run: MusicRun;
  busy: boolean;
  selection: string[];
  setSelection: (ids: string[]) => void;
  focusLane: number;
  playhead: () => number;
  setTool: (tool: PlaylistTool) => void;
}) {
  const ref = useRef(o);
  ref.current = o;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const c = ref.current,
        target = e.target as HTMLElement;
      if (
        e.defaultPrevented ||
        c.busy ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
        target.isContentEditable ||
        target.closest?.('.music-midi, [contenteditable]:not([contenteditable="false"])')
      )
        return;
      const ctrl = e.ctrlKey || e.metaKey,
        k = e.key.toLowerCase(),
        chosen = c.doc.clips.filter((x) => c.selection.includes(x.id));
      const fresh = () => crypto.randomUUID();
      if ((e.key === 'Delete' || e.key === 'Backspace') && chosen.length) {
        e.preventDefault();
        c.run({ type: 'removeClips', ids: chosen.map((x) => x.id) });
        c.setSelection([]);
      } else if (ctrl && k === 'c' && chosen.length) {
        e.preventDefault();
        playlistViewMemory.clipboard = chosen.map((x) => ({ ...x }));
      } else if (ctrl && k === 'x' && chosen.length) {
        e.preventDefault();
        playlistViewMemory.clipboard = chosen.map((x) => ({ ...x }));
        c.run({ type: 'removeClips', ids: chosen.map((x) => x.id) });
        c.setSelection([]);
      } else if (ctrl && k === 'v' && playlistViewMemory.clipboard.length) {
        e.preventDefault();
        const valid = playlistViewMemory.clipboard.filter(
          (x) =>
            x.kind === 'audio' ||
            (x.kind === 'pattern' && c.doc.patterns?.some((p) => p.id === x.refId)) ||
            (x.kind === 'automation' && c.doc.automationClips.some((a) => a.id === x.refId)),
        );
        const pasted = pasteClips(c.doc, valid, c.playhead(), c.focusLane, fresh);
        if (pasted.length) {
          c.run({ type: 'addClips', clips: pasted });
          c.setSelection(pasted.map((x) => x.id));
        }
      } else if (ctrl && k === 'd' && chosen.length) {
        e.preventDefault();
        const copies = duplicateClips(c.doc, chosen, selectionSpan(chosen).length, fresh);
        if (copies.length) {
          c.run({ type: 'addClips', clips: copies });
          c.setSelection(copies.map((x) => x.id));
        }
      } else if (ctrl && k === 'a') {
        e.preventDefault();
        c.setSelection(c.doc.clips.map((x) => x.id));
      } else if (e.key === 'Escape') c.setSelection([]);
      else if (!ctrl && !e.altKey && !e.shiftKey && !e.repeat)
        // Letter keys: let other window handlers (MIDI computer keyboard) claim them first.
        setTimeout(() => {
          if (e.defaultPrevented) return;
          if (k === 'm' && chosen.length) {
            const muted = !chosen.every((x) => x.muted);
            c.run({
              type: 'updateClips',
              updates: chosen.map((x) => ({ id: x.id, patch: { muted } })),
            });
            return;
          }
          const tool = PLAYLIST_TOOLS.find((t) => t.key.toLowerCase() === k);
          if (tool) c.setTool(tool.id);
        }, 0);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
}
