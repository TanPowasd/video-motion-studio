import type { SoundDocument, SoundEffect } from '../../../core/sound-schema.js';
import { METER_PROCESSOR, TRACK_PROCESSOR, type FromWorklet, type MeterReading } from './protocol.js';

/**
 * Web Audio graph of the realtime engine: one worklet node per track (voices + fader) →
 * track effect chain → its bus and sends; buses (effects → fader) in the offline bus order;
 * master (gain stage, effects) → meter worklet → destination.
 *
 * Built-in effects are approximated with native nodes (offline remains authoritative):
 * gain = GainNode; filter = BiquadFilterNode (same RBJ shapes); distortion = WaveShaper with
 * the offline tanh curve; delay = per-channel DelayNode + feedback; chorus = LFO-modulated
 * DelayNode; reverb = ConvolverNode on a generated exponential-noise IR (not the offline
 * algorithm); compressor/limiter = DynamicsCompressorNode (different detector/knee).
 * Plugin effects are bypassed (TODO: live plugin host).
 */
const dbGain = (db: number) => 10 ** (db / 20);
/** Started LFOs of the graph being built, stopped on dispose. */
let sources: AudioScheduledSourceNode[] = [];
interface Chain {
  input: AudioNode;
  output: AudioNode;
}
function through(ctx: BaseAudioContext): Chain {
  const g = ctx.createGain();
  return { input: g, output: g };
}
/** Offline balance law: attenuate the opposite side, keep the centre level. */
function fader(ctx: BaseAudioContext, gainDb: number, pan: number): Chain {
  const input = ctx.createGain(),
    split = ctx.createChannelSplitter(2),
    merge = ctx.createChannelMerger(2),
    l = ctx.createGain(),
    r = ctx.createGain(),
    gain = dbGain(gainDb);
  input.channelCount = 2;
  input.channelCountMode = 'explicit';
  l.gain.value = gain * (pan > 0 ? Math.cos((pan * Math.PI) / 2) : 1);
  r.gain.value = gain * (pan < 0 ? Math.cos((-pan * Math.PI) / 2) : 1);
  input.connect(split);
  split.connect(l, 0).connect(merge, 0, 0);
  split.connect(r, 1).connect(merge, 0, 1);
  return { input, output: merge };
}
function wetDry(ctx: BaseAudioContext, mix: number, wet: Chain): Chain {
  const input = ctx.createGain(),
    output = ctx.createGain(),
    dry = ctx.createGain(),
    wetGain = ctx.createGain();
  dry.gain.value = 1 - mix;
  wetGain.gain.value = mix;
  input.connect(dry).connect(output);
  input.connect(wet.input);
  wet.output.connect(wetGain).connect(output);
  return { input, output };
}
function reverbImpulse(ctx: BaseAudioContext, seconds: number, damping: number) {
  const length = Math.max(1, Math.round(seconds * ctx.sampleRate)),
    buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    let state = 0x9e3779b9 ^ (c + 1),
      low = 0;
    for (let i = 0; i < length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const white = state / 2147483648 - 1;
      low += (white - low) * (1 - damping * 0.9);
      data[i] = low * Math.exp((-6.9 * i) / length);
    }
  }
  return buffer;
}
function effectChain(ctx: BaseAudioContext, effect: SoundEffect): Chain {
  switch (effect.type) {
    case 'gain': {
      const g = ctx.createGain();
      g.gain.value = dbGain(effect.db);
      return { input: g, output: g };
    }
    case 'filter': {
      const f = ctx.createBiquadFilter();
      f.type = effect.mode;
      f.frequency.value = Math.min(effect.frequency, ctx.sampleRate / 2 - 1);
      f.Q.value = effect.q;
      f.gain.value = effect.db;
      return { input: f, output: f };
    }
    case 'distortion': {
      const shaper = ctx.createWaveShaper(),
        curve = new Float32Array(2049),
        norm = Math.tanh(effect.drive);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * effect.drive) / norm;
      }
      shaper.curve = curve;
      return wetDry(ctx, effect.mix, { input: shaper, output: shaper });
    }
    case 'delay': {
      const split = ctx.createChannelSplitter(2),
        merge = ctx.createChannelMerger(2);
      [effect.seconds, effect.rightSeconds ?? effect.seconds].forEach((seconds, channel) => {
        const d = ctx.createDelay(3.5),
          fb = ctx.createGain();
        d.delayTime.value = seconds;
        fb.gain.value = effect.feedback;
        split.connect(d, channel);
        d.connect(fb).connect(d);
        d.connect(merge, 0, channel);
      });
      return wetDry(ctx, effect.mix, { input: split, output: merge });
    }
    case 'chorus': {
      const d = ctx.createDelay(0.1),
        lfo = ctx.createOscillator(),
        depth = ctx.createGain();
      d.delayTime.value = effect.delay;
      lfo.frequency.value = effect.rate;
      depth.gain.value = effect.depth;
      lfo.connect(depth).connect(d.delayTime);
      lfo.start();
      sources.push(lfo);
      return wetDry(ctx, effect.mix, { input: d, output: d });
    }
    case 'reverb': {
      const conv = ctx.createConvolver();
      conv.buffer = reverbImpulse(ctx, effect.seconds, effect.damping);
      return wetDry(ctx, effect.mix, { input: conv, output: conv });
    }
    case 'compressor': {
      const c = ctx.createDynamicsCompressor(),
        makeup = ctx.createGain();
      c.threshold.value = effect.thresholdDb;
      c.ratio.value = Math.min(20, effect.ratio);
      c.knee.value = Math.min(40, effect.kneeDb);
      c.attack.value = Math.min(1, effect.attack);
      c.release.value = Math.min(1, effect.release);
      makeup.gain.value = dbGain(effect.makeupDb);
      c.connect(makeup);
      return { input: c, output: makeup };
    }
    case 'limiter': {
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = effect.ceilingDb;
      c.ratio.value = 20;
      c.knee.value = 0;
      c.attack.value = 0.001;
      c.release.value = Math.min(1, effect.release);
      return { input: c, output: c };
    }
    case 'plugin':
      // TODO(P2 live plugin host): run plugin effects through the native live session.
      return through(ctx);
  }
}
function chain(ctx: BaseAudioContext, effects: SoundEffect[]): Chain {
  const head = through(ctx);
  let tail: AudioNode = head.output;
  for (const effect of effects) {
    const c = effectChain(ctx, effect);
    tail.connect(c.input);
    tail = c.output;
  }
  return { input: head.input, output: tail };
}

