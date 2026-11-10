import { useEffect, useState } from 'react';
import { compileSound } from '../../core/sound.js';
import { soundDocumentSchema } from '../../core/sound-schema.js';
import { MidiPerformance } from './MidiPerformance.js';
import { MusicChannels } from './MusicChannels.js';
import { MusicInlineForms } from './MusicInlineForms.js';
import { MusicMixer } from './MusicMixer.js';
import { MusicPatternEditor } from './MusicPatternEditor.js';
import { MusicSettings } from './MusicSettings.js';
import { PlaylistPanel } from './PlaylistPanel.js';
import type { MusicTool, MusicWorkspaceContext } from './music-panel-types.js';

/** Centre column: title row, tab strip, inline forms, conflict alert, the active tab body and channels. */
export function MusicMainArea({
  ctx,
  tab,
  setTab,
  grid,
  setGrid,
  owner,
  setOwner,
  showMidi,
  setShowMidi,
  showPlace,
  setShowPlace,
  performanceOpen,
}: {
  ctx: MusicWorkspaceContext;
  tab: string;
  setTab: (tab: string) => void;
  grid: number;
  setGrid: (grid: number) => void;
  owner: string;
  setOwner: (owner: string) => void;
  showMidi: boolean;
  setShowMidi: (open: boolean) => void;
  showPlace: boolean;
  setShowPlace: (open: boolean) => void;
  performanceOpen: boolean;
}) {
  const { m, doc, draft, busy, duration, track, pattern, run, addTrack, selectTrack } = ctx;
  const [tool, setTool] = useState<MusicTool>('draw'),
    [zoom, setZoom] = useState(80);
  const [jsonText, setJsonText] = useState(''),
    [jsonError, setJsonError] = useState('');
  useEffect(() => {
    if (tab === 'json' && doc) setJsonText(JSON.stringify(doc, null, 2));
  }, [tab, doc]);
  return (
    <main className="music-main">
      <div className="music-title-row">
        <input
          aria-label="乐曲名称"
          value={doc.name}
          disabled={busy}
          onChange={(e) => run({ type: 'setSettings', patch: { name: e.target.value } }, 'name')}
        />
        <span>
          {doc.tracks.length} CHANNELS · {duration.toFixed(1)}s
        </span>
      </div>
      <div className="music-tabs music-main-tabs">
        {[
          ['playlist', 'Playlist · 编排'],
          ['piano', 'Piano roll · 钢琴卷帘'],
          ['rack', 'Channel rack · 步进鼓机'],
          ['mixer', 'Mixer · 混音'],
          ['settings', '工程设置'],
          ['json', 'JSON'],
        ].map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <MusicInlineForms
        ctx={ctx}
        showMidi={showMidi}
        setShowMidi={setShowMidi}
        showPlace={showPlace}
        setShowPlace={setShowPlace}
      />
      {m.conflicted && (
        <div className="music-alert">
          源文件已由其他编辑修改，当前草稿保留。复制 JSON 合并后重新载入。
          <button disabled={busy} onClick={m.reload}>
            重新载入源文件
          </button>
        </div>
      )}
      {tab === 'playlist' && (
        <PlaylistPanel doc={doc} m={m} run={run} busy={busy} grid={grid} setTab={setTab} />
      )}
      {(tab === 'piano' || tab === 'rack') && (
        <MusicPatternEditor
          ctx={ctx}
          tab={tab}
          grid={grid}
          setGrid={setGrid}
          tool={tool}
          setTool={setTool}
          zoom={zoom}
          setZoom={setZoom}
        />
      )}
      {tab === 'mixer' && (
        <MusicMixer doc={doc} m={m} run={run} busy={busy} owner={owner} setOwner={setOwner} />
      )}
      {tab === 'settings' && (
        <MusicSettings doc={doc} m={m} run={run} busy={busy} pattern={pattern} />
      )}
      {tab === 'json' && (
        <div className="music-json-panel">
          <div className="music-editor-toolbar">
            <span>代码草稿需应用后才进入乐曲。稳定 ID 与 Pattern 保留在工程文件中。</span>
            <button
              disabled={busy}
              onClick={() => {
                try {
                  const next = soundDocumentSchema.parse(JSON.parse(jsonText));
                  if (next.id !== doc.id) throw new Error('乐曲 ID 不可更改');
                  compileSound(next);
                  m.edit(next);
                  setJsonError('');
                } catch (e) {
                  setJsonError((e as Error).message);
                }
              }}
            >
              应用 JSON 草稿
            </button>
          </div>
          <textarea
            aria-label="音乐工程 JSON"
            value={jsonText}
            spellCheck={false}
            onChange={(e) => setJsonText(e.target.value)}
          />
          {jsonError && (
            <p role="alert" className="music-error">
              {jsonError}
            </p>
          )}
        </div>
      )}
      {performanceOpen && (
        <MidiPerformance
          doc={doc}
          track={track}
          patternId={draft.patternId}
          grid={grid}
          disabled={busy}
          onEdit={m.edit}
          onStatus={(error) =>
            void m.task('MIDI', async () => {
              throw new Error(error);
            })
          }
        />
      )}
      <MusicChannels
        doc={doc}
        m={m}
        run={run}
        busy={busy}
        draft={draft}
        track={track}
        addTrack={addTrack}
        selectTrack={selectTrack}
      />
    </main>
  );
}
