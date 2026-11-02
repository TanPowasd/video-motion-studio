import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { snapFloor, snapSize } from '../../core/sound-playlist.js';
import type { SoundClip } from '../../core/sound-schema.js';
import { musicSeconds, musicTime } from './music-model.js';
import type { MusicPanelProps } from './music-panel-types.js';
import { followScroll } from './transport.js';
import { AutomationEditor } from './playlist/AutomationEditor.js';
import { PlaylistClipView, PlaylistLaneHeader } from './playlist/PlaylistLanes.js';
import { PlaylistRuler } from './playlist/PlaylistRuler.js';
import { PlaylistSelectionBar } from './playlist/PlaylistSelectionBar.js';
import { PlaylistToolbar } from './playlist/PlaylistToolbar.js';
import { usePlaylistKeys } from './playlist/use-playlist-keys.js';
import { usePlaylistGestures } from './playlist/use-playlist-gestures.js';
import {
  HEAD,
  PX_PER_UNIT,
  RULER,
  ZOOM_X,
  ZOOM_Y,
  clipsByLane,
  defaultPlaylistView,
  laneAt,
  laneOffsets,
  playlistViewMemory,
  secondsPerUnit,
  visibleLanes,
  type PlaylistViewState,
} from './playlist/playlist-view.js';

/**
 * FL-style Playlist (P3): up to 500 lanes (virtualised), tools, multi-select, move/trim/slice/
 * paint/duplicate, markers, automation and audio clips. Every document edit is one
 * `sound-commands` command (drags commit once on release); selection, clipboard, zoom, snap and
 * tool are view state outside undo.
 */
