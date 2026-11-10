import { describe, it, expect } from 'vitest';
import { compileSound, SoundRenderer, SOUND_RATE } from '../src/core/sound.js';
import { applySoundCommand, applySoundCommands } from '../src/core/sound-commands.js';
import {
  soundDocumentSchema,
  type SoundClip,
  type SoundDocument,
} from '../src/core/sound-schema.js';
import {
  duplicateClips,
  makeClipUnique,
  moveClips,
  paintClips,
  pasteClips,
  selectionSpan,
  sliceClip,
  snapSize,
  snapTime,
  trimClip,
} from '../src/core/sound-playlist.js';
import { newMusic } from '../src/editor/music/music-model.js';

const ids = () => {
  let n = 0;
  return () => `new-${++n}`;
};
const pclip = (patch: Partial<SoundClip>): SoundClip => ({
  id: 'c',
  kind: 'pattern',
  lane: 0,
  at: 0,
  length: 4,
  offset: 0,
  muted: false,
  refId: 'pattern-1',
  ...patch,
});
const timing = (doc: SoundDocument) =>
  compileSound(doc)
    .tracks.flatMap((t) => t.events.map((e) => [t.track.id, e.start, e.end, e.note]))
    .sort((a, b) => String(a).localeCompare(String(b)));

describe('playlist snapping and moves', () => {
  it('sizes bar/beat/step/none for beats and seconds documents', () => {
    const d = newMusic('m');
    expect(['bar', 'beat', 'step', 'none'].map((s) => snapSize(d, s as never))).toEqual([
      4, 1, 0.25, 0,
    ]);
    expect(snapSize({ ...d, timeSignature: [6, 8] }, 'bar')).toBe(3);
    expect(snapSize({ ...d, timeSignature: [6, 8] }, 'beat')).toBe(0.5);
    expect(snapSize({ ...d, unit: 'seconds' }, 'beat')).toBe(0.5);
    expect(snapTime(1.37, 0.25)).toBe(1.25);
    expect(snapTime(1.37, 0)).toBe(1.37);
  });
  it('moves a selection as a block: anchor snaps, others keep spacing, clamps to score/lanes', () => {
    const d = newMusic('m'); // clips at 0,4,8,12 on lane 0, length 4, duration 16
    const moved = moveClips(d, ['clip-2', 'clip-3'], { at: 1.3, lane: 2 }, 1);
    expect(moved).toEqual([
      { id: 'clip-2', patch: { at: 5, lane: 2 } },
      { id: 'clip-3', patch: { at: 9, lane: 2 } },
    ]);
    // Alt (no snap): exact delta.
    expect(moveClips(d, ['clip-2'], { at: 1.3, lane: 0 }, 0)[0].patch.at).toBe(5.3);
    // Clamped at the end of the score and the last lane.
    const end = moveClips(d, ['clip-3', 'clip-4'], { at: 10, lane: 99 }, 1);
    expect(end.map((m) => m.patch)).toEqual([
      { at: 8, lane: 15 },
      { at: 12, lane: 15 },
    ]);
    expect(moveClips(d, ['clip-1'], { at: -3, lane: -1 }, 1)).toEqual([]);
  });
});

