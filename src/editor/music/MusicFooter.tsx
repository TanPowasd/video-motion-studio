import type { MusicWorkspaceContext } from './music-panel-types.js';
import { noteLabel } from './music-model.js';

/** Status line plus the audition player and its peak/RMS readout. */
export function MusicFooter({ ctx }: { ctx: MusicWorkspaceContext }) {
  const { m, validation, pattern, track, selected } = ctx;
  return (
    <footer className="music-footer">
      <div className="music-footer-status" role={m.error || validation ? 'alert' : 'status'}>
        {m.error ||
          validation ||
          m.notice ||
          `${pattern?.name ?? '整曲'} · ${track?.name ?? '选择通道'} · ${selected.length ? selected.map((n) => noteLabel(n.note)).join(', ') : '准备就绪'}`}
      </div>
      {m.audio && (
        <>
          <audio
            ref={m.audioRef}
            controls
            autoPlay
            src={m.audio.src}
            onPlay={() => m.setPlaying(true)}
            onPause={() => m.setPlaying(false)}
            onEnded={() => m.setPlaying(false)}
            onTimeUpdate={(e) => m.setStart(m.audio!.startSeconds + e.currentTarget.currentTime)}
          />
          <span className={m.audio.peak > 1 ? 'music-error' : ''}>
            Peak {m.audio.peak.toFixed(3)} · RMS {m.audio.rms.toFixed(3)}
          </span>
        </>
      )}
      {!m.audio && m.realtimePlaying && m.realtimeMeter && (
        <span className={Math.max(...m.realtimeMeter.peak) > 1 ? 'music-error' : ''}>
          Peak {Math.max(...m.realtimeMeter.peak).toFixed(3)} · RMS{' '}
          {Math.max(...m.realtimeMeter.rms).toFixed(3)}
        </span>
      )}
    </footer>
  );
}
