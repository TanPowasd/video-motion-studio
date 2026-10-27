import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icons.js';
import {
  computeMaskGeometry,
  formatInboxAnswers,
  inboxPrompt,
  inboxTitle,
  statusLabel,
  type InboxMaskStroke,
  type InboxMessage,
  type InboxQuestionField,
  type InboxQuestionOption,
  type InboxReplyAnswers,
  type InboxReplyValue,
  type InboxRequest,
} from '../../core/inbox-model.js';
import { formatAgo, prettyClient, type ChangeEntry } from './change-feed.js';
import {
  requestEntries,
  requestFiles,
  requestUndoSteps,
  sortRequests,
  type InboxSelectionItem,
} from './inbox-ui.js';
import { placeToolbar, type Obstacle } from './model.js';

const pct = (v: number, of: number) => `${(v / Math.max(1, of)) * 100}%`;

export interface InboxReplyPayload {
  text?: string;
  answers?: InboxReplyAnswers;
  skipped?: boolean;
}

export interface InboxMaskPayload {
  strokes: InboxMaskStroke[];
  candidates?: InboxSelectionItem[];
}

/**
 * 画布指令 input: a small floating box next to the selection, plus an optional interactive
 * brush/erase canvas mask overlay. The person types what they want (and optionally paints the
 * region of interest); Enter (or Ctrl+Enter) sends it to the inbox for whatever external AI is
 * connected. Vmotion itself calls no model. Coral = the person's request.
 */
