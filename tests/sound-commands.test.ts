import { describe, it, expect } from 'vitest';
import { compileSound, soundPreset } from '../src/core/sound.js';
import { soundBusSchema, soundTrackSchema, type SoundDocument } from '../src/core/sound-schema.js';
import {
  applySoundCommand,
  applySoundCommands,
  musicEvents,
  type SoundCommand,
} from '../src/core/sound-commands.js';
import {
  newMusic,
  musicReducer,
  emptyMusicDraft,
  type MusicDraft,
} from '../src/editor/music/music-model.js';
import {
  MUSIC_COALESCE_MS,
  MUSIC_HISTORY_DEPTH,
  emptyMusicHistory,
  pushMusicHistory,
} from '../src/editor/music/music-history.js';

const base = () => newMusic('music');
const run = (doc: SoundDocument, command: SoundCommand) => {
  const frozen = structuredClone(doc);
  const result = applySoundCommand(doc, command);
  // Commands are pure: the input is never mutated and a summary is always given.
  expect(doc).toEqual(frozen);
  expect(result.summary.length).toBeGreaterThan(0);
  return result.doc;
};
const track = (id: string, preset = 'pluck') =>
  soundTrackSchema.parse({ id, name: id, instrument: soundPreset(preset) });
const note = (id: string, at: number, n = 60) => ({
  id,
  at,
  duration: 0.5,
  note: n,
  velocity: 0.7,
  pan: 0,
});