describe('slice, trim, duplicate, paint, make unique', () => {
  it('slices a clip into two that render the same notes', () => {
    const d = newMusic('m');
    const [l, r] = sliceClip(d.clips[1], 6, 'right')!;
    expect(l).toMatchObject({ id: 'clip-2', at: 4, length: 2, offset: 0 });
    expect(r).toMatchObject({ id: 'right', at: 6, length: 2, offset: 2, refId: 'pattern-1' });
    expect(sliceClip(d.clips[1], 4, 'x')).toBeUndefined();
    expect(sliceClip(d.clips[1], 8, 'x')).toBeUndefined();
    const sliced = applySoundCommand(d, {
      type: 'sliceClips',
      cuts: [{ clipId: 'clip-2', at: 6, newId: 'right' }],
    }).doc;
    expect(sliced.clips.map((c) => c.id)).toEqual([
      'clip-1',
      'clip-2',
      'right',
      'clip-3',
      'clip-4',
    ]);
    expect(timing(sliced)).toEqual(timing(d));
    // Slicing through a note: the left part shortens it (0.75 → 0.5 beats).
    const mid = applySoundCommand(d, {
      type: 'sliceClips',
      cuts: [{ clipId: 'clip-1', at: 0.5, newId: 'r' }],
    }).doc;
    const first = compileSound(mid).tracks[0].events.find((e) => e.start === 0)!;
    expect(first.gate).toBeCloseTo(0.25, 9);
  });
  it('trims left (at+offset move together) and right edges with limits', () => {
    const c = pclip({ at: 4, length: 4, offset: 1 });
    expect(trimClip(c, 'left', 6, { minLength: 0.25, duration: 16 })).toEqual({
      at: 6,
      offset: 3,
      length: 2,
    });
    // Cannot reveal source before 0.
    expect(trimClip(c, 'left', 0, { minLength: 0.25, duration: 16 })).toEqual({
      at: 3,
      offset: 0,
      length: 5,
    });
    expect(trimClip(c, 'left', 9, { minLength: 0.25, duration: 16 }).length).toBe(0.25);
    expect(trimClip(c, 'right', 20, { minLength: 0.25, duration: 16 })).toEqual({ length: 12 });
    expect(trimClip(c, 'right', 20, { minLength: 0.25, duration: 16, sourceLength: 3 })).toEqual({
      length: 2,
    });
  });
  it('duplicates (Ctrl+D shifts by the selection span) and pastes relative to the target', () => {
    const d = newMusic('m');
    const sel = d.clips.slice(0, 2),
      span = selectionSpan(sel);
    expect(span).toEqual({ start: 0, end: 8, length: 8 });
    const copies = duplicateClips(d, sel, span.length, ids());
    expect(copies.map((c) => [c.id, c.at, c.lane])).toEqual([
      ['new-1', 8, 0],
      ['new-2', 12, 0],
    ]);
    // Copies past the score are dropped.
    expect(duplicateClips(d, d.clips.slice(2), 8, ids())).toEqual([]);
    const pasted = pasteClips(
      d,
      [pclip({ at: 4, lane: 2 }), pclip({ at: 6, lane: 3 })],
      1,
      5,
      ids(),
    );
    expect(pasted.map((c) => [c.at, c.lane])).toEqual([
      [1, 5],
      [3, 6],
    ]);
  });
  it('paints repeats, skipping occupied slots and the score end', () => {
    const d = { ...newMusic('m'), clips: [pclip({ id: 'x', at: 4, lane: 1 })] };
    const painted = paintClips(
      d,
      { kind: 'pattern', refId: 'pattern-1', length: 4 },
      1,
      0,
      14,
      ids(),
    );
    expect(painted.map((c) => c.at)).toEqual([0, 8, 12]);
    const left = paintClips(d, { kind: 'pattern', refId: 'pattern-1', length: 4 }, 2, 12, 3, ids());
    expect(left.map((c) => c.at)).toEqual([12, 8, 4]);
  });
  it('make unique clones the pattern for one clip only; undoable as one command', () => {
    const d = newMusic('m');
    const u = makeClipUnique(d, 'clip-3', 'p2');
    expect(u.patterns!.map((p) => [p.id, p.name])).toEqual([
      ['pattern-1', 'Pattern 01'],
      ['p2', 'Pattern 01 #2'],
    ]);
    expect(u.clips.map((c) => c.refId)).toEqual(['pattern-1', 'pattern-1', 'p2', 'pattern-1']);
    expect(u.patterns![1].channels).toEqual(d.patterns![0].channels);
    expect(u.patterns![1].channels).not.toBe(d.patterns![0].channels);
    expect(timing(u)).toEqual(timing(d));
    expect(soundDocumentSchema.parse(u)).toBeTruthy();
    expect(makeClipUnique(d, 'missing', 'p3')).toBe(d);
  });
});

describe('lanes, markers and automation commands', () => {
  it('inserts, removes and reorders lanes; clips follow their lane', () => {
    const d = {
      ...newMusic('m'),
      clips: [pclip({ id: 'a', lane: 0 }), pclip({ id: 'b', lane: 3, at: 4 })],
    };
    const added = applySoundCommand(d, {
      type: 'addPlaylistTracks',
      index: 1,
      tracks: [{ id: 'new', name: 'New', muted: false, height: 56 }],
    }).doc;
    expect(added.playlistTracks.length).toBe(17);
    expect(added.clips.map((c) => c.lane)).toEqual([0, 4]);
    const moved = applySoundCommand(added, { type: 'movePlaylistTrack', from: 4, to: 0 }).doc;
    expect(moved.playlistTracks[0].id).toBe(added.playlistTracks[4].id);
    expect(moved.clips.map((c) => c.lane)).toEqual([1, 0]);
    const removed = applySoundCommand(moved, { type: 'removePlaylistTrack', index: 0 }).doc;
    expect(removed.clips.map((c) => [c.id, c.lane])).toEqual([['a', 0]]);
    expect(soundDocumentSchema.parse(removed).playlistTracks.length).toBe(16);
    const renamed = applySoundCommand(removed, {
      type: 'updatePlaylistTrack',
      index: 2,
      patch: { name: '鼓', muted: true, height: 80, color: '#57d6b0' },
    }).doc;
    expect(renamed.playlistTracks[2]).toMatchObject({ name: '鼓', muted: true, height: 80 });
    // 500 lanes is the ceiling.
    const many = applySoundCommand(d, {
      type: 'addPlaylistTracks',
      index: 16,
      tracks: Array.from({ length: 600 }, (_, i) => ({
        id: `l${i}`,
        name: '',
        muted: false,
        height: 56,
      })),
    }).doc;
    expect(many.playlistTracks.length).toBe(500);
  });
  it('batch-edits clips, markers and automation points through commands', () => {
    const d = newMusic('m');
    const r = applySoundCommands(d, [
      { type: 'updateClips', updates: [{ id: 'clip-1', patch: { muted: true } }] },
      { type: 'removeClips', ids: ['clip-4'] },
      { type: 'addClips', clips: [pclip({ id: 'z', lane: 2 })] },
      {
        type: 'setMarkers',
        markers: [
          { at: 8, name: 'B' },
          { at: 0, name: 'A' },
        ],
      },
      {
        type: 'addAutomationClip',
        automation: {
          id: 'au',
          target: { type: 'track', trackId: 'lead', param: 'pan' },
          points: [{ at: 0, value: 0, curve: 'linear', tension: 0 }],
        },
        clip: { ...pclip({ id: 'au', lane: 3 }), kind: 'automation', refId: 'au' },
      },
      {
        type: 'updateAutomationClip',
        automationId: 'au',
        patch: {
          points: [
            { at: 3, value: 1, curve: 'linear', tension: 0 },
            { at: 0, value: -1, curve: 'smooth', tension: 0 },
          ],
        },
      },
    ]).doc;
    expect(r.clips.map((c) => c.id)).toEqual(['clip-1', 'clip-2', 'clip-3', 'z', 'au']);
    expect(r.clips[0].muted).toBe(true);
    expect(r.markers.map((m) => m.name)).toEqual(['A', 'B']);
    expect(r.automationClips[0].points.map((p) => p.at)).toEqual([0, 3]);
    expect(soundDocumentSchema.parse(r)).toBeTruthy();
    expect(compileSound(r).tracks[0].automation[0].property).toBe('pan');
  });
});

