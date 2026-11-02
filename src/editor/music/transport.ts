/**
 * Pure transport logic for the music workspace (P2b): ruler mapping, loop normalisation,
 * metronome/count-in timing and position formatting. No React, no Web Audio, so it is unit
 * tested directly and shared by the realtime controller and the transport UI.
 */

export type TransportMode = 'pattern' | 'song';
export type CountInBars = 0 | 1 | 2;
/** Editor view state of the transport. Not part of the document and not in undo. */
export interface MusicTransportState {
  /** Explicit Pattern/Song choice; null follows the open tab (pattern editors → pattern). */
  mode: TransportMode | null;
  /** Whether the document's loop region (`doc.loop`) is applied in song mode. */
  loop: boolean;
  metronome: boolean;
  countIn: CountInBars;
  /** Auto-scroll the playlist / piano roll to keep the playhead visible. */
  follow: boolean;
}
export const defaultTransportState: MusicTransportState = {
  mode: null,
  loop: true,
  metronome: false,
  countIn: 0,
  follow: true,
};

/** Effective realtime mode: the explicit choice, else the inference (pattern needs a pattern). */
export function resolveTransportMode(
  explicit: TransportMode | null,
  inferred: TransportMode,
  hasPattern: boolean,
): TransportMode {
  const mode = explicit ?? inferred;
  return mode === 'pattern' && !hasPattern ? 'song' : mode;
}

/** Snap a document-unit value to `grid` (grid ≤ 0 means no snap). */
export function snapUnits(units: number, grid: number) {
  return grid > 0 ? Math.round(units / grid) * grid : units;
}

/**
 * Ruler x (client px) → document units, snapped and clamped to [0, max].
 * `origin` is the client x of unit 0 (ruler left + header offset − scroll already applied
 * by getBoundingClientRect), `pxPerUnit` the zoom.
 */
export function rulerUnitsAt(
  clientX: number,
  ruler: { origin: number; pxPerUnit: number; max: number; grid: number },
) {
  const raw = (clientX - ruler.origin) / ruler.pxPerUnit;
  return Math.max(0, Math.min(ruler.max, snapUnits(Number.isFinite(raw) ? raw : 0, ruler.grid)));
}

/**
 * Loop region from two ruler points (either order), snapped, clamped to [0, max]. Returns null
 * when the region is shorter than one grid step (or `minLength` without a grid), which a
 * click-without-drag produces; the caller then leaves `doc.loop` unchanged.
 */
export function normalizeLoop(
  a: number,
  b: number,
  options: { max: number; grid: number; minLength?: number },
): { start: number; end: number } | null {
  const clamp = (v: number) => Math.max(0, Math.min(options.max, snapUnits(v, options.grid))),
    x = Number.isFinite(a) ? a : 0,
    y = Number.isFinite(b) ? b : 0;
  const start = clamp(Math.min(x, y)),
    end = clamp(Math.max(x, y)),
    min = options.minLength ?? (options.grid > 0 ? options.grid : 1e-3);
  return end - start >= min - 1e-9 ? { start, end } : null;
}

export interface SignatureSegment {
  /** Quarter-note beat where this signature starts (bars restart here). */
  beat: number;
  numerator: number;
  denominator: number;
}
/**
 * The document's signature map: the opening `timeSignature` at beat 0, then
 * `timeSignatureChanges` in order (a later change at the same beat wins). Pattern mode plays a
 * pattern on its own from beat 0, so it uses only the opening signature.
 */
export function signatureSegments(
  doc: {
    timeSignature: readonly [number, number];
    timeSignatureChanges?: readonly SignatureSegment[];
  },
  mode: TransportMode = 'song',
): SignatureSegment[] {
  const out: SignatureSegment[] = [
    { beat: 0, numerator: doc.timeSignature[0], denominator: doc.timeSignature[1] },
  ];
  if (mode === 'song')
    for (const c of [...(doc.timeSignatureChanges ?? [])].sort((x, y) => x.beat - y.beat)) {
      const s = { beat: c.beat, numerator: c.numerator, denominator: c.denominator };
      if (Math.abs(out[out.length - 1].beat - c.beat) < 1e-9) out[out.length - 1] = s;
      else out.push(s);
    }
  return out;
}
function segmentIndex(segments: SignatureSegment[], quarter: number) {
  let i = 0;
  while (i + 1 < segments.length && segments[i + 1].beat <= quarter + 1e-9) i++;
  return i;
}
export function signatureAt(segments: SignatureSegment[], quarter: number) {
  return segments[segmentIndex(segments, quarter)];
}

export interface MetronomeTick {
  /** Quarter-note beat of the click. */
  quarter: number;
  /** Bar downbeat (accented click). */
  accent: boolean;
  /** 1-based bar and beat (beat in the signature's denominator). */
  bar: number;
  beat: number;
}
/** 1-based bar number at the start of each segment (bars restart at every change). */
function segmentBars(segments: SignatureSegment[]) {
  const bars = [1];
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1],
      beatLen = 4 / prev.denominator,
      beats = (segments[i].beat - prev.beat) / beatLen;
    bars.push(bars[i - 1] + Math.ceil(beats / prev.numerator - 1e-9));
  }
  return bars;
}
/**
 * Metronome clicks in the half-open quarter range [from, to): one per beat of the signature
 * in effect (its denominator note), accent on each bar downbeat, bars restarting at each
 * `timeSignatureChanges` entry (a change off a bar line starts a new bar there).
 */
