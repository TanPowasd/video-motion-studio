import { useState } from 'react';
import type { MusicWorkspaceContext } from './music-panel-types.js';
import { MusicNumber } from './MusicInspector.js';

/** Inline forms above the editor: MIDI import and place-on-video-track. */
export function MusicInlineForms({
  ctx,
  showMidi,
  setShowMidi,
  showPlace,
  setShowPlace,
}: {
  ctx: MusicWorkspaceContext;
  showMidi: boolean;
  setShowMidi: (open: boolean) => void;
  showPlace: boolean;
  setShowPlace: (open: boolean) => void;
}) {
  const { m, application, busy, validation } = ctx;
  const [midiPath, setMidiPath] = useState(''),
    [placeTrack, setPlaceTrack] = useState(''),
    [placeFrame, setPlaceFrame] = useState(0);
  const activeSequence = application.snapshot.sequences.find(
    (s) => s.id === application.snapshot.project.activeSequence,
  )!;
  return (
    <>
      {showMidi && (
        <form
          className="music-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (midiPath) void m.importMidi(midiPath);
          }}
        >
          <input
            aria-label="MIDI 文件路径"
            placeholder="本地 .mid 文件完整路径"
            value={midiPath}
            onChange={(e) => setMidiPath(e.target.value)}
          />
          <button disabled={busy || !midiPath}>导入为新乐曲</button>
          <button type="button" onClick={() => setShowMidi(false)}>
            ×
          </button>
        </form>
      )}
      {showPlace && (
        <div className="music-inline-form">
          <select
            aria-label="视频音乐轨道"
            value={placeTrack}
            onChange={(e) => setPlaceTrack(e.target.value)}
          >
            <option value="">新建音乐轨道</option>
            {activeSequence.tracks
              .filter((t) => t.type === 'audio' && !t.locked)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
          <MusicNumber
            label="起始帧"
            min={0}
            max={activeSequence.duration - 1}
            step={1}
            value={placeFrame}
            onChange={setPlaceFrame}
          />
          <button
            disabled={busy || !!validation}
            onClick={() => m.insert(placeTrack, Math.round(placeFrame))}
          >
            保存并加入轨道
          </button>
          <button onClick={() => setShowPlace(false)}>×</button>
        </div>
      )}
    </>
  );
}
