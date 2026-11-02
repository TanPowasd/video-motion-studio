import React, { useEffect, useMemo, useRef, useState } from 'react';
import { snapFloor, snapSize } from '../../core/sound-playlist.js';
import type { SoundClip } from '../../core/sound-schema.js';
import { musicSeconds, musicTime } from './music-model.js';
import type { MusicPanelProps } from './music-panel-types.js';
import { followScroll } from './transport.js';
import { AutomationEditor } from './playlist/AutomationEditor.js';
import { PlaylistLaneRows } from './playlist/PlaylistLaneRows.js';
import { PlaylistRuler } from './playlist/PlaylistRuler.js';
import { PlaylistSelectionBar } from './playlist/PlaylistSelectionBar.js';
import { PlaylistToolbar } from './playlist/PlaylistToolbar.js';
import { usePlaylistKeys } from './playlist/use-playlist-keys.js';
import { usePlaylistViewport } from './playlist/use-playlist-viewport.js';
import { usePlaylistGestures } from './playlist/use-playlist-gestures.js';
import {
  HEAD,
  PX_PER_UNIT,
  RULER,
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
  usePlaylistViewport(scrollRef, setScroll, setViewState, px);
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
    bar = doc.unit === 'beats' ? (doc.timeSignature[0] * 4) / doc.timeSignature[1] : 1;
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
            {
              width,
              height: RULER + total + 40,
              '--beat-px': `${px < 10 ? px * bar : px}px`,
            } as React.CSSProperties
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
            <PlaylistLaneRows
              doc={doc}
              run={run}
              busy={busy}
              offsets={offsets}
              lanes={lanes}
              byLane={byLane}
              preview={preview}
              range={[t0, t1]}
              selected={selected}
              focusLane={focusLane}
              zoomY={view.zoomY}
              px={px}
              laneFromY={laneFromY}
              assetName={(id) => assets.find((a) => a.id === id)?.name}
            />
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