describe('sound commands', () => {
  it('replaces the document and patches settings, BPM and time signature', () => {
    const doc = base();
    const other = { ...doc, name: 'other' };
    expect(run(doc, { type: 'replaceDocument', document: other })).toBe(other);
    const set = run(doc, {
      type: 'setSettings',
      patch: { name: 'X', duration: 32, tail: 2, seed: 7 },
    });
    expect([set.name, set.duration, set.tail, set.seed]).toEqual(['X', 32, 2, 7]);
    expect(set.tracks).toBe(doc.tracks);
    expect(run(doc, { type: 'setBpm', bpm: 90 }).tempo[0].bpm).toBe(90);
    expect(run(doc, { type: 'setTimeSignature', timeSignature: [3, 4] }).timeSignature).toEqual([
      3, 4,
    ]);
  });
  it('adds, updates (sorting by beat), and removes tempo points; the first stays anchored', () => {
    let doc = run(base(), { type: 'addTempo' });
    expect(doc.tempo).toEqual([
      { beat: 0, bpm: 120 },
      { beat: 4, bpm: 120 },
    ]);
    doc = run(doc, { type: 'addTempo' });
    doc = run(doc, { type: 'updateTempo', index: 2, beat: 2, bpm: 100 });
    expect(doc.tempo.map((t) => t.beat)).toEqual([0, 2, 4]);
    expect(doc.tempo[1].bpm).toBe(100);
    expect(run(doc, { type: 'updateTempo', index: 0, beat: 3 })).toBe(doc);
    expect(run(doc, { type: 'removeTempo', index: 0 })).toBe(doc);
    expect(run(doc, { type: 'removeTempo', index: 1 }).tempo.map((t) => t.beat)).toEqual([0, 4]);
  });
  it('adds (capped at 64), upserts, updates and removes tracks with their pattern channels', () => {
    const doc = base();
    const added = run(doc, { type: 'addTracks', tracks: [track('a'), track('kick', 'kick')] });
    expect(added.tracks.map((t) => t.id)).toEqual(['lead', 'a', 'kick']);
    const many = Array.from({ length: 70 }, (_, i) => track('t' + i));
    expect(run(doc, { type: 'addTracks', tracks: many }).tracks).toHaveLength(64);
    const up = run(added, { type: 'upsertTrack', track: { ...track('a'), name: 'renamed' } });
    expect(up.tracks.find((t) => t.id === 'a')!.name).toBe('renamed');
    expect(run(doc, { type: 'upsertTrack', track: track('b') }).tracks.at(-1)!.id).toBe('b');
    const props = run(doc, {
      type: 'updateTrack',
      trackId: 'lead',
      patch: { gainDb: -6, pan: 0.5, muted: true, solo: true, name: 'L' },
    });
    expect(props.tracks[0]).toMatchObject({
      gainDb: -6,
      pan: 0.5,
      muted: true,
      solo: true,
      name: 'L',
    });
    expect(
      run(doc, { type: 'updateTrack', trackId: 'missing', patch: { muted: true } }).tracks,
    ).toBe(doc.tracks);
    const removed = run(doc, { type: 'removeTrack', trackId: 'lead' });
    expect(removed.tracks).toEqual([]);
    expect(removed.patterns![0].channels).toEqual([]);
    expect(run(doc, { type: 'removeTrack', trackId: 'missing' })).toBe(doc);
  });
  it('adds and updates buses and the master', () => {
    const doc = base();
    const bus = soundBusSchema.parse({ id: 'bus', name: 'Bus 1' });
    const withBus = run(doc, { type: 'addBus', bus });
    expect(withBus.buses.map((b) => b.id)).toEqual(['bus']);
    expect(
      run(withBus, { type: 'updateBus', busId: 'bus', patch: { gainDb: -3, pan: -1 } }).buses[0],
    ).toMatchObject({ gainDb: -3, pan: -1 });
    const master = run(doc, { type: 'updateMaster', patch: { gainDb: -2 } }).master;
    expect(master.gainDb).toBe(-2);
    expect(master.effects).toBe(doc.master.effects);
  });
  it('sets, adds, removes, updates (resize) and moves notes in patterns and the direct score', () => {
    const doc = base();
    const target = { trackId: 'lead', patternId: 'pattern-1' };
    const added = run(doc, { type: 'addNotes', ...target, events: [note('n', 3.25, 62)] });
    expect(musicEvents(added, 'lead', 'pattern-1')).toHaveLength(5);
    const removed = run(added, { type: 'removeNotes', ...target, ids: ['n', 'note-0'] });
    expect(musicEvents(removed, 'lead', 'pattern-1').map((e) => e.id)).toEqual([
      'note-1',
      'note-2',
      'note-3',
    ]);
    const resized = run(doc, {
      type: 'updateNotes',
      ...target,
      updates: [{ id: 'note-1', patch: { duration: 0.25, velocity: 1 } }],
    });
    expect(musicEvents(resized, 'lead', 'pattern-1')[1]).toMatchObject({
      duration: 0.25,
      velocity: 1,
    });
    const moved = run(doc, {
      type: 'moveNotes',
      ...target,
      ids: ['note-0'],
      offset: 0.5,
      transpose: 12,
      limit: 4,
    });
    expect(musicEvents(moved, 'lead', 'pattern-1')[0]).toMatchObject({ at: 0.5, note: 72 });
    const set = run(doc, { type: 'setEvents', ...target, events: [note('only', 0)] });
    expect(musicEvents(set, 'lead', 'pattern-1').map((e) => e.id)).toEqual(['only']);
    // Direct (non-pattern) notes live on the track.
    const direct = run(doc, {
      type: 'addNotes',
      trackId: 'lead',
      patternId: '',
      events: [note('d', 1)],
    });
    expect(direct.tracks[0].events.map((e) => e.id)).toEqual(['d']);
    expect(direct.patterns).toBe(doc.patterns);
    // A channel is created for a track the pattern did not use yet.
    const two = run(run(doc, { type: 'addTracks', tracks: [track('b')] }), {
      type: 'addNotes',
      trackId: 'b',
      patternId: 'pattern-1',
      events: [note('b1', 0)],
    });
    expect(two.patterns![0].channels.map((c) => c.trackId)).toEqual(['lead', 'b']);
    expect(run(doc, { type: 'removeNotes', ...target, ids: ['missing'] })).toBe(doc);
    expect(compileSound(added).eventCount).toBe(20);
  });
  it('upserts and transforms track events like the sound service', () => {
    const doc = run(base(), {
      type: 'setEvents',
      trackId: 'lead',
      patternId: '',
      events: [note('a', 0), note('b', 1)],
    });
    const up = run(doc, {
      type: 'upsertEvents',
      trackId: 'lead',
      events: [{ ...note('a', 0), velocity: 1 }, note('c', 2)],
    });
    expect(up.tracks[0].events.map((e) => [e.id, e.velocity])).toEqual([
      ['a', 1],
      ['b', 0.7],
      ['c', 0.7],
    ]);
    const t = run(doc, {
      type: 'transformEvents',
      trackId: 'lead',
      eventIds: ['b'],
      offset: 0.3,
      timeScale: 2,
      transpose: -2,
      velocityScale: 2,
      quantize: 0.5,
    });
    expect(t.tracks[0].events[1]).toMatchObject({ at: 2.5, duration: 1, note: 58, velocity: 1 });
    const dup = run(doc, {
      type: 'transformEvents',
      trackId: 'lead',
      duplicate: true,
      offset: 4,
      newIds: ['x', 'y'],
    });
    expect(dup.tracks[0].events.map((e) => [e.id, e.at])).toEqual([
      ['a', 0],
      ['b', 1],
      ['x', 4],
      ['y', 5],
    ]);
  });
  it('adds, updates and removes patterns (removing their clips) and arrangement clips', () => {
    const doc = base();
    const pattern = { id: 'p2', name: 'Pattern 02', length: 4, channels: [] };
    const added = run(doc, { type: 'addPattern', pattern });
    expect(added.patterns!.map((p) => p.id)).toEqual(['pattern-1', 'p2']);
    const renamed = run(added, {
      type: 'updatePattern',
      patternId: 'p2',
      patch: { name: 'B', length: 8 },
    });
    expect(renamed.patterns![1]).toMatchObject({ name: 'B', length: 8 });
    const removed = run(doc, { type: 'removePattern', patternId: 'pattern-1' });
    expect(removed.patterns).toEqual([]);
    expect(removed.arrangement).toEqual([]);
    expect(run(doc, { type: 'removePattern', patternId: 'missing' })).toBe(doc);
    const clip = { id: 'c2', patternId: 'pattern-1', at: 4, repeats: 1 };
    const placed = run(doc, { type: 'addClip', clip });
    expect(placed.arrangement!.map((c) => c.id)).toEqual(['clip-1', 'c2']);
    const moved = run(placed, { type: 'updateClip', clipId: 'c2', patch: { at: 8, repeats: 2 } });
    expect(moved.arrangement![1]).toMatchObject({ at: 8, repeats: 2 });
    expect(run(placed, { type: 'removeClip', clipId: 'c2' }).arrangement!.map((c) => c.id)).toEqual(
      ['clip-1'],
    );
    expect(run(doc, { type: 'updateClip', clipId: 'missing', patch: { at: 1 } })).toBe(doc);
  });
  it('applies a batch of commands in order', () => {
    const result = applySoundCommands(base(), [
      { type: 'setBpm', bpm: 100 },
      { type: 'updateTrack', trackId: 'lead', patch: { muted: true } },
    ]);
    expect(result.doc.tempo[0].bpm).toBe(100);
    expect(result.doc.tracks[0].muted).toBe(true);
    expect(result.summary.split('; ')).toHaveLength(2);
  });
});

