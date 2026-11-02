import React, { useEffect, useState, useRef } from 'react';
import { noteNumber } from '../../core/sound.js';
import { musicSeconds, musicTime } from './music-model.js';
import { MusicNumber } from './MusicInspector.js';
import { colors, type MusicPanelProps } from './music-panel-types.js';
import type { SoundClip, SoundDocument } from '../../core/sound-schema.js';
import { followScroll, normalizeLoop, rulerUnitsAt } from './transport.js';

const PX = 36,
  HEAD = 120;

function patternClip(refId: string, lane: number, at: number, length: number): SoundClip {
  return {
    id: crypto.randomUUID(),
    kind: 'pattern',
    lane,
    at,
    length,
    offset: 0,
    muted: false,
    refId,
  };
}
function automationLabel(doc: SoundDocument, id: string) {
  const t = doc.automationClips.find((a) => a.id === id)?.target;
  if (!t) return id;
  return t.type === 'track'
    ? `${doc.tracks.find((x) => x.id === t.trackId)?.name ?? t.trackId} ${t.param === 'pan' ? '声像' : '音量'}`
    : t.type;
}
export function PlaylistPanel({
  doc,
  m,
  run,
  busy,
  grid,
  setTab,
}: Pick<MusicPanelProps, 'doc' | 'm' | 'run' | 'busy' | 'grid' | 'setTab'>) {
  const [clipSelection, setClipSelection] = useState(''),
    [clipPreview, setClipPreview] = useState<{ id: string; at: number }>();
  const laneCount = Math.min(
    doc.playlistTracks.length,
    Math.max(doc.patterns?.length ?? 0, ...doc.clips.map((c) => c.lane + 1)),
  );
  const clipGesture = useRef<{ id: string; x: number; at: number; pointer: number } | undefined>(
    undefined,
  );
  // Shift-drag on the ruler: loop region preview (document units) until pointer up.
  const loopGesture = useRef<{ pointer: number; from: number } | undefined>(undefined),
    [loopPreview, setLoopPreview] = useState<{ start: number; end: number } | null>();
  const scrollRef = useRef<HTMLDivElement>(null),
    cursorUnits = musicTime(doc, m.start);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !m.transport.follow || !m.realtimePlaying || m.realtimeMode !== 'song') return;
    const next = followScroll(HEAD + cursorUnits * PX, el.scrollLeft + HEAD, el.clientWidth - HEAD);
    if (next !== el.scrollLeft + HEAD) el.scrollLeft = Math.max(0, next - HEAD);
  }, [cursorUnits, m.transport.follow, m.realtimePlaying, m.realtimeMode]);
  const rulerAt = (e: React.PointerEvent<HTMLDivElement>, snap = grid) =>
    rulerUnitsAt(e.clientX, {
      origin: e.currentTarget.getBoundingClientRect().left + HEAD,
      pxPerUnit: PX,
      max: doc.duration,
      grid: snap,
    });
  const loop = loopPreview === undefined ? doc.loop : loopPreview;
  return (
    <>
      <div className="music-editor-toolbar">
        <strong>Pattern 编排</strong>
        <span>从左侧拖入，或点击轨道放置 · 拖动移动 · 双击进入</span>
        <MusicNumber
          label="时长"
          value={doc.duration}
          min={0.25}
          max={14400}
          step={1}
          onChange={(n) => run({ type: 'setSettings', patch: { duration: n } }, 'duration')}
        />
      </div>
      <div className="music-playlist-scroll" ref={scrollRef}>
        <div className="music-playlist" style={{ width: Math.max(760, doc.duration * 36 + 120) }}>
          <div
            className="music-playlist-ruler"
            style={{ paddingLeft: 120 }}
            title="点击定位播放头 · Shift+拖动设置循环区"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              if (e.shiftKey && !busy) {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                const from = rulerAt(e);
                loopGesture.current = { pointer: e.pointerId, from };
                setLoopPreview(null);
                return;
              }
              // Click seeks (snapped to the grid); when stopped this sets the start position.
              m.seek(musicSeconds(doc, rulerAt(e)));
            }}
            onPointerMove={(e) => {
              const g = loopGesture.current;
              if (!g || g.pointer !== e.pointerId) return;
              setLoopPreview(normalizeLoop(g.from, rulerAt(e), { max: doc.duration, grid }));
            }}
            onPointerUp={(e) => {
              const g = loopGesture.current;
              if (!g || g.pointer !== e.pointerId) return;
              loopGesture.current = undefined;
              const next = normalizeLoop(g.from, rulerAt(e), { max: doc.duration, grid });
              setLoopPreview(undefined);
              if (
                next &&
                (next.start !== doc.loop?.start || next.end !== doc.loop?.end)
              ) {
                m.setLoopRegion(next);
                if (!m.transport.loop) m.setTransport({ loop: true });
              }
            }}
            onPointerCancel={() => {
              loopGesture.current = undefined;
              setLoopPreview(undefined);
            }}
          >
            {loop && (
              <b
                className={`music-loop-region ${m.transport.loop ? '' : 'off'}`}
                style={{ left: HEAD + loop.start * PX, width: (loop.end - loop.start) * PX }}
              />
            )}
            {Array.from({ length: Math.min(1000, Math.ceil(doc.duration / 4)) }, (_, i) => (
              <span style={{ left: 120 + i * 144 }} key={i}>
                {doc.unit === 'beats' ? `${i + 1}` : `${i * 4}s`}
              </span>
            ))}
          </div>
          {loop && (
            <i
              className={`music-loop-shade ${m.transport.loop ? '' : 'off'}`}
              style={{ left: HEAD + loop.start * PX, width: (loop.end - loop.start) * PX }}
            />
          )}
          <i className="music-playlist-cursor" style={{ left: HEAD + cursorUnits * PX }} />
          {Array.from({ length: laneCount }, (_, lane) => {
            const p = doc.patterns?.[lane];
            return (
              <div
                key={lane}
                className="music-playlist-lane"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (busy) return;
                  const id = e.dataTransfer.getData('application/x-vmotion-pattern');
                  const dropped = doc.patterns?.find((p) => p.id === id);
                  if (!dropped) return;
                  const at = Math.max(
                    0,
                    Math.round(
                      (e.clientX - e.currentTarget.getBoundingClientRect().left - 120) / 36 / grid,
                    ) * grid,
                  );
                  if (at + dropped.length > doc.duration) return;
                  run({ type: 'addClip', clip: patternClip(id, lane, at, dropped.length) });
                }}
                onPointerDown={(e) => {
                  if (!p || busy || e.button !== 0 || (e.target as Element).closest('button'))
                    return;
                  const at = Math.max(
                    0,
                    Math.round(
                      (e.clientX - e.currentTarget.getBoundingClientRect().left - 120) / 36 / grid,
                    ) * grid,
                  );
                  if (at + p.length <= doc.duration)
                    run({ type: 'addClip', clip: patternClip(p.id, lane, at, p.length) });
                }}
              >
                {p ? (
                  <button
                    className="music-lane-label"
                    onClick={() => {
                      m.dispatch({ type: 'select', patternId: p.id });
                      setTab('piano');
                    }}
                  >
                    <i style={{ background: p.color ?? colors[lane % colors.length] }} />
                    {p.name}
                  </button>
                ) : (
                  <span className="music-lane-label">
                    {doc.playlistTracks[lane]?.name ?? `Track ${lane + 1}`}
                  </span>
                )}
                {doc.clips
                  .filter((c) => c.lane === lane)
                  .map((c) => {
                    const source =
                        c.kind === 'pattern'
                          ? doc.patterns?.find((x) => x.id === c.refId)
                          : undefined,
                      sourceIndex = source ? doc.patterns!.indexOf(source) : lane,
                      label =
                        source?.name ??
                        (c.kind === 'automation'
                          ? `自动化 · ${automationLabel(doc, c.refId)}`
                          : c.refId);
                    return (
                      <button
                        key={c.id}
                        data-clip={c.id}
                        className={`music-pattern-clip ${clipSelection === c.id ? 'selected' : ''}`}
                        style={
                          {
                            left: 120 + (clipPreview?.id === c.id ? clipPreview.at : c.at) * 36,
                            width: Math.max(16, c.length * 36 - 2),
                            opacity: c.muted ? 0.45 : undefined,
                            '--pattern-color':
                              c.color ?? source?.color ?? colors[sourceIndex % colors.length],
                          } as React.CSSProperties
                        }
                        onDoubleClick={() => {
                          if (!source) return;
                          m.dispatch({ type: 'select', patternId: source.id });
                          setTab('piano');
                        }}
                        onPointerDown={(e) => {
                          if (busy || e.button !== 0) return;
                          e.stopPropagation();
                          e.currentTarget.setPointerCapture(e.pointerId);
                          setClipSelection(c.id);
                          clipGesture.current = {
                            id: c.id,
                            x: e.clientX,
                            at: c.at,
                            pointer: e.pointerId,
                          };
                        }}
                        onPointerMove={(e) => {
                          const g = clipGesture.current;
                          if (!g || g.pointer !== e.pointerId) return;
                          setClipPreview({
                            id: c.id,
                            at: Math.max(
                              0,
                              Math.min(
                                doc.duration - c.length,
                                g.at + Math.round((e.clientX - g.x) / 36 / grid) * grid,
                              ),
                            ),
                          });
                        }}
                        onPointerUp={() => {
                          if (clipPreview)
                            run({
                              type: 'updateClip',
                              clipId: c.id,
                              patch: { at: clipPreview.at },
                            });
                          clipGesture.current = undefined;
                          setClipPreview(undefined);
                        }}
                        onPointerCancel={() => {
                          clipGesture.current = undefined;
                          setClipPreview(undefined);
                        }}
                      >
                        <span>{label}</span>
                        {source && (
                          <div className="music-mini-notes">
                            {source.channels
                              .flatMap((ch) => ch.events)
                              .filter((n) => n.at >= c.offset && n.at < c.offset + c.length)
                              .slice(0, 64)
                              .map((n, i) => (
                                <i
                                  key={i}
                                  style={{
                                    left: `${((n.at - c.offset) / c.length) * 100}%`,
                                    top: `${4 + (84 - noteNumber(n.note)) * 0.6}px`,
                                    width: `${Math.max(1, (n.duration / c.length) * 100)}%`,
                                  }}
                                />
                              ))}
                          </div>
                        )}
                      </button>
                    );
                  })}
              </div>
            );
          })}
          {!doc.patterns?.length && !doc.clips.length && (
            <div className="music-empty">
              此乐曲使用整曲音符。前往钢琴卷帘编辑，或新建 Pattern 开始编排。
            </div>
          )}
          {doc.tracks.some((t) => t.events.length) && (
            <div
              className="music-direct-score"
              onClick={() => {
                m.dispatch({ type: 'select', patternId: '' });
                setTab('piano');
              }}
            >
              整曲直接音符 · {doc.tracks.reduce((sum, t) => sum + t.events.length, 0)} 个 · 点击编辑
            </div>
          )}
        </div>
      </div>
      <div className="music-selection-bar">
        {(() => {
          const c = doc.clips.find((c) => c.id === clipSelection);
          return c ? (
            <>
              <span>编排片段</span>
              <MusicNumber
                label="起点"
                value={c.at}
                min={0}
                max={doc.duration}
                step={grid}
                onChange={(at) =>
                  run({ type: 'updateClip', clipId: c.id, patch: { at } }, 'clip-at:' + c.id)
                }
              />
              <MusicNumber
                label="长度"
                value={c.length}
                min={grid}
                max={doc.duration}
                step={grid}
                onChange={(length) =>
                  run(
                    { type: 'updateClip', clipId: c.id, patch: { length } },
                    'clip-length:' + c.id,
                  )
                }
              />
              <button onClick={() => run({ type: 'removeClip', clipId: c.id })}>删除片段</button>
            </>
          ) : (
            <span>重复使用同一 Pattern，编辑音符时所有实例一起更新。</span>
          );
        })()}
      </div>
    </>
  );
}
