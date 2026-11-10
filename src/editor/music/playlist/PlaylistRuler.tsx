import React, { useRef, useState } from 'react';
import type { SoundDocument } from '../../../core/sound-schema.js';
import { musicSeconds } from '../music-model.js';
import type { MusicPanelProps } from '../music-panel-types.js';
import { normalizeLoop, rulerUnitsAt } from '../transport.js';
import { HEAD, rulerBarStep } from './playlist-view.js';

/**
 * Playlist ruler (sticky top): bar numbers for the visible range, click to seek, Shift+drag to
 * set the loop region, markers (double-click empty ruler adds one, double-click a marker renames,
 * right-click a marker deletes). Only visible labels are rendered.
 */
export function PlaylistRuler({
  doc,
  m,
  run,
  busy,
  px,
  grid,
  scrollLeft,
  viewWidth,
}: Pick<MusicPanelProps, 'doc' | 'm' | 'run' | 'busy'> & {
  px: number;
  grid: number;
  scrollLeft: number;
  viewWidth: number;
}) {
  const loopGesture = useRef<{ pointer: number; from: number } | undefined>(undefined),
    [loopPreview, setLoopPreview] = useState<{ start: number; end: number } | null>();
  const bar = doc.unit === 'beats' ? (doc.timeSignature[0] * 4) / doc.timeSignature[1] : 1,
    step = rulerBarStep(bar * px),
    firstBar = Math.max(0, Math.floor((scrollLeft - HEAD) / px / bar / step) * step),
    lastBar = Math.min(
      Math.ceil(doc.duration / bar),
      Math.ceil((scrollLeft + viewWidth) / px / bar),
    );
  const at = (
    e: React.PointerEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>,
    snap = grid,
  ) =>
    rulerUnitsAt(e.clientX, {
      origin: e.currentTarget.getBoundingClientRect().left + HEAD,
      pxPerUnit: px,
      max: doc.duration,
      grid: snap,
    });
  const loop = loopPreview === undefined ? doc.loop : loopPreview;
  const setMarkers = (markers: SoundDocument['markers']) => run({ type: 'setMarkers', markers });
  const labels: number[] = [];
  for (let b = firstBar; b <= lastBar && labels.length < 400; b += step) labels.push(b);
  return (
    <div
      className="music-playlist-ruler"
      title="点击定位播放头 · Shift+拖动设置循环区 · 双击添加标记"
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as Element).closest('.music-marker, .music-ruler-corner'))
          return;
        if (e.shiftKey && !busy) {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          loopGesture.current = { pointer: e.pointerId, from: at(e) };
          setLoopPreview(null);
          return;
        }
        // Click seeks (snapped); when stopped this sets the start position.
        m.seek(musicSeconds(doc, at(e)));
      }}
      onPointerMove={(e) => {
        const g = loopGesture.current;
        if (!g || g.pointer !== e.pointerId) return;
        setLoopPreview(normalizeLoop(g.from, at(e), { max: doc.duration, grid }));
      }}
      onPointerUp={(e) => {
        const g = loopGesture.current;
        if (!g || g.pointer !== e.pointerId) return;
        loopGesture.current = undefined;
        const next = normalizeLoop(g.from, at(e), { max: doc.duration, grid });
        setLoopPreview(undefined);
        if (next && (next.start !== doc.loop?.start || next.end !== doc.loop?.end)) {
          m.setLoopRegion(next);
          if (!m.transport.loop) m.setTransport({ loop: true });
        }
      }}
      onPointerCancel={() => {
        loopGesture.current = undefined;
        setLoopPreview(undefined);
      }}
      onDoubleClick={(e) => {
        if (busy || (e.target as Element).closest('.music-marker, .music-ruler-corner')) return;
        const t = at(e);
        setMarkers([...doc.markers, { at: t, name: `标记 ${doc.markers.length + 1}` }]);
      }}
    >
      <div className="music-ruler-corner">
        {doc.unit === 'beats' ? '小节' : '秒'}
        <small>{doc.markers.length ? `${doc.markers.length} 个标记` : '双击标尺加标记'}</small>
      </div>
      {loop && (
        <b
          className={`music-loop-region ${m.transport.loop ? '' : 'off'}`}
          style={{ left: HEAD + loop.start * px, width: (loop.end - loop.start) * px }}
        />
      )}
      {labels.map((b) => (
        <span key={b} style={{ left: HEAD + b * bar * px }}>
          {doc.unit === 'beats' ? b + 1 : `${b}s`}
        </span>
      ))}
      {doc.markers.map((mk, i) => (
        <button
          key={i}
          className="music-marker"
          style={{ left: HEAD + mk.at * px }}
          aria-label={`标记 ${mk.name || i + 1}`}
          title={`${mk.name}（双击重命名，右键删除，点击定位）`}
          disabled={busy}
          onClick={() => m.seek(musicSeconds(doc, mk.at))}
          onDoubleClick={() => {
            const name = window.prompt('标记名称', mk.name);
            if (name === null) return;
            setMarkers(doc.markers.map((x, j) => (j === i ? { ...x, name } : x)));
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMarkers(doc.markers.filter((_, j) => j !== i));
          }}
        >
          {mk.name || '▾'}
        </button>
      ))}
    </div>
  );
}
