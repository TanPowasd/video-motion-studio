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
/** MCP sampling capability negotiated with an external AI client ('none' = inbox_wait pull). */
export type SamplingMode = 'none' | 'basic' | 'tools';

export type InboxFieldKind = 'text' | 'number' | 'boolean' | 'select' | 'multiselect';
export interface InboxQuestionOption {
  value: string;
  label?: string;
}
export interface InboxQuestionField {
  id: string;
  label: string;
  kind: InboxFieldKind;
  options?: Array<string | InboxQuestionOption>;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string | number | boolean | string[];
  min?: number;
  max?: number;
}
export type InboxReplyValue = string | number | boolean | string[];
export type InboxReplyAnswers = Record<string, InboxReplyValue>;

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
export interface InboxMaskStrokePoint {
  x: number;
  y: number;
}
export interface InboxMaskStroke {
  mode?: 'brush' | 'erase';
  radius: number;
  points: InboxMaskStrokePoint[];
}
export interface InboxMaskHitNode extends InboxNodeContext {
  /** Fraction of the node box or painted mask region covered by their intersection (0..1). */
  overlapRatio: number;
}
export interface InboxMask {
  /** Mask PNG file relative to `.vmotion/requests/` (e.g. `req-...-mask.png`). */
  file?: string;
  /** Bounding box of painted mask pixels in project canvas coordinates. */
  bounds: { x: number; y: number; width: number; height: number };
  /** Normalized bounding box in 0..1 coordinates relative to project width/height. */
  normalizedBounds: { x: number; y: number; width: number; height: number };
  /** Fraction of the total canvas area covered by the painted mask (0..1). */
  coverageRatio: number;
  /** Number of brush/erase strokes that produced the mask. */
  strokeCount: number;
  /** Scene / component nodes geometrically hit by the painted mask, sorted by overlapRatio desc. */
  hitNodes: InboxMaskHitNode[];
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
  /** Painted brush/mask region on the canvas (bounds, mask PNG, and hit-tested nodes). */
  mask?: InboxMask;
}
export interface InboxMessage {
  at: string;
  from: 'human' | 'ai';
  kind: 'request' | 'question' | 'reply' | 'note' | 'done' | 'cancel' | 'requeue';
  text: string;
  /** Quick single-click choices shown on the Vmotion Studio card (never in external agent UI). */
  options?: string[];
  /** Structured elicitation-style form fields shown on the Vmotion Studio card. */
  fields?: InboxQuestionField[];
  /** Structured key-value answers submitted from the Studio card. */
  answers?: InboxReplyAnswers;
  /** True when the person explicitly skipped the AI's question ("按默认处理"). */
  skipped?: boolean;
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
  if (c.mask) {
    lines.push(
      `- 涂抹遮罩区域：x=${c.mask.bounds.x}, y=${c.mask.bounds.y}, width=${c.mask.bounds.width}, height=${c.mask.bounds.height}（占画面 ${Math.round(c.mask.coverageRatio * 1000) / 10}%）`,
    );
    if (c.mask.file) lines.push(`- 遮罩图片：${INBOX_DIR}/${c.mask.file}`);
  }
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
  if (c.mask?.hitNodes.length) {
    lines.push('');
    lines.push(`## 遮罩命中对象（${c.mask.hitNodes.length}）`);
    for (const n of c.mask.hitNodes) {
      lines.push(
        `- ${n.name ? `${n.name} ` : ''}\`${n.id}\`（${n.type}，重叠度 ${Math.round(n.overlapRatio * 100)}%）`,
      );
      if (n.owner)
        lines.push(
          `  - 属于组件图层 \`${n.owner.nodeId}\`${n.owner.component ? ` · ${n.owner.component}` : ''}${n.localId ? ` · 组件内 id \`${n.localId}\`` : ''}`,
        );
      if (n.source)
        lines.push(
          `  - 源码：${n.source.file}${n.source.line ? `:${n.source.line}${n.source.endLine && n.source.endLine !== n.source.line ? `-${n.source.endLine}` : ''}` : ''}${n.source.note ? `（${n.source.note}）` : ''}`,
        );
      const props = Object.entries(n.props);
      if (props.length) lines.push(`  - 当前属性：${props.map(([k, v]) => `${k}=${fmt(v)}`).join(', ')}`);
    }
  }
  const replies = request.thread.filter((m) => m.kind === 'question' || m.kind === 'reply');
  if (replies.length) {
    lines.push('');
    lines.push('## 问答');
    for (const m of replies) {
      const suffix =
        m.kind === 'question' && m.options?.length
          ? `（候选项：${m.options.join(' / ')}）`
          : m.kind === 'reply' && m.answers && Object.keys(m.answers).length
            ? `（结构化答案：${JSON.stringify(m.answers)}）`
            : '';
      lines.push(`- ${m.from === 'ai' ? 'AI 问' : '回答'}：${m.text}${suffix}`);
    }
  }
  lines.push('');
  lines.push('## 做法');
  lines.push('- 直接修改上面列出的工程文件（.tsx 组件 / scenes/*.json），保持已有 id 不变。');
  lines.push('- 用 `vmotion validate --project .` 校验，用 `vmotion frame --project . --frame <n> -o f.png` 看结果。');
  lines.push(`- 完成后可运行 \`vmotion inbox done ${request.id} --summary "<做了什么>"\`，Vmotion 会把这段时间的文件改动关联到这条指令。`);
  return lines.join('\n');
}

/** Readable one-line summary for structured Studio form replies. */
export function formatInboxAnswers(
  answers: InboxReplyAnswers | undefined,
  fields?: readonly InboxQuestionField[],
): string {
  if (!answers) return '';
  const labels = new Map((fields ?? []).map((f) => [f.id, f.label] as const));
  return Object.entries(answers)
    .map(([k, v]) => {
      const label = labels.get(k) ?? k;
      const shown = Array.isArray(v) ? v.join('、') : typeof v === 'boolean' ? (v ? '是' : '否') : String(v);
      return `${label}：${shown}`;
    })
    .join('；');
}

/** Short card title: the request text clipped to one line. */
export const inboxTitle = (request: Pick<InboxRequest, 'text'>, max = 80) => {
  const one = request.text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
};

const distToSegmentSq = (
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number => {
  const dx = x1 - x0,
    dy = y1 - y0,
    lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-9) {
    const ex = px - x0,
      ey = py - y0;
    return ex * ex + ey * ey;
  }
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / lenSq)),
    cx = x0 + t * dx,
    cy = y0 + t * dy,
    ex = px - cx,
    ey = py - cy;
  return ex * ex + ey * ey;
};

