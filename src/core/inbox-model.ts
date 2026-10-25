/**
 * Canvas request inbox (画布指令): the person selects something on the canvas, types what
 * they want, and Vmotion packages the intent plus context as a request for whatever external
 * AI is connected. Vmotion itself never calls a model. Pure types and text helpers, shared by
 * the service (Node) and the Studio (browser).
 */
export const INBOX_DIR = '.vmotion/requests';
export const inboxStatuses = ['pending', 'claimed', 'question', 'done', 'cancelled'] as const;
export type InboxStatus = (typeof inboxStatuses)[number];
export const openStatuses: readonly InboxStatus[] = ['pending', 'claimed', 'question'];

export interface InboxSource {
  /** Project-relative source file (e.g. components/title.tsx). */
  file: string;
  /** 1-based line of the element's opening tag, when resolvable. */
  line?: number;
  endLine?: number;
  column?: number;
  /** Element id literal searched in the source (the last segment of the local id). */
  element?: string;
  /** Why no line could be given (not found, ambiguous, imported file…). */
  note?: string;
}
export interface InboxNodeContext {
  id: string;
  name?: string;
  type: string;
  /** Root scene node that owns a generated JSX node (component layer). */
  owner?: { nodeId: string; name?: string; component?: string };
  /** Id inside the owning component (override key), when generated. */
  localId?: string;
  source?: InboxSource;
  /** Current key properties (evaluated at the playhead when the Studio supplied them). */
  props: Record<string, unknown>;
  bounds?: { x: number; y: number; width: number; height: number };
}
export interface InboxContext {
  workspace?: string;
  sceneId?: string;
  sceneName?: string;
  sequenceId?: string;
  /** Composition path the person had entered (group/component focus). */
  path?: string[];
  frame: number;
  seconds: number;
  fps: number;
  range?: { start: number; end: number };
  revision: string;
  project: { name: string; width: number; height: number };
  selection: InboxNodeContext[];
  /** PNG snapshot beside the request JSON (file name relative to the requests folder). */
  snapshot?: string;
}
export interface InboxMessage {
  at: string;
  from: 'human' | 'ai';
  kind: 'request' | 'question' | 'reply' | 'note' | 'done' | 'cancel' | 'requeue';
  text: string;
}
export interface InboxChange {
  id: string;
  at: number;
  kind: string;
  action: string;
  revision: string;
  previous: string;
  files: string[];
  targets: Array<{ kind: string; change: string; id?: string; sceneId?: string; name?: string }>;
}
export interface InboxRequest {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  status: InboxStatus;
  text: string;
  context: InboxContext;
  claimedBy?: { client: string; at: string };
  /** Human answered a question the AI has not read yet (inbox_wait returns it again). */
  unreadReply?: boolean;
  thread: InboxMessage[];
  summary?: string;
  changedFiles?: string[];
  /** Change journal entries recorded while the request was claimed (filled at done). */
  changes?: InboxChange[];
}

export const statusLabel: Record<InboxStatus, string> = {
  pending: '等待 AI',
  claimed: 'AI 处理中',
  question: 'AI 有疑问',
  done: '已完成',
  cancelled: '已取消',
};

const fmt = (v: unknown) =>
  typeof v === 'number' ? String(Math.round(v * 100) / 100) : typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);

/**
 * Self-contained prompt for "复制为提示词": everything an AI without MCP needs to act on the
 * request by editing project files (paths, lines, ids, props, frame), plus how to report back.
 */
export function inboxPrompt(request: InboxRequest, root?: string): string {
  const c = request.context,
    lines: string[] = [];
  lines.push(`Vmotion 画布指令 ${request.id}`);
  lines.push('');
  lines.push(`请求：${request.text}`);
  lines.push('');
  lines.push('## 上下文');
  if (root) lines.push(`- 工程目录：${root}`);
  lines.push(`- 工程：${c.project.name}（${c.project.width}×${c.project.height}，${c.fps} fps，revision ${c.revision.slice(0, 12)}）`);
  if (c.sceneId) lines.push(`- 场景：${c.sceneName ? `${c.sceneName} ` : ''}(${c.sceneId}) → scenes/${c.sceneId}.json`);
  if (c.sequenceId) lines.push(`- 序列：${c.sequenceId}`);
  if (c.path?.length) lines.push(`- 已进入：${c.path.join(' / ')}`);
  lines.push(`- 播放头：第 ${c.frame} 帧（${Math.round(c.seconds * 100) / 100} s）`);
  if (c.range) lines.push(`- 时间范围：第 ${c.range.start}–${c.range.end} 帧`);
  if (c.snapshot) lines.push(`- 当前帧截图：${INBOX_DIR}/${c.snapshot}`);
  if (c.selection.length) {
    lines.push('');
    lines.push(`## 选中对象（${c.selection.length}）`);
    for (const n of c.selection) {
      lines.push(`- ${n.name ? `${n.name} ` : ''}\`${n.id}\`（${n.type}）`);
      if (n.owner)
        lines.push(`  - 属于组件图层 \`${n.owner.nodeId}\`${n.owner.component ? ` · ${n.owner.component}` : ''}${n.localId ? ` · 组件内 id \`${n.localId}\`` : ''}`);
      if (n.source)
        lines.push(
          `  - 源码：${n.source.file}${n.source.line ? `:${n.source.line}${n.source.endLine && n.source.endLine !== n.source.line ? `-${n.source.endLine}` : ''}` : ''}${n.source.note ? `（${n.source.note}）` : ''}`,
        );
      const props = Object.entries(n.props);
      if (props.length) lines.push(`  - 当前属性：${props.map(([k, v]) => `${k}=${fmt(v)}`).join(', ')}`);
    }
  } else lines.push('- 没有选中对象（针对整个画面）');
  const replies = request.thread.filter((m) => m.kind === 'question' || m.kind === 'reply');
  if (replies.length) {
    lines.push('');
    lines.push('## 问答');
    for (const m of replies) lines.push(`- ${m.from === 'ai' ? 'AI 问' : '回答'}：${m.text}`);
  }
  lines.push('');
  lines.push('## 做法');
  lines.push('- 直接修改上面列出的工程文件（.tsx 组件 / scenes/*.json），保持已有 id 不变。');
  lines.push('- 用 `vmotion validate --project .` 校验，用 `vmotion frame --project . --frame <n> -o f.png` 看结果。');
  lines.push(`- 完成后可运行 \`vmotion inbox done ${request.id} --summary "<做了什么>"\`，Vmotion 会把这段时间的文件改动关联到这条指令。`);
  return lines.join('\n');
}

/** Short card title: the request text clipped to one line. */
export const inboxTitle = (request: Pick<InboxRequest, 'text'>, max = 80) => {
  const one = request.text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
};
