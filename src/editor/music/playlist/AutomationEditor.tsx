import React, { useRef, useState } from 'react';
import type { AutomationClip, SoundClip, SoundDocument } from '../../../core/sound-schema.js';
import { automationLinearKeys } from '../../../core/sound-patterns.js';
import { automationRange } from '../../../core/sound-playlist.js';
import type { MusicRun } from '../music-panel-types.js';

type Point = AutomationClip['points'][number];
const W = 640,
  H = 150,
  PAD = 10;
const CURVES: Array<[Point['curve'], string]> = [
  ['linear', '线性'],
  ['smooth', '平滑'],
  ['hold', '保持'],
  ['tension', '张力'],
];
export function automationTargetLabel(doc: SoundDocument, auto: AutomationClip | undefined) {
  const t = auto?.target;
  if (!t) return '自动化';
  if (t.type === 'tempo') return '速度 BPM';
  if (t.type === 'track')
    return `${doc.tracks.find((x) => x.id === t.trackId)?.name ?? t.trackId} ${t.param === 'pan' ? '声像' : '音量'}`;
  return t.type;
}

/**
 * Basic point editor for one automation clip (opened by double-clicking it in the Playlist):
 * click the empty area to add a point, drag a point to move it, double-click or right-click a
 * point to delete it; the selected point's curve type and tension apply to the segment after it.
 * A drag previews locally and commits once on release (one undo step).
 */
export function AutomationEditor({
  doc,
  clip,
  run,
  busy,
  onClose,
}: {
  doc: SoundDocument;
  clip: SoundClip;
  run: MusicRun;
  busy: boolean;
  onClose: () => void;
}) {
  const auto = doc.automationClips.find((a) => a.id === clip.refId);
  const [draft, setDraft] = useState<Point[]>(),
    [selected, setSelected] = useState(0);
  const drag = useRef<{ index: number; pointer: number } | undefined>(undefined);
  if (!auto) return null;
  const points = draft ?? auto.points,
    [lo, hi] = automationRange(auto.target),
    span = Math.max(clip.offset + clip.length, ...points.map((p) => p.at), 1e-6);
  const x = (at: number) => PAD + (at / span) * (W - 2 * PAD),
    y = (v: number) => PAD + (1 - (v - lo) / (hi - lo)) * (H - 2 * PAD);
  const from = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect(),
      at = (((e.clientX - r.left) / r.width) * W - PAD) / (W - 2 * PAD),
      v = 1 - (((e.clientY - r.top) / r.height) * H - PAD) / (H - 2 * PAD);
    return {
      at: Math.max(0, Number((at * span).toFixed(4))),
      value: Number(Math.max(lo, Math.min(hi, lo + v * (hi - lo))).toFixed(4)),
    };
  };
  const commit = (next: Point[]) =>
    run({ type: 'updateAutomationClip', automationId: auto.id, patch: { points: next } });
  const keys = automationLinearKeys([...points].sort((a, b) => a.at - b.at));
  const sel = points[selected];
  return (
    <div className="music-automation-editor" aria-label="自动化片段编辑器">
      <div className="music-editor-toolbar">
        <strong>自动化 · {automationTargetLabel(doc, auto)}</strong>
        <span>点击空白添加点 · 拖动移动 · 双击/右键删除</span>
        {sel && (
          <>
            <label>
              曲线
              <select
                aria-label="自动化曲线类型"
                value={sel.curve}
                disabled={busy}
                onChange={(e) =>
                  commit(
                    points.map((p, i) =>
                      i === selected ? { ...p, curve: e.target.value as Point['curve'] } : p,
                    ),
                  )
                }
              >
                {CURVES.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {sel.curve === 'tension' && (
              <label>
                张力
                <input
                  aria-label="自动化张力"
                  type="range"
                  min={-1}
                  max={1}
                  step={0.05}
                  value={sel.tension}
                  disabled={busy}
                  onChange={(e) =>
                    run(
                      {
                        type: 'updateAutomationClip',
                        automationId: auto.id,
                        patch: {
                          points: points.map((p, i) =>
                            i === selected ? { ...p, tension: Number(e.target.value) } : p,
                          ),
                        },
                      },
                      'auto-tension:' + auto.id,
                    )
                  }
                />
              </label>
            )}
            <span className="music-automation-value">
              {sel.at.toFixed(2)} · {sel.value.toFixed(2)}
            </span>
          </>
        )}
        <button onClick={onClose} aria-label="关闭自动化编辑器">
          完成
        </button>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="music-automation-canvas"
        onPointerDown={(e) => {
          if (busy || e.button !== 0 || (e.target as Element).closest('circle')) return;
          const p = from(e),
            next = [...points, { ...p, curve: 'linear' as const, tension: 0 }].sort(
              (a, b) => a.at - b.at,
            );
          setSelected(next.findIndex((q) => q.at === p.at && q.value === p.value));
          commit(next);
        }}
        onPointerMove={(e) => {
          const g = drag.current;
          if (!g || g.pointer !== e.pointerId) return;
          const p = from(e);
          setDraft(points.map((q, i) => (i === g.index ? { ...q, ...p } : q)));
        }}
        onPointerUp={(e) => {
          const g = drag.current;
          if (!g || g.pointer !== e.pointerId) return;
          drag.current = undefined;
          if (draft) {
            const moved = draft[g.index],
              sorted = [...draft].sort((a, b) => a.at - b.at);
            setSelected(sorted.indexOf(moved));
            commit(sorted);
          }
          setDraft(undefined);
        }}
      >
        <rect
          x={x(clip.offset)}
          y={0}
          width={x(clip.offset + clip.length) - x(clip.offset)}
          height={H}
          className="music-automation-window"
        />
        <polyline points={keys.map((k) => `${x(k.at)},${y(k.value)}`).join(' ')} />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={x(p.at)}
            cy={y(p.value)}
            r={i === selected ? 6 : 4.5}
            className={i === selected ? 'selected' : ''}
            onPointerDown={(e) => {
              if (busy || e.button !== 0) return;
              e.stopPropagation();
              (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId);
              setSelected(i);
              drag.current = { index: i, pointer: e.pointerId };
            }}
            onDoubleClick={() => points.length > 1 && commit(points.filter((_, j) => j !== i))}
            onContextMenu={(e) => {
              e.preventDefault();
              if (points.length > 1) commit(points.filter((_, j) => j !== i));
            }}
          />
        ))}
      </svg>
    </div>
  );
}
