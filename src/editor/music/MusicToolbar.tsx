import { McpConnectionButton } from '../McpConnection.js';
import type { SoundDocument } from '../../core/sound-schema.js';
import { Icon } from '../Icons.js';
import { ProjectActions } from '../ProjectHome.js';
import type { MusicWorkspaceContext } from './music-panel-types.js';

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
  const { embedded, m, doc, draft, application, busy, validation, clock, run } = ctx;
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
        <div className="music-clock">
          {Math.floor(m.start / 60)
            .toString()
            .padStart(2, '0')}
          :{(m.start % 60).toFixed(2).padStart(5, '0')}
          <small>{doc.unit === 'beats' ? `${clock.toFixed(2)} BEATS` : 'SECONDS'}</small>
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
