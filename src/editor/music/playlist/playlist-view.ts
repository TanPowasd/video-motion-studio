import type { PlaylistTrack, SoundClip, SoundDocument } from '../../../core/sound-schema.js';
import type { PlaylistSnap } from '../../../core/sound-playlist.js';

/**
 * Playlist view state and geometry (P3). Nothing here enters the document or undo: zoom, snap,
 * tool, selection and the clip clipboard are editor state, kept per window session.
 */
export type PlaylistTool = 'select' | 'draw' | 'paint' | 'slice' | 'delete' | 'mute';
export const PLAYLIST_TOOLS: Array<{
  id: PlaylistTool;
  label: string;
  key: string;
  title: string;
}> = [
  { id: 'select', label: '选择', key: 'E', title: '选择/框选/拖动/裁剪边缘（E）' },
  { id: 'draw', label: '绘制', key: 'P', title: '点击放置当前 Pattern，右键删除（P）' },
  { id: 'paint', label: '刷绘', key: 'B', title: '拖动连续铺满当前 Pattern（B）' },
  { id: 'slice', label: '切分', key: 'C', title: '点击片段在该处切成两段（C）' },
  { id: 'delete', label: '删除', key: 'D', title: '点击或拖过片段删除（D）' },
  { id: 'mute', label: '静音', key: 'T', title: '点击片段切换静音（T）' },
];
export const PLAYLIST_SNAPS: Array<{ id: PlaylistSnap; label: string }> = [
  { id: 'bar', label: '小节' },
  { id: 'beat', label: '拍' },
  { id: 'step', label: '步' },
  { id: 'none', label: '无' },
];
/** Pixels per document unit at zoom 1; lane header width; ruler height. */
export const PX_PER_UNIT = 36,
  HEAD = 172,
  RULER = 30;
export const ZOOM_X = { min: 0.08, max: 8 },
  ZOOM_Y = { min: 0.4, max: 3 };

export interface PlaylistViewState {
  tool: PlaylistTool;
  snap: PlaylistSnap;
  zoomX: number;
  zoomY: number;
  /** Pattern placed by draw/paint. */
  patternId: string;
}
/** Survives tab switches (the panel unmounts) but not reloads. */
export const playlistViewMemory: { view?: PlaylistViewState; clipboard: SoundClip[] } = {
  clipboard: [],
};
export function defaultPlaylistView(doc: SoundDocument): PlaylistViewState {
  return {
    tool: 'draw',
    snap: 'beat',
    zoomX: 1,
    zoomY: 1,
    patternId: doc.patterns?.[0]?.id ?? '',
  };
}

/** Top offset of every lane (and the total height at index n), heights scaled by zoomY. */
export function laneOffsets(tracks: PlaylistTrack[], zoomY: number) {
  const out = new Float64Array(tracks.length + 1);
  for (let i = 0; i < tracks.length; i++)
    out[i + 1] = out[i] + Math.round(tracks[i].height * zoomY);
  return out;
}
/** Lane index under content y (clamped to the lane range). */
export function laneAt(offsets: Float64Array, y: number) {
  const n = offsets.length - 1;
  if (n <= 0) return 0;
  let lo = 0,
    hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, Math.min(n - 1, lo));
}
/** Lanes intersecting [top, bottom) plus `overscan` either side. */
export function visibleLanes(offsets: Float64Array, top: number, bottom: number, overscan = 3) {
  const n = offsets.length - 1;
  if (n <= 0) return { first: 0, last: -1 };
  return {
    first: Math.max(0, laneAt(offsets, top) - overscan),
    last: Math.min(n - 1, laneAt(offsets, bottom) + overscan),
  };
}
/** Ruler label step (in bars) so labels stay ≥ ~48 px apart. */
export function rulerBarStep(barPx: number) {
  for (const step of [1, 2, 4, 8, 16, 32, 64, 128]) if (barPx * step >= 48) return step;
  return 256;
}
export function clipsByLane(clips: SoundClip[]) {
  const map = new Map<number, SoundClip[]>();
  for (const c of clips) {
    const list = map.get(c.lane);
    if (list) list.push(c);
    else map.set(c.lane, [c]);
  }
  return map;
}
/** Seconds per document unit at `at` (1 for seconds documents). */
export function secondsPerUnit(doc: SoundDocument, toSeconds: (at: number) => number, at: number) {
  return doc.unit === 'beats' ? toSeconds(at + 1) - toSeconds(at) : 1;
}