export interface EngineGraph {
  tracks: Map<string, AudioWorkletNode>;
  dispose(): void;
}
/** Build the graph for a document. `onMeter` receives readings keyed by track id or 'master'. */
export function buildEngineGraph(
  ctx: AudioContext,
  document: SoundDocument,
  onMeter: (id: string, reading: MeterReading) => void,
): EngineGraph {
  const nodes: AudioNode[] = [];
  const started: AudioScheduledSourceNode[] = (sources = []);
  const keep = <T extends AudioNode>(n: T) => (nodes.push(n), n);
  const listen = (id: string, node: AudioWorkletNode) => {
    node.port.onmessage = (e: MessageEvent<FromWorklet>) => {
      if (e.data?.type === 'meter') onMeter(id, { peak: e.data.peak, rms: e.data.rms });
    };
  };
  // Master: [pre gain] → effects → [post gain] → meter → destination.
  const master = document.master,
    masterIn = keep(ctx.createGain()),
    masterGain = dbGain(master.gainDb),
    post = master.gainStage === 'post',
    masterChain = chain(ctx, master.effects),
    masterOut = keep(ctx.createGain()),
    meter = keep(
      new AudioWorkletNode(ctx, METER_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      }),
    );
  masterIn.gain.value = post ? 1 : masterGain;
  masterOut.gain.value = post ? masterGain : 1;
  masterIn.connect(masterChain.input);
  masterChain.output.connect(masterOut).connect(meter).connect(ctx.destination);
  listen('master', meter);
  const inputs = new Map<string, AudioNode>([['master', masterIn]]);
  for (const bus of document.buses) inputs.set(bus.id, keep(ctx.createGain()));
  const route = (
    from: AudioNode,
    v: { busId: string; sends: { busId: string; db: number }[] },
  ) => {
    from.connect(inputs.get(v.busId) ?? masterIn);
    for (const send of v.sends) {
      const g = keep(ctx.createGain());
      g.gain.value = dbGain(send.db);
      from.connect(g).connect(inputs.get(send.busId) ?? masterIn);
    }
  };
  for (const bus of document.buses) {
    const c = chain(ctx, bus.effects),
      f = fader(ctx, bus.gainDb, bus.pan);
    inputs.get(bus.id)!.connect(c.input);
    c.output.connect(f.input);
    route(f.output, bus);
  }
  const tracks = new Map<string, AudioWorkletNode>();
  for (const track of document.tracks) {
    const node = new AudioWorkletNode(ctx, TRACK_PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    keep(node);
    listen(track.id, node);
    const c = chain(ctx, track.effects);
    node.connect(c.input);
    route(c.output, track);
    tracks.set(track.id, node);
  }
  return {
    tracks,
    dispose() {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* already disconnected */
        }
        if (n instanceof AudioWorkletNode) n.port.onmessage = null;
      }
      for (const s of started) s.stop();
      for (const node of [...tracks.values(), meter]) {
        node.port.postMessage({ type: 'dispose' });
        node.port.close();
      }
    },
  };
}
/** Graph-shaping part of a document: when it changes the graph is rebuilt. */
export function graphSignature(document: SoundDocument) {
  return JSON.stringify({
    t: document.tracks.map((t) => [t.id, t.effects, t.busId, t.sends]),
    b: document.buses,
    m: document.master,
  });
}
