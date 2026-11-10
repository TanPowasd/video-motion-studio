import { describe, it, expect } from 'vitest';
import { newMusic, musicReducer, emptyMusicDraft } from '../src/editor/music/music-model.js';
import { buildRealtimeTimeline } from '../src/editor/music/realtime/timeline.js';
import { RealtimeScheduler } from '../src/editor/music/realtime/scheduler.js';
import {
  barBeatTick,
  countInClicks,
  followScroll,
  formatClock,
  meterLevel,
  metronomeTicks,
  normalizeLoop,
  quarterSeconds,
  resolveTransportMode,
  rulerUnitsAt,
  signatureSegments,
  spanClicks,
} from '../src/editor/music/transport.js';

describe('ruler seek mapping', () => {
  const ruler = { origin: 220, pxPerUnit: 36, max: 16, grid: 0.25 };
  it('maps x to units with grid snap and clamps', () => {
    expect(rulerUnitsAt(220, ruler)).toBe(0);
    expect(rulerUnitsAt(220 + 36 * 3, ruler)).toBe(3);
    // 3.1 beats snaps to 3; 3.15 to 3.25
    expect(rulerUnitsAt(220 + 36 * 3.1, ruler)).toBe(3);
    expect(rulerUnitsAt(220 + 36 * 3.15, ruler)).toBe(3.25);
    expect(rulerUnitsAt(100, ruler)).toBe(0);
    expect(rulerUnitsAt(220 + 36 * 40, ruler)).toBe(16);
  });
  it('grid 0 means no snap', () => {
    expect(rulerUnitsAt(220 + 36 * 3.1, { ...ruler, grid: 0 })).toBeCloseTo(3.1, 9);
  });
});

describe('loop region normalisation', () => {
  const o = { max: 16, grid: 0.25 };
  it('orders, snaps and clamps', () => {
    expect(normalizeLoop(8.1, 4.05, o)).toEqual({ start: 4, end: 8 });
    expect(normalizeLoop(-2, 30, o)).toEqual({ start: 0, end: 16 });
  });
  it('rejects regions shorter than one grid step (a click without drag)', () => {
    expect(normalizeLoop(4, 4.1, o)).toBeNull();
    expect(normalizeLoop(4, 4.2, o)).toEqual({ start: 4, end: 4.25 });
    expect(normalizeLoop(NaN, 2, o)).toEqual({ start: 0, end: 2 });
  });
  it('the loop region is document data: one undoable command', () => {
    const doc = newMusic('loop');
    let state = musicReducer(emptyMusicDraft, { type: 'load', document: doc });
    state = musicReducer(state, {
      type: 'command',
      command: { type: 'setSettings', patch: { loop: { start: 4, end: 8 } } },
    });
    expect(state.document!.loop).toEqual({ start: 4, end: 8 });
    expect(state.past.length).toBe(1);
    state = musicReducer(state, { type: 'undo' });
    expect(state.document!.loop ?? null).toBeNull();
  });
});

