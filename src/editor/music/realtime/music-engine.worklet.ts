/**
 * AudioWorklet processors of the realtime music engine. Bundled on its own (imported with
 * Vite's `?worker&url`) and loaded with `audioWorklet.addModule`.
 *
 * - `vm-music-track`: one node per track. Voices the built-in synth and drum instruments with
 *   the offline renderer's own per-sample DSP (`core/sound-dsp`), note pan + velocity as
 *   offline, then the track fader (gain dB + balance pan, automatable) and posts peak/RMS.
 * - `vm-music-meter`: pass-through meter, placed at the end of the master chain.
 *
 * Not voiced here: `sample` and `plugin` instruments (the controller falls back to the
 * offline preview for scores that need them; TODO: route plugin tracks to the live plugin
 * host, decode sample assets in the editor).
 */
import { drumValue, synthValue, voicePhase } from '../../../core/sound-dsp.js';
import type { SoundInstrument } from '../../../core/sound-schema.js';
import {
  METER_PROCESSOR,
  METER_RATE,
  TRACK_PROCESSOR,
  type FromWorklet,
  type ToWorklet,
  type WorkletNoteEvent,
} from './protocol.js';

// AudioWorkletGlobalScope (not part of TypeScript's DOM lib).
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

const MAX_VOICES = 256,
  FADE_SECONDS = 0.005,
  SMOOTH_SECONDS = 0.005;

class Meter {
  private peak = [0, 0];
  private sum = [0, 0];
  private count = 0;
  private readonly window = Math.max(128, Math.round(sampleRate / METER_RATE));
  constructor(private port: MessagePort) {}
  add(left: Float32Array, right: Float32Array) {
    for (let i = 0; i < left.length; i++) {
      const l = left[i],
        r = right[i];
      const al = l < 0 ? -l : l,
        ar = r < 0 ? -r : r;
      if (al > this.peak[0]) this.peak[0] = al;
      if (ar > this.peak[1]) this.peak[1] = ar;
      this.sum[0] += l * l;
      this.sum[1] += r * r;
    }
    this.count += left.length;
    if (this.count < this.window) return;
    const message: FromWorklet = {
      type: 'meter',
      peak: [this.peak[0], this.peak[1]],
      rms: [Math.sqrt(this.sum[0] / this.count), Math.sqrt(this.sum[1] / this.count)],
    };
    this.port.postMessage(message);
    this.peak = [0, 0];
    this.sum = [0, 0];
    this.count = 0;
  }
}

interface Voice {
  id: number;
  start: number;
  end: number;
  gate: number;
  f0: number;
  f1: number;
  seed: number;
  velocity: number;
  lpan: number;
  rpan: number;
  kill?: number;
}
type Queued = WorkletNoteEvent & { frame: number };
const frequency = (note: number) => 440 * 2 ** ((note - 69) / 12);

