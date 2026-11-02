import type { SoundInstrument } from './sound-schema.js';

/**
 * Per-sample voice DSP shared by the offline renderer (`core/sound.ts`) and the realtime
 * AudioWorklet (`editor/music/realtime`). Dependency-free (type imports only) so the worklet
 * bundle stays small. Every function takes the sample rate; the offline renderer always uses
 * the default, `DSP_RATE`, which equals `SOUND_RATE` (48 kHz), so its output is bit-identical
 * to the code that used to live inline in the renderer.
 */
export const DSP_RATE = 48000;

export function noise(seed: number, index: number) {
  let x = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return ((x ^ (x >>> 15)) >>> 0) / 2147483648 - 1;
}
export function blep(t: number, dt: number) {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}
export function oscillator(
  wave: string,
  cycles: number,
  frequency: number,
  seed: number,
  index: number,
  rate = DSP_RATE,
) {
  const phase = ((cycles % 1) + 1) % 1,
    dt = Math.min(0.49, frequency / rate);
  if (wave === 'noise') return noise(seed, index);
  if (wave === 'saw') return 2 * phase - 1 - blep(phase, dt);
  if (wave === 'square')
    return (phase < 0.5 ? 1 : -1) + blep(phase, dt) - blep((phase + 0.5) % 1, dt);
  if (wave === 'triangle') return 1 - 4 * Math.abs(phase - 0.5);
  return Math.sin(2 * Math.PI * cycles);
}
export function envelope(
  t: number,
  gate: number,
  attack: number,
  decay: number,
  sustain: number,
  release: number,
  rate = DSP_RATE,
) {
  const on = (at: number) =>
    at < attack
      ? at / Math.max(attack, 1 / rate)
      : at < attack + decay
        ? 1 - ((1 - sustain) * (at - attack)) / Math.max(decay, 1 / rate)
        : sustain;
  return t < gate ? on(t) : release ? on(gate) * Math.max(0, 1 - (t - gate) / release) : 0;
}
type Synth = Extract<SoundInstrument, { type: 'synth' }>;
type Drum = Extract<SoundInstrument, { type: 'drum' }>;
/** Mono synth voice value (before note pan and velocity). */
export function synthValue(
  instrument: Synth,
  t: number,
  cycles: number,
  frequency: number,
  gate: number,
  seed: number,
  index: number,
  rate = DSP_RATE,
) {
  const env = envelope(
      t,
      gate,
      instrument.attack,
      instrument.decay,
      instrument.sustain,
      instrument.release,
      rate,
    ),
    phase =
      cycles +
      (instrument.fmIndex *
        Math.exp(-3 * t) *
        Math.sin(2 * Math.PI * cycles * instrument.fmRatio)) /
        (2 * Math.PI);
  return oscillator(instrument.wave, phase, frequency, seed, index, rate) * env * instrument.gain;
}
/** Mono drum voice value (before note pan and velocity). */
export function drumValue(
  instrument: Drum,
  t: number,
  frequency: number,
  seed: number,
  index: number,
) {
  const life = instrument.release,
    env = Math.exp((-8 * t) / life) * (t < life ? 1 : 0),
    n = noise(seed, index),
    hp = (n - noise(seed, index - 1)) * 0.5,
    base = frequency;
  let value: number;
  switch (instrument.voice) {
    case 'kick':
      value = Math.sin(2 * Math.PI * (base * t + base * 0.9 * 0.035 * (1 - Math.exp(-t / 0.035)))) * env;
      break;
    case 'tom':
      value = Math.sin(2 * Math.PI * (base * t + base * 0.4 * 0.04 * (1 - Math.exp(-t / 0.04)))) * env;
      break;
    case 'snare':
      value = (0.75 * n + 0.25 * Math.sin(2 * Math.PI * 180 * t)) * env;
      break;
    case 'hat':
      value = hp * env;
      break;
    case 'clap': {
      const burst = t < 0.03 ? Math.exp(-((t % 0.01) / 0.003)) : Math.exp(-(t - 0.03) * 25);
      value = hp * burst * env;
      break;
    }
  }
  return value * instrument.gain;
}
/**
 * Glide state of a voice at sample `index` after its start: instantaneous frequency and
 * integrated cycles, exactly as the offline renderer computes them.
 */
export function voicePhase(f0: number, f1: number, gate: number, index: number, rate = DSP_RATE) {
  const slope = (f1 - f0) / gate,
    t = index / rate,
    glide = Math.min(t, gate),
    frequency = Math.min(22000, f0 + slope * glide),
    cycles = f0 * glide + (slope * glide * glide) / 2 + Math.max(0, t - gate) * f1;
  return { t, frequency, cycles };
}
