import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compileSound, SoundRenderer } from '../src/core/sound.js';
import {
  soundDocumentSchema,
  soundDocumentV1Schema,
  type SoundDocument,
} from '../src/core/sound-schema.js';
import { migrateSoundV1, upgradeSoundDocument } from '../src/core/sound-migrate.js';
import { automationLinearKeys, resolveSoundAutomation } from '../src/core/sound-patterns.js';
import { applySoundCommand } from '../src/core/sound-commands.js';
import { newMusic } from '../src/editor/music/music-model.js';
import { soundPlanSchema } from '../src/service/sound.js';

const fixtureText = readFileSync(
  new URL('./fixtures/sound-v1-music.json', import.meta.url),
  'utf8',
);
const v1 = () => JSON.parse(fixtureText);
/** sha256 of the float32 stereo render, recorded on HEAD 286c469 (schema version 1). */
const V1_RENDER_HASH = '92d810a7d830d700e5fc1bdbde7a39fbc3f49d38ac172506281eb63d506b40fd';
function renderHash(doc: unknown) {
  const r = new SoundRenderer(doc),
    h = createHash('sha256');
  for (let left = r.compiled.sampleCount; left > 0;) {
    const n = Math.min(16384, left),
      b = r.process(n);
    h.update(Buffer.from(new Float32Array(b.left).buffer));
    h.update(Buffer.from(new Float32Array(b.right).buffer));
    left -= n;
  }
  return h.digest('hex');
}
const clip = (patch: Record<string, unknown>) => ({
  id: 'c',
  kind: 'pattern',
  lane: 0,
  at: 0,
  length: 4,
  refId: 'pattern-1',
  ...patch,
});
const issues = (input: unknown) => {
  const r = soundDocumentSchema.safeParse(input);
  expect(r.success).toBe(false);
  return r.success ? '' : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
};