describe('audio clips render offline', () => {
  it('plays the trimmed source window sample-exactly with clip gain', () => {
    // 120 bpm: one beat = 0.5 s = 24000 samples.
    const base = newMusic('m');
    const doc: SoundDocument = {
      ...base,
      clips: [
        {
          id: 'a',
          kind: 'audio',
          lane: 1,
          at: 2,
          length: 1,
          offset: 1,
          muted: false,
          gainDb: -6,
          refId: 'asset-1',
        },
      ],
      master: { ...base.master, effects: [] },
      tail: 0,
    };
    const compiled = compileSound(doc),
      track = compiled.tracks.find((t) => t.track.id === 'audio-clip:a')!;
    expect(track.track.instrument).toMatchObject({
      type: 'sample',
      assetId: 'asset-1',
      sourceIn: 0.5,
      sourceDuration: 0.5,
      rootNote: 60,
    });
    expect([track.events[0].start, track.events[0].end]).toEqual([48000, 72000]);
    // The decoder hands the renderer the window starting at sourceIn (round(0.5·48k) = 24000).
    const source = new Float32Array(SOUND_RATE * 0.5).map((_, i) => ((i % 977) - 488) / 1000),
      gain = 10 ** (-6 / 20);
    const renderer = new SoundRenderer(
      doc,
      new Map([['audio-clip:a', { left: source, right: source.map((v) => -v) }]]),
    );
    const out = {
      left: new Float32Array(compiled.sampleCount),
      right: new Float32Array(compiled.sampleCount),
    };
    while (renderer.position < compiled.sampleCount) {
      const at = renderer.position,
        block = renderer.process(Math.min(4096, compiled.sampleCount - at));
      out.left.set(block.left, at);
      out.right.set(block.right, at);
    }
    expect(compiled.sampleCount).toBe(16 * 24000);
    for (let i = 0; i < out.left.length; i++) {
      const k = i - 48000,
        want = k >= 0 && k < 24000 ? source[k] * gain : 0;
      if (Math.abs(out.left[i] - want) > 1e-6 || Math.abs(out.right[i] + want) > 1e-6)
        throw new Error(`sample ${i}: ${out.left[i]} / ${out.right[i]} != ${want}`);
    }
    // Muted clip (or muted lane) does not render and needs no decoded sample.
    const muted = { ...doc, clips: [{ ...doc.clips[0], muted: true }] };
    expect(compileSound(muted).tracks.some((t) => t.track.id.startsWith('audio-clip:'))).toBe(
      false,
    );
    expect(() => new SoundRenderer(muted)).not.toThrow();
    // A left trim moves the source window with it.
    const trimmed = applySoundCommand(doc, {
      type: 'updateClips',
      updates: [
        { id: 'a', patch: trimClip(doc.clips[0], 'left', 2.5, { minLength: 0.25, duration: 16 }) },
      ],
    }).doc;
    const t2 = compileSound(trimmed).tracks.find((t) => t.track.id === 'audio-clip:a')!;
    expect(t2.track.instrument).toMatchObject({ sourceIn: 0.75, sourceDuration: 0.25 });
    expect([t2.events[0].start, t2.events[0].end]).toEqual([60000, 72000]);
  });
});