export interface MaskGeometryCandidate {
  id: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface ComputedMaskGeometry {
  bounds: { x: number; y: number; width: number; height: number };
  normalizedBounds: { x: number; y: number; width: number; height: number };
  coverageRatio: number;
  strokeCount: number;
  hits: Array<{ id: string; overlapRatio: number }>;
}

/**
 * Deterministic 2D occupancy grid evaluation for brush/erase strokes on the project canvas.
 * Shared by the Studio overlay (for instant hit-node preview) and the Node service.
 */
export function computeMaskGeometry(
  strokes: readonly InboxMaskStroke[],
  project: { width: number; height: number },
  candidates: readonly MaskGeometryCandidate[] = [],
): ComputedMaskGeometry | undefined {
  const W = Math.max(1, project.width),
    H = Math.max(1, project.height);
  if (!strokes.length) return undefined;
  const maxSide = 160,
    aspect = W / H,
    cols = aspect >= 1 ? maxSide : Math.max(24, Math.round(maxSide * aspect)),
    rows = aspect >= 1 ? Math.max(24, Math.round(maxSide / aspect)) : maxSide,
    cellW = W / cols,
    cellH = H / rows,
    grid = new Uint8Array(cols * rows);

  for (const stroke of strokes) {
    const pts = stroke.points;
    if (!pts.length) continue;
    const r = Math.max(1, stroke.radius),
      rSq = r * r,
      val = stroke.mode === 'erase' ? 0 : 1,
      segCount = Math.max(1, pts.length - 1);
    for (let i = 0; i < segCount; i++) {
      const p0 = pts[i],
        p1 = pts[Math.min(pts.length - 1, i + 1)],
        minX = Math.max(0, Math.floor((Math.min(p0.x, p1.x) - r) / cellW)),
        maxX = Math.min(cols - 1, Math.ceil((Math.max(p0.x, p1.x) + r) / cellW)),
        minY = Math.max(0, Math.floor((Math.min(p0.y, p1.y) - r) / cellH)),
        maxY = Math.min(rows - 1, Math.ceil((Math.max(p0.y, p1.y) + r) / cellH));
      for (let gy = minY; gy <= maxY; gy++) {
        const cy = (gy + 0.5) * cellH,
          rowOff = gy * cols;
        for (let gx = minX; gx <= maxX; gx++) {
          const cx = (gx + 0.5) * cellW;
          if (distToSegmentSq(cx, cy, p0.x, p0.y, p1.x, p1.y) <= rSq) {
            grid[rowOff + gx] = val;
          }
        }
      }
    }
  }

  let active = 0,
    minGx = cols,
    maxGx = -1,
    minGy = rows,
    maxGy = -1;
  for (let gy = 0; gy < rows; gy++) {
    const rowOff = gy * cols;
    for (let gx = 0; gx < cols; gx++) {
      if (grid[rowOff + gx]) {
        active++;
        if (gx < minGx) minGx = gx;
        if (gx > maxGx) maxGx = gx;
        if (gy < minGy) minGy = gy;
        if (gy > maxGy) maxGy = gy;
      }
    }
  }
  if (active === 0) return undefined;

  const hasErase = strokes.some((s) => s.mode === 'erase');
  let bx0 = minGx * cellW,
    by0 = minGy * cellH,
    bx1 = (maxGx + 1) * cellW,
    by1 = (maxGy + 1) * cellH;
  if (!hasErase) {
    let ax0 = Infinity,
      ay0 = Infinity,
      ax1 = -Infinity,
      ay1 = -Infinity;
    for (const s of strokes) {
      if (s.mode === 'erase') continue;
      const r = Math.max(1, s.radius);
      for (const p of s.points) {
        if (p.x - r < ax0) ax0 = p.x - r;
        if (p.y - r < ay0) ay0 = p.y - r;
        if (p.x + r > ax1) ax1 = p.x + r;
        if (p.y + r > ay1) ay1 = p.y + r;
      }
    }
    if (Number.isFinite(ax0)) {
      bx0 = Math.max(0, Math.min(W, ax0));
      by0 = Math.max(0, Math.min(H, ay0));
      bx1 = Math.max(bx0, Math.min(W, ax1));
      by1 = Math.max(by0, Math.min(H, ay1));
    }
  }

  const r10 = (n: number) => Math.round(n * 10) / 10,
    r10000 = (n: number) => Math.round(n * 10000) / 10000,
    bounds = {
      x: r10(bx0),
      y: r10(by0),
      width: Math.max(0.1, r10(bx1 - bx0)),
      height: Math.max(0.1, r10(by1 - by0)),
    },
    normalizedBounds = {
      x: r10000(bounds.x / W),
      y: r10000(bounds.y / H),
      width: r10000(bounds.width / W),
      height: r10000(bounds.height / H),
    },
    coverageRatio = r10000(active / (cols * rows));

  const hits: Array<{ id: string; overlapRatio: number }> = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!c.bounds || seen.has(c.id)) continue;
    seen.add(c.id);
    const nb = c.bounds;
    if (nb.width <= 0 || nb.height <= 0) continue;
    const cMinX = Math.max(0, Math.floor(nb.x / cellW)),
      cMaxX = Math.min(cols - 1, Math.floor((nb.x + nb.width) / cellW)),
      cMinY = Math.max(0, Math.floor(nb.y / cellH)),
      cMaxY = Math.min(rows - 1, Math.floor((nb.y + nb.height) / cellH));
    if (cMaxX < cMinX || cMaxY < cMinY) continue;
    let hitCells = 0,
      nodeCells = 0;
    for (let gy = cMinY; gy <= cMaxY; gy++) {
      const rowOff = gy * cols;
      for (let gx = cMinX; gx <= cMaxX; gx++) {
        nodeCells++;
        if (grid[rowOff + gx]) hitCells++;
      }
    }
    if (hitCells > 0 && nodeCells > 0) {
      const ratio = Math.min(
        1,
        Math.round(Math.max(hitCells / nodeCells, hitCells / active) * 1000) / 1000,
      );
      hits.push({ id: c.id, overlapRatio: Math.max(0.001, ratio) });
    }
  }
  hits.sort((a, b) => b.overlapRatio - a.overlapRatio);
  return {
    bounds,
    normalizedBounds,
    coverageRatio,
    strokeCount: strokes.length,
    hits,
  };
}
