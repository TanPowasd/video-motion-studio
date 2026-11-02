import type { SoundDocument } from '../../../core/sound-schema.js';
import { newPlaylistTrack, snapFloor, snapSize } from '../../../core/sound-playlist.js';
import { MusicNumber } from '../MusicInspector.js';
import { musicTime } from '../music-model.js';
import type { MusicPanelProps } from '../music-panel-types.js';
import {
  PLAYLIST_SNAPS,
  PLAYLIST_TOOLS,
  ZOOM_X,
  ZOOM_Y,
  type PlaylistViewState,
} from './playlist-view.js';

/** Playlist toolbar: tools, snap, draw pattern, zoom, add lane/marker/automation, duration. */
export function PlaylistToolbar({
  doc,
  m,
  run,
  busy,
  view,
  setView,
  focusLane,
}: Pick<MusicPanelProps, 'doc' | 'm' | 'run' | 'busy'> & {
  view: PlaylistViewState;
  setView: (patch: Partial<PlaylistViewState>) => void;
  focusLane: number;
}) {
  const grid = snapSize(doc, view.snap),
    playhead = Math.min(doc.duration, snapFloor(musicTime(doc, m.start), grid));
  const addAutomation = (value: string) => {
    if (!value) return;
    const [kind, trackId, param] = value.split('|'),
      target: SoundDocument['automationClips'][number]['target'] =
        kind === 'tempo'
          ? { type: 'tempo' }
          : { type: 'track', trackId, param: param as 'gainDb' | 'pan' };
    const base =
        target.type === 'tempo'
          ? doc.tempo[0].bpm
          : target.param === 'pan'
            ? 0
            : (doc.tracks.find((t) => t.id === trackId)?.gainDb ?? 0),
      bar = doc.unit === 'beats' ? (doc.timeSignature[0] * 4) / doc.timeSignature[1] : 1,
      at = Math.min(playhead, Math.max(0, doc.duration - bar)),
      length = Math.min(doc.duration - at, bar * 4),
      id = crypto.randomUUID();
    run({
      type: 'addAutomationClip',
      automation: {
        id,
        target,
        points: [
          { at: 0, value: base, curve: 'linear', tension: 0 },
          { at: length, value: base, curve: 'linear', tension: 0 },
        ],
      },
      clip: {
        id,
        kind: 'automation',
        lane: focusLane,
        at,
        length,
        offset: 0,
        muted: false,
        refId: id,
      },
    });
  };
  const zoom = (key: 'zoomX' | 'zoomY', factor: number) => {
    const range = key === 'zoomX' ? ZOOM_X : ZOOM_Y;
    setView({ [key]: Math.max(range.min, Math.min(range.max, view[key] * factor)) });
  };
  return (
    <div className="music-editor-toolbar music-playlist-toolbar">
      <strong>Playlist</strong>
      <div className="music-tool-group" role="group" aria-label="Playlist 工具">
        {PLAYLIST_TOOLS.map((t) => (
          <button
            key={t.id}
            aria-label={`${t.label}工具`}
            aria-pressed={view.tool === t.id}
            className={view.tool === t.id ? 'active' : ''}
            title={t.title}
            onClick={() => setView({ tool: t.id })}
          >
            {t.label}
          </button>
        ))}
      </div>
      <label title="网格吸附；拖动时按住 Alt 临时不吸附">
        吸附
        <select
          aria-label="Playlist 吸附"
          value={view.snap}
          onChange={(e) => setView({ snap: e.target.value as PlaylistViewState['snap'] })}
        >
          {PLAYLIST_SNAPS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label title="绘制/刷绘工具放置的 Pattern；点击片段会切换到它">
        Pattern
        <select
          aria-label="绘制用 Pattern"
          value={view.patternId}
          disabled={!doc.patterns?.length}
          onChange={(e) => setView({ patternId: e.target.value })}
        >
          {!doc.patterns?.length && <option value="">（无 Pattern）</option>}
          {doc.patterns?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div
        className="music-tool-group"
        role="group"
        aria-label="Playlist 缩放"
        title="Ctrl+滚轮缩放时间，Ctrl+Shift+滚轮缩放轨道高度"
      >
        <button aria-label="缩小时间" onClick={() => zoom('zoomX', 1 / 1.25)}>
          −
        </button>
        <span className="music-zoom-value">{Math.round(view.zoomX * 100)}%</span>
        <button aria-label="放大时间" onClick={() => zoom('zoomX', 1.25)}>
          ＋
        </button>
        <button aria-label="降低轨道高度" onClick={() => zoom('zoomY', 1 / 1.2)}>
          ↕−
        </button>
        <button aria-label="增加轨道高度" onClick={() => zoom('zoomY', 1.2)}>
          ↕＋
        </button>
      </div>
      <button
        disabled={busy || doc.playlistTracks.length >= 500}
        title="在当前轨道下方插入一条轨道"
        onClick={() =>
          run({
            type: 'addPlaylistTracks',
            index: focusLane + 1,
            tracks: [newPlaylistTrack(doc, crypto.randomUUID())],
          })
        }
      >
        ＋ 轨道
      </button>
      <button
        disabled={busy}
        title="在播放头位置添加标记"
        onClick={() =>
          run({
            type: 'setMarkers',
            markers: [...doc.markers, { at: playhead, name: `标记 ${doc.markers.length + 1}` }],
          })
        }
      >
        ＋ 标记
      </button>
      <select
        aria-label="添加自动化片段"
        value=""
        disabled={busy || doc.automationClips.length >= 512}
        title="在当前轨道的播放头处添加自动化片段（双击片段编辑点）"
        onChange={(e) => addAutomation(e.target.value)}
      >
        <option value="">＋ 自动化…</option>
        {doc.unit === 'beats' && <option value="tempo">速度 BPM</option>}
        {doc.tracks.flatMap((t) => [
          <option key={t.id + 'g'} value={`track|${t.id}|gainDb`}>
            {t.name} 音量
          </option>,
          <option key={t.id + 'p'} value={`track|${t.id}|pan`}>
            {t.name} 声像
          </option>,
        ])}
      </select>
      <MusicNumber
        label="时长"
        value={doc.duration}
        min={0.25}
        max={14400}
        step={1}
        onChange={(n) => run({ type: 'setSettings', patch: { duration: n } }, 'duration')}
      />
    </div>
  );
}
