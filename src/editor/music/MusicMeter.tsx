import type { MeterReading } from './realtime/protocol.js';
import { meterLevel } from './transport.js';

/**
 * Peak + RMS meter from the realtime engine (dB scale, −60…0 dBFS). The RMS fill and a peak
 * line; red when the peak clips. `fallbackPeak` shows a single offline reading (audition).
 */
export function MusicMeter({
  reading,
  fallbackPeak,
  label,
  horizontal = false,
}: {
  reading?: MeterReading;
  fallbackPeak?: number;
  label: string;
  horizontal?: boolean;
}) {
  const peak = reading ? Math.max(reading.peak[0], reading.peak[1]) : (fallbackPeak ?? 0),
    rms = reading ? Math.max(reading.rms[0], reading.rms[1]) : 0,
    size = (v: number) => `${(meterLevel(v) * 100).toFixed(1)}%`,
    axis = horizontal ? 'width' : 'height';
  return (
    <div
      className={`music-meter ${horizontal ? 'horizontal' : ''} ${peak > 1 ? 'clip' : ''}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(peak.toFixed(3))}
      title={`Peak ${peak.toFixed(3)} · RMS ${rms.toFixed(3)}`}
    >
      <i style={{ [axis]: size(reading ? rms : peak) }} />
      {reading && <b style={{ [horizontal ? 'left' : 'bottom']: size(peak) }} />}
    </div>
  );
}
