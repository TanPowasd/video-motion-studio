import type { AutomationTarget } from '../../../core/sound-schema.js';
import { laneValue, lowerBound, type RtNote, type RtTimeline } from './timeline.js';

/**
 * Lookahead scheduler: maps a realtime clock (AudioContext seconds, injected by the caller)
 * onto timeline seconds and emits, per `advance(now)` call, every event that falls in
 * [already scheduled, now + lookahead). Pure and window-based: it keeps a note cursor, a
 * bounded queue of pending note-offs (one per sounding voice) and a short ring of loop
 * anchors, never a growing list of scheduled events.
 *
 * Time model: an anchor says "context time `ctx` plays timeline position `pos`". Positions
 * advance 1:1 with context time until the segment end (loop end, or the timeline length when
 * not looping), where a loop starts a new anchor at the loop start. Intervals are half-open,
 * so a note exactly on the loop end belongs to the next lap and none is played twice.
 */
export type RtEvent =
  | {
      type: 'on';
      time: number;
      voice: number;
      trackId: string;
      note: RtNote;
      /** Gate in seconds, cut at the loop end when looping. */
      gate: number;
    }
  | { type: 'off'; time: number; voice: number; trackId: string }
  | { type: 'auto'; time: number; key: string; target: AutomationTarget; value: number }
  /** Cancel everything queued at or after `time` and release sounding voices. */
  | { type: 'reset'; time: number }
  /** Song end reached (no loop); voices keep releasing. */
  | { type: 'end'; time: number };

export interface LoopRegion {
  /** Timeline seconds. */
  start: number;
  end: number;
}
export interface SchedulerOptions {
  /** How far ahead of `now` to schedule, seconds (default 0.12). */
  lookahead?: number;
  /** Automation sample spacing, seconds (default 0.02). */
  automationStep?: number;
}
interface Anchor {
  ctx: number;
  pos: number;
}
interface PendingOff {
  time: number;
  voice: number;
  trackId: string;
}
const MAX_ANCHORS = 8;
const MIN_LOOP = 1e-3;

export class RealtimeScheduler {
  readonly lookahead: number;
  readonly automationStep: number;
  private timeline: RtTimeline;
  private loop: LoopRegion | null = null;
  private running = false;
  private anchors: Anchor[] = [{ ctx: 0, pos: 0 }];
  private scheduledCtx = 0;
  private cursor = 0;
  private nextAuto = 0;
  private offs: PendingOff[] = [];
  private voiceId = 0;
  private stoppedAt = 0;
  private endCtx = Infinity;

