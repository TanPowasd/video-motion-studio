import React, { useRef, useState } from 'react';
import { noteNumber } from '../../../core/sound.js';
import { automationLinearKeys } from '../../../core/sound-patterns.js';
import { automationRange } from '../../../core/sound-playlist.js';
import type { PlaylistTrack, SoundClip, SoundDocument } from '../../../core/sound-schema.js';
import { colors, type MusicRun } from '../music-panel-types.js';
import { automationTargetLabel } from './AutomationEditor.js';

/** Sticky lane header: reorder handle, colour, name, mute, remove, height handle. */
export function PlaylistLaneHeader({
  doc,
  lane,
  track,
  height,
  zoomY,
  run,
  busy,
  laneFromY,
}: {
  doc: SoundDocument;
  lane: number;
  track: PlaylistTrack;
  height: number;
  zoomY: number;
  run: MusicRun;
  busy: boolean;
  /** Lane index under a client y (for drag-reorder). */
  laneFromY: (clientY: number) => number;
}) {
  const n = lane + 1;
  const reorder = useRef<{ pointer: number } | undefined>(undefined),
    resize = useRef<{ pointer: number; y: number; h: number } | undefined>(undefined),
    [target, setTarget] = useState<number>();
  const clipCount = doc.clips.reduce((s, c) => s + (c.lane === lane ? 1 : 0), 0);
  return (
    <div
      className={`music-lane-header ${track.muted ? 'muted' : ''} ${target !== undefined && target !== lane ? 'reordering' : ''}`}
      style={{ '--lane-color': track.color ?? colors[lane % colors.length] } as React.CSSProperties}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span
        className="music-lane-grip"
        title="拖动调整轨道顺序"
        aria-label={`拖动轨道 ${n}`}
        onPointerDown={(e) => {
          if (busy || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          reorder.current = { pointer: e.pointerId };
        }}
        onPointerMove={(e) => {
          if (reorder.current?.pointer === e.pointerId) setTarget(laneFromY(e.clientY));
        }}
        onPointerUp={(e) => {
          if (reorder.current?.pointer !== e.pointerId) return;
          reorder.current = undefined;
          const to = laneFromY(e.clientY);
          setTarget(undefined);
          if (to !== lane) run({ type: 'movePlaylistTrack', from: lane, to });
        }}
      >
        ⋮⋮
      </span>
      <input
        type="color"
        aria-label={`轨道 ${n} 颜色`}
        value={track.color ?? '#7aa2ff'}
        disabled={busy}
        onChange={(e) =>
          run(
            { type: 'updatePlaylistTrack', index: lane, patch: { color: e.target.value } },
            'lane-color:' + lane,
          )
        }
      />
      <input
        className="music-lane-name"
        aria-label={`轨道 ${n} 名称`}
        value={track.name}
        disabled={busy}
        onChange={(e) =>
          run(
            { type: 'updatePlaylistTrack', index: lane, patch: { name: e.target.value } },
            'lane-name:' + lane,
          )
        }
      />
      <button
        aria-label={`静音轨道 ${n}`}
        aria-pressed={track.muted}
        title="静音此轨道（片段保留）"
        disabled={busy}
        className={track.muted ? 'active' : ''}
        onClick={() =>
          run({ type: 'updatePlaylistTrack', index: lane, patch: { muted: !track.muted } })
        }
      >
        M
      </button>
      <button
        aria-label={`删除轨道 ${n}`}
        title={clipCount ? `删除轨道及其 ${clipCount} 个片段` : '删除轨道'}
        disabled={busy || doc.playlistTracks.length <= 1}
        onClick={() => {
          if (clipCount && !window.confirm(`删除轨道 ${n} 及其 ${clipCount} 个片段？`)) return;
          run({ type: 'removePlaylistTrack', index: lane });
        }}
      >
        ×
      </button>
      <i
        className="music-lane-resize"
        title="拖动调整轨道高度"
        onPointerDown={(e) => {
          if (busy || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          resize.current = { pointer: e.pointerId, y: e.clientY, h: height };
        }}
        onPointerMove={(e) => {
          const g = resize.current;
          if (!g || g.pointer !== e.pointerId) return;
          const next = Math.round(Math.max(16, Math.min(400, (g.h + e.clientY - g.y) / zoomY)));
          if (next !== track.height)
            run(
              { type: 'updatePlaylistTrack', index: lane, patch: { height: next } },
              'lane-height:' + lane,
            );
        }}
        onPointerUp={() => (resize.current = undefined)}
      />
    </div>
  );
}

/** One clip body: pattern mini-notes, automation curve, or audio summary, with trim edges. */
export function PlaylistClipView({
  doc,
  clip,
  px,
  height,
  selected,
  ghost,
  assetName,
}: {
  doc: SoundDocument;
  clip: SoundClip;
  px: number;
  height: number;
  selected: boolean;
  ghost?: boolean;
  assetName?: string;
}) {
  const pattern =
      clip.kind === 'pattern' ? doc.patterns?.find((p) => p.id === clip.refId) : undefined,
    auto =
      clip.kind === 'automation' ? doc.automationClips.find((a) => a.id === clip.refId) : undefined,
    index = pattern ? doc.patterns!.indexOf(pattern) : clip.lane,
    color =
      clip.color ??
      pattern?.color ??
      (clip.kind === 'audio' ? '#5fc8f4' : clip.kind === 'automation' ? '#57d6b0' : undefined) ??
      colors[index % colors.length],
    width = Math.max(6, clip.length * px - 1),
    label =
      pattern?.name ??
      (auto
        ? `自动化 · ${automationTargetLabel(doc, auto)}`
        : `${assetName ?? clip.refId}${clip.gainDb ? ` · ${clip.gainDb > 0 ? '+' : ''}${clip.gainDb} dB` : ''}`);
  const body = Math.max(0, height - 22);
  let content: React.ReactNode = null;
  if (pattern && body > 6) {
    const notes = pattern.channels
      .flatMap((ch) => ch.events)
      .filter((n) => n.at >= clip.offset && n.at < clip.offset + clip.length)
      .slice(0, 96);
    const pitches = notes.map((n) => noteNumber(n.note)),
      top = Math.max(...pitches, 0),
      range = Math.max(12, top - Math.min(...pitches, 127) + 1);
    content = (
      <div className="music-mini-notes" style={{ height: body }}>
        {notes.map((n, i) => (
          <i
            key={i}
            style={{
              left: `${((n.at - clip.offset) / clip.length) * 100}%`,
              top: `${((top - pitches[i]) / range) * (body - 3)}px`,
              width: `${Math.max(1, (n.duration / clip.length) * 100)}%`,
            }}
          />
        ))}
      </div>
    );
  } else if (auto && body > 6) {
    const [lo, hi] = automationRange(auto.target),
      keys = automationLinearKeys(auto.points),
      inWindow = keys.filter((k) => k.at >= clip.offset && k.at <= clip.offset + clip.length),
      shown = inWindow.length ? inWindow : keys;
    const pts = shown
      .map(
        (k) =>
          `${((k.at - clip.offset) / clip.length) * 100},${(1 - (k.value - lo) / (hi - lo)) * 100}`,
      )
      .join(' ');
    content = (
      <svg
        className="music-clip-curve"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{ height: body }}
      >
        <polyline points={pts} vectorEffect="non-scaling-stroke" />
      </svg>
    );
  } else if (clip.kind === 'audio' && body > 6) {
    // TODO(P3b): real waveform peaks from the decoded asset; a neutral pattern stands in.
    content = <div className="music-clip-audio" style={{ height: body }} />;
  }
  return (
    <div
      data-clip={ghost ? undefined : clip.id}
      role="button"
      aria-label={`${clip.kind === 'pattern' ? 'Pattern' : clip.kind === 'audio' ? '音频' : '自动化'}片段 ${label}`}
      aria-pressed={selected}
      className={`music-pattern-clip kind-${clip.kind} ${selected ? 'selected' : ''} ${clip.muted ? 'muted' : ''} ${ghost ? 'ghost' : ''}`}
      style={
        {
          left: 0,
          transform: `translateX(${clip.at * px}px)`,
          width,
          height: height - 6,
          '--pattern-color': color,
        } as React.CSSProperties
      }
    >
      <span>{label}</span>
      {content}
      {!ghost && width > 14 && (
        <>
          <i className="clip-edge left" data-edge="left" />
          <i className="clip-edge right" data-edge="right" />
        </>
      )}
    </div>
  );
}
