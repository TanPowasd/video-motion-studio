import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../Icons.js';
import { inboxPrompt, inboxTitle, statusLabel, type InboxRequest } from '../../core/inbox-model.js';
import { formatAgo, prettyClient, type ChangeEntry } from './change-feed.js';
import { requestEntries, requestFiles, requestUndoSteps, sortRequests } from './inbox-ui.js';
import { placeToolbar, type Obstacle } from './model.js';

const pct = (v: number, of: number) => `${(v / Math.max(1, of)) * 100}%`;

/**
 * 画布指令 input: a small floating box next to the selection. The person types what they want;
 * Enter (or Ctrl+Enter) sends it to the inbox for whatever external AI is connected. Vmotion
 * itself calls no model. Coral = the person's request.
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
  obstacles = [],
  busy,
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
  obstacles?: Obstacle[];
  busy: boolean;
  onSubmit: (text: string, range?: { start: number; end: number }) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [ranged, setRanged] = useState(false);
  const [range, setRange] = useState({ start: frame, end: Math.min(Math.max(0, duration - 1), frame + Math.round(fps)) });
  const input = useRef<HTMLTextAreaElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => input.current?.focus(), []);
  const [size, setSize] = useState({ width: width * 0.32, height: height * 0.16, scale: 0.4 });
  useLayoutEffect(() => {
    const el = ref.current,
      parent = el?.parentElement;
    if (!el || !parent) return;
    const scale = parent.clientWidth / Math.max(1, width);
    if (!scale) return;
    const next = { width: el.offsetWidth / scale, height: el.offsetHeight / scale, scale };
    if (Math.abs(next.width - size.width) > 1 || Math.abs(next.height - size.height) > 1 || Math.abs(scale - size.scale) > 0.01) setSize(next);
  });
  const anchor = box ?? { x: width / 2 - 1, y: height * 0.7, width: 2, height: 2 };
  const place = placeToolbar(anchor, size, { width, height }, obstacles, 14 / size.scale, 14 / size.scale);
  const submit = () => {
    const value = text.trim();
    if (!value || busy) return;
    onSubmit(value, ranged ? { start: Math.min(range.start, range.end), end: Math.max(range.start, range.end) } : undefined);
  };
  const target = count === 0 ? '整个画面' : count === 1 ? names[0] || '1 个对象' : `${count} 个对象`;
  return (
    <div
      ref={ref}
      className="inbox-prompt"
      role="dialog"
      aria-label="给外部 AI 的画布指令"
      style={{ left: pct(place.x, width), top: pct(place.y, height) }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !e.shiftKey) && !e.nativeEvent.isComposing) {
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
        </span>
        <button className="icon-button" aria-label="关闭" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </header>
      <textarea
        ref={input}
        rows={2}
        value={text}
        maxLength={4000}
        placeholder="想怎么改？例如：标题再大一点，入场慢一些"
        aria-label="指令内容"
        onChange={(e) => setText(e.target.value)}
      />
      <footer>
        <label className="inbox-range">
          <input type="checkbox" checked={ranged} onChange={(e) => setRanged(e.target.checked)} />
          <span>时间范围</span>
        </label>
        {ranged && (
          <span className="inbox-range-fields">
            <input type="number" aria-label="起始帧" min={0} value={range.start} onChange={(e) => setRange((r) => ({ ...r, start: Math.max(0, Number(e.target.value) || 0) }))} />
            <span>–</span>
            <input type="number" aria-label="结束帧" min={0} value={range.end} onChange={(e) => setRange((r) => ({ ...r, end: Math.max(0, Number(e.target.value) || 0) }))} />
          </span>
        )}
        <span className="inbox-hint">Enter 发送 · Shift+Enter 换行</span>
        <button className="primary inbox-send" disabled={busy || !text.trim()} onClick={submit}>
          {busy ? '打包中…' : '发给 AI'}
        </button>
      </footer>
    </div>
  );
}

/**
 * 画布指令 cards above the change feed: status, the AI's question with a reply box, linked
 * changes (mint) with one-click undo through the shared history, cancel, and "复制为提示词".
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
  onReply: (id: string, text: string) => void;
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
    open = sorted.filter((r) => r.status === 'pending' || r.status === 'claimed' || r.status === 'question'),
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
        <button className="inbox-toggle" aria-expanded={!collapsed} onClick={() => setCollapsed((v) => !v)}>
          <Icon name={collapsed ? 'down' : 'up'} size={12} />
          <h2>画布指令</h2>
        </button>
        {open.length > 0 && <b className="inbox-count">{open.length}</b>}
        {!connected && open.some((r) => r.status === 'pending') && (
          <span className="inbox-note" title="没有 AI 通过 MCP 连接；可复制为提示词交给任意 AI">未连接 AI</span>
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
  onReply: (id: string, text: string) => void;
  onCancel: (id: string) => void;
  onRequeue: (id: string) => void;
  onUndo: (request: InboxRequest, steps: number) => void;
  onKeep: (request: InboxRequest) => void;
  onReveal: (request: InboxRequest) => void;
  onFocus: (id: string | undefined) => void;
  onCopy: (request: InboxRequest) => void;
}) {
  const [reply, setReply] = useState('');
  const entries = requestEntries(request, log),
    files = requestFiles(request, log),
    steps = requestUndoSteps(request, log, head),
    kept = entries.length > 0 && entries.every((e) => reviewed.has(e.id)),
    question = [...request.thread].reverse().find((m) => m.kind === 'question'),
    replies = request.thread.filter((m) => m.kind === 'question' || m.kind === 'reply'),
    who = prettyClient(request.claimedBy?.client) ?? request.claimedBy?.client,
    open = request.status === 'pending' || request.status === 'claimed' || request.status === 'question',
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
          {request.status === 'claimed' && <span className="cf-typing" aria-hidden><i /><i /><i /></span>}
          {statusLabel[request.status]}
        </span>
        {who && request.status !== 'pending' && <span className="inbox-who">{who}</span>}
        <time title={new Date(at).toLocaleString()}>{formatAgo(now - at)}</time>
      </header>
      <p className="inbox-text">“{request.text}”</p>
      <p className="inbox-ctx">
        {sel.length ? sel.slice(0, 3).map((n) => n.name || n.id.split('/').at(-1)).join('、') + (sel.length > 3 ? ` 等 ${sel.length} 个` : '') : '整个画面'}
        {' · '}第 {request.context.frame} 帧
        {request.context.range && ` · ${request.context.range.start}–${request.context.range.end}`}
        {sel[0]?.source?.line && (
          <code title="源码位置">
            {sel[0].source.file.split('/').at(-1)}:{sel[0].source.line}
          </code>
        )}
      </p>
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
        <form
          className="inbox-reply"
          onSubmit={(e) => {
            e.preventDefault();
            if (!reply.trim()) return;
            onReply(request.id, reply.trim());
            setReply('');
          }}
        >
          <input value={reply} placeholder="回答 AI 的问题…" aria-label="回复" onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <button className="primary" disabled={busy || !reply.trim()}>回复</button>
        </form>
      )}
      {request.status === 'done' && request.summary && <p className="inbox-summary">{request.summary}</p>}
      {(entries.length > 0 || files.length > 0) && (
        <div className="inbox-changes">
          <span>
            <Icon name="check" size={12} /> {entries.length ? `${entries.length} 次改动` : '已报告的文件'}
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
              title={steps ? `撤销这条指令的全部改动（共 ${steps} 步，共享撤销历史）` : '之后还有改动：需先撤销更新的改动'}
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