describe('command-level music undo', () => {
  const load = (): MusicDraft => {
    const doc = base();
    return musicReducer(emptyMusicDraft, { type: 'load', document: doc, saved: doc });
  };
  const gain = (state: MusicDraft, gainDb: number, now: number, coalesce = 'mixer-gain:lead') =>
    musicReducer(state, {
      type: 'command',
      command: { type: 'updateTrack', trackId: 'lead', patch: { gainDb } },
      coalesce,
      now,
    });
  it('coalesces a drag with the same key inside the window into one undo step', () => {
    let state = load();
    for (let i = 1; i <= 10; i++) state = gain(state, -i, 1000 + i * 100);
    expect(state.past).toHaveLength(1);
    expect(state.document!.tracks[0].gainDb).toBe(-10);
    state = musicReducer(state, { type: 'undo' });
    expect(state.document!.tracks[0].gainDb).toBe(0);
    state = musicReducer(state, { type: 'redo' });
    expect(state.document!.tracks[0].gainDb).toBe(-10);
  });
  it('starts a new step after the window, for another key, without a key, or after undo', () => {
    let state = gain(load(), -1, 0);
    state = gain(state, -2, MUSIC_COALESCE_MS + 1);
    expect(state.past).toHaveLength(2);
    state = gain(state, -3, MUSIC_COALESCE_MS + 2, 'mixer-gain:other');
    expect(state.past).toHaveLength(3);
    state = musicReducer(state, {
      type: 'command',
      command: { type: 'setBpm', bpm: 99 },
      now: MUSIC_COALESCE_MS + 3,
    });
    state = musicReducer(state, {
      type: 'command',
      command: { type: 'setBpm', bpm: 98 },
      now: MUSIC_COALESCE_MS + 4,
    });
    expect(state.past).toHaveLength(5);
    state = musicReducer(state, { type: 'undo' });
    state = gain(state, -4, MUSIC_COALESCE_MS + 5, 'k');
    state = gain(state, -5, MUSIC_COALESCE_MS + 6, 'k');
    expect(state.past).toHaveLength(5);
    expect(state.future).toHaveLength(0);
    state = musicReducer(state, { type: 'undo' });
    expect(state.document!.tempo[0].bpm).toBe(99);
  });
  it('ignores no-op commands and keeps selection out of the history', () => {
    let state = load();
    state = musicReducer(state, {
      type: 'command',
      command: { type: 'updateTrack', trackId: 'missing', patch: { muted: true } },
    });
    state = musicReducer(state, {
      type: 'command',
      command: { type: 'updateTrack', trackId: 'lead', patch: { muted: false } },
    });
    state = musicReducer(state, { type: 'select', selected: ['note-0'] });
    expect(state.past).toHaveLength(0);
    state = musicReducer(state, {
      type: 'command',
      command: { type: 'removeNotes', trackId: 'lead', patternId: 'pattern-1', ids: ['note-0'] },
    });
    state = musicReducer(state, { type: 'select', selected: ['note-1'] });
    state = musicReducer(state, { type: 'undo' });
    expect(state.selected).toEqual(['note-1']);
    expect(musicEvents(state.document!, 'lead', 'pattern-1')).toHaveLength(4);
  });
  it('bounds the stack at 200 entries and clears it on save', () => {
    let state = load();
    for (let i = 0; i < 250; i++)
      state = musicReducer(state, {
        type: 'command',
        command: { type: 'setSettings', patch: { name: 'n' + i } },
        now: i * 1000,
      });
    expect(MUSIC_HISTORY_DEPTH).toBe(200);
    expect(state.past).toHaveLength(200);
    for (let i = 0; i < 200; i++) state = musicReducer(state, { type: 'undo' });
    expect(state.document!.name).toBe('n49');
    expect(musicReducer(state, { type: 'undo' })).toBe(state);
    state = musicReducer(state, { type: 'saved', document: state.document! });
    expect([state.past.length, state.future.length]).toEqual([0, 0]);
  });
  it('pushMusicHistory merges only into an open entry', () => {
    const a = base(),
      b = { ...a, name: 'b' },
      c = { ...a, name: 'c' };
    let h = pushMusicHistory(emptyMusicHistory, {
      label: '1',
      before: a,
      after: b,
      key: 'k',
      at: 0,
    });
    h = pushMusicHistory(h, { label: '2', before: b, after: c, key: 'k', at: 10 });
    expect(h.past).toHaveLength(1);
    expect(h.past[0]).toMatchObject({ before: a, after: c, at: 10, label: '1' });
    h = pushMusicHistory(
      { ...h, open: false },
      { label: '3', before: c, after: a, key: 'k', at: 20 },
    );
    expect(h.past).toHaveLength(2);
  });
});