describe('metronome ticks', () => {
  it('4/4: a click per quarter, accented downbeats', () => {
    const ticks = metronomeTicks(signatureSegments({ timeSignature: [4, 4] }), 0, 8);
    expect(ticks.map((t) => t.quarter)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(ticks.filter((t) => t.accent).map((t) => t.quarter)).toEqual([0, 4]);
    expect(ticks[5]).toMatchObject({ bar: 2, beat: 2 });
  });
  it('6/8 clicks eighths; half-open ranges do not repeat a tick', () => {
    const seg = signatureSegments({ timeSignature: [6, 8] });
    const a = metronomeTicks(seg, 0, 1.5),
      b = metronomeTicks(seg, 1.5, 3.5);
    expect(a.map((t) => t.quarter)).toEqual([0, 0.5, 1]);
    expect(b.map((t) => t.quarter)).toEqual([1.5, 2, 2.5, 3]);
    expect(b.find((t) => t.quarter === 3)).toMatchObject({ accent: true, bar: 2, beat: 1 });
  });
  it('honours timeSignatureChanges (song) and ignores them in pattern mode', () => {
    const doc = {
      timeSignature: [4, 4] as [number, number],
      timeSignatureChanges: [
        { beat: 8, numerator: 3, denominator: 4 as const },
        { beat: 14, numerator: 7, denominator: 8 as const },
      ],
    };
    const seg = signatureSegments(doc);
    const ticks = metronomeTicks(seg, 6, 18);
    expect(ticks.filter((t) => t.accent).map((t) => t.quarter)).toEqual([8, 11, 14, 17.5]);
    // 7/8 from beat 14: eighth clicks, bar 5 (bars 1–2 of 4/4, 3–4 of 3/4)
    expect(ticks.filter((t) => t.quarter >= 14).map((t) => t.quarter)).toEqual([
      14, 14.5, 15, 15.5, 16, 16.5, 17, 17.5,
    ]);
    expect(ticks.find((t) => t.quarter === 17.5)).toMatchObject({ bar: 6, beat: 1 });
    expect(barBeatTick(seg, 14)).toMatchObject({ bar: 5, beat: 1, tick: 0 });
    expect(barBeatTick(seg, 11.5)).toMatchObject({ bar: 4, beat: 1, tick: 48, label: '4:1:48' });
    expect(signatureSegments(doc, 'pattern')).toHaveLength(1);
  });
  it('a change off the bar line starts a new bar there', () => {
    const seg = signatureSegments({
      timeSignature: [4, 4],
      timeSignatureChanges: [{ beat: 6, numerator: 4, denominator: 4 }],
    });
    const ticks = metronomeTicks(seg, 0, 10);
    expect(ticks.filter((t) => t.accent).map((t) => [t.quarter, t.bar])).toEqual([
      [0, 1],
      [4, 2],
      [6, 3],
    ]);
  });
});

describe('count-in', () => {
  it('bars × numerator clicks at the signature beat, accent per bar', () => {
    const c = countInClicks({ numerator: 4, denominator: 4 }, 0.5, 2);
    expect(c.duration).toBe(4);
    expect(c.clicks.map((k) => k.time)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect(c.clicks.filter((k) => k.accent).map((k) => k.time)).toEqual([0, 2]);
    const eighths = countInClicks({ numerator: 6, denominator: 8 }, 0.5, 1);
    expect(eighths.duration).toBe(1.5);
    expect(eighths.clicks).toHaveLength(6);
    expect(countInClicks({ numerator: 4, denominator: 4 }, 0.5, 0)).toEqual({
      clicks: [],
      duration: 0,
    });
  });
  it('a count-in delays the scheduler start by exactly its duration', () => {
    const doc = newMusic('count'),
      timeline = buildRealtimeTimeline(doc),
      s = new RealtimeScheduler(timeline),
      count = countInClicks({ numerator: 4, denominator: 4 }, 0.5, 1),
      t0 = 10;
    s.start(t0 + count.duration, 0);
    // Nothing is scheduled during the count-in, and the position holds at the start.
    expect(s.advance(t0 + 1).filter((e) => e.type === 'on')).toHaveLength(0);
    expect(s.positionAt(t0 + 1)).toBe(0);
    const first = s.advance(t0 + count.duration).find((e) => e.type === 'on');
    expect(first?.time).toBeCloseTo(t0 + count.duration, 9);
  });
});

describe('metronome against the scheduler', () => {
  it('pattern loop: clicks land on every beat across laps, none twice', () => {
    const doc = newMusic('metro'),
      timeline = buildRealtimeTimeline(doc, { mode: 'pattern', patternId: 'pattern-1' }),
      s = new RealtimeScheduler(timeline, { lookahead: 0.1 }),
      seg = signatureSegments(doc, 'pattern'),
      toSec = quarterSeconds(timeline, doc.unit);
    s.start(1, 0);
    let from = 1;
    const clicks: { time: number; accent: boolean }[] = [];
    for (let now = 1; now < 1 + 6.05; now += 0.025) {
      s.advance(now);
      const spans = s.spans(from, now + 0.1);
      if (spans.length) from = spans[spans.length - 1].end;
      clicks.push(...spanClicks(spans, seg, timeline.beatsAt, toSec));
    }
    // 120 BPM: a beat every 0.5 s; the 4-beat pattern loops every 2 s.
    const times = clicks.map((c) => +(c.time - 1).toFixed(6));
    expect(times.slice(0, 13)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6]);
    expect(new Set(times).size).toBe(times.length);
    expect(clicks.filter((c) => c.accent).map((c) => +(c.time - 1).toFixed(6))).toEqual([
      0, 2, 4, 6,
    ]);
  });
});

describe('transport helpers', () => {
  it('mode: explicit choice wins, pattern needs a pattern', () => {
    expect(resolveTransportMode(null, 'pattern', true)).toBe('pattern');
    expect(resolveTransportMode('song', 'pattern', true)).toBe('song');
    expect(resolveTransportMode('pattern', 'song', true)).toBe('pattern');
    expect(resolveTransportMode('pattern', 'song', false)).toBe('song');
  });
  it('formats m:ss.mmm', () => {
    expect(formatClock(0)).toBe('0:00.000');
    expect(formatClock(61.2345)).toBe('1:01.235');
    expect(formatClock(-3)).toBe('0:00.000');
    expect(formatClock(3600)).toBe('60:00.000');
  });
  it('follow scroll pages when the playhead nears the right edge', () => {
    expect(followScroll(500, 0, 1000)).toBe(0);
    expect(followScroll(900, 0, 1000)).toBe(860);
    expect(followScroll(100, 400, 1000)).toBe(60);
  });
  it('meter level is a −60…0 dB scale', () => {
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(1)).toBe(1);
    expect(meterLevel(2)).toBe(1);
    expect(meterLevel(10 ** (-30 / 20))).toBeCloseTo(0.5, 9);
  });
});
