import type { SoundDocument } from '../../../core/sound-schema.js';
import { SOUND_RATE } from '../../../core/sound-effects.js';
import { buildEngineGraph, graphSignature, type EngineGraph } from './engine-graph.js';
import { RealtimeScheduler, type RtEvent } from './scheduler.js';
import {
  buildRealtimeTimeline,
  positionAt,
  type RealtimeMode,
  type RtPosition,
  type RtTimeline,
} from './timeline.js';
import type { MeterReading, ToWorklet, WorkletNoteEvent } from './protocol.js';
import workletUrl from './music-engine.worklet.ts?worker&url';

export type { RealtimeMode, RtPosition } from './timeline.js';
export type { MeterReading } from './protocol.js';

/**
 * Realtime transport over the lookahead scheduler and the AudioWorklet engine. The editor's
 * play/stop buttons use it when AudioWorklet is available; the offline renderer stays the
 * authoritative export and the "精确试听" path.
 */
export class MusicRealtimeController {
  /** Whether this browser can run the realtime engine at all. */
  static isSupported() {
    return (
      typeof window !== 'undefined' &&
      typeof AudioContext !== 'undefined' &&
      typeof AudioWorkletNode !== 'undefined'
    );
  }
  /**
   * Why a score cannot be monitored in realtime (the caller then uses the offline preview),
   * or undefined. Plugin and sample instruments are not voiced by the worklet yet.
   */
  static unsupportedReason(document: SoundDocument): string | undefined {
    const solo = document.tracks.some((t) => t.solo && !t.muted);
    const needs = document.tracks.filter(
      (t) =>
        !t.muted &&
        (!solo || t.solo) &&
        (t.instrument.type === 'plugin' || t.instrument.type === 'sample'),
    );
    if (needs.length)
      return `实时引擎暂不支持${needs[0].instrument.type === 'plugin' ? '插件' : '采样'}乐器（${needs[0].name}），已改用离线试听`;
    return undefined;
  }

  private ctx?: AudioContext;
  private ready?: Promise<void>;
  private graph?: EngineGraph;
  private signature = '';
  private document?: SoundDocument;
  private mode: RealtimeMode = 'song';
  private patternId?: string;
  private loopUnits: { start: number; end: number } | null = null;
  private scheduler?: RealtimeScheduler;
  private timer?: ReturnType<typeof setInterval>;
  private frame?: number;
  private positionListeners = new Set<(p: RtPosition) => void>();
  private meterListeners = new Set<(id: string, m: MeterReading) => void>();
  private stateListeners = new Set<(playing: boolean) => void>();

  constructor(
    private options: { lookahead?: number; interval?: number } = {},
  ) {}

  get playing() {
    return !!this.scheduler?.playing;
  }
  get timeline(): RtTimeline | undefined {
    return this.scheduler?.currentTimeline;
  }
  /** Output latency estimate in seconds (base + output latency). */
  get latency() {
    return (this.ctx?.baseLatency ?? 0) + (this.ctx?.outputLatency ?? 0);
  }

  private async ensureContext() {
    if (!this.ctx) {
      try {
        // Same rate as the offline renderer so the shared DSP (noise per sample) matches.
        this.ctx = new AudioContext({ sampleRate: SOUND_RATE, latencyHint: 'interactive' });
      } catch {
        this.ctx = new AudioContext({ latencyHint: 'interactive' });
      }
      this.ready = this.ctx.audioWorklet.addModule(workletUrl);
    }
    await this.ready;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }
  private rebuildTimeline() {
    const doc = this.document!;
    const timeline = buildRealtimeTimeline(doc, { mode: this.mode, patternId: this.patternId });
    if (!this.scheduler)
      this.scheduler = new RealtimeScheduler(timeline, { lookahead: this.options.lookahead });
    else this.scheduler.setTimeline(timeline);
    this.applyLoop();
  }
  private applyLoop() {
    const s = this.scheduler!,
      t = s.currentTimeline;
    s.setLoop(
      this.loopUnits && t.mode === 'song'
        ? { start: t.toSeconds(this.loopUnits.start), end: t.toSeconds(this.loopUnits.end) }
        : null,
    );
  }
  private configureTracks() {
    if (!this.graph || !this.document) return;
    const timeline = this.scheduler!.currentTimeline;
    for (const track of timeline.tracks) {
      const message: ToWorklet = {
        type: 'config',
        instrument: track.instrument,
        gainDb: track.gainDb,
        pan: track.pan,
        enabled: track.enabled,
      };
      this.graph.tracks.get(track.id)?.port.postMessage(message);
    }
  }
  private syncGraph() {
    const ctx = this.ctx!,
      doc = this.document!,
      signature = graphSignature(doc);
    if (!this.graph || signature !== this.signature) {
      this.graph?.dispose();
      this.graph = buildEngineGraph(ctx, doc, (id, m) => {
        for (const l of this.meterListeners) l(id, m);
      });
      this.signature = signature;
      this.configureTracks();
      // A rebuilt graph has fresh voices: re-start from the current position.
      if (this.scheduler?.playing)
        this.dispatch(this.scheduler.seek(this.scheduler.positionAt(ctx.currentTime), ctx.currentTime));
      return;
    }
    this.configureTracks();
  }
  private dispatch(events: RtEvent[]) {
    if (!events.length || !this.graph) return;
    const perTrack = new Map<string, WorkletNoteEvent[]>();
    const push = (id: string, e: WorkletNoteEvent) => {
      const list = perTrack.get(id);
      if (list) list.push(e);
      else perTrack.set(id, [e]);
    };
    for (const e of events) {
      if (e.type === 'reset') {
        const message: ToWorklet = { type: 'reset', time: e.time };
        // Flush what is batched so far, then reset, so later events in this batch survive.
        this.flush(perTrack);
        for (const node of this.graph.tracks.values()) node.port.postMessage(message);
      } else if (e.type === 'on')
        push(e.trackId, {
          type: 'on',
          time: e.time,
          voice: e.voice,
          note: e.note.note,
          endNote: e.note.endNote,
          velocity: e.note.velocity,
          pan: e.note.pan,
          gate: e.gate,
          seed: e.note.seed,
        });
      else if (e.type === 'off') push(e.trackId, { type: 'off', time: e.time, voice: e.voice });
      else if (e.type === 'auto' && e.target.type === 'track')
        push(e.target.trackId, {
          type: 'auto',
          time: e.time,
          param: e.target.param,
          value: e.value,
        });
      else if (e.type === 'end') this.scheduleEnd(e.time);
    }
    this.flush(perTrack);
  }
  private flush(perTrack: Map<string, WorkletNoteEvent[]>) {
    for (const [id, events] of perTrack) {
      const message: ToWorklet = { type: 'events', events };
      this.graph?.tracks.get(id)?.port.postMessage(message);
    }
    perTrack.clear();
  }
  private scheduleEnd(time: number) {
    const wait = Math.max(0, (time - this.ctx!.currentTime) * 1000);
    setTimeout(() => {
      if (!this.scheduler?.playing) this.halt();
    }, wait);
  }
  private tick = () => {
    if (!this.ctx || !this.scheduler) return;
    this.dispatch(this.scheduler.advance(this.ctx.currentTime));
  };
  private report = () => {
    this.frame = undefined;
    if (!this.ctx || !this.scheduler) return;
    const p = positionAt(
      this.scheduler.currentTimeline,
      this.scheduler.positionAt(this.ctx.currentTime - this.latency),
    );
    for (const l of this.positionListeners) l(p);
    if (this.timer !== undefined) this.frame = requestAnimationFrame(this.report);
  };
  private halt() {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.report();
    for (const l of this.stateListeners) l(false);
  }

