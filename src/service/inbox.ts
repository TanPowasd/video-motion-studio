import { EventEmitter } from 'node:events';
import { mkdir, open, readdir, readFile, rm, stat, unlink } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { VmotionError, type Node, type Snapshot } from '../core/model.js';
import { locateJsxElement } from '../core/jsx-writeback.js';
import {
  formatInboxAnswers,
  INBOX_DIR,
  inboxStatuses,
  openStatuses,
  type InboxChange,
  type InboxContext,
  type InboxMessage,
  type InboxNodeContext,
  type InboxQuestionField,
  type InboxReplyAnswers,
  type InboxRequest,
  type InboxStatus,
} from '../core/inbox-model.js';
import { atomicWrite, safePath } from '../platform/project-files.js';
import type { ChangeEntry } from './change-journal.js';

export { INBOX_DIR };
export type { InboxRequest, InboxStatus };

/** Longest a single inbox_wait may block. The CLI/MCP bridge to an open Studio times out at 30 s. */
export const INBOX_WAIT_MAX_MS = 25_000;
const MAX_TEXT = 4000,
  MAX_SELECTION = 50,
  LOCK_STALE_MS = 10_000;

// ── Requests from the Studio ─────────────────────────────────────────────────────────────
const selectionItem = z
  .object({
    id: z.string().min(1).max(400),
    name: z.string().max(200).optional(),
    type: z.string().max(40).optional(),
    /** Evaluated props at the playhead, as the Studio sees them (generated nodes have no scene entry). */
    props: z.record(z.unknown()).optional(),
    bounds: z
      .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
      .optional(),
    /** Interaction layer path (names the owning component for deep-selected generated nodes). */
    layerPath: z.array(z.string().max(400)).max(32).optional(),
  })
  .strict();
export const inboxCreateSchema = z
  .object({
    text: z.string().trim().min(1).max(MAX_TEXT),
    sceneId: z.string().max(200).optional(),
    sequenceId: z.string().max(200).optional(),
    workspace: z.string().max(40).optional(),
    path: z.array(z.string().max(400)).max(32).optional(),
    frame: z.number().int().nonnegative().default(0),
    range: z
      .object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
      .refine((r) => r.end >= r.start, 'range.end must be ≥ range.start')
      .optional(),
    selection: z.array(selectionItem).max(MAX_SELECTION).default([]),
    snapshot: z.boolean().default(true),
  })
  .strict();
export type InboxCreateInput = z.infer<typeof inboxCreateSchema>;

const KEY_PROPS = [
  'x',
  'y',
  'width',
  'height',
  'rotation',
  'scale',
  'scaleX',
  'scaleY',
  'opacity',
  'fill',
  'stroke',
  'strokeWidth',
  'radius',
  'text',
  'fontSize',
  'fontWeight',
  'fontFamily',
  'align',
  'start',
  'end',
  'visible',
  'blend',
  'blur',
  'src',
  'component',
] as const;
/** Small, readable subset of a node's props (long strings and structures clipped). */
export function keyProps(node: Partial<Node> | Record<string, unknown> | undefined) {
  const out: Record<string, unknown> = {};
  if (!node) return out;
  for (const key of KEY_PROPS) {
    const value = (node as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'number') out[key] = Math.round(value * 1000) / 1000;
    else if (typeof value === 'string') out[key] = value.length > 200 ? value.slice(0, 199) + '…' : value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === 'number')) out[key] = value;
  }
  const params = (node as { params?: unknown }).params;
  if (params && typeof params === 'object') {
    const json = JSON.stringify(params);
    out.params = json.length > 400 ? json.slice(0, 399) + '…' : params;
  }
  if (Array.isArray((node as { animations?: unknown[] }).animations))
    out.animated = ((node as { animations: Array<{ property?: string }> }).animations)
      .map((a) => a.property)
      .filter(Boolean)
      .slice(0, 12);
  return out;
}

/**
 * Context pack for one request: scene/sequence/frame, every selected node with its owning
 * component and the .tsx line of its element where resolvable, key props and the revision.
 * Same resolution as 写回源码 (jsx-writeback-scope): generated ids are owner-prefixed.
 */
