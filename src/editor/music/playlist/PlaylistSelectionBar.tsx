import { MusicNumber } from '../MusicInspector.js';
import type { MusicPanelProps } from '../music-panel-types.js';

/** Bottom bar: numeric edit of the selected clip(s), make unique, mute, gain, delete. */
export function PlaylistSelectionBar({
  doc,
  m,
  run,
  busy,
  grid,
  selection,
  setSelection,
  openAutomation,
  setTab,
}: Pick<MusicPanelProps, 'doc' | 'm' | 'run' | 'busy' | 'setTab'> & {
  grid: number;
  selection: string[];
  setSelection: (ids: string[]) => void;
  openAutomation: (clipId: string) => void;
}) {
  const chosen = doc.clips.filter((c) => selection.includes(c.id)),
    c = chosen.length === 1 ? chosen[0] : undefined,
    step = grid || 0.01;
  if (!chosen.length)
    return (
      <div className="music-selection-bar">
        <span>
          重复使用同一 Pattern，编辑音符时所有实例一起更新。E 选择 · P 绘制 · B 刷绘 · C 切分 · D
          删除 · T 静音 · Ctrl+C/V/D 复制粘贴 · Delete 删除
        </span>
        {doc.tracks.some((t) => t.events.length) && (
          <button
            className="music-direct-score"
            onClick={() => {
              m.dispatch({ type: 'select', patternId: '' });
              setTab('piano');
            }}
          >
            整曲直接音符 · {doc.tracks.reduce((sum, t) => sum + t.events.length, 0)} 个 · 点击编辑
          </button>
        )}
      </div>
    );
  const allMuted = chosen.every((x) => x.muted);
  return (
    <div className="music-selection-bar">
      <span>{c ? '编排片段' : `已选 ${chosen.length} 个片段`}</span>
      {c && (
        <>
          <MusicNumber
            label="起点"
            value={c.at}
            min={0}
            max={doc.duration - c.length}
            step={step}
            onChange={(at) =>
              run({ type: 'updateClip', clipId: c.id, patch: { at } }, 'clip-at:' + c.id)
            }
          />
          <MusicNumber
            label="长度"
            value={c.length}
            min={step}
            max={doc.duration - c.at}
            step={step}
            onChange={(length) =>
              run({ type: 'updateClip', clipId: c.id, patch: { length } }, 'clip-length:' + c.id)
            }
          />
          <MusicNumber
            label="偏移"
            value={c.offset}
            min={0}
            max={14400}
            step={step}
            onChange={(offset) =>
              run({ type: 'updateClip', clipId: c.id, patch: { offset } }, 'clip-offset:' + c.id)
            }
          />
          {c.kind === 'audio' && (
            <MusicNumber
              label="增益 dB"
              value={c.gainDb ?? 0}
              min={-60}
              max={6}
              step={0.5}
              onChange={(gainDb) =>
                run({ type: 'updateClip', clipId: c.id, patch: { gainDb } }, 'clip-gain:' + c.id)
              }
            />
          )}
          <label className="music-field">
            <span>颜色</span>
            <input
              type="color"
              aria-label="片段颜色"
              value={c.color ?? '#ff7a66'}
              disabled={busy}
              onChange={(e) =>
                run(
                  { type: 'updateClip', clipId: c.id, patch: { color: e.target.value } },
                  'clip-color:' + c.id,
                )
              }
            />
          </label>
          {c.kind === 'pattern' && (
            <button
              disabled={busy || (doc.patterns?.length ?? 0) >= 128}
              title="复制此片段的 Pattern，只让这个片段使用副本"
              onClick={() =>
                run({ type: 'makeUnique', clipId: c.id, patternId: crypto.randomUUID() })
              }
            >
              使唯一
            </button>
          )}
          {c.kind === 'automation' && (
            <button disabled={busy} onClick={() => openAutomation(c.id)}>
              编辑自动化点
            </button>
          )}
        </>
      )}
      <button
        aria-pressed={allMuted}
        disabled={busy}
        onClick={() =>
          run({
            type: 'updateClips',
            updates: chosen.map((x) => ({ id: x.id, patch: { muted: !allMuted } })),
          })
        }
      >
        {allMuted ? '取消静音' : '静音片段'}
      </button>
      <button
        disabled={busy}
        onClick={() => {
          run({ type: 'removeClips', ids: chosen.map((x) => x.id) });
          setSelection([]);
        }}
      >
        删除片段
      </button>
    </div>
  );
}