export function InboxPrompt({
  box,
  width,
  height,
  count,
  names,
  frame,
  fps,
  duration,
  candidates = [],
  obstacles = [],
  busy,
  deliveryMode = 'offline',
  onSubmit,
  onClose,
}: {
  /** Union box of the selection in canvas units (undefined = whole frame). */
  box?: { x: number; y: number; width: number; height: number };
  width: number;
  height: number;
  count: number;
  names: string[];
  frame: number;
  fps: number;
  duration: number;
  /** Candidate scene layers with bounds so painted masks can live-highlight hit nodes. */
  candidates?: InboxSelectionItem[];
  obstacles?: Obstacle[];
  busy: boolean;
  deliveryMode?: 'push' | 'queue' | 'offline';
  onSubmit: (
    text: string,
    range?: { start: number; end: number },
    snapshot?: boolean,
    mask?: InboxMaskPayload,
  ) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [withSnapshot, setWithSnapshot] = useState(false);
  const [ranged, setRanged] = useState(false);
  const [range, setRange] = useState({
    start: frame,
    end: Math.min(Math.max(0, duration - 1), frame + Math.round(fps)),
  });
  const [tool, setTool] = useState<'none' | 'brush' | 'erase'>('none');
  const [brushRadius, setBrushRadius] = useState(() => Math.round(Math.max(16, Math.min(width, height) * 0.04)));
  const [strokes, setStrokes] = useState<InboxMaskStroke[]>([]);
  const drawingRef = useRef<InboxMaskStroke | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);

  const maskGeometry = useMemo(
    () => (strokes.length ? computeMaskGeometry(strokes, { width, height }, candidates) : undefined),
    [strokes, width, height, candidates],
  );

  useEffect(() => {
    const canvas = maskCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!strokes.length) return;
    const scaleX = canvas.width / Math.max(1, width),
      scaleY = canvas.height / Math.max(1, height),
      scale = (scaleX + scaleY) * 0.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) {
      if (!s.points.length) continue;
      const r = Math.max(1, s.radius * scale);
      ctx.save();
      ctx.globalCompositeOperation = s.mode === 'erase' ? 'destination-out' : 'source-over';
      ctx.strokeStyle = 'rgba(255, 107, 87, 0.55)';
      ctx.fillStyle = 'rgba(255, 107, 87, 0.55)';
      ctx.lineWidth = r * 2;
      if (s.points.length === 1) {
        ctx.beginPath();
        ctx.arc(s.points[0].x * scaleX, s.points[0].y * scaleY, r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(s.points[0].x * scaleX, s.points[0].y * scaleY);
        for (let i = 1; i < s.points.length; i++) {
          ctx.lineTo(s.points[i].x * scaleX, s.points[i].y * scaleY);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
    if (maskGeometry) {
      ctx.save();
      ctx.strokeStyle = '#ff6b57';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(
        maskGeometry.bounds.x * scaleX,
        maskGeometry.bounds.y * scaleY,
        maskGeometry.bounds.width * scaleX,
        maskGeometry.bounds.height * scaleY,
      );
      ctx.restore();
    }
  }, [strokes, maskGeometry, width, height]);

  const input = useRef<HTMLTextAreaElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => input.current?.focus(), []);
  const [size, setSize] = useState({ width: width * 0.34, height: height * 0.16, scale: 0.4 });
  useLayoutEffect(() => {
    const el = ref.current,
      parent = el?.parentElement;
    if (!el || !parent) return;
    const scale = parent.clientWidth / Math.max(1, width);
    if (!scale) return;
    const next = { width: el.offsetWidth / scale, height: el.offsetHeight / scale, scale };
    if (
      Math.abs(next.width - size.width) > 1 ||
      Math.abs(next.height - size.height) > 1 ||
      Math.abs(scale - size.scale) > 0.01
    )
      setSize(next);
  });
  const anchor = maskGeometry?.bounds ?? box ?? { x: width / 2 - 1, y: height * 0.7, width: 2, height: 2 };
  const place = placeToolbar(
    anchor,
    size,
    { width, height },
    obstacles,
    14 / size.scale,
    14 / size.scale,
  );
  const submit = () => {
    const value = text.trim();
    if (!value || busy) return;
    onSubmit(
      value,
      ranged
        ? { start: Math.min(range.start, range.end), end: Math.max(range.start, range.end) }
        : undefined,
      withSnapshot,
      maskGeometry ? { strokes, candidates } : undefined,
    );
  };
  const toCanvasPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.round(Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width))) * width * 10) / 10,
      y: Math.round(Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height))) * height * 10) / 10,
    };
  };
  const target =
    count === 0 ? '整个画面' : count === 1 ? names[0] || '1 个对象' : `${count} 个对象`;
  return (
    <>
      {(tool !== 'none' || strokes.length > 0) && (
        <canvas
          ref={maskCanvasRef}
          className={`inbox-mask-canvas ${tool !== 'none' ? 'active' : ''}`}
          width={Math.min(960, Math.max(1, Math.round(width)))}
          height={Math.max(1, Math.round((height / Math.max(1, width)) * Math.min(960, Math.max(1, Math.round(width)))))}
          aria-label="画布指令涂抹遮罩"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: tool !== 'none' ? 'auto' : 'none',
            cursor: tool === 'erase' ? 'cell' : tool === 'brush' ? 'crosshair' : 'default',
            zIndex: 18,
          }}
          onPointerDown={(e) => {
            if (tool === 'none') return;
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            const pt = toCanvasPoint(e);
            const stroke: InboxMaskStroke = { mode: tool, radius: brushRadius, points: [pt] };
            drawingRef.current = stroke;
            setStrokes((prev) => [...prev, stroke]);
          }}
          onPointerMove={(e) => {
            if (!drawingRef.current) return;
            e.stopPropagation();
            const pt = toCanvasPoint(e);
            drawingRef.current = {
              ...drawingRef.current,
              points: [...drawingRef.current.points, pt],
            };
            const updated = drawingRef.current;
            setStrokes((prev) => [...prev.slice(0, -1), updated]);
          }}
          onPointerUp={(e) => {
            if (!drawingRef.current) return;
            e.stopPropagation();
            drawingRef.current = null;
          }}
        />
      )}
      <div
        ref={ref}
        className="inbox-prompt"
        role="dialog"
        aria-label="给外部 AI 的画布指令"
        style={{ left: pct(place.x, width), top: pct(place.y, height), zIndex: 20 }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          } else if (
            e.key === 'Enter' &&
            (e.ctrlKey || e.metaKey || !e.shiftKey) &&
            !e.nativeEvent.isComposing
          ) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <header>
          <span className="inbox-dot" aria-hidden />
          <strong>画布指令</strong>
          <span className="inbox-target" title={names.join('、')}>
            {target} · 第 {frame} 帧
            {maskGeometry ? ` · 遮罩命中 ${maskGeometry.hits.length} 项` : ''}
          </span>
          {deliveryMode !== 'offline' && (
            <span
              className={`inbox-mode-tag ${deliveryMode}`}
              title={
                deliveryMode === 'push'
                  ? '已连接支持 MCP Sampling 的客户端，发送后立即主动推送给 AI'
                  : '已连接 MCP 客户端，等待 AI 通过 inbox_wait 接单'
              }
            >
              {deliveryMode === 'push' ? '主动推送' : '队列接单'}
            </span>
          )}
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <Icon name="close" size={13} />
          </button>
        </header>
        <textarea
          ref={input}
          rows={2}
          value={text}
          maxLength={4000}
          placeholder="想怎么改？例如：标题再大一点，或用画笔圈出画面区域局部修改"
          aria-label="指令内容"
          onChange={(e) => setText(e.target.value)}
        />
        <footer>
          <button
            type="button"
            className={`inbox-option-chip ${tool === 'brush' ? 'active' : ''}`}
            title="在画面上涂抹或圈出需要修改的局部区域"
            onClick={() => setTool((t) => (t === 'brush' ? 'none' : 'brush'))}
          >
            画笔遮罩
          </button>
          {(tool !== 'none' || strokes.length > 0) && (
            <>
              <button
                type="button"
                className={`inbox-option-chip ${tool === 'erase' ? 'active' : ''}`}
                title="擦除局部遮罩"
                onClick={() => setTool((t) => (t === 'erase' ? 'brush' : 'erase'))}
              >
                橡皮
              </button>
              <label className="inbox-range" title="画笔半径（像素）">
                <span>半径</span>
                <input
                  type="number"
                  aria-label="画笔半径"
                  min={4}
                  max={400}
                  value={brushRadius}
                  style={{ width: 48 }}
                  onChange={(e) => setBrushRadius(Math.max(4, Math.min(400, Number(e.target.value) || 24)))}
                />
              </label>
              {strokes.length > 0 && (
                <button
                  type="button"
                  className="inbox-option-chip"
                  title="清空已涂抹的遮罩"
                  onClick={() => {
                    setStrokes([]);
                    setTool('none');
                  }}
                >
                  清空遮罩
                </button>
              )}
            </>
          )}
          <label
            className="inbox-range"
            title="默认仅发送节点、属性与源码片段；手动勾选后附带当前帧画面截图"
          >
            <input
              type="checkbox"
              checked={withSnapshot}
              onChange={(e) => setWithSnapshot(e.target.checked)}
            />
            <span>附带当前帧截图</span>
          </label>
          <label className="inbox-range">
            <input type="checkbox" checked={ranged} onChange={(e) => setRanged(e.target.checked)} />
            <span>时间范围</span>
          </label>
          {ranged && (
            <span className="inbox-range-fields">
              <input
                type="number"
                aria-label="起始帧"
                min={0}
                value={range.start}
                onChange={(e) =>
                  setRange((r) => ({ ...r, start: Math.max(0, Number(e.target.value) || 0) }))
                }
              />
              <span>–</span>
              <input
                type="number"
                aria-label="结束帧"
                min={0}
                value={range.end}
                onChange={(e) =>
                  setRange((r) => ({ ...r, end: Math.max(0, Number(e.target.value) || 0) }))
                }
              />
            </span>
          )}
          <span className="inbox-hint">Enter 发送 · Shift+Enter 换行</span>
          <button className="primary inbox-send" disabled={busy || !text.trim()} onClick={submit}>
            {busy ? '发送中…' : deliveryMode === 'push' ? '推送给 AI' : '发给 AI'}
          </button>
        </footer>
      </div>
    </>
  );
}