export function buildInboxContext(snapshot: Snapshot, input: InboxCreateInput): InboxContext {
  const project = snapshot.project,
    scene = input.sceneId ? snapshot.scenes.find((s) => s.id === input.sceneId) : undefined,
    fps = project.fps ? Math.round((project.fps.num / project.fps.den) * 1000) / 1000 : 30;
  const selection: InboxNodeContext[] = input.selection.map((item) => {
    const direct = scene?.nodes.find((n) => n.id === item.id);
    const ctx: InboxNodeContext = {
      id: item.id,
      type: direct?.type ?? item.type ?? 'unknown',
      props: { ...keyProps(direct), ...keyProps(item.props) },
      ...(direct?.name || item.name ? { name: direct?.name ?? item.name } : {}),
      ...(item.bounds ? { bounds: roundBounds(item.bounds) } : {}),
    };
    if (direct) {
      if (direct.type === 'component' && direct.component)
        ctx.source = { file: direct.component, note: '组件图层本身（整个组件）' };
      else if (scene) ctx.source = { file: `scenes/${scene.id}.json`, note: '场景节点' };
      return ctx;
    }
    // Generated node: find the owning component layer at the scene root.
    const ownerId = input.path?.[0] ?? item.layerPath?.[0] ?? item.id.split('/')[0],
      owner = scene?.nodes.find((n) => n.id === ownerId);
    if (!owner) return ctx;
    const localId = item.id.startsWith(owner.id + '/') ? item.id.slice(owner.id.length + 1) : item.id;
    ctx.owner = { nodeId: owner.id, ...(owner.name ? { name: owner.name } : {}), ...(owner.component ? { component: owner.component } : {}) };
    ctx.localId = localId;
    const override = owner.overrides?.[localId];
    if (override) ctx.props = { ...ctx.props, override: keyProps(override as Record<string, unknown>) };
    const file = owner.component;
    if (!file) return ctx;
    const text = snapshot.files[file];
    if (text === undefined || !file.endsWith('.tsx')) {
      ctx.source = { file, note: file.endsWith('.tsx') ? '源文件未加载' : '非 .tsx 组件，无法定位行号' };
      return ctx;
    }
    try {
      const at = locateJsxElement(file, text, localId);
      ctx.source = at
        ? {
            file,
            line: at.line,
            endLine: at.endLine,
            column: at.column,
            element: at.element,
            ...(at.candidates > 1 ? { note: `${at.candidates} 个元素使用该 id，给出第一个` } : {}),
          }
        : { file, element: localId.split('/').at(-1), note: '入口文件中没有该字面量 id（可能在导入的文件里或由表达式生成）' };
    } catch {
      ctx.source = { file, note: '无法解析源文件' };
    }
    return ctx;
  });
  const frame = input.frame;
  return {
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(scene ? { sceneId: scene.id, sceneName: scene.name } : input.sceneId ? { sceneId: input.sceneId } : {}),
    ...(input.sequenceId ? { sequenceId: input.sequenceId } : {}),
    ...(input.path?.length ? { path: input.path } : {}),
    frame,
    seconds: Math.round((frame / fps) * 1000) / 1000,
    fps,
    ...(input.range ? { range: input.range } : {}),
    revision: snapshot.revision,
    project: { name: project.name, width: project.width, height: project.height },
    selection,
  };
}
const roundBounds = (b: { x: number; y: number; width: number; height: number }) => ({
  x: Math.round(b.x * 10) / 10,
  y: Math.round(b.y * 10) / 10,
  width: Math.round(b.width * 10) / 10,
  height: Math.round(b.height * 10) / 10,
});

