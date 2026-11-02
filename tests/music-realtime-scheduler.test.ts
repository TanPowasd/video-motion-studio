import { describe, it, expect } from 'vitest';
import { compileSound, SoundRenderer, SOUND_RATE } from '../src/core/sound.js';
import { drumValue, synthValue, voicePhase } from '../src/core/sound-dsp.js';
import { soundDocumentSchema, type SoundDocument } from '../src/core/sound-schema.js';
import { newMusic } from '../src/editor/music/music-model.js';
import {
  buildRealtimeTimeline,
  positionAt,
  type RtTimeline,
} from '../src/editor/music/realtime/timeline.js';
import { RealtimeScheduler, type RtEvent } from '../src/editor/music/realtime/scheduler.js';

/** Deterministic PRNG for the jittery clock. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
type On = Extract<RtEvent, { type: 'on' }>;
/**
 * Drive a scheduler with a simulated clock: `advance` is called at irregular intervals
 * (uniform in [minGap, maxGap] seconds) from `from` to `to`; returns every event with the
 * clock reading at which it was emitted.
 */
function drive(
  s: RealtimeScheduler,
  from: number,
  to: number,
  gaps: [number, number] = [0.025, 0.025],
  seed = 1,
  onBatch?: (batch: RtEvent[], now: number) => void,
) {
  const random = rng(seed),
    out: { event: RtEvent; now: number }[] = [];
  for (let now = from; now <= to; now += gaps[0] + (gaps[1] - gaps[0]) * random()) {
    const batch = s.advance(now);
    onBatch?.(batch, now);
    for (const event of batch) out.push({ event, now });
  }
  return out;
}
const ons = (events: { event: RtEvent }[]) =>
  events.map((e) => e.event).filter((e): e is On => e.type === 'on');

function songWith(patch: Record<string, unknown>): SoundDocument {
  return soundDocumentSchema.parse({ ...newMusic('rt'), ...patch });
}

describe('realtime timeline', () => {
  it('uses the offline expansion: same notes, times and seeds as compileSound', () => {
    const doc = newMusic('rt'),
      timeline = buildRealtimeTimeline(doc, { mode: 'song' }),
      compiled = compileSound(doc).tracks.flatMap((t) =>
        t.events.map((e) => ({ trackId: t.track.id, start: e.start, seed: e.seed, note: e.note })),
      );
    expect(timeline.notes).toHaveLength(compiled.length);
    expect(timeline.length).toBeCloseTo(8, 9); // 16 beats at 120 bpm
    const byStart = [...compiled].sort((a, b) => a.start - b.start);
    timeline.notes.forEach((n, i) => {
      expect(Math.round(n.at * SOUND_RATE)).toBe(byStart[i].start);
      expect(n.seed).toBe(byStart[i].seed);
      expect(n.note).toBe(byStart[i].note);
      expect(n.gate).toBeCloseTo(0.375, 9);
    });
  });
  it('pattern mode expands the one pattern from zero', () => {
    const timeline = buildRealtimeTimeline(newMusic('rt'), { mode: 'pattern', patternId: 'pattern-1' });
    expect(timeline.mode).toBe('pattern');
    expect(timeline.length).toBeCloseTo(2, 9);
    expect(timeline.notes.map((n) => n.at)).toEqual([0, 0.5, 1, 1.5]);
  });
  it('bar:beat:tick follows the time signature', () => {
    const timeline = buildRealtimeTimeline(newMusic('rt'));
    expect(positionAt(timeline, 2.25).label).toBe('2:1:48');
    expect(positionAt(timeline, 0).label).toBe('1:1:00');
    const six = buildRealtimeTimeline(songWith({ timeSignature: [6, 8] }));
    // 1.5 s = 3 quarter beats = 6 eighths = one full 6/8 bar.
    expect(positionAt(six, 1.5).label).toBe('2:1:00');
  });
});