  /** Load or replace the score (live edits while playing keep the musical position). */
  async load(document: SoundDocument) {
    await this.ensureContext();
    this.update(document);
  }
  /** Apply an edited document. Synchronous once `load` has resolved. */
  update(document: SoundDocument) {
    this.document = document;
    if (!this.ctx) return;
    this.rebuildTimeline();
    this.syncGraph();
  }
  /** Start from `seconds` (timeline seconds; default: where it stopped, or 0 after the end). */
  async start(seconds?: number) {
    if (!this.document) throw new Error('No score loaded');
    const ctx = await this.ensureContext();
    if (!this.scheduler) this.rebuildTimeline();
    this.syncGraph();
    const s = this.scheduler!,
      from = seconds ?? s.positionAt(ctx.currentTime),
      position = !s.region() && from >= s.currentTimeline.length - 1e-6 ? 0 : from;
    // Start a little ahead so the first window is not late.
    this.dispatch(s.start(ctx.currentTime + 0.03, position));
    this.tick();
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = setInterval(this.tick, this.options.interval ?? 25);
    this.frame ??= requestAnimationFrame(this.report);
    for (const l of this.stateListeners) l(true);
  }
  stop() {
    if (!this.ctx || !this.scheduler) return;
    this.dispatch(this.scheduler.stop(this.ctx.currentTime));
    this.halt();
  }
  /** Seek to timeline seconds. */
  seek(seconds: number) {
    if (!this.scheduler) return;
    this.dispatch(this.scheduler.seek(seconds, this.ctx?.currentTime ?? 0));
    if (!this.playing) this.report();
  }
  setMode(mode: RealtimeMode, patternId?: string) {
    if (mode === this.mode && patternId === this.patternId) return;
    this.mode = mode;
    this.patternId = patternId;
    if (!this.document || !this.ctx) return;
    const timeline = buildRealtimeTimeline(this.document, { mode, patternId });
    this.scheduler!.setTimeline(timeline);
    this.applyLoop();
    this.configureTracks();
    if (this.playing) this.seek(0);
  }
  /** Loop region in document units (song mode); null loops nothing (pattern mode loops the pattern). */
  setLoop(loop: { start: number; end: number } | null) {
    this.loopUnits = loop && loop.end > loop.start ? { ...loop } : null;
    if (this.scheduler) this.applyLoop();
  }
  /** Set the base tempo (first tempo point) of the loaded score, keeping the musical position. */
  setBpm(bpm: number) {
    if (!this.document) return;
    const tempo = this.document.tempo.map((t, i) => (i === 0 ? { ...t, bpm } : t));
    this.update({ ...this.document, tempo });
  }
  onPosition(listener: (p: RtPosition) => void) {
    this.positionListeners.add(listener);
    return () => this.positionListeners.delete(listener);
  }
  onMeter(listener: (id: string, reading: MeterReading) => void) {
    this.meterListeners.add(listener);
    return () => this.meterListeners.delete(listener);
  }
  onState(listener: (playing: boolean) => void) {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  dispose() {
    this.stop();
    this.graph?.dispose();
    this.graph = undefined;
    void this.ctx?.close();
    this.ctx = undefined;
    this.positionListeners.clear();
    this.meterListeners.clear();
    this.stateListeners.clear();
  }
}