describe('sound document v1 → v2 migration', () => {
  it('turns repeats into consecutive equal-length clips on the pattern lane', () => {
    const doc = soundDocumentSchema.parse(v1());
    expect(doc.version).toBe(2);
    expect('arrangement' in doc).toBe(false);
    const patternClips = doc.clips.filter((c) => c.kind === 'pattern');
    expect(patternClips.map((c) => [c.id, c.at, c.length, c.offset, c.lane, c.refId])).toEqual([
      ['clip-1', 0, 4, 0, 0, 'pattern-1'],
      ['clip-1#1', 4, 4, 0, 0, 'pattern-1'],
      ['clip-1#2', 8, 4, 0, 0, 'pattern-1'],
      ['clip-1#3', 12, 4, 0, 0, 'pattern-1'],
      ['clip-2', 16, 4, 0, 0, 'pattern-1'],
      ['clip-2#1', 20, 4, 0, 0, 'pattern-1'],
    ]);
    expect(doc.playlistTracks).toHaveLength(16);
    expect(doc.markers).toEqual([]);
    expect(doc.timeSignatureChanges).toEqual([]);
  });
  it('moves per-track automation into automation clips placed across the score', () => {
    const doc = soundDocumentSchema.parse(v1());
    expect(doc.tracks.every((t) => !('automation' in t))).toBe(true);
    expect(doc.automationClips).toEqual([
      {
        id: 'auto-lead-gainDb',
        target: { type: 'track', trackId: 'lead', param: 'gainDb' },
        points: [
          { at: 0, value: -12, curve: 'linear', tension: 0 },
          { at: 6, value: 0, curve: 'linear', tension: 0 },
          { at: 20, value: -4, curve: 'linear', tension: 0 },
        ],
      },
      {
        id: 'auto-lead-pan',
        target: { type: 'track', trackId: 'lead', param: 'pan' },
        points: [
          { at: 2, value: -0.7, curve: 'linear', tension: 0 },
          { at: 18, value: 0.5, curve: 'linear', tension: 0 },
        ],
      },
    ]);
    const autoClips = doc.clips.filter((c) => c.kind === 'automation');
    expect(autoClips.map((c) => [c.refId, c.lane, c.at, c.length])).toEqual([
      ['auto-lead-gainDb', 1, 0, 24],
      ['auto-lead-pan', 2, 0, 24],
    ]);
    expect(resolveSoundAutomation(doc).get('track:lead:pan')?.keys).toEqual([
      { at: 2, value: -0.7 },
      { at: 18, value: 0.5 },
    ]);
  });
  it('round-trips: the v2 output parses to itself, through JSON, and the input is untouched', () => {
    const input = v1(),
      before = structuredClone(input),
      doc = soundDocumentSchema.parse(input);
    expect(input).toEqual(before);
    expect(soundDocumentSchema.parse(doc)).toEqual(doc);
    expect(soundDocumentSchema.parse(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    expect(upgradeSoundDocument(input)).toEqual(doc);
    expect(soundDocumentSchema.parse(migrateSoundV1(soundDocumentV1Schema.parse(input)))).toEqual(
      doc,
    );
  });
  it('keeps expanded note ids (and noise seeds) and renders byte-identically to version 1', () => {
    const a = compileSound(v1()),
      b = compileSound(soundDocumentSchema.parse(v1()));
    expect(a.tracks[0].events.map((e) => e.id)).toContain('pattern:["clip-1",3,"note-2"]');
    expect(b.tracks[0].events).toEqual(a.tracks[0].events);
    expect(renderHash(v1())).toBe(V1_RENDER_HASH);
    expect(renderHash(soundDocumentSchema.parse(v1()))).toBe(V1_RENDER_HASH);
  }, 120_000);
  it('accepts v1 wherever a sound document is parsed (service plan input)', () => {
    const plan = soundPlanSchema.parse({ items: [{ assetId: 'music', document: v1() }] });
    expect(plan.items[0].document?.version).toBe(2);
    expect(plan.items[0].document?.clips).toHaveLength(8);
  });
});

describe('sound document v2 boundaries', () => {
  const base = () => JSON.parse(JSON.stringify(newMusic('music'))) as SoundDocument;
  it('reports clear errors for out-of-range fields', () => {
    const d = base();
    expect(issues({ ...d, clips: [clip({ lane: 500 })] })).toContain('clip lane must be < 500');
    expect(issues({ ...d, clips: [clip({ lane: 1.5 })] })).toContain(
      'clip lane must be an integer',
    );
    expect(issues({ ...d, clips: [clip({ lane: 20 })] })).toContain(
      'clips.0.lane: clip lane 20 has no playlist track (16 defined)',
    );
    expect(issues({ ...d, clips: [clip({ kind: 'video' })] })).toContain(
      "clip kind must be 'pattern', 'audio' or 'automation'",
    );
    expect(issues({ ...d, clips: [clip({ length: 0 })] })).toContain('clip length must be > 0');
    expect(issues({ ...d, clips: [clip({ refId: 'nope' })] })).toContain(
      "pattern clip references missing pattern 'nope'",
    );
    expect(issues({ ...d, clips: [clip({ kind: 'automation', refId: 'nope' })] })).toContain(
      "automation clip references missing automationClips id 'nope'",
    );
    expect(
      issues({
        ...d,
        playlistTracks: Array.from({ length: 501 }, (_, i) => ({ id: `l${i}` })),
      }),
    ).toContain('playlistTracks holds at most 500 tracks');
    const auto = (points: unknown, target: unknown = { type: 'tempo' }) => ({
      ...d,
      automationClips: [{ id: 'a', target, points }],
    });
    expect(issues(auto([{ at: 0, value: 1, curve: 'zigzag' }]))).toContain(
      "automation curve must be 'hold', 'linear', 'smooth' or 'tension'",
    );
    expect(issues(auto([{ at: 0, value: 1, curve: 'tension', tension: 2 }]))).toContain(
      'automation tension must be -1..1',
    );
    expect(issues(auto([]))).toContain('an automation clip needs at least one point');
    expect(issues(auto([{ at: 0, value: 1 }], { type: 'knob' }))).toContain(
      "automation target type must be 'track', 'bus', 'effect', 'synth', 'plugin' or 'tempo'",
    );
    expect(issues({ ...d, loop: { start: 4, end: 4 } })).toContain(
      'loop.end must be after loop.start',
    );
    expect(issues({ ...d, patterns: [{ ...d.patterns![0], color: 'red' }] })).toContain(
      'color must be a #rrggbb hex string',
    );
    expect(
      issues({ ...v1(), arrangement: [{ id: 'x', patternId: 'pattern-1', at: -1 }] }),
    ).toContain('version 1 document:');
    expect(issues({ ...v1(), arrangement: [{ id: 'x', patternId: 'missing', at: 0 }] })).toContain(
      'version 1 document could not be upgraded: Arrangement references a missing pattern',
    );
    expect(issues({ ...d, arrangement: [] })).toContain('arrangement');
  });
  it('accepts every automation target kind, markers, loop and time-signature changes', () => {
    const d = soundDocumentSchema.parse({
      ...base(),
      automationClips: [
        { type: 'track', trackId: 'lead', param: 'pan' },
        { type: 'bus', busId: 'master', param: 'gainDb' },
        { type: 'effect', ownerId: 'lead', index: 0, param: 'mix' },
        { type: 'synth', trackId: 'lead', param: 'fmIndex' },
        { type: 'plugin', ownerId: 'lead', slot: 'instrument', index: 3 },
        { type: 'tempo' },
      ].map((target, i) => ({ id: `a${i}`, target, points: [{ at: 0, value: 0.5 }] })),
      markers: [{ at: 4, name: 'Verse' }],
      loop: { start: 0, end: 8 },
      timeSignatureChanges: [{ beat: 8, numerator: 3, denominator: 4 }],
    });
    expect(d.automationClips).toHaveLength(6);
    expect(d.loop).toEqual({ start: 0, end: 8 });
  });
});

describe('clip expansion and generic automation', () => {
  const base = () => newMusic('music');
  const at = (doc: SoundDocument) => compileSound(doc).tracks[0].events.map((e) => e.at);
  it('trims by offset/length, skips muted clips and muted lanes, and plays every lane', () => {
    const d = base();
    expect(at({ ...d, clips: [clip({ at: 8, offset: 1, length: 2 }) as never] })).toEqual([8, 9]);
    const trimmed = compileSound({
      ...d,
      clips: [clip({ at: 0, offset: 0, length: 3.5 }) as never],
    });
    expect(trimmed.tracks[0].events.map((e) => e.duration)).toEqual([0.75, 0.75, 0.75, 0.5]);
    expect(at({ ...d, clips: [clip({ muted: true }) as never] })).toEqual([]);
    const lanes = d.playlistTracks.map((l, i) => (i === 3 ? { ...l, muted: true } : l));
    expect(
      at({
        ...d,
        playlistTracks: lanes,
        clips: [clip({ id: 'x', lane: 3 }), clip({ id: 'y', lane: 5, at: 4 })] as never,
      }),
    ).toEqual([4, 5, 6, 7]);
    expect(() => compileSound({ ...d, clips: [clip({ at: 14 }) as never] })).toThrow('beyond');
    // P3: audio clips render through an internal sample track (decoded sample required).
    const audio = { ...d, clips: [clip({ kind: 'audio', refId: 'asset' }) as never] };
    expect(compileSound(audio).tracks.map((t) => t.track.id)).toContain('audio-clip:c');
    expect(() => new SoundRenderer(audio)).toThrow('Decoded sample');
  });
  it('shapes hold/smooth/tension segments and applies bpm automation', () => {
    expect(
      automationLinearKeys([
        { at: 0, value: 0, curve: 'hold', tension: 0 },
        { at: 1, value: 1, curve: 'linear', tension: 0 },
      ]),
    ).toEqual([
      { at: 0, value: 0 },
      { at: 1 - 1e-6, value: 0 },
      { at: 1, value: 1 },
    ]);
    const smooth = automationLinearKeys([
      { at: 0, value: 0, curve: 'smooth', tension: 0 },
      { at: 1, value: 1, curve: 'linear', tension: 0 },
    ]);
    expect(smooth).toHaveLength(17);
    expect(smooth[8].value).toBeCloseTo(0.5);
    const d = base(),
      slow = {
        ...d,
        automationClips: [
          {
            id: 't',
            target: { type: 'tempo' as const },
            points: [{ at: 0, value: 60, curve: 'linear' as const, tension: 0 }],
          },
        ],
        clips: [
          ...d.clips,
          {
            ...clip({ id: 't', kind: 'automation', refId: 't', lane: 1, length: 16 }),
            offset: 0,
            muted: false,
          } as never,
        ],
      };
    expect(compileSound(d).duration).toBeCloseTo(9);
    expect(compileSound(slow).duration).toBeCloseTo(17);
    const gainOnBus = {
      ...slow,
      automationClips: [
        {
          ...slow.automationClips[0],
          target: { type: 'bus' as const, busId: 'master', param: 'gainDb' as const },
        },
      ],
    };
    expect(() => compileSound(gainOnBus)).toThrow('not rendered yet');
  });
  it('edits track automation through commands and drops it with the track', () => {
    let d = base();
    d = applySoundCommand(d, {
      type: 'setTrackAutomation',
      trackId: 'lead',
      param: 'gainDb',
      keys: [
        { at: 4, value: -6 },
        { at: 0, value: 0 },
      ],
    }).doc;
    expect(resolveSoundAutomation(d).get('track:lead:gainDb')?.keys).toEqual([
      { at: 0, value: 0 },
      { at: 4, value: -6 },
    ]);
    expect(d.clips.find((c) => c.kind === 'automation')).toMatchObject({ lane: 1, length: 16 });
    expect(compileSound(d).tracks[0].automation).toHaveLength(1);
    const removed = applySoundCommand(d, { type: 'removeTrack', trackId: 'lead' }).doc;
    expect(removed.automationClips).toEqual([]);
    expect(removed.clips.some((c) => c.kind === 'automation')).toBe(false);
    const cleared = applySoundCommand(d, {
      type: 'setTrackAutomation',
      trackId: 'lead',
      param: 'gainDb',
      keys: null,
    }).doc;
    expect(cleared.automationClips).toEqual([]);
  });
  it('keeps autoLength patterns at their notes rounded up to a bar', () => {
    let d = base();
    d = applySoundCommand(d, {
      type: 'updatePattern',
      patternId: 'pattern-1',
      patch: { autoLength: true },
    }).doc;
    d = applySoundCommand(d, {
      type: 'addNotes',
      trackId: 'lead',
      patternId: 'pattern-1',
      events: [{ id: 'late', at: 5, duration: 1, note: 60, velocity: 0.8, pan: 0 }],
    }).doc;
    expect(d.patterns![0].length).toBe(8);
  });
});