describe('shared voice DSP', () => {
  it('the worklet voice formula reproduces the offline renderer sample for sample', () => {
    for (const instrument of [
      { type: 'synth', wave: 'saw', fmRatio: 2, fmIndex: 1.5, detune: 7 },
      { type: 'drum', voice: 'snare' },
    ] as const) {
      const doc = soundDocumentSchema.parse({
        kind: 'sound',
        version: 2,
        id: 'dsp',
        name: 'dsp',
        duration: 2,
        tail: 0.5,
        tracks: [
          {
            id: 't',
            name: 't',
            instrument,
            events: [{ id: 'n', at: 0, duration: 0.5, note: 57, endNote: 64, velocity: 0.8, pan: 0.3 }],
          },
        ],
      });
      const r = new SoundRenderer(doc),
        block = r.process(16000),
        timeline = buildRealtimeTimeline(doc),
        note = timeline.notes[0],
        inst = timeline.tracks[0].instrument,
        detune = inst.type === 'synth' ? 2 ** (inst.detune / 1200) : 1,
        f = (n: number) => 440 * 2 ** ((n - 69) / 12) * detune,
        lpan = Math.cos(((note.pan + 1) * Math.PI) / 4);
      for (let index = 0; index < 16000; index += 7) {
        const { t, frequency, cycles } = voicePhase(f(note.note), f(note.endNote), note.gate, index);
        const value =
          inst.type === 'synth'
            ? synthValue(inst, t, cycles, frequency, note.gate, note.seed, index)
            : inst.type === 'drum'
              ? drumValue(inst, t, frequency, note.seed, index)
              : NaN;
        // Worklet order: (value · pan) · velocity (· fade 1), as the renderer.
        expect(value * lpan * note.velocity + 0).toBe(block.left[index] + 0);
      }
    }
  });
});

