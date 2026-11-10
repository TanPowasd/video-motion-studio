import type { SoundInstrument } from '../../../core/sound-schema.js';

/** Messages between the realtime controller (main thread) and the AudioWorklet processors. */
export const TRACK_PROCESSOR = 'vm-music-track';
export const METER_PROCESSOR = 'vm-music-meter';

export type WorkletNoteEvent =
  | {
      type: 'on';
      /** AudioContext seconds. */
      time: number;
      voice: number;
      note: number;
      endNote: number;
      velocity: number;
      pan: number;
      gate: number;
      seed: number;
    }
  | { type: 'off'; time: number; voice: number }
  | { type: 'auto'; time: number; param: 'gainDb' | 'pan'; value: number };

export type ToWorklet =
  | { type: 'config'; instrument: SoundInstrument; gainDb: number; pan: number; enabled: boolean }
  | { type: 'events'; events: WorkletNoteEvent[] }
  /** Drop queued events at/after `time`; fade out sounding voices from `time`. */
  | { type: 'reset'; time: number }
  /** Let the processor end (process() returns false). */
  | { type: 'dispose' };

export interface MeterReading {
  /** Linear peak and RMS per channel over the last ~33 ms window. */
  peak: [number, number];
  rms: [number, number];
}
export type FromWorklet = { type: 'meter' } & MeterReading;

/** Meter posting rate, Hz. */
export const METER_RATE = 30;