  constructor(timeline: RtTimeline, options: SchedulerOptions = {}) {
    this.timeline = timeline;
    this.lookahead = options.lookahead ?? 0.12;
    this.automationStep = options.automationStep ?? 0.02;
  }
  get playing() {
    return this.running;
  }
  get currentTimeline() {
    return this.timeline;
  }
  /** The loop in effect: the explicit region, or the whole pattern in pattern mode. */
  region(): LoopRegion | null {
    const length = this.timeline.length;
    if (this.loop) {
      const start = Math.max(0, Math.min(length, this.loop.start)),
        end = Math.max(0, Math.min(length, this.loop.end));
      if (end - start >= MIN_LOOP) return { start, end };
    }
    return this.timeline.mode === 'pattern' && length >= MIN_LOOP ? { start: 0, end: length } : null;
  }
  private normalize(position: number) {
    const region = this.region();
    let p = Math.max(0, Number.isFinite(position) ? position : 0);
    if (region && p >= region.end)
      p = region.start + ((p - region.start) % (region.end - region.start));
    return region ? p : Math.min(p, this.timeline.length);
  }
  private anchor(ctx: number, pos: number) {
    const last = this.anchors[this.anchors.length - 1];
    if (last && last.ctx === ctx) this.anchors[this.anchors.length - 1] = { ctx, pos };
    else this.anchors.push({ ctx, pos });
    if (this.anchors.length > MAX_ANCHORS) this.anchors.shift();
    this.cursor = lowerBound(this.timeline.notes, pos, (n) => n.at);
    this.nextAuto = pos;
  }
  private addOff(off: PendingOff) {
    const i = lowerBound(this.offs, off.time + 1e-12, (o) => o.time);
    this.offs.splice(i, 0, off);
  }
  /** Begin playback: context time `ctx` plays timeline second `position`. */
  start(ctx: number, position = this.stoppedAt): RtEvent[] {
    const out: RtEvent[] = this.running ? [{ type: 'reset', time: ctx }] : [];
    this.running = true;
    this.offs = [];
    this.endCtx = Infinity;
    this.anchors = [];
    this.anchor(ctx, this.normalize(position));
    this.scheduledCtx = ctx;
    return out;
  }
  /** Stop; the position is kept for the next `start()`. */
  stop(ctx: number): RtEvent[] {
    if (!this.running) return [];
    this.stoppedAt = this.positionAt(ctx);
    this.running = false;
    this.offs = [];
    return [{ type: 'reset', time: ctx }];
  }
  /** Jump to a timeline second. While playing this cuts sounding notes (reset). */
  seek(position: number, ctx: number): RtEvent[] {
    if (!this.running) {
      this.stoppedAt = this.normalize(position);
      return [];
    }
    return this.start(ctx, position);
  }
  /**
   * Re-anchor at the already scheduled horizon so events in flight stay as scheduled and the
   * change applies from there on (no reset, no dropped or repeated notes).
   */
  private reanchor(position: number) {
    this.anchor(this.scheduledCtx, this.normalize(position));
  }
  setLoop(loop: LoopRegion | null) {
    const pos = this.running ? this.positionAt(this.scheduledCtx) : this.stoppedAt;
    this.loop = loop && loop.end - loop.start >= MIN_LOOP ? { ...loop } : null;
    if (this.running) this.reanchor(pos);
    else this.stoppedAt = this.normalize(pos);
  }
  /**
   * Swap in a rebuilt timeline (edited document, BPM change, mode change), keeping the
   * musical position (document units) when `keepUnits`, else the timeline second.
   */
  setTimeline(timeline: RtTimeline, keepUnits = true) {
    const old = this.timeline,
      pos = this.running ? this.positionAt(this.scheduledCtx) : this.stoppedAt,
      next = keepUnits && old.mode === timeline.mode ? timeline.toSeconds(old.toUnits(pos)) : pos;
    this.timeline = timeline;
    if (this.running) this.reanchor(next);
    else this.stoppedAt = this.normalize(next);
  }
  /** Timeline second heard at context time `ctx` (follows loop wraps already scheduled). */
  positionAt(ctx: number): number {
    if (!this.running) return this.stoppedAt;
    if (ctx >= this.endCtx) return this.timeline.length;
    let a = this.anchors[0];
    for (const anchor of this.anchors) if (anchor.ctx <= ctx) a = anchor;
    const p = a.pos + Math.max(0, ctx - a.ctx),
      region = this.region();
    return region && p >= region.end ? region.start : p;
  }
  /** Schedule everything up to `now + lookahead` that has not been scheduled yet. */
  advance(now: number): RtEvent[] {
    if (!this.running) return [];
    const horizon = now + this.lookahead,
      out: RtEvent[] = [],
      { notes, lanes } = this.timeline;
    let guard = 0;
    while (this.running && this.scheduledCtx < horizon && guard++ < 10000) {
      const a = this.anchors[this.anchors.length - 1],
        region = this.region(),
        segEndPos = region ? region.end : this.timeline.length,
        segEndCtx = a.ctx + (segEndPos - a.pos),
        until = Math.min(horizon, Math.max(segEndCtx, this.scheduledCtx)),
        posUntil = a.pos + (until - a.ctx);
      while (this.cursor < notes.length && notes[this.cursor].at < posUntil) {
        const note = notes[this.cursor++],
          time = a.ctx + (note.at - a.pos),
          gate = region ? Math.min(note.gate, region.end - note.at) : note.gate,
          voice = ++this.voiceId;
        out.push({ type: 'on', time, voice, trackId: note.trackId, note, gate });
        this.addOff({ time: time + gate, voice, trackId: note.trackId });
      }
      if (lanes.length)
        while (this.nextAuto < posUntil) {
          const time = a.ctx + (this.nextAuto - a.pos);
          for (const lane of lanes)
            out.push({
              type: 'auto',
              time,
              key: lane.key,
              target: lane.target,
              value: laneValue(lane, this.nextAuto),
            });
          this.nextAuto += this.automationStep;
        }
      this.scheduledCtx = until;
      if (until >= segEndCtx) {
        if (region) this.anchor(segEndCtx, region.start);
        else {
          this.endCtx = segEndCtx;
          out.push({ type: 'end', time: segEndCtx });
          for (const off of this.offs) out.push({ type: 'off', ...off });
          this.offs = [];
          this.stoppedAt = this.timeline.length;
          this.running = false;
        }
      }
    }
    let flushed = 0;
    while (flushed < this.offs.length && this.offs[flushed].time < horizon) flushed++;
    for (const off of this.offs.splice(0, flushed)) out.push({ type: 'off', ...off });
    return out.sort((x, y) => x.time - y.time);
  }
  /** Sizes of the internal state, for tests and diagnostics; all bounded by polyphony. */
  stats() {
    return { pendingOffs: this.offs.length, anchors: this.anchors.length, voices: this.voiceId };
  }
}