/**
 * 画布指令 cards above the change feed: status, the AI's structured clarification form (rendered
 * strictly inside Vmotion Studio, never in external agent windows), linked changes (mint) with
 * one-click undo through the shared history, cancel, and "复制为提示词".
 */
export function InboxPanel({
  requests,
  log,
  head,
  reviewed,
  root,
  now,
  busy,
  connected,
  focusId,
  onReply,
  onCancel,
  onRequeue,
  onUndo,
  onKeep,
  onReveal,
  onFocus,
  onCopied,
}: {
  requests: InboxRequest[];
  log: ChangeEntry[];
  head: string;
  reviewed: ReadonlySet<string>;
  root?: string;
  now: number;
  busy: boolean;
  connected: boolean;
  focusId?: string;
  onReply: (id: string, payload: string | InboxReplyPayload) => void;
  onCancel: (id: string) => void;
  onRequeue: (id: string) => void;
  onUndo: (request: InboxRequest, steps: number) => void;
  onKeep: (request: InboxRequest) => void;
  onReveal: (request: InboxRequest) => void;
  onFocus: (id: string | undefined) => void;
  onCopied: (ok: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [showDone, setShowDone] = useState(false);
  if (!requests.length) return null;
  const sorted = sortRequests(requests),
    open = sorted.filter(
      (r) => r.status === 'pending' || r.status === 'claimed' || r.status === 'question',
    ),
    finished = sorted.filter((r) => !open.includes(r)),
    visible = [...open, ...(showDone ? finished : finished.slice(0, open.length ? 1 : 3))];
  const copy = async (request: InboxRequest) => {
    try {
      await navigator.clipboard.writeText(inboxPrompt(request, root));
      onCopied(true);
    } catch {
      onCopied(false);
    }
  };
  return (
    <section className="inbox-panel" aria-label="画布指令">
      <header className="inbox-head">
        <button
          className="inbox-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
        >
          <Icon name={collapsed ? 'down' : 'up'} size={12} />
          <h2>画布指令</h2>
        </button>
        {open.length > 0 && <b className="inbox-count">{open.length}</b>}
        {!connected && open.some((r) => r.status === 'pending') && (
          <span
            className="inbox-note"
            title="没有 AI 通过 MCP 连接；可复制为提示词交给任意 AI"
          >
            未连接 AI
          </span>
        )}
      </header>
      {!collapsed && (
        <div className="inbox-list">
          {visible.map((request) => (
            <InboxCard
              key={request.id}
              request={request}
              log={log}
              head={head}
              reviewed={reviewed}
              now={now}
              busy={busy}
              focused={focusId === request.id}
              onReply={onReply}
              onCancel={onCancel}
              onRequeue={onRequeue}
              onUndo={onUndo}
              onKeep={onKeep}
              onReveal={onReveal}
              onFocus={onFocus}
              onCopy={copy}
            />
          ))}
          {finished.length > visible.length - open.length && (
            <button className="inbox-more" onClick={() => setShowDone((v) => !v)}>
              {showDone ? '收起已完成' : `显示全部已完成（${finished.length}）`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

const normalizeOption = (opt: string | InboxQuestionOption): InboxQuestionOption =>
  typeof opt === 'string' ? { value: opt, label: opt } : { value: opt.value, label: opt.label ?? opt.value };

function initialFieldValue(field: InboxQuestionField): InboxReplyValue {
  if (field.defaultValue !== undefined) return field.defaultValue;
  if (field.kind === 'boolean') return false;
  if (field.kind === 'multiselect') return [];
  if (field.kind === 'select') {
    const first = field.options?.[0];
    return first ? normalizeOption(first).value : '';
  }
  if (field.kind === 'number') return field.min ?? 0;
  return '';
}

function InboxQuestionForm({
  requestId,
  question,
  busy,
  onReply,
}: {
  requestId: string;
  question: InboxMessage;
  busy: boolean;
  onReply: (id: string, payload: string | InboxReplyPayload) => void;
}) {
  const fields = question.fields ?? [];
  const quickOptions = question.options ?? [];
  const [reply, setReply] = useState('');
  const [values, setValues] = useState<InboxReplyAnswers>(() =>
    Object.fromEntries(fields.map((f) => [f.id, initialFieldValue(f)])),
  );
  useEffect(() => {
    setValues(Object.fromEntries((question.fields ?? []).map((f) => [f.id, initialFieldValue(f)])));
    setReply('');
  }, [question.at]);

  if (fields.length > 0) {
    const missingRequired = fields.some((f) => {
      if (!f.required) return false;
      const v = values[f.id];
      if (Array.isArray(v)) return v.length === 0;
      if (typeof v === 'string') return !v.trim();
      return v === undefined || v === null;
    });
    const submitForm = (e: React.FormEvent) => {
      e.preventDefault();
      if (busy || missingRequired) return;
      const summary = formatInboxAnswers(values, fields);
      const text = reply.trim() ? (summary ? `${summary}（补充：${reply.trim()}）` : reply.trim()) : summary;
      onReply(requestId, { text, answers: values });
    };
    return (
      <form className="inbox-form" onSubmit={submitForm} onKeyDown={(e) => e.stopPropagation()}>
        {fields.map((field) => {
          const opts = (field.options ?? []).map(normalizeOption);
          const current = values[field.id];
          return (
            <div key={field.id} className="inbox-field">
              <label className="inbox-field-label">
                {field.label}
                {field.required && <em>*</em>}
              </label>
              {field.kind === 'boolean' && (
                <label className="inbox-bool">
                  <input
                    type="checkbox"
                    checked={Boolean(current)}
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, [field.id]: e.target.checked }))
                    }
                  />
                  <span>{current ? '是' : '否'}</span>
                </label>
              )}
              {field.kind === 'number' && (
                <input
                  type="number"
                  min={field.min}
                  max={field.max}
                  value={typeof current === 'number' ? current : Number(current) || 0}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [field.id]: Number(e.target.value) }))
                  }
                />
              )}
              {field.kind === 'text' && (
                <input
                  type="text"
                  placeholder={field.placeholder ?? '请输入…'}
                  value={typeof current === 'string' ? current : ''}
                  onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
                />
              )}
              {field.kind === 'select' &&
                (opts.length <= 5 ? (
                  <div className="inbox-options" role="radiogroup" aria-label={field.label}>
                    {opts.map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        className={`inbox-option-chip ${current === o.value ? 'active' : ''}`}
                        onClick={() => setValues((prev) => ({ ...prev, [field.id]: o.value }))}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <select
                    aria-label={field.label}
                    value={typeof current === 'string' ? current : ''}
                    onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
                  >
                    {opts.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ))}
              {field.kind === 'multiselect' && (
                <div className="inbox-options" role="group" aria-label={field.label}>
                  {opts.map((o) => {
                    const arr = Array.isArray(current) ? current : [];
                    const on = arr.includes(o.value);
                    return (
                      <button
                        key={o.value}
                        type="button"
                        aria-pressed={on}
                        className={`inbox-option-chip ${on ? 'active' : ''}`}
                        onClick={() =>
                          setValues((prev) => {
                            const prevArr = Array.isArray(prev[field.id])
                              ? (prev[field.id] as string[])
                              : [];
                            return {
                              ...prev,
                              [field.id]: on
                                ? prevArr.filter((v) => v !== o.value)
                                : [...prevArr, o.value],
                            };
                          })
                        }
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        <div className="inbox-reply">
          <input
            value={reply}
            placeholder="补充说明（可选）…"
            aria-label="补充说明"
            onChange={(e) => setReply(e.target.value)}
          />
          <button
            type="button"
            disabled={busy}
            title="跳过提问，让 AI 按默认方案处理"
            onClick={() => onReply(requestId, { skipped: true })}
          >
            跳过
          </button>
          <button className="primary" type="submit" disabled={busy || missingRequired}>
            提交回答
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="inbox-question-box" onKeyDown={(e) => e.stopPropagation()}>
      {quickOptions.length > 0 && (
        <div className="inbox-options" role="group" aria-label="快捷选项">
          {quickOptions.map((opt) => (
            <button
              key={opt}
              type="button"
              className="inbox-option-chip"
              disabled={busy}
              onClick={() => onReply(requestId, { text: opt, answers: { choice: opt } })}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
      <form
        className="inbox-reply"
        onSubmit={(e) => {
          e.preventDefault();
          if (!reply.trim() || busy) return;
          onReply(requestId, reply.trim());
          setReply('');
        }}
      >
        <input
          value={reply}
          placeholder={quickOptions.length ? '或输入自定义回答…' : '回答 AI 的问题…'}
          aria-label="回复"
          onChange={(e) => setReply(e.target.value)}
        />
        <button
          type="button"
          disabled={busy}
          title="跳过提问，让 AI 按默认方案处理"
          onClick={() => onReply(requestId, { skipped: true })}
        >
          跳过
        </button>
        <button className="primary" type="submit" disabled={busy || !reply.trim()}>
          回复
        </button>
      </form>
    </div>
  );
}

function InboxCard({
  request,
  log,
  head,
  reviewed,
  now,
  busy,
  focused,
  onReply,
  onCancel,
  onRequeue,
  onUndo,
  onKeep,
  onReveal,
  onFocus,
  onCopy,
}: {
  request: InboxRequest;
  log: ChangeEntry[];
  head: string;
  reviewed: ReadonlySet<string>;
  now: number;
  busy: boolean;
  focused: boolean;
  onReply: (id: string, payload: string | InboxReplyPayload) => void;
  onCancel: (id: string) => void;
  onRequeue: (id: string) => void;
  onUndo: (request: InboxRequest, steps: number) => void;
  onKeep: (request: InboxRequest) => void;
  onReveal: (request: InboxRequest) => void;
  onFocus: (id: string | undefined) => void;
  onCopy: (request: InboxRequest) => void;
}) {
  const entries = requestEntries(request, log),
    files = requestFiles(request, log),
    steps = requestUndoSteps(request, log, head),
    kept = entries.length > 0 && entries.every((e) => reviewed.has(e.id)),
    question = [...request.thread].reverse().find((m) => m.kind === 'question'),
    lastNote =
      request.status === 'pending'
        ? [...request.thread].reverse().find((m) => m.from === 'ai' && m.kind === 'note')
        : undefined,
    replies = request.thread.filter((m) => m.kind === 'question' || m.kind === 'reply'),
    who = prettyClient(request.claimedBy?.client) ?? request.claimedBy?.client,
    open =
      request.status === 'pending' ||
      request.status === 'claimed' ||
      request.status === 'question',
    sel = request.context.selection,
    at = Date.parse(request.updatedAt);
  return (
    <article
      className={`inbox-card ${request.status} ${focused ? 'focused' : ''} ${kept ? 'kept' : ''}`}
      data-request={request.id}
      aria-label={`画布指令：${inboxTitle(request, 40)}`}
      onMouseEnter={() => onFocus(request.id)}
      onMouseLeave={() => onFocus(undefined)}
    >
      <header>
        <span className={`inbox-status ${request.status}`}>
          {request.status === 'claimed' && (
            <span className="cf-typing" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          )}
          {statusLabel[request.status]}
        </span>
        {who && request.status !== 'pending' && <span className="inbox-who">{who}</span>}
        <time title={new Date(at).toLocaleString()}>{formatAgo(now - at)}</time>
      </header>
      <p className="inbox-text">“{request.text}”</p>
      <p className="inbox-ctx">
        {sel.length
          ? sel
              .slice(0, 3)
              .map((n) => n.name || n.id.split('/').at(-1))
              .join('、') + (sel.length > 3 ? ` 等 ${sel.length} 个` : '')
          : '整个画面'}
        {' · '}第 {request.context.frame} 帧
        {request.context.range && ` · ${request.context.range.start}–${request.context.range.end}`}
        {request.context.snapshot && <span title="包含当前帧截图">· 含截图</span>}
        {request.context.mask && (
          <span
            title={`涂抹遮罩区域 ${request.context.mask.bounds.width}×${request.context.mask.bounds.height}，命中 ${request.context.mask.hitNodes.length} 个图层`}
          >
            · 遮罩{request.context.mask.hitNodes.length ? `(${request.context.mask.hitNodes.length})` : ''}
          </span>
        )}
        {sel[0]?.source?.line && (
          <code title="源码位置">
            {sel[0].source.file.split('/').at(-1)}:{sel[0].source.line}
          </code>
        )}
      </p>
      {lastNote && <p className="inbox-ai-note">{lastNote.text}</p>}
      {replies.length > 0 && (
        <ul className="inbox-thread">
          {replies.map((m, i) => (
            <li key={i} className={m.from}>
              <span>{m.from === 'ai' ? 'AI' : '我'}</span>
              {m.text}
            </li>
          ))}
        </ul>
      )}
      {request.status === 'question' && question && (
        <InboxQuestionForm
          requestId={request.id}
          question={question}
          busy={busy}
          onReply={onReply}
        />
      )}
      {request.status === 'done' && request.summary && (
        <p className="inbox-summary">{request.summary}</p>
      )}
      {(entries.length > 0 || files.length > 0) && (
        <div className="inbox-changes">
          <span>
            <Icon name="check" size={12} />{' '}
            {entries.length ? `${entries.length} 次改动` : '已报告的文件'}
          </span>
          {files.slice(0, 4).map((f) => (
            <code key={f}>{f}</code>
          ))}
          {files.length > 4 && <em>+{files.length - 4}</em>}
        </div>
      )}
      <footer>
        {request.status === 'done' && entries.length > 0 && (
          <>
            {!kept && (
              <button className="cf-keep" disabled={busy} onClick={() => onKeep(request)}>
                保留
              </button>
            )}
            <button
              disabled={busy || !steps}
              title={
                steps
                  ? `撤销这条指令的全部改动（共 ${steps} 步，共享撤销历史）`
                  : '之后还有改动：需先撤销更新的改动'
              }
              onClick={() => onUndo(request, steps)}
            >
              撤销这条指令
            </button>
          </>
        )}
        {sel.length > 0 && (
          <button onClick={() => onReveal(request)} title="在画布上选中这些对象">
            定位
          </button>
        )}
        <button onClick={() => onCopy(request)} title="复制包含上下文的完整提示词，交给任意 AI">
          复制为提示词
        </button>
        {(request.status === 'claimed' || request.status === 'question') && (
          <button onClick={() => onRequeue(request.id)} title="AI 没有响应时退回待处理">
            退回
          </button>
        )}
        {open && (
          <button className="inbox-cancel" disabled={busy} onClick={() => onCancel(request.id)}>
            取消
          </button>
        )}
      </footer>
    </article>
  );
}