// ── Agent-facing tool schemas ────────────────────────────────────────────────────────────
const requestId = z.string().regex(/^req-[0-9a-z-]{8,60}$/, 'Request ids look like req-20261026-012300-ab12');
export const inboxListSchema = z
  .object({
    status: z.union([z.enum(inboxStatuses), z.literal('open'), z.literal('all')]).default('open'),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export const inboxGetSchema = z.object({ id: requestId }).strict();
export const inboxWaitSchema = z
  .object({
    timeoutMs: z.number().int().min(0).max(INBOX_WAIT_MAX_MS).default(20_000),
  })
  .strict();
export const inboxClaimSchema = z.object({ id: requestId }).strict();
export const inboxDoneSchema = z
  .object({
    id: requestId,
    summary: z.string().trim().min(1).max(2000),
    changedFiles: z.array(z.string().max(400)).max(100).optional(),
  })
  .strict();
export const inboxQuestionFieldSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(200),
    kind: z.enum(['text', 'number', 'boolean', 'select', 'multiselect']).default('text'),
    options: z
      .array(
        z.union([
          z.string().trim().min(1).max(200),
          z
            .object({
              value: z.string().trim().min(1).max(200),
              label: z.string().trim().min(1).max(200).optional(),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(20)
      .optional(),
    placeholder: z.string().max(200).optional(),
    required: z.boolean().optional(),
    defaultValue: z
      .union([
        z.string().max(500),
        z.number().finite(),
        z.boolean(),
        z.array(z.string().max(200)).max(20),
      ])
      .optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .strict();
export const inboxAskSchema = z
  .object({
    id: requestId,
    question: z.string().trim().min(1).max(2000),
    /** Quick single-choice buttons rendered on the Vmotion Studio card (never in external agent UI). */
    options: z.array(z.string().trim().min(1).max(200)).min(1).max(12).optional(),
    /** Structured elicitation-style form fields rendered on the Vmotion Studio card. */
    fields: z.array(inboxQuestionFieldSchema).min(1).max(12).optional(),
    /** Block up to this long for the human's reply (0 = return immediately). */
    waitMs: z.number().int().min(0).max(INBOX_WAIT_MAX_MS).default(0),
  })
  .strict();
export const inboxReplySchema = z
  .object({
    id: z.string().min(1),
    text: z.string().max(MAX_TEXT).optional(),
    answers: z
      .record(
        z.string().min(1).max(64),
        z.union([
          z.string().max(2000),
          z.number().finite(),
          z.boolean(),
          z.array(z.string().max(200)).max(20),
        ]),
      )
      .optional(),
    skipped: z.boolean().optional(),
  })
  .strict();
export type InboxReplyInput = z.infer<typeof inboxReplySchema>;

const fileSchema = z
  .object({
    version: z.literal(1),
    id: requestId,
    status: z.enum(inboxStatuses),
    text: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    context: z.record(z.unknown()),
    thread: z.array(z.record(z.unknown())),
  })
  .passthrough();

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export function newRequestId(at = new Date()) {
  return `req-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}-${randomBytes(2).toString('hex')}`;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface InboxStoreOptions {
  /** Live change journal entries (linked by `request`). */
  changes?: () => ChangeEntry[];
  /** Ingest external file edits before closing a request so they link to it. */
  settle?: () => Promise<void>;
}

/**
 * File-backed inbox in `.vmotion/requests/<id>.json` (+ `<id>.png`). Human readable, safe for
 * several processes: every mutation re-reads the file under a lock file, so two agents racing
 * for one request get exactly one claim. Agents may read the folder directly; status changes
 * go through the MCP/CLI tools.
 */
export class InboxStore extends EventEmitter {
  readonly dir: string;
  private cache = new Map<string, InboxRequest>();
  private queue: Promise<unknown> = Promise.resolve();
  private signature = '';
  constructor(
    readonly root: string,
    private options: InboxStoreOptions = {},
  ) {
    super();
    this.dir = safePath(root, INBOX_DIR);
  }
  file(id: string) {
    return path.join(this.dir, `${id}.json`);
  }
  snapshotFile(id: string) {
    return path.join(this.dir, `${id}.png`);
  }
  /** Serialise mutations in this process and across processes (lock file, stale after 10 s). */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const lock = path.join(this.dir, '.lock'),
        deadline = Date.now() + 5000;
      for (;;) {
        try {
          const handle = await open(lock, 'wx');
          await handle.writeFile(String(process.pid));
          await handle.close();
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
          try {
            if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) await unlink(lock).catch(() => {});
          } catch {
            /* lock vanished */
          }
          if (Date.now() > deadline) throw new VmotionError('INBOX_BUSY', 'Inbox is locked by another process; retry');
          await sleep(15);
        }
      }
      try {
        return await fn();
      } finally {
        await unlink(lock).catch(() => {});
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }
  private parse(text: string): InboxRequest | undefined {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(text));
      return parsed.success ? (parsed.data as unknown as InboxRequest) : undefined;
    } catch {
      return undefined;
    }
  }
  /** Re-reads the folder; emits `change` when any request file changed (other processes too). */
  async refresh() {
    let names: string[] = [];
    try {
      names = (await readdir(this.dir)).filter((f) => f.endsWith('.json'));
    } catch {
      names = [];
    }
    const next = new Map<string, InboxRequest>(),
      stamps: string[] = [];
    for (const name of names) {
      try {
        const text = await readFile(path.join(this.dir, name), 'utf8'),
          request = this.parse(text);
        if (request && request.id === name.slice(0, -5)) {
          next.set(request.id, request);
          stamps.push(`${request.id}:${request.updatedAt}:${request.status}`);
        }
      } catch {
        /* removed meanwhile */
      }
    }
    this.cache = next;
    const signature = stamps.sort().join('|');
    if (signature !== this.signature) {
      const first = this.signature === '' && !stamps.length;
      this.signature = signature;
      if (!first) this.emit('change');
    }
    return next;
  }
  /** Synchronous cache warm-up (used once at open so linking works before the first poll). */
  loadSync() {
    try {
      for (const name of readdirSync(this.dir).filter((f) => f.endsWith('.json'))) {
        const request = this.parse(readFileSync(path.join(this.dir, name), 'utf8'));
        if (request) this.cache.set(request.id, request);
      }
    } catch {
      /* no inbox yet */
    }
    return this;
  }
  private async write(request: InboxRequest) {
    request.updatedAt = new Date().toISOString();
    await atomicWrite(this.file(request.id), JSON.stringify(request, null, 2) + '\n');
    this.cache.set(request.id, request);
    this.signature = '';
    await this.refresh();
  }
  private async load(id: string) {
    let text: string;
    try {
      text = await readFile(this.file(id), 'utf8');
    } catch {
      throw new VmotionError('INBOX_NOT_FOUND', `No canvas request ${id}`, { id });
    }
    const request = this.parse(text);
    if (!request) throw new VmotionError('INBOX_INVALID', `Request file ${id}.json is not valid`, { id });
    return request;
  }
  private stateError(request: InboxRequest, action: string, allowed: InboxStatus[]) {
    return new VmotionError(
      'INBOX_STATE',
      `Request ${request.id} is ${request.status}; ${action} needs ${allowed.join(' or ')}`,
      { id: request.id, status: request.status, claimedBy: request.claimedBy },
    );
  }
  /** Most recently claimed open request: external changes recorded now belong to it. */
  activeClaim(): string | undefined {
    let best: InboxRequest | undefined;
    for (const r of this.cache.values())
      if ((r.status === 'claimed' || r.status === 'question') && r.claimedBy)
        if (!best || r.claimedBy.at > best.claimedBy!.at) best = r;
    return best?.id;
  }
  /** Newest first, at most `limit` (Studio panel + inbox_list). */
  all(limit = 50) {
    return [...this.cache.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  async create(context: InboxContext, text: string, snapshotPng?: Buffer) {
    return this.locked(async () => {
      const now = new Date(),
        id = newRequestId(now);
      if (snapshotPng) {
        await atomicWrite(this.snapshotFile(id), snapshotPng);
        context = { ...context, snapshot: `${id}.png` };
      }
      const request: InboxRequest = {
        version: 1,
        id,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        status: 'pending',
        text,
        context,
        thread: [{ at: now.toISOString(), from: 'human', kind: 'request', text }],
      };
      await this.write(request);
      return request;
    });
  }
  async get(id: string, options: { markRead?: boolean } = {}) {
    if (!options.markRead) return this.load(id);
    return this.locked(async () => {
      const request = await this.load(id);
      if (request.unreadReply) {
        delete request.unreadReply;
        await this.write(request);
      }
      return request;
    });
  }
  async list(raw: unknown = {}) {
    const request = inboxListSchema.parse(raw);
    await this.refresh();
    const items = this.all(200).filter((r) =>
      request.status === 'all' ? true : request.status === 'open' ? openStatuses.includes(r.status) : r.status === request.status,
    );
    return { total: items.length, requests: items.slice(0, request.limit) };
  }
  private claimNow(request: InboxRequest, client: string) {
    const at = new Date().toISOString();
    request.status = 'claimed';
    request.claimedBy = { client, at };
    request.thread.push({ at, from: 'ai', kind: 'note', text: `${client} 开始处理` });
  }
  async claim(id: string, client: string) {
    return this.locked(async () => {
      const request = await this.load(id);
      if (request.status !== 'pending') throw this.stateError(request, 'claim', ['pending']);
      this.claimNow(request, client);
      await this.write(request);
      return request;
    });
  }
  /**
   * Long-poll: returns the oldest answered question of this client (reason "reply") or claims
   * the oldest pending request (reason "new"). Resolves with request null after timeoutMs.
   */
  async wait(raw: unknown, client: string, signal?: AbortSignal) {
    const { timeoutMs } = inboxWaitSchema.parse(raw ?? {}),
      deadline = Date.now() + timeoutMs;
    let wake: (() => void) | undefined;
    const onChange = () => wake?.();
    this.on('change', onChange);
    try {
      for (;;) {
        const found = await this.locked(async () => {
          await this.refresh();
          const sorted = [...this.cache.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
            replied = sorted.find((r) => r.unreadReply && r.status === 'claimed' && (!r.claimedBy || r.claimedBy.client === client)) ??
              sorted.find((r) => r.unreadReply && r.status === 'claimed');
          if (replied) {
            delete replied.unreadReply;
            await this.write(replied);
            return { request: replied, reason: 'reply' as const };
          }
          const pending = sorted.find((r) => r.status === 'pending');
          if (!pending) return undefined;
          this.claimNow(pending, client);
          await this.write(pending);
          return { request: pending, reason: 'new' as const };
        });
        if (found) return found;
        const left = deadline - Date.now();
        if (left <= 0 || signal?.aborted) return { request: null, reason: 'timeout' as const, waitedMs: timeoutMs };
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, Math.min(left, 400));
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        wake = undefined;
      }
    } finally {
      this.off('change', onChange);
    }
  }
  private linked(id: string): InboxChange[] {
    return (this.options.changes?.() ?? [])
      .filter((e) => e.request === id)
      .map((e) => ({
        id: e.id,
        at: e.at,
        kind: e.kind,
        action: e.action,
        revision: e.revision,
        previous: e.previous,
        files: e.files.slice(0, 40),
        targets: e.targets.slice(0, 20).map((t) => ({
          kind: t.kind,
          change: t.change,
          ...(t.id ? { id: t.id } : {}),
          ...(t.sceneId ? { sceneId: t.sceneId } : {}),
          ...(t.name ? { name: t.name } : {}),
        })),
      }));
  }
  async done(raw: unknown, client: string) {
    const input = inboxDoneSchema.parse(raw);
    // Edits written just before done may still sit in the watcher debounce: ingest them first.
    await this.options.settle?.().catch(() => {});
    return this.locked(async () => {
      const request = await this.load(input.id);
      if (request.status !== 'claimed' && request.status !== 'question')
        throw this.stateError(request, 'done', ['claimed', 'question']);
      const at = new Date().toISOString();
      request.status = 'done';
      request.summary = input.summary;
      if (input.changedFiles?.length) request.changedFiles = input.changedFiles;
      request.changes = this.linked(request.id);
      delete request.unreadReply;
      request.thread.push({ at, from: 'ai', kind: 'done', text: input.summary });
      await this.write(request);
      void client;
      return request;
    });
  }
  async ask(raw: unknown, client: string, signal?: AbortSignal) {
    const input = inboxAskSchema.parse(raw);
    const asked = await this.locked(async () => {
      const request = await this.load(input.id);
      if (request.status !== 'claimed' && request.status !== 'question')
        throw this.stateError(request, 'ask', ['claimed']);
      request.status = 'question';
      delete request.unreadReply;
      request.thread.push({
        at: new Date().toISOString(),
        from: 'ai',
        kind: 'question',
        text: input.question,
        ...(input.options?.length ? { options: input.options } : {}),
        ...(input.fields?.length ? { fields: input.fields as InboxQuestionField[] } : {}),
      });
      if (!request.claimedBy) request.claimedBy = { client, at: new Date().toISOString() };
      await this.write(request);
      return request;
    });
    if (!input.waitMs) return { request: asked, answered: false };
    const deadline = Date.now() + input.waitMs;
    let wake: (() => void) | undefined;
    const onChange = () => wake?.();
    this.on('change', onChange);
    signal?.addEventListener('abort', onChange, { once: true });
    try {
      while (Date.now() < deadline && !signal?.aborted) {
        await this.refresh();
        const current = this.cache.get(input.id);
        if (current && current.status !== 'question') {
          if (current.unreadReply) {
            const read = await this.get(input.id, { markRead: true }),
              lastReply = [...read.thread].reverse().find((m) => m.kind === 'reply');
            return {
              request: read,
              answered: true,
              ...(lastReply?.answers ? { answers: lastReply.answers } : {}),
              ...(lastReply?.skipped ? { skipped: true } : {}),
            };
          }
          return { request: current, answered: false };
        }
        const left = deadline - Date.now();
        if (left <= 0 || signal?.aborted) break;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, Math.min(left, 300));
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        wake = undefined;
      }
    } finally {
      this.off('change', onChange);
      signal?.removeEventListener('abort', onChange);
    }
    return { request: this.cache.get(input.id) ?? asked, answered: false };
  }
  /** Human answer to the AI's question: back to claimed with an unread reply flag. */
  async reply(
    id: string,
    text?: string,
    extra: { answers?: InboxReplyAnswers; skipped?: boolean } = {},
  ) {
    return this.locked(async () => {
      const request = await this.load(id);
      if (request.status !== 'question' && request.status !== 'claimed')
        throw this.stateError(request, 'reply', ['question']);
      const lastQuestion = [...request.thread].reverse().find((m) => m.kind === 'question'),
        derived =
          text?.trim() ||
          formatInboxAnswers(extra.answers, lastQuestion?.fields) ||
          (extra.skipped ? '按默认处理' : ''),
        clean = z.string().trim().min(1).max(MAX_TEXT).parse(derived);
      request.thread.push({
        at: new Date().toISOString(),
        from: 'human',
        kind: 'reply',
        text: clean,
        ...(extra.answers && Object.keys(extra.answers).length ? { answers: extra.answers } : {}),
        ...(extra.skipped ? { skipped: true } : {}),
      });
      request.status = 'claimed';
      request.unreadReply = true;
      await this.write(request);
      return request;
    });
  }
  /** Release an AI claim back to pending with a diagnostic note (e.g. sampling push failed). */
  async releaseClaim(id: string, note: string) {
    return this.locked(async () => {
      const request = await this.load(id);
      if (request.status !== 'claimed' && request.status !== 'question') return request;
      request.status = 'pending';
      delete request.claimedBy;
      delete request.unreadReply;
      request.thread.push({
        at: new Date().toISOString(),
        from: 'ai',
        kind: 'note',
        text: note.slice(0, 600),
      });
      await this.write(request);
      return request;
    });
  }
  async cancel(id: string, reason?: string) {
    return this.locked(async () => {
      const request = await this.load(id);
      if (!openStatuses.includes(request.status)) throw this.stateError(request, 'cancel', [...openStatuses]);
      request.status = 'cancelled';
      delete request.unreadReply;
      const message: InboxMessage = { at: new Date().toISOString(), from: 'human', kind: 'cancel', text: reason?.trim() || '已取消' };
      request.thread.push(message);
      request.changes = this.linked(id);
      await this.write(request);
      return request;
    });
  }
  /** Give a stuck claim back to the queue (the AI went away). */
  async requeue(id: string) {
    return this.locked(async () => {
      const request = await this.load(id);
      if (request.status !== 'claimed' && request.status !== 'question')
        throw this.stateError(request, 'requeue', ['claimed', 'question']);
      request.status = 'pending';
      delete request.claimedBy;
      delete request.unreadReply;
      request.thread.push({ at: new Date().toISOString(), from: 'human', kind: 'requeue', text: '退回待处理' });
      await this.write(request);
      return request;
    });
  }
  /** Removes finished requests (and their snapshots) older than `keepMs`. */
  async prune(keepMs = 30 * 24 * 3600_000) {
    await this.refresh();
    const cutoff = Date.now() - keepMs;
    for (const r of this.cache.values())
      if ((r.status === 'done' || r.status === 'cancelled') && Date.parse(r.updatedAt) < cutoff) {
        await rm(this.file(r.id), { force: true });
        await rm(this.snapshotFile(r.id), { force: true });
      }
    await this.refresh();
  }
}

/** Tool result shape: the request plus where its files are, and the next step for an agent. */
export function agentView(store: InboxStore, request: InboxRequest | null, extra: Record<string, unknown> = {}) {
  if (!request) return { request: null, ...extra };
  const next =
    request.status === 'claimed' || request.status === 'question'
      ? 'Edit the project files named in context.selection[].source (files first), check with vmotion validate / frame, then inbox_done {id, summary}. Ask with inbox_ask if the request is unclear.'
      : request.status === 'pending'
        ? 'inbox_claim {id} (or inbox_wait) before editing'
        : undefined;
  return {
    request,
    files: {
      json: path.relative(store.root, store.file(request.id)).split(path.sep).join('/'),
      ...(request.context.snapshot ? { snapshot: `${INBOX_DIR}/${request.context.snapshot}` } : {}),
    },
    ...(next ? { next } : {}),
    ...extra,
  };
}
