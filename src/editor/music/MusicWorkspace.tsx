import { useEffect, useState } from 'react';
import { compileSound, soundPreset } from '../../core/sound.js';
import { soundTrackSchema, type SoundDocument, type SoundEvent } from '../../core/sound-schema.js';
import { MusicInspector } from './MusicInspector.js';
import { musicEvents, musicTime, setMusicEvents } from './music-model.js';
import { useMusic } from './use-music.js';
import type { MusicWorkspaceContext } from './music-panel-types.js';
import { MusicToolbar } from './MusicToolbar.js';
import { MusicBrowser } from './MusicBrowser.js';
import { MusicMainArea } from './MusicMainArea.js';
import { MusicFooter } from './MusicFooter.js';
import '../studio-shell.css';
import './music.css';

export default function MusicWorkspace({ embedded = false }: { embedded?: boolean } = {}) {
  const m = useMusic(),
    { doc, draft, application } = m;
  const [tab, setTab] = useState('playlist'),
    [grid, setGrid] = useState(0.25);
  const [performanceOpen, setPerformanceOpen] = useState(false);
  const [owner, setOwner] = useState(''),
    [showMidi, setShowMidi] = useState(false),
    [showPlace, setShowPlace] = useState(false);
  const track = doc?.tracks.find((t) => t.id === draft.trackId),
    pattern = doc?.patterns?.find((p) => p.id === draft.patternId);
  const length = pattern?.length ?? doc?.duration ?? 16,
    events = doc ? musicEvents(doc, draft.trackId, draft.patternId) : [];
  const selected = events.filter((e) => draft.selected.includes(e.id)),
    busy = !!m.busy;
  const selectTrack = (trackId: string) => {
    m.dispatch({ type: 'select', trackId });
    setOwner(trackId);
  };
  const editEvents = (next: SoundEvent[]) => {
    if (doc) m.edit(setMusicEvents(doc, draft.trackId, draft.patternId, next));
  };
  const edit = (change: (d: SoundDocument) => void) => {
    if (!doc) return;
    const next = structuredClone(doc);
    change(next);
    m.edit(next);
  };
  let validation = '',
    duration = 0;
  if (doc)
    try {
      duration = compileSound(doc).duration;
    } catch (e) {
      validation = (e as Error).message;
    }
  useEffect(() => {
    setOwner(draft.trackId);
  }, [draft.trackId]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName) || busy)
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void m.save();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void m.history(e.shiftKey);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && tab === 'piano') {
        e.preventDefault();
        m.dispatch({ type: 'select', selected: events.map((n) => n.id) });
      } else if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        tab === 'piano' &&
        draft.selected.length
      ) {
        e.preventDefault();
        editEvents(events.filter((n) => !draft.selected.includes(n.id)));
        m.dispatch({ type: 'select', selected: [] });
      } else if (e.code === 'Space') {
        e.preventDefault();
        if (m.audio) {
          if (m.audioRef.current?.paused) void m.audioRef.current.play();
          else m.audioRef.current?.pause();
        } else void m.audition();
      } else if (e.key === 'Escape') m.dispatch({ type: 'select', selected: [] });
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const addTrack = (preset: string) => {
    if (!doc || doc.tracks.length >= 64) return;
    const id = crypto.randomUUID();
    edit((d) =>
      d.tracks.push(
        soundTrackSchema.parse({
          id,
          name: preset === 'pluck' ? '旋律 ' + (d.tracks.length + 1) : preset,
          instrument: soundPreset(preset),
        }),
      ),
    );
    selectTrack(id);
  };
  if (!application || !doc)
    return (
      <div className="workspace-loading">
        {m.error || '正在打开音乐工作区…'}
        <a href="#/project">返回剪辑</a>
      </div>
    );
  const assets = application.snapshot.project.assets;
  const clock = musicTime(doc, m.start);
  const ctx: MusicWorkspaceContext = {
    embedded,
    m,
    doc,
    draft,
    application,
    busy,
    validation,
    duration,
    clock,
    track,
    pattern,
    length,
    events,
    selected,
    edit,
    editEvents,
    selectTrack,
    addTrack,
  };
  return (
    <div className={`music-app ${embedded ? 'embedded' : ''}`}>
      <MusicToolbar
        ctx={ctx}
        showPlace={showPlace}
        setShowPlace={setShowPlace}
        performanceOpen={performanceOpen}
        setPerformanceOpen={setPerformanceOpen}
      />
      <div className="music-body">
        <MusicBrowser ctx={ctx} showMidi={showMidi} setShowMidi={setShowMidi} />
        <MusicMainArea
          ctx={ctx}
          tab={tab}
          setTab={setTab}
          grid={grid}
          setGrid={setGrid}
          owner={owner}
          setOwner={setOwner}
          showMidi={showMidi}
          setShowMidi={setShowMidi}
          showPlace={showPlace}
          setShowPlace={setShowPlace}
          performanceOpen={performanceOpen}
        />
        <fieldset className="music-inspector-fieldset" disabled={busy}>
          <MusicInspector
            key={owner}
            doc={doc}
            owner={owner || draft.trackId}
            assets={assets}
            edit={m.edit}
          />
        </fieldset>
      </div>
      <MusicFooter ctx={ctx} />
    </div>
  );
}
