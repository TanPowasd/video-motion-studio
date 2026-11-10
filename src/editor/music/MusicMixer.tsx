import React from 'react';
import { soundBusSchema } from '../../core/sound-schema.js';
import { colors, type MusicPanelProps } from './music-panel-types.js';
import { MusicMeter } from './MusicMeter.js';
export function MusicMixer({
  doc,
  m,
  run,
  busy,
  owner,
  setOwner,
}: Pick<MusicPanelProps, 'doc' | 'm' | 'run' | 'busy' | 'owner' | 'setOwner'>) {
  return (
    <div className="music-mixer">
      <div className="music-mixer-strips">
        {[
          ...doc.tracks.map((t, i) => ({
            id: t.id,
            name: t.name,
            gain: t.gainDb,
            pan: t.pan,
            color: colors[i % colors.length],
            kind: 'track',
          })),
          ...doc.buses.map((b) => ({
            id: b.id,
            name: b.name,
            gain: b.gainDb,
            pan: b.pan,
            color: '#7ebbc9',
            kind: 'bus',
          })),
          {
            id: 'master',
            name: 'Master',
            gain: doc.master.gainDb,
            pan: 0,
            color: '#f2aa62',
            kind: 'master',
          },
        ].map((channel, index) => (
          <div
            key={channel.id}
            className={`music-mixer-strip ${owner === channel.id ? 'selected' : ''}`}
            style={{ '--channel-color': channel.color } as React.CSSProperties}
            onClick={() => setOwner(channel.id)}
          >
            <small>{channel.kind === 'master' ? 'M' : String(index + 1).padStart(2, '0')}</small>
            <strong>{channel.name}</strong>
            <span className="music-strip-type">{channel.kind}</span>
            <div className="music-fader-row">
              <MusicMeter
                label={channel.name + ' 电平'}
                reading={m.realtimePlaying ? m.realtimeMeters[channel.id] : undefined}
                fallbackPeak={
                  channel.kind === 'master' && m.audio && !m.realtimePlaying
                    ? m.audio.peak
                    : undefined
                }
              />
              <input
                aria-label={channel.name + ' 混音音量'}
                type="range"
                min={-80}
                max={24}
                step={0.5}
                value={channel.gain}
                disabled={busy}
                onChange={(e) => {
                  const gainDb = Number(e.target.value),
                    key = 'mixer-gain:' + channel.id;
                  if (channel.kind === 'master')
                    run({ type: 'updateMaster', patch: { gainDb } }, key);
                  else if (channel.kind === 'bus')
                    run({ type: 'updateBus', busId: channel.id, patch: { gainDb } }, key);
                  else run({ type: 'updateTrack', trackId: channel.id, patch: { gainDb } }, key);
                }}
              />
            </div>
            <output>{channel.gain.toFixed(1)} dB</output>
            {channel.kind !== 'master' && (
              <input
                aria-label={channel.name + ' 声像'}
                type="range"
                min={-1}
                max={1}
                step={0.05}
                value={channel.pan}
                disabled={busy}
                onChange={(e) => {
                  const pan = Number(e.target.value),
                    key = 'mixer-pan:' + channel.id;
                  if (channel.kind === 'bus')
                    run({ type: 'updateBus', busId: channel.id, patch: { pan } }, key);
                  else run({ type: 'updateTrack', trackId: channel.id, patch: { pan } }, key);
                }}
              />
            )}
          </div>
        ))}
        <button
          className="music-add-bus"
          disabled={busy || doc.buses.length >= 16}
          onClick={() => {
            const id = crypto.randomUUID();
            run({
              type: 'addBus',
              bus: soundBusSchema.parse({ id, name: 'Bus ' + (doc.buses.length + 1) }),
            });
            setOwner(id);
          }}
        >
          ＋ Bus
        </button>
      </div>
      <p className="music-muted">
        实时播放时显示各通道与主输出的峰值（线）和 RMS（填充）；停止后主输出显示最近一次试听的峰值。总线暂无实时电平。选择通道，在右侧编辑效果、路由和发送。
      </p>
    </div>
  );
}
