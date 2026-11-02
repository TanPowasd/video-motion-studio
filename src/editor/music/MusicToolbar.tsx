import { McpConnectionButton } from '../McpConnection.js';
import type { SoundDocument } from '../../core/sound-schema.js';
import { Icon } from '../Icons.js';
import { ProjectActions } from '../ProjectHome.js';
import type { MusicWorkspaceContext } from './music-panel-types.js';
import { musicTime } from './music-model.js';
import {
  barBeatTick,
  formatClock,
  signatureSegments,
  type CountInBars,
  type TransportMode,
} from './transport.js';

/** Header bar (project, save state, undo/redo, save) and the transport bar beneath it. */
export function MusicToolbar({
  ctx,
  showPlace,
  setShowPlace,
  performanceOpen,
  setPerformanceOpen,
}: {
  ctx: MusicWorkspaceContext;
  showPlace: boolean;
  setShowPlace: (open: boolean) => void;
  performanceOpen: boolean;
  setPerformanceOpen: (open: boolean) => void;
}) {
  const { embedded, m, doc, draft, application, busy, validation, run } = ctx;
  const t = m.transport,
    shownMode: TransportMode = m.realtimePlaying ? m.realtimeMode : ctx.transportMode,
    seconds = shownMode === 'pattern' ? m.patternStart : m.start,
    bpm0 = doc.tempo[0].bpm,
    quarter =
      shownMode === 'song' && doc.unit === 'beats' ? musicTime(doc, seconds) : (seconds * bpm0) / 60,
    position = barBeatTick(signatureSegments(doc, shownMode), quarter),
    loop = doc.loop,
    unit = doc.unit === 'beats' ? '拍' : '秒';
  return (
    <>
      <header className="music-header">
        {!embedded && (
          <a className="music-brand" href="#/project">
            <span>V</span>Vmotion
          </a>
        )}
        {!embedded && (
          <ProjectActions
            onError={(error) =>
              void m.task('工程', async () => {
                throw new Error(error);
              })
            }
            onPause={() => m.audioRef.current?.pause()}
          />
        )}
        <span className="music-project">
          {application.snapshot.project.name}
          <small>音乐工作区</small>
        </span>
        <div className="music-spacer" />
        {!embedded && <McpConnectionButton />}
        <span className="music-save-state">
          {busy ? m.busy + '…' : m.dirty ? '● 草稿未保存' : '● 已保存'}
        </span>
        <button
          title="Ctrl+Z"
          aria-label="撤销音乐编辑"
          disabled={busy || !(draft.past.length || (!m.dirty && application.canUndo))}
          onClick={() => m.history()}
        >
          <Icon name="undo" />
        </button>
        <button
          aria-label="重做音乐编辑"
          disabled={busy || !(draft.future.length || (!m.dirty && application.canRedo))}
          onClick={() => m.history(true)}
        >
          <Icon name="redo" />
        </button>
        <button disabled={busy || !!validation} onClick={m.save} className="music-primary">
          保存到素材库
        </button>
        {!embedded && (
          <a className="music-button" href="#/project">
            返回视频剪辑 <Icon name="film" />
          </a>
        )}
      </header>
      <nav className="music-transport">
        <div className="music-section-mark">
          <Icon name="music" /> MUSIC STUDIO
        </div>
        <button
          aria-label="播放或暂停音乐"
          className="music-play"
          disabled={busy || !!validation}
          onClick={() => void m.togglePlay(ctx.transportMode, ctx.pattern?.id)}
        >
          <Icon name={m.playing ? 'pause' : 'play'} />
        </button>
        <button
          aria-label="停止音乐"
          onClick={m.stopTransport}
        >
          ■
        </button>
        <div
          className="music-transport-group music-mode-toggle"
          role="group"
          aria-label="走带模式"
        >
          {(
            [
              ['pattern', 'Pattern', '只循环当前 Pattern'],
              ['song', 'Song', '按 Playlist 播放整曲'],
            ] as const
          ).map(([mode, label, title]) => (
            <button
              key={mode}
              title={title + (t.mode === null ? '（当前跟随所在标签页）' : '')}
              aria-label={label + ' 模式'}
              aria-pressed={ctx.transportMode === mode}
              className={ctx.transportMode === mode ? 'active' : ''}
              disabled={mode === 'pattern' && !ctx.pattern}
              onClick={() => m.setTransportMode(mode, ctx.pattern?.id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="music-clock" aria-label="播放位置" title="小节:拍:tick · 分:秒.毫秒">
          {position.label}
          <small>
            {formatClock(seconds)} · {shownMode === 'pattern' ? 'PAT' : 'SONG'}
          </small>
        </div>
        <div className="music-transport-group" role="group" aria-label="走带选项">
          <button
            aria-label="循环播放"
            aria-pressed={t.loop}
            className={t.loop ? 'active' : ''}
            title={
              loop
                ? `循环区 ${+loop.start.toFixed(3)}–${+loop.end.toFixed(3)} ${unit}（Song 模式）；Shift+拖动标尺重设`
                : '尚未设置循环区：在 Playlist 标尺上 Shift+拖动'
            }
            onClick={() => m.setTransport({ loop: !t.loop })}
          >
            ⟲ 循环
          </button>
          {loop && (
            <button
              aria-label="清除循环区"
              title="清除循环区（可撤销）"
              disabled={busy}
              onClick={() => m.setLoopRegion(null)}
            >
              ×
            </button>
          )}
          <button
            aria-label="节拍器"
            aria-pressed={t.metronome}
            className={t.metronome ? 'active' : ''}
            title="实时播放时每拍发声，小节首拍重音"
            onClick={() => m.setTransport({ metronome: !t.metronome })}
          >
            ♩ 节拍器
          </button>
          <label className="music-countin" title="开始播放前的预备拍">
            <select
              aria-label="预备拍"
              value={t.countIn}
              onChange={(e) => m.setTransport({ countIn: Number(e.target.value) as CountInBars })}
            >
              <option value={0}>无预备拍</option>
              <option value={1}>预备 1 小节</option>
              <option value={2}>预备 2 小节</option>
            </select>
          </label>
          <button
            aria-label="跟随播放头"
            aria-pressed={t.follow}
            className={t.follow ? 'active' : ''}
            title="播放时自动滚动 Playlist 与钢琴卷帘"
            onClick={() => m.setTransport({ follow: !t.follow })}
          >
            ⇥ 跟随
          </button>
        </div>
        <label className="music-bpm">
          BPM
          <input
            aria-label="音乐 BPM"
            type="number"
            min={20}
            max={400}
            value={doc.tempo[0].bpm}
            disabled={busy}
            onChange={(e) =>
              run(
                {
                  type: 'setBpm',
                  bpm: Math.max(20, Math.min(400, Number(e.target.value) || 120)),
                },
                'bpm',
              )
            }
          />
        </label>
        <label className="music-signature">
          <select
            aria-label="拍号"
            value={doc.timeSignature.join('/')}
            disabled={busy}
            onChange={(e) => {
              const [a, b] = e.target.value.split('/').map(Number);
              run({
                type: 'setTimeSignature',
                timeSignature: [a, b] as SoundDocument['timeSignature'],
              });
            }}
          >
            {['4/4', '3/4', '6/8', '7/8', '2/4'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <div className="music-spacer" />
        <button disabled={busy || !!validation} onClick={() => m.audition()}>
          试听草稿 · 10 秒
        </button>
        <button disabled={busy || !!validation} onClick={() => m.audition(true)}>
          整曲试听
        </button>
        <button disabled={busy || !!validation} onClick={m.exportWav}>
          导出 WAV
        </button>
        <button disabled={busy || !!validation} onClick={m.exportMidi}>
          MIDI ↓
        </button>
        <button disabled={busy} onClick={() => setShowPlace(!showPlace)}>
          加入视频轨道
        </button>
        <button
          className={performanceOpen ? 'active' : ''}
          onClick={() => setPerformanceOpen(!performanceOpen)}
        >
          MIDI 演奏
        </button>
      </nav>
    </>
  );
}
