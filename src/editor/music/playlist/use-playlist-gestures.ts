import React, { useRef, useState } from 'react';
import type { SoundClip, SoundDocument } from '../../../core/sound-schema.js';
import {
  moveClips,
  paintClips,
  snapFloor,
  snapTime,
  trimClip,
  type ClipPatch,
} from '../../../core/sound-playlist.js';
import type { MusicRun } from '../music-panel-types.js';
import { HEAD, laneAt, type PlaylistTool } from './playlist-view.js';

/** What the lanes draw while a gesture is in flight (nothing here is in the document yet). */
export interface PlaylistPreview {
  patches?: Map<string, ClipPatch['patch']>;
  added?: SoundClip[];
  removed?: Set<string>;
  box?: { x: number; y: number; w: number; h: number };
}
type Gesture =
  | {
      kind: 'move';
      pointer: number;
      t0: number;
      lane0: number;
      ids: string[];
      anchor: string;
      dup: boolean;
      toggle?: string;
      moved: boolean;
    }
  | { kind: 'trim'; pointer: number; id: string; edge: 'left' | 'right'; moved: boolean }
  | { kind: 'box'; pointer: number; x0: number; y0: number; base: string[] }
  | { kind: 'paint'; pointer: number; lane: number; from: number }
  | { kind: 'erase'; pointer: number; ids: Set<string> };

export interface GestureContext {
  doc: SoundDocument;
  run: MusicRun;
  busy: boolean;
  tool: PlaylistTool;
  grid: number;
  px: number;
  offsets: Float64Array;
  selection: string[];
  setSelection: (ids: string[]) => void;
  setFocusLane: (lane: number) => void;
  /** Pattern used by draw/paint. */
  patternId: string;
  setPatternId: (id: string) => void;
  /** Source length (document units) of an audio clip's asset, if known. */
  audioSourceLength: (clip: SoundClip) => number | undefined;
  onOpen: (clip: SoundClip) => void;
}
const newId = () => crypto.randomUUID();

/**
 * Pointer handling for the Playlist lanes: tools, box select, move (Ctrl = duplicate), trim,
 * paint, erase, slice, mute. Drags preview locally and commit ONE command on release.
 */