export function metronomeTicks(
  segments: SignatureSegment[],
  from: number,
  to: number,
  limit = 100000,
): MetronomeTick[] {
  const out: MetronomeTick[] = [],
    bars = segmentBars(segments);
  if (!(to > from)) return out;
  for (let i = segmentIndex(segments, Math.max(0, from)); i < segments.length; i++) {
    const s = segments[i],
      end = Math.min(to, segments[i + 1]?.beat ?? Infinity),
      beatLen = 4 / s.denominator;
    if (s.beat >= to) break;
    let k = Math.max(0, Math.ceil((from - s.beat) / beatLen - 1e-9));
    for (; out.length < limit; k++) {
      const quarter = s.beat + k * beatLen;
      if (quarter >= end - 1e-9) break;
      const beatInBar = k % s.numerator;
      out.push({
        quarter,
        accent: beatInBar === 0,
        bar: bars[i] + Math.floor(k / s.numerator),
        beat: beatInBar + 1,
      });
    }
  }
  return out;
}

export const TRANSPORT_TICKS = 96;
/** Bar:beat:tick (1-based, ticks per signature beat = 96) honouring signature changes. */
export function barBeatTick(segments: SignatureSegment[], quarter: number) {
  const q = Math.max(0, quarter),
    i = segmentIndex(segments, q),
    s = segments[i],
    beatLen = 4 / s.denominator,
    beats = (q - s.beat) / beatLen + 1e-9,
    barIn = Math.floor(beats / s.numerator),
    inBar = beats - barIn * s.numerator,
    beat = Math.floor(inBar) + 1,
    tick = Math.min(TRANSPORT_TICKS - 1, Math.floor((inBar - (beat - 1)) * TRANSPORT_TICKS)),
    bar = segmentBars(segments)[i] + barIn;
  return { bar, beat, tick, label: `${bar}:${beat}:${String(tick).padStart(2, '0')}` };
}

/** m:ss.mmm (minutes unpadded, grows past 59). */
export function formatClock(seconds: number) {
  const ms = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000)),
    m = Math.floor(ms / 60000),
    s = Math.floor((ms % 60000) / 1000),
    rest = ms % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(rest).padStart(3, '0')}`;
}

export interface Click {
  /** Seconds (relative offset for count-in; context seconds for scheduled clicks). */
  time: number;
  accent: boolean;
}
/**
 * Count-in before playback: `bars` bars of the signature at the start position, one click per
 * signature beat, accent on each bar's first beat. `secondsPerQuarter` is the tempo there.
 * Playback starts at `duration` after the first click.
 */
export function countInClicks(
  signature: { numerator: number; denominator: number },
  secondsPerQuarter: number,
  bars: number,
): { clicks: Click[]; duration: number } {
  const n = Math.max(0, Math.floor(bars)),
    beat = (4 / signature.denominator) * secondsPerQuarter,
    clicks: Click[] = [];
  for (let b = 0; b < n; b++)
    for (let k = 0; k < signature.numerator; k++)
      clicks.push({ time: (b * signature.numerator + k) * beat, accent: k === 0 });
  return { clicks, duration: n * signature.numerator * beat };
}

/** A scheduler span: context seconds [ctx, end) play timeline seconds from `pos`. */
export interface PlaySpan {
  ctx: number;
  end: number;
  pos: number;
}
/**
 * Metronome clicks for scheduled spans, in context seconds. `quarterAt` maps timeline seconds
 * to quarter beats and `secondsAt` back (the timeline's clock).
 */
export function spanClicks(
  spans: PlaySpan[],
  segments: SignatureSegment[],
  quarterAt: (seconds: number) => number,
  secondsAt: (quarter: number) => number,
): Click[] {
  const out: Click[] = [];
  for (const span of spans) {
    const length = span.end - span.ctx;
    if (!(length > 0)) continue;
    const q0 = quarterAt(span.pos),
      q1 = quarterAt(span.pos + length);
    for (const t of metronomeTicks(segments, q0, q1, 1000))
      out.push({ time: span.ctx + (secondsAt(t.quarter) - span.pos), accent: t.accent });
  }
  return out;
}

/** Quarter beats → timeline seconds for a timeline with `beatsAt` (seconds → quarters). */
export function quarterSeconds(
  timeline: { toSeconds: (u: number) => number; beatsAt: (s: number) => number },
  unit: 'beats' | 'seconds',
) {
  if (unit === 'beats') return timeline.toSeconds;
  const perSecond = timeline.beatsAt(1) || 2;
  return (q: number) => q / perSecond;
}

/**
 * Scroll offset that keeps a playhead at `x` (content px) visible in a viewport
 * [scroll, scroll + width): page forward when it passes 85% (or is left of view), else keep.
 */
export function followScroll(x: number, scroll: number, width: number, lead = 40) {
  if (width <= 0) return scroll;
  if (x < scroll || x > scroll + width * 0.85) return Math.max(0, x - lead);
  return scroll;
}

/** Meter bar fill (0–1) for a linear level on a dB scale from `floorDb` to 0 dBFS (clips at 1). */
export function meterLevel(linear: number, floorDb = -60) {
  if (!(linear > 0)) return 0;
  const db = 20 * Math.log10(linear);
  return Math.max(0, Math.min(1, (db - floorDb) / -floorDb));
}
