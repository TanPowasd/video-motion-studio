import { noteNumber } from '../../core/sound.js';
import { ChannelRack } from './ChannelRack.js';
import { MusicNumber } from './MusicInspector.js';
import { PianoRoll } from './PianoRoll.js';
import type { MusicTool, MusicWorkspaceContext } from './music-panel-types.js';
import { moveMusicNotes, musicSeconds } from './music-model.js';

/** Piano roll / channel rack tab body: editor toolbar, the editor itself and the note selection bar. */
export function MusicPatternEditor({
  ctx,
  tab,
  grid,
  setGrid,
  tool,
  setTool,
  zoom,
  setZoom,
}: {
  ctx: MusicWorkspaceContext;
  tab: string;
  grid: number;
  setGrid: (grid: number) => void;
  tool: MusicTool;
  setTool: (tool: MusicTool) => void;
  zoom: number;
  setZoom: (zoom: number) => void;
}) {
  const { m, doc, draft, busy, clock, pattern, length, events, selected, edit, editEvents } = ctx;
  const { addTrack, selectTrack } = ctx;
  const duplicateNotes = () => {
    if (!selected.length) return;
    const min = Math.min(...selected.map((n) => n.at)),
      max = Math.max(...selected.map((n) => n.at + n.duration)),
      offset = max - min;
    if (max + offset > length) return;
    const copies = selected.map((n) => ({ ...n, id: crypto.randomUUID(), at: n.at + offset }));
    editEvents([...events, ...copies]);
    m.dispatch({ type: 'select', selected: copies.map((n) => n.id) });
  };
  return (
    <>
      <div className="music-editor-toolbar">
        <select
          aria-label="编辑 Pattern"
          value={draft.patternId}
          onChange={(e) => m.dispatch({ type: 'select', patternId: e.target.value })}
        >
          <option value="">整曲音符</option>
          {doc.patterns?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          aria-label="编辑音乐通道"
          value={draft.trackId}
          onChange={(e) => selectTrack(e.target.value)}
        >
          {doc.tracks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select
          aria-label="音符网格"
          value={grid}
          onChange={(e) => setGrid(Number(e.target.value))}
        >
          {[
            [1, '1 拍'],
            [0.5, '1/2'],
            [0.25, '1/4'],
            [0.125, '1/8'],
            [1 / 3, '三连音'],
          ].map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
        {tab === 'piano' && (
          <>
            <button className={tool === 'draw' ? 'active' : ''} onClick={() => setTool('draw')}>
              铅笔
            </button>
            <button className={tool === 'select' ? 'active' : ''} onClick={() => setTool('select')}>
              选择
            </button>
            <label>
              缩放
              <input
                aria-label="钢琴卷帘缩放"
                type="range"
                min={30}
                max={160}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
              />
            </label>
          </>
        )}
        {pattern && (
          <MusicNumber
            label="Pattern 长度"
            value={pattern.length}
            min={0.25}
            max={doc.duration}
            step={0.25}
            onChange={(n) =>
              edit((d) => {
                d.patterns = d.patterns?.map((p) =>
                  p.id === pattern.id ? { ...p, length: n } : p,
                );
              })
            }
          />
        )}
      </div>
      {tab === 'piano' ? (
        <PianoRoll
          key={doc.id + ':' + draft.patternId}
          events={events}
          selected={draft.selected}
          length={length}
          grid={grid}
          zoom={zoom}
          tool={tool}
          disabled={busy}
          playhead={!pattern ? clock : undefined}
          onSelect={(selected) => m.dispatch({ type: 'select', selected })}
          onEdit={editEvents}
          onSeek={(at) => m.seek(musicSeconds(doc, at))}
        />
      ) : (
        <ChannelRack
          doc={doc}
          m={m}
          edit={edit}
          busy={busy}
          draft={draft}
          length={length}
          addTrack={addTrack}
          selectTrack={selectTrack}
        />
      )}
      <div className="music-selection-bar">
        <span>
          {selected.length
            ? `${selected.length} 个音符`
            : '点击绘制 · 拖动移动 · 右边缘调整长度 · Ctrl 多选 · 右键删除'}
        </span>
        {selected.length > 0 && (
          <>
            <button
              disabled={busy}
              onClick={() =>
                editEvents(
                  events.map((n) =>
                    draft.selected.includes(n.id)
                      ? {
                          ...n,
                          at: Math.min(
                            length - n.duration,
                            Math.max(0, Math.round(n.at / grid) * grid),
                          ),
                        }
                      : n,
                  ),
                )
              }
            >
              量化
            </button>
            <button disabled={busy} onClick={duplicateNotes}>
              复制
            </button>
            <button
              disabled={busy}
              onClick={() => editEvents(moveMusicNotes(events, draft.selected, 0, 12, length))}
            >
              ＋ 八度
            </button>
            <MusicNumber
              label="力度"
              value={selected[0].velocity}
              min={0}
              max={1}
              step={0.05}
              onChange={(velocity) =>
                editEvents(
                  events.map((n) => (draft.selected.includes(n.id) ? { ...n, velocity } : n)),
                )
              }
            />
            {selected.length === 1 && (
              <>
                <MusicNumber
                  label="起点"
                  value={selected[0].at}
                  min={0}
                  max={length - selected[0].duration}
                  step={grid}
                  onChange={(at) =>
                    editEvents(events.map((n) => (n.id === selected[0].id ? { ...n, at } : n)))
                  }
                />
                <MusicNumber
                  label="长度"
                  value={selected[0].duration}
                  min={0.001}
                  max={length - selected[0].at}
                  step={grid}
                  onChange={(duration) =>
                    editEvents(
                      events.map((n) => (n.id === selected[0].id ? { ...n, duration } : n)),
                    )
                  }
                />
                <MusicNumber
                  label="MIDI 音高"
                  value={noteNumber(selected[0].note)}
                  min={0}
                  max={127}
                  step={1}
                  onChange={(note) =>
                    editEvents(events.map((n) => (n.id === selected[0].id ? { ...n, note } : n)))
                  }
                />
              </>
            )}
            <button
              disabled={busy}
              onClick={() => {
                editEvents(events.filter((n) => !draft.selected.includes(n.id)));
                m.dispatch({ type: 'select', selected: [] });
              }}
            >
              删除
            </button>
          </>
        )}
      </div>
    </>
  );
}