class TrackProcessor extends AudioWorkletProcessor {
  private instrument?: SoundInstrument;
  private enabled = true;
  private gain = 1;
  private gainTarget = 1;
  private pan = 0;
  private panTarget = 0;
  private queue: Queued[] = [];
  private voices: Voice[] = [];
  private meter: Meter;
  private readonly smooth = 1 - Math.exp(-1 / (SMOOTH_SECONDS * sampleRate));
  private readonly fade = Math.max(1, Math.round(FADE_SECONDS * sampleRate));
  constructor(options?: unknown) {
    super(options);
    this.meter = new Meter(this.port);
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => this.receive(e.data);
  }
  private alive = true;
  private receive(message: ToWorklet) {
    if (message.type === 'dispose') this.alive = false;
    else if (message.type === 'config') {
      this.instrument = message.instrument;
      this.enabled = message.enabled;
      this.gainTarget = 10 ** (message.gainDb / 20);
      this.panTarget = message.pan;
    } else if (message.type === 'reset') {
      const frame = Math.round(message.time * sampleRate);
      this.queue = this.queue.filter((e) => e.frame < frame);
      for (const v of this.voices) if (v.kill === undefined) v.kill = Math.max(frame, v.start);
    } else if (message.type === 'events') {
      for (const event of message.events) {
        const queued = { ...event, frame: Math.round(event.time * sampleRate) } as Queued;
        let i = this.queue.length;
        while (i > 0 && this.queue[i - 1].frame > queued.frame) i--;
        this.queue.splice(i, 0, queued);
      }
    }
  }
  private release(instrument: SoundInstrument) {
    return 'release' in instrument ? instrument.release : 0;
  }
  private handle(event: Queued) {
    const instrument = this.instrument;
    if (!instrument) return;
    if (event.type === 'auto') {
      if (event.param === 'gainDb') this.gainTarget = 10 ** (event.value / 20);
      else this.panTarget = event.value;
    } else if (event.type === 'on') {
      if (instrument.type !== 'synth' && instrument.type !== 'drum') return;
      const detune = instrument.type === 'synth' ? 2 ** (instrument.detune / 1200) : 1;
      if (this.voices.length >= MAX_VOICES) this.voices.shift();
      this.voices.push({
        id: event.voice,
        start: event.frame,
        end: event.frame + Math.ceil((event.gate + this.release(instrument)) * sampleRate),
        gate: event.gate,
        f0: frequency(event.note) * detune,
        f1: frequency(event.endNote) * detune,
        seed: event.seed,
        velocity: event.velocity,
        lpan: Math.cos(((event.pan + 1) * Math.PI) / 4),
        rpan: Math.sin(((event.pan + 1) * Math.PI) / 4),
      });
    } else {
      const v = this.voices.find((v) => v.id === event.voice);
      if (v && event.frame - v.start < v.gate * sampleRate) {
        v.gate = Math.max(0, (event.frame - v.start) / sampleRate);
        v.end = v.start + Math.ceil((v.gate + this.release(instrument)) * sampleRate);
      }
    }
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const left = outputs[0][0],
      right = outputs[0][1] ?? outputs[0][0],
      n = left.length,
      first = currentFrame,
      last = first + n;
    while (this.queue.length && this.queue[0].frame < last) this.handle(this.queue.shift()!);
    const instrument = this.instrument;
    if (instrument && this.enabled && (instrument.type === 'synth' || instrument.type === 'drum'))
      for (const v of this.voices)
        for (let i = 0; i < n; i++) {
          const index = first + i - v.start;
          if (index < 0) continue;
          if (index >= v.end - v.start) break;
          let fade = 1;
          if (v.kill !== undefined && first + i >= v.kill) {
            fade = 1 - (first + i - v.kill) / this.fade;
            if (fade <= 0) {
              v.end = first + i;
              break;
            }
          }
          const { t, frequency, cycles } = voicePhase(v.f0, v.f1, v.gate, index, sampleRate);
          const value =
            (instrument.type === 'synth'
              ? synthValue(instrument, t, cycles, frequency, v.gate, v.seed, index, sampleRate)
              : drumValue(instrument, t, frequency, v.seed, index)) *
            v.velocity *
            fade;
          left[i] += value * v.lpan;
          right[i] += value * v.rpan;
        }
    this.voices = this.voices.filter((v) => v.end > last);
    for (let i = 0; i < n; i++) {
      this.gain += (this.gainTarget - this.gain) * this.smooth;
      this.pan += (this.panTarget - this.pan) * this.smooth;
      const p = this.pan;
      left[i] *= this.gain * (p > 0 ? Math.cos((p * Math.PI) / 2) : 1);
      right[i] *= this.gain * (p < 0 ? Math.cos((-p * Math.PI) / 2) : 1);
    }
    this.meter.add(left, right);
    return this.alive;
  }
}

class MeterProcessor extends AudioWorkletProcessor {
  private meter: Meter;
  constructor(options?: unknown) {
    super(options);
    this.meter = new Meter(this.port);
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => {
      if (e.data?.type === 'dispose') this.alive = false;
    };
  }
  private alive = true;
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const input = inputs[0],
      output = outputs[0];
    for (let c = 0; c < output.length; c++)
      if (input?.[c]) output[c].set(input[c]);
      else output[c].fill(0);
    this.meter.add(output[0], output[1] ?? output[0]);
    return this.alive;
  }
}

registerProcessor(TRACK_PROCESSOR, TrackProcessor);
registerProcessor(METER_PROCESSOR, MeterProcessor);