describe('realtime scheduler', () => {
  it('is jitter-proof with a simulated clock: every note once, exact times, never late', () => {
    const timeline = buildRealtimeTimeline(newMusic('rt'), { mode: 'pattern' }),
      s = new RealtimeScheduler(timeline, { lookahead: 0.12 });
    const t0 = 10.003;
    s.start(t0, 0);
    // Irregular callback gaps from 1 ms to 110 ms (all below the 120 ms lookahead).
    const events = drive(s, t0, t0 + 30, [0.001, 0.11], 7);
    const notes = events.filter((e) => e.event.type === 'on');
    for (const { event, now } of notes) expect(event.time).toBeGreaterThanOrEqual(now);
    const times = ons(events).map((e) => e.time);
    const expected: number[] = [];
    for (let lap = 0; t0 + lap * 2 <= t0 + 30.12; lap++)
      for (const at of [0, 0.5, 1, 1.5]) {
        const t = t0 + lap * 2 + at;
        if (t < events[events.length - 1].now + 0.12) expected.push(t);
      }
    expect(times.length).toBe(expected.length);
    times.forEach((t, i) => expect(t).toBeCloseTo(expected[i], 9));
    // Ordered and unique.
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
  });
  it('song mode plays the clips once and ends; offs match ons', () => {
    const s = new RealtimeScheduler(buildRealtimeTimeline(newMusic('rt'), { mode: 'song' }));
    s.start(1, 0);
    const events = drive(s, 1, 12, [0.01, 0.06], 3);
    expect(ons(events)).toHaveLength(16);
    const offs = events.filter((e) => e.event.type === 'off');
    expect(offs).toHaveLength(16);
    const end = events.find((e) => e.event.type === 'end');
    expect(end?.event.time).toBeCloseTo(9, 9);
    expect(s.playing).toBe(false);
    expect(s.positionAt(20)).toBeCloseTo(8, 9);
    expect(s.stats().pendingOffs).toBe(0);
  });
  it('pattern vs song: the same document schedules different material', () => {
    const doc = newMusic('rt');
    const pattern = new RealtimeScheduler(buildRealtimeTimeline(doc, { mode: 'pattern' })),
      song = new RealtimeScheduler(buildRealtimeTimeline(doc, { mode: 'song' }));
    pattern.start(0, 0);
    song.start(0, 0);
    const p = ons(drive(pattern, 0, 9.5)),
      g = ons(drive(song, 0, 9.5));
    expect(g).toHaveLength(16);
    expect(p.length).toBeGreaterThan(16); // keeps looping past the song end
    expect(pattern.playing).toBe(true);
    expect(song.playing).toBe(false);
    // Switching modes on a running scheduler keeps playing from the new timeline.
    pattern.setTimeline(buildRealtimeTimeline(doc, { mode: 'song' }));
    expect(pattern.currentTimeline.mode).toBe('song');
  });
  it('loops seamlessly: no dropped or duplicated notes across the wrap', () => {
    // Loop beats [2, 6) = seconds [1, 3) of the 120 bpm song; notes every beat.
    const timeline = buildRealtimeTimeline(newMusic('rt')),
      s = new RealtimeScheduler(timeline);
    s.setLoop({ start: 1, end: 3 });
    s.start(5, 0);
    const events = drive(s, 5, 5 + 41, [0.004, 0.1], 11);
    const list = ons(events);
    // Before the loop: beats 0 and 1 once. Then each lap plays beats 2, 3, 4, 5 exactly once.
    expect(list.slice(0, 2).map((e) => e.time - 5)).toEqual([0, 0.5]);
    const laps = list.slice(2);
    laps.forEach((e, i) => {
      const lap = Math.floor(i / 4),
        k = i % 4;
      expect(e.time).toBeCloseTo(5 + 1 + lap * 2 + k * 0.5, 9);
      expect(e.note.at).toBeCloseTo(1 + k * 0.5, 9);
    });
    expect(laps.length % 4 === 0 || laps.length % 4 === 1).toBe(true);
    const keys = new Set(list.map((e) => `${e.time.toFixed(9)}:${e.note.key}`));
    expect(keys.size).toBe(list.length);
    // A position read just across the wrap is the loop start, not past the loop end.
    expect(s.positionAt(5 + 3 + 1e-9)).toBeCloseTo(1, 6);
    expect(s.stats().anchors).toBeLessThanOrEqual(8);
  });
  it('cuts gates at the loop end and keeps a note on the loop start each lap', () => {
    const timeline = buildRealtimeTimeline(newMusic('rt'));
    const s = new RealtimeScheduler(timeline);
    s.setLoop({ start: 0.5, end: 0.7 }); // only the note at 0.5 s, gate 0.375 → cut to 0.2
    s.start(0, 0.5);
    const list = ons(drive(s, 0, 2));
    expect(list.length).toBeGreaterThanOrEqual(10);
    for (const e of list) expect(e.gate).toBeCloseTo(0.2, 9);
  });
  it('seeks: resets in-flight events and continues from the new position', () => {
    const s = new RealtimeScheduler(buildRealtimeTimeline(newMusic('rt')));
    s.start(0, 0);
    drive(s, 0, 1);
    const reset = s.seek(5, 1.2);
    expect(reset).toEqual([{ type: 'reset', time: 1.2 }]);
    expect(s.stats().pendingOffs).toBe(0);
    const after = ons(drive(s, 1.2, 2.5));
    expect(after[0].note.at).toBeCloseTo(5, 9);
    expect(after[0].time).toBeCloseTo(1.2, 9);
    for (const e of after) expect(e.time - 1.2).toBeCloseTo(e.note.at - 5, 9);
    expect(s.positionAt(2)).toBeCloseTo(5.8, 9);
    // Seeking while stopped only moves the start point.
    s.stop(3);
    expect(s.seek(2, 3)).toEqual([]);
    expect(s.positionAt(99)).toBe(2);
  });
  it('emits automation samples on a fixed grid with the offline lane values', () => {
    const doc = songWith({
      automationClips: [
        {
          id: 'fade',
          target: { type: 'track', trackId: 'lead', param: 'gainDb' },
          points: [
            { at: 0, value: -24, curve: 'linear' },
            { at: 8, value: 0, curve: 'linear' },
          ],
        },
      ],
      clips: [
        ...newMusic('rt').clips,
        { id: 'auto-1', kind: 'automation', lane: 1, at: 0, length: 8, refId: 'fade' },
      ],
    });
    const timeline = buildRealtimeTimeline(doc);
    expect(timeline.lanes).toHaveLength(1);
    const s = new RealtimeScheduler(timeline, { automationStep: 0.02 });
    s.start(0, 0);
    const autos = drive(s, 0, 2)
      .map((e) => e.event)
      .filter((e): e is Extract<RtEvent, { type: 'auto' }> => e.type === 'auto');
    expect(autos[0].value).toBeCloseTo(-24, 9);
    const at1 = autos.find((a) => Math.abs(a.time - 1) < 1e-6)!;
    expect(at1.value).toBeCloseTo(-24 + 24 * (2 / 8), 6); // 1 s = beat 2 of 8
    for (let i = 1; i < autos.length; i++)
      expect(autos[i].time - autos[i - 1].time).toBeCloseTo(0.02, 6);
  });
  it('schedules a 10-minute song with bounded state (window-based, no growth)', () => {
    // 1200 beats at 120 bpm = 600 s; 300 four-beat clips of a 16-note, two-track pattern.
    const base = newMusic('long');
    const doc = soundDocumentSchema.parse({
      ...base,
      duration: 1200,
      tracks: [
        ...base.tracks,
        { id: 'hat', name: 'hat', instrument: { type: 'drum', voice: 'hat' } },
      ],
      patterns: [
        {
          id: 'p',
          name: 'P',
          length: 4,
          channels: ['lead', 'hat'].map((trackId) => ({
            trackId,
            events: Array.from({ length: 16 }, (_, i) => ({
              id: `${trackId}-${i}`,
              at: i * 0.25,
              duration: 0.2,
              note: 60 + (i % 12),
              velocity: 0.8,
            })),
          })),
        },
      ],
      clips: Array.from({ length: 300 }, (_, r) => ({
        id: `c${r}`,
        kind: 'pattern',
        lane: 0,
        at: r * 4,
        length: 4,
        refId: 'p',
      })),
    });
    const timeline: RtTimeline = buildRealtimeTimeline(doc);
    expect(timeline.notes).toHaveLength(9600);
    expect(timeline.length).toBeCloseTo(600, 6);
    const s = new RealtimeScheduler(timeline);
    s.start(0, 0);
    let maxBatch = 0,
      maxOffs = 0,
      total = 0,
      calls = 0;
    const heapBefore = process.memoryUsage().heapUsed;
    for (let now = 0; now <= 602; now += 0.025) {
      const batch = s.advance(now);
      calls++;
      for (const e of batch) if (e.type === 'on') total++;
      maxBatch = Math.max(maxBatch, batch.length);
      maxOffs = Math.max(maxOffs, s.stats().pendingOffs);
    }
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
    expect(calls).toBeGreaterThan(24000);
    expect(total).toBe(9600);
    expect(maxBatch).toBeLessThan(40); // one ~25 ms window of a 16th-note grid × 2 tracks
    expect(maxOffs).toBeLessThan(16); // only sounding voices are tracked
    expect(s.stats().anchors).toBeLessThanOrEqual(8);
    expect(heapGrowth).toBeLessThan(32 * 1024 * 1024);
    expect(s.playing).toBe(false);

    // The same song looped in two-bar (8-beat) laps for 10 minutes keeps the anchor ring bounded.
    const looped = new RealtimeScheduler(timeline);
    looped.setLoop({ start: 0, end: 4 });
    looped.start(0, 0);
    let loopedOns = 0;
    for (let now = 0; now <= 600; now += 0.025)
      for (const e of looped.advance(now)) if (e.type === 'on') loopedOns++;
    expect(looped.stats().anchors).toBeLessThanOrEqual(8);
    expect(looped.stats().pendingOffs).toBeLessThan(16);
    // 150 four-second laps of 64 notes (2 clips × 2 tracks × 16), plus the two notes
    // already inside the final lookahead window.
    expect(loopedOns).toBeGreaterThanOrEqual(150 * 64);
    expect(loopedOns).toBeLessThanOrEqual(150 * 64 + 2);
  });
});