export function usePlaylistGestures(c: GestureContext) {
  const gesture = useRef<Gesture | undefined>(undefined),
    [preview, setPreview] = useState<PlaylistPreview>({});
  const point = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect(),
      x = e.clientX - r.left - HEAD,
      y = e.clientY - r.top;
    return { x, y, t: Math.max(0, x / c.px), lane: laneAt(c.offsets, y) };
  };
  const clipAt = (lane: number, t: number) =>
    [...c.doc.clips].reverse().find((k) => k.lane === lane && t >= k.at && t < k.at + k.length);
  const pattern = () => c.doc.patterns?.find((p) => p.id === c.patternId) ?? c.doc.patterns?.[0];
  const minLength = (free: number) => (free > 0 ? free : 1 / 64);

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (c.busy || e.button === 1) return;
    const p = point(e);
    if (p.x < 0) return;
    c.setFocusLane(p.lane);
    const el = (e.target as Element).closest<HTMLElement>('[data-clip]'),
      clip = el ? c.doc.clips.find((k) => k.id === el.dataset.clip) : undefined,
      edge = (e.target as Element).closest<HTMLElement>('[data-edge]')?.dataset.edge as
        'left' | 'right' | undefined,
      free = e.altKey ? 0 : c.grid;
    if (e.button === 2) {
      // Right-click deletes in the drawing tools (FL habit); the menu is suppressed.
      if (clip && c.tool !== 'select') c.run({ type: 'removeClips', ids: [clip.id] });
      return;
    }
    const capture = () => e.currentTarget.setPointerCapture(e.pointerId);
    if (c.tool === 'slice') {
      if (clip)
        c.run({
          type: 'sliceClips',
          cuts: [{ clipId: clip.id, at: snapTime(p.t, free), newId: newId() }],
        });
      return;
    }
    if (c.tool === 'delete') {
      capture();
      gesture.current = {
        kind: 'erase',
        pointer: e.pointerId,
        ids: new Set(clip ? [clip.id] : []),
      };
      setPreview({ removed: new Set(clip ? [clip.id] : []) });
      return;
    }
    if (c.tool === 'mute') {
      if (!clip) return;
      const ids = c.selection.includes(clip.id) ? c.selection : [clip.id];
      c.run({
        type: 'updateClips',
        updates: ids.map((id) => ({ id, patch: { muted: !clip.muted } })),
      });
      return;
    }
    if (!clip) {
      const source = pattern();
      if ((c.tool === 'draw' || c.tool === 'paint') && source) {
        const at = snapFloor(p.t, free);
        if (c.tool === 'paint') {
          capture();
          gesture.current = { kind: 'paint', pointer: e.pointerId, lane: p.lane, from: at };
          setPreview({
            added: paintClips(
              c.doc,
              { kind: 'pattern', refId: source.id, length: source.length },
              p.lane,
              at,
              at,
              newId,
            ),
          });
          return;
        }
        if (at + source.length <= c.doc.duration + 1e-9) {
          const placed: SoundClip = {
            id: newId(),
            kind: 'pattern',
            lane: p.lane,
            at,
            length: source.length,
            offset: 0,
            muted: false,
            refId: source.id,
          };
          c.run({ type: 'addClips', clips: [placed] });
          c.setSelection([placed.id]);
        }
        return;
      }
      capture();
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      gesture.current = {
        kind: 'box',
        pointer: e.pointerId,
        x0: p.x,
        y0: p.y,
        base: additive ? c.selection : [],
      };
      if (!additive) c.setSelection([]);
      return;
    }
    if (clip.kind === 'pattern') c.setPatternId(clip.refId);
    capture();
    if (edge) {
      c.setSelection([clip.id]);
      gesture.current = { kind: 'trim', pointer: e.pointerId, id: clip.id, edge, moved: false };
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey,
      inSel = c.selection.includes(clip.id);
    if (e.shiftKey) {
      c.setSelection(
        inSel ? c.selection.filter((id) => id !== clip.id) : [...c.selection, clip.id],
      );
      return;
    }
    const ids = inSel ? c.selection : ctrl ? [...c.selection, clip.id] : [clip.id];
    if (!inSel && !ctrl) c.setSelection(ids);
    gesture.current = {
      kind: 'move',
      pointer: e.pointerId,
      t0: p.t,
      lane0: p.lane,
      ids,
      anchor: clip.id,
      dup: ctrl,
      toggle: ctrl ? clip.id : undefined,
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || g.pointer !== e.pointerId) return;
    const p = point(e),
      free = e.altKey ? 0 : c.grid;
    if (g.kind === 'move') {
      const patches = moveClips(
        c.doc,
        g.ids,
        { at: p.t - g.t0, lane: p.lane - g.lane0 },
        free,
        g.anchor,
      );
      g.moved ||= patches.length > 0;
      const map = new Map(patches.map((u) => [u.id, u.patch]));
      setPreview(
        g.dup
          ? {
              added: c.doc.clips
                .filter((k) => map.has(k.id))
                .map((k) => ({ ...k, ...map.get(k.id), id: 'dup:' + k.id })),
            }
          : { patches: map },
      );
    } else if (g.kind === 'trim') {
      const clip = c.doc.clips.find((k) => k.id === g.id);
      if (!clip) return;
      const patch = trimClip(clip, g.edge, snapTime(p.t, free), {
        minLength: minLength(free),
        duration: c.doc.duration,
        sourceLength: clip.kind === 'audio' ? c.audioSourceLength(clip) : undefined,
      });
      g.moved = true;
      setPreview({ patches: new Map([[clip.id, patch]]) });
    } else if (g.kind === 'box') {
      const x = Math.min(g.x0, p.x),
        y = Math.min(g.y0, p.y),
        w = Math.abs(p.x - g.x0),
        h = Math.abs(p.y - g.y0);
      const l0 = laneAt(c.offsets, y),
        l1 = laneAt(c.offsets, y + h),
        t0 = x / c.px,
        t1 = (x + w) / c.px;
      const hit = c.doc.clips
        .filter((k) => k.lane >= l0 && k.lane <= l1 && k.at < t1 && k.at + k.length > t0)
        .map((k) => k.id);
      c.setSelection([...new Set([...g.base, ...hit])]);
      setPreview({ box: { x, y, w, h } });
    } else if (g.kind === 'paint') {
      const source = pattern();
      if (!source) return;
      setPreview({
        added: paintClips(
          c.doc,
          { kind: 'pattern', refId: source.id, length: source.length },
          g.lane,
          g.from,
          snapFloor(p.t, free),
          newId,
        ),
      });
    } else if (g.kind === 'erase') {
      const hit = clipAt(p.lane, p.t);
      if (hit && !g.ids.has(hit.id)) {
        g.ids.add(hit.id);
        setPreview({ removed: new Set(g.ids) });
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || g.pointer !== e.pointerId) return;
    gesture.current = undefined;
    const current = preview;
    setPreview({});
    if (g.kind === 'move') {
      if (!g.moved) {
        if (g.toggle)
          c.setSelection(
            c.selection.includes(g.toggle)
              ? c.selection.filter((id) => id !== g.toggle)
              : [...c.selection, g.toggle],
          );
        return;
      }
      if (g.dup && current.added?.length) {
        const copies = current.added.map((k) => ({ ...k, id: newId() }));
        c.run({ type: 'addClips', clips: copies });
        c.setSelection(copies.map((k) => k.id));
      } else if (current.patches?.size)
        c.run({
          type: 'updateClips',
          updates: [...current.patches].map(([id, patch]) => ({ id, patch })),
        });
    } else if (g.kind === 'trim') {
      if (g.moved && current.patches?.size)
        c.run({
          type: 'updateClips',
          updates: [...current.patches].map(([id, patch]) => ({ id, patch })),
        });
    } else if (g.kind === 'paint') {
      if (current.added?.length) c.run({ type: 'addClips', clips: current.added });
    } else if (g.kind === 'erase') {
      if (g.ids.size) c.run({ type: 'removeClips', ids: [...g.ids] });
    }
  };
  const onPointerCancel = () => {
    gesture.current = undefined;
    setPreview({});
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLElement>) => {
    // Pointer capture retargets click/dblclick to the lanes body, so hit-test by position.
    const p = point(e);
    if (p.x < 0) return;
    const clip = clipAt(p.lane, p.t);
    if (clip) c.onOpen(clip);
  };
  return {
    preview,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onDoubleClick,
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    },
  };
}