export function PlaylistPanel({
  doc,
  m,
  run,
  busy,
  setTab,
}: Pick<MusicPanelProps, 'doc' | 'm' | 'run' | 'busy' | 'grid' | 'setTab'>) {
  const [view, setViewState] = useState<PlaylistViewState>(
    () => playlistViewMemory.view ?? defaultPlaylistView(doc),
  );
  const setView = (patch: Partial<PlaylistViewState>) =>
    setViewState((v) => (playlistViewMemory.view = { ...v, ...patch }));
  const [selection, setSelection] = useState<string[]>([]),
    [focusLane, setFocusLane] = useState(0),
    [openAuto, setOpenAuto] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null),
    bodyRef = useRef<HTMLDivElement>(null),
    [scroll, setScroll] = useState({ left: 0, top: 0, w: 900, h: 400 });
  const px = PX_PER_UNIT * view.zoomX,
    grid = snapSize(doc, view.snap),
    offsets = useMemo(
      () => laneOffsets(doc.playlistTracks, view.zoomY),
      [doc.playlistTracks, view.zoomY],
    ),
    byLane = useMemo(() => clipsByLane(doc.clips), [doc.clips]);
  const pattern = doc.patterns?.find((p) => p.id === view.patternId) ?? doc.patterns?.[0];
  const assets = m.application?.snapshot.project.assets ?? [];
  const toSeconds = (at: number) => musicSeconds(doc, at);
  const audioSourceLength = (clip: SoundClip) => {
    const seconds = Number(assets.find((a) => a.id === clip.refId)?.metadata.duration);
    return seconds > 0 ? seconds / secondsPerUnit(doc, toSeconds, clip.at) : undefined;
  };
  const { preview, handlers } = usePlaylistGestures({
    doc,
    run,
    busy,
    tool: view.tool,
    grid,
    px,
    offsets,
    selection,
    setSelection,
    setFocusLane,
    patternId: pattern?.id ?? '',
    setPatternId: (patternId) => patternId !== view.patternId && setView({ patternId }),
    audioSourceLength,
    onOpen: (clip) => {
      if (clip.kind === 'automation') setOpenAuto(clip.id);
      else if (clip.kind === 'pattern') {
        m.dispatch({ type: 'select', patternId: clip.refId });
        setTab('piano');
      }
    },
  });
  usePlaylistKeys({
    doc,
    run,
    busy,
    selection,
    setSelection,
    focusLane,
    playhead: () => snapFloor(musicTime(doc, m.start), grid),
    setTool: (tool) => setView({ tool }),
  });
  // Scroll/size tracking for virtualisation (one state update per frame).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setScroll({ left: el.scrollLeft, top: el.scrollTop, w: el.clientWidth, h: el.clientHeight });
    };
    const queue = () => (frame ||= requestAnimationFrame(read));
    el.addEventListener('scroll', queue, { passive: true });
    const ro = new ResizeObserver(queue);
    ro.observe(el);
    read();
    return () => {
      el.removeEventListener('scroll', queue);
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  // Ctrl+wheel zooms time around the cursor; Ctrl+Shift/Alt+wheel zooms lane height.
  const zoomAnchor = useRef<{ t: number; x: number } | undefined>(undefined);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = Math.exp(-Math.sign(e.deltaY) * 0.15);
      if (e.shiftKey || e.altKey)
        setViewState(
          (v) =>
            (playlistViewMemory.view = {
              ...v,
              zoomY: Math.max(ZOOM_Y.min, Math.min(ZOOM_Y.max, v.zoomY * factor)),
            }),
        );
      else {
        const x = e.clientX - el.getBoundingClientRect().left;
        setViewState((v) => {
          const before = PX_PER_UNIT * v.zoomX,
            zoomX = Math.max(ZOOM_X.min, Math.min(ZOOM_X.max, v.zoomX * factor));
          zoomAnchor.current = { t: (el.scrollLeft + x - HEAD) / before, x };
          return (playlistViewMemory.view = { ...v, zoomX });
        });
      }
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  useLayoutEffect(() => {
    const el = scrollRef.current,
      a = zoomAnchor.current;
    if (!el || !a) return;
    zoomAnchor.current = undefined;
    el.scrollLeft = Math.max(0, a.t * px + HEAD - a.x);
  }, [px]);
  const cursorUnits = musicTime(doc, m.start);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !m.transport.follow || !m.realtimePlaying || m.realtimeMode !== 'song') return;
    const next = followScroll(HEAD + cursorUnits * px, el.scrollLeft + HEAD, el.clientWidth - HEAD);
    if (next !== el.scrollLeft + HEAD) el.scrollLeft = Math.max(0, next - HEAD);
  }, [cursorUnits, m.transport.follow, m.realtimePlaying, m.realtimeMode, px]);

  const total = offsets[offsets.length - 1],
    width = Math.max(scroll.w, HEAD + doc.duration * px + 80),
    lanes = visibleLanes(offsets, scroll.top - RULER, scroll.top + scroll.h),
    t0 = (scroll.left - HEAD) / px - 1,
    t1 = (scroll.left + scroll.w) / px + 1,
    selected = new Set(selection),
    loop = doc.loop,
    patches = preview.patches,
    removed = preview.removed;
  const laneFromY = (clientY: number) =>
    laneAt(offsets, clientY - (bodyRef.current?.getBoundingClientRect().top ?? 0));
  const autoClip = doc.clips.find((c) => c.id === openAuto && c.kind === 'automation');
  const drop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (busy) return;
    const r = e.currentTarget.getBoundingClientRect(),
      lane = laneAt(offsets, e.clientY - r.top),
      at = Math.max(0, snapFloor((e.clientX - r.left - HEAD) / px, e.altKey ? 0 : grid)),
      patternId = e.dataTransfer.getData('application/x-vmotion-pattern'),
      sampleId = e.dataTransfer.getData('application/x-vmotion-sample'),
      dropped = doc.patterns?.find((p) => p.id === patternId);
    let clip: SoundClip | undefined;
    if (dropped && at + dropped.length <= doc.duration + 1e-9)
      clip = {
        id: crypto.randomUUID(),
        kind: 'pattern',
        lane,
        at,
        length: dropped.length,
        offset: 0,
        muted: false,
        refId: dropped.id,
      };
    else if (sampleId) {
      const seconds = Number(assets.find((a) => a.id === sampleId)?.metadata.duration) || 1,
        length = Math.min(doc.duration - at, musicTime(doc, toSeconds(at) + seconds) - at);
      if (length > 1e-6)
        clip = {
          id: crypto.randomUUID(),
          kind: 'audio',
          lane,
          at,
          length: Number(length.toFixed(6)),
          offset: 0,
          muted: false,
          gainDb: 0,
          refId: sampleId,
        };
    }
    if (clip) {
      run({ type: 'addClips', clips: [clip] });
      setSelection([clip.id]);
    }
  };
  return (
    <>
      <PlaylistToolbar
        doc={doc}
        m={m}
        run={run}
        busy={busy}
        view={view}
        setView={setView}
        focusLane={focusLane}
      />
      <div className="music-playlist-scroll" ref={scrollRef} tabIndex={-1}>
        <div
          className="music-playlist"
          style={
            { width, height: RULER + total + 40, '--beat-px': `${px}px` } as React.CSSProperties
          }
        >
          <PlaylistRuler
            doc={doc}
            m={m}
            run={run}
            busy={busy}
            px={px}
            grid={grid}
            scrollLeft={scroll.left}
            viewWidth={scroll.w}
          />
          <div
            className={`music-playlist-body tool-${view.tool}`}
            ref={bodyRef}
            style={{ height: total }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={drop}
            {...handlers}
          >
            {Array.from({ length: Math.max(0, lanes.last - lanes.first + 1) }, (_, k) => {
              const lane = lanes.first + k,
                track = doc.playlistTracks[lane],
                height = offsets[lane + 1] - offsets[lane],
                list = (byLane.get(lane) ?? []).concat(),
                moving = patches
                  ? doc.clips.filter(
                      (c) =>
                        patches.has(c.id) && patches.get(c.id)!.lane === lane && c.lane !== lane,
                    )
                  : [];
              const shown = [...list, ...moving]
                .filter(
                  (c) => !(patches?.has(c.id) && (patches.get(c.id)!.lane ?? c.lane) !== lane),
                )
                .map((c) => (patches?.has(c.id) ? { ...c, ...patches.get(c.id) } : c))
                .filter((c) => c.at < t1 && c.at + c.length > t0);
              const ghosts = (preview.added ?? []).filter((c) => c.lane === lane);
              return (
                <div
                  key={track.id}
                  className={`music-playlist-lane ${track.muted ? 'muted' : ''} ${lane === focusLane ? 'focus' : ''}`}
                  style={{ top: offsets[lane], height }}
                >
                  <PlaylistLaneHeader
                    doc={doc}
                    lane={lane}
                    track={track}
                    height={height}
                    zoomY={view.zoomY}
                    run={run}
                    busy={busy}
                    laneFromY={laneFromY}
                  />
                  <div className="music-lane-clips">
                    {shown.map((c) =>
                      removed?.has(c.id) ? null : (
                        <PlaylistClipView
                          key={c.id}
                          doc={doc}
                          clip={c}
                          px={px}
                          height={height}
                          selected={selected.has(c.id)}
                          assetName={
                            c.kind === 'audio'
                              ? assets.find((a) => a.id === c.refId)?.name
                              : undefined
                          }
                        />
                      ),
                    )}
                    {ghosts.map((c) => (
                      <PlaylistClipView
                        key={c.id}
                        doc={doc}
                        clip={c}
                        px={px}
                        height={height}
                        selected={false}
                        ghost
                      />
                    ))}
                  </div>
                </div>
              );
            })}
            {preview.box && (
              <b
                className="music-box-select"
                style={{
                  left: HEAD + preview.box.x,
                  top: preview.box.y,
                  width: preview.box.w,
                  height: preview.box.h,
                }}
              />
            )}
          </div>
          {loop && (
            <i
              className={`music-loop-shade ${m.transport.loop ? '' : 'off'}`}
              style={{ left: HEAD + loop.start * px, width: (loop.end - loop.start) * px }}
            />
          )}
          {doc.markers.map((mk, i) => (
            <i key={i} className="music-marker-line" style={{ left: HEAD + mk.at * px }} />
          ))}
          <i className="music-playlist-cursor" style={{ left: HEAD + cursorUnits * px }} />
        </div>
      </div>
      {autoClip ? (
        <AutomationEditor
          doc={doc}
          clip={autoClip}
          run={run}
          busy={busy}
          onClose={() => setOpenAuto(undefined)}
        />
      ) : (
        <PlaylistSelectionBar
          doc={doc}
          m={m}
          run={run}
          busy={busy}
          grid={grid}
          selection={selection}
          setSelection={setSelection}
          openAutomation={setOpenAuto}
          setTab={setTab}
        />
      )}
    </>
  );
}
