import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  InboxStore,
  buildInboxContext,
  inboxCreateSchema,
  keyProps,
  newRequestId,
  agentView,
  renderInboxMaskPng,
} from '../src/service/inbox.js';
import {
  computeMaskGeometry,
  inboxPrompt,
  inboxTitle,
  formatInboxAnswers,
  type InboxContext,
} from '../src/core/inbox-model.js';
import { extractJsonCandidate, runSamplingRequest } from '../src/mcp/sampling-runner.js';
import { locateJsxElement } from '../src/core/jsx-writeback.js';
import { ChangeJournal } from '../src/service/change-journal.js';
import type { Snapshot } from '../src/core/model.js';
import { undoStepsFor, type FeedGroup } from '../src/editor/studio-ui/change-feed.js';
import { requestEntries, requestHighlights, requestUndoSteps } from '../src/editor/studio-ui/inbox-ui.js';

const TSX = `/** @jsxImportSource @vmotion/sdk */
import { defineComponent, Stage } from '@vmotion/sdk';
const Chip = () => (
  <group id="chip">
    <rect id="bg" width={10} height={10} />
  </group>
);
export default defineComponent({
  name: 'Card',
  render() {
    return (
      <Stage id="stage">
        <text id="title" x={0} y={300}
          fontSize={84}>
          hi
        </text>
        <group id="row">
          <rect id="bg" width={20} height={4} />
        </group>
        <Chip key="a" />
      </Stage>
    );
  },
});
`;
const snapshot = (): Snapshot =>
  ({
    revision: 'rev-1',
    project: { name: 'Demo', width: 1280, height: 720, fps: { num: 30, den: 1 }, assets: [] },
    scenes: [
      {
        id: 'intro',
        name: 'Intro',
        duration: 90,
        nodes: [
          {
            id: 'card',
            type: 'component',
            name: 'Card',
            component: 'components/card.tsx',
            width: 1280,
            height: 720,
            params: { title: '你好' },
            overrides: { 'stage/title': { y: 280 } },
          },
          { id: 'box', type: 'rect', name: 'Box', x: 10, y: 20, width: 100, height: 50, fill: '#ff0000', opacity: 0.5 },
        ],
      },
    ],
    sequences: [],
    files: { 'components/card.tsx': TSX },
  }) as unknown as Snapshot;
const context = (over: Partial<Parameters<typeof inboxCreateSchema.parse>[0]> = {}): InboxContext =>
  buildInboxContext(
    snapshot(),
    inboxCreateSchema.parse({ text: '把标题放大一点', sceneId: 'intro', frame: 45, ...over }),
  );

describe('canvas inbox: context pack', () => {
  it('locates JSX elements by nested id, line and range', () => {
    const title = locateJsxElement('c.tsx', TSX, 'stage/title')!;
    expect(title).toMatchObject({ line: 13, endLine: 16, element: 'title', candidates: 1 });
    // "bg" exists twice: the ancestor chain disambiguates.
    expect(locateJsxElement('c.tsx', TSX, 'stage/row/bg')).toMatchObject({ line: 18, candidates: 1 });
    expect(locateJsxElement('c.tsx', TSX, 'a/chip/bg')).toMatchObject({ line: 5 });
    expect(locateJsxElement('c.tsx', TSX, 'stage/missing')).toBeUndefined();
  });
  it('packs scene nodes, generated JSX nodes (owner, file:line, overrides) and frame time', () => {
    const c = context({
      selection: [
        { id: 'box' },
        { id: 'card/stage/title', name: 'title', type: 'text', props: { fontSize: 84, x: 0, y: 280, text: 'hi' }, bounds: { x: 0, y: 280.04, width: 1280, height: 110 } },
        { id: 'card' },
        { id: 'card/stage/ghost', type: 'rect' },
      ],
      range: { start: 30, end: 60 },
    });
    expect(c).toMatchObject({ sceneId: 'intro', sceneName: 'Intro', frame: 45, seconds: 1.5, fps: 30, revision: 'rev-1', range: { start: 30, end: 60 } });
    expect(c.project).toEqual({ name: 'Demo', width: 1280, height: 720 });
    const [box, title, card, ghost] = c.selection;
    expect(box).toMatchObject({ id: 'box', type: 'rect', name: 'Box', props: { x: 10, y: 20, fill: '#ff0000', opacity: 0.5 }, source: { file: 'scenes/intro.json' } });
    expect(title).toMatchObject({
      id: 'card/stage/title',
      type: 'text',
      owner: { nodeId: 'card', component: 'components/card.tsx' },
      localId: 'stage/title',
      source: { file: 'components/card.tsx', line: 13, endLine: 16, element: 'title' },
      props: { fontSize: 84, y: 280, override: { y: 280 } },
      bounds: { x: 0, y: 280, width: 1280, height: 110 },
    });
    expect(card.source).toMatchObject({ file: 'components/card.tsx' });
    expect(card.props).toMatchObject({ width: 1280, params: { title: '你好' } });
    expect(ghost.source).toMatchObject({ file: 'components/card.tsx', element: 'ghost' });
    expect(ghost.source?.line).toBeUndefined();
  });
  it('keeps key props small and readable', () => {
    const props = keyProps({ x: 1.23456, text: 'x'.repeat(500), fill: '#fff', nodes: [1], animations: [{ property: 'x' }] } as never);
    expect(props.x).toBe(1.235);
    expect(String(props.text).length).toBe(200);
    expect(props.animated).toEqual(['x']);
    expect(props).not.toHaveProperty('nodes');
  });
  it('rejects empty text and inverted ranges', () => {
    expect(() => inboxCreateSchema.parse({ text: '  ' })).toThrow();
    expect(() => inboxCreateSchema.parse({ text: 'a', range: { start: 5, end: 2 } })).toThrow();
  });
});

describe('canvas inbox: prompt copy', () => {
  it('is self-contained: request, files, lines, ids, props, frame and how to report back', () => {
    const c = context({ selection: [{ id: 'card/stage/title', props: { fontSize: 84 } }] });
    const text = inboxPrompt(
      {
        version: 1,
        id: 'req-20261026-012300-ab12',
        createdAt: '',
        updatedAt: '',
        status: 'question',
        text: '把标题放大一点',
        context: { ...c, snapshot: 'req-20261026-012300-ab12.png' },
        thread: [
          { at: '', from: 'ai', kind: 'question', text: '放大到多少？' },
          { at: '', from: 'human', kind: 'reply', text: '96' },
        ],
      },
      '/p/demo',
    );
    for (const part of [
      '请求：把标题放大一点',
      '工程目录：/p/demo',
      'scenes/intro.json',
      '第 45 帧（1.5 s）',
      '.vmotion/requests/req-20261026-012300-ab12.png',
      '`card/stage/title`',
      'components/card.tsx:13-16',
      '组件内 id `stage/title`',
      'fontSize=84',
      'AI 问：放大到多少？',
      '回答：96',
      'vmotion inbox done req-20261026-012300-ab12',
    ])
      expect(text).toContain(part);
    expect(inboxTitle({ text: 'a\nb  c' })).toBe('a b c');
    expect(inboxTitle({ text: 'x'.repeat(100) }, 10)).toHaveLength(10);
  });
});

describe('canvas inbox: store', () => {
  let root: string, store: InboxStore;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-inbox-'));
    store = new InboxStore(root);
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('writes human-readable request files with a PNG beside them', async () => {
    expect(newRequestId(new Date(2026, 9, 26, 1, 23, 0))).toMatch(/^req-20261026-012300-[0-9a-f]{4}$/);
    const r = await store.create(context(), '把标题放大一点', Buffer.from([137, 80, 78, 71]));
    expect(r.status).toBe('pending');
    expect(r.context.snapshot).toBe(`${r.id}.png`);
    const files = (await readdir(path.join(root, '.vmotion/requests'))).sort();
    expect(files).toEqual([`${r.id}.json`, `${r.id}.png`]);
    const json = await readFile(path.join(root, '.vmotion/requests', `${r.id}.json`), 'utf8');
    expect(json).toContain('\n  "status": "pending"');
    expect(json).toContain('把标题放大一点');
    expect((agentView(store, r) as { files?: unknown }).files).toEqual({ json: `.vmotion/requests/${r.id}.json`, snapshot: `.vmotion/requests/${r.id}.png` });
  });
  it('runs pending → claimed → question → (reply) → claimed → done with a thread', async () => {
    const r = await store.create(context(), 'A');
    const claimed = await store.claim(r.id, 'claude-code');
    expect(claimed).toMatchObject({ status: 'claimed', claimedBy: { client: 'claude-code' } });
    expect(store.activeClaim()).toBe(r.id);
    await expect(store.claim(r.id, 'codex')).rejects.toMatchObject({ code: 'INBOX_STATE' });
    const asked = await store.ask({ id: r.id, question: '放大到多少？' }, 'claude-code');
    expect(asked).toMatchObject({ answered: false, request: { status: 'question' } });
    const replied = await store.reply(r.id, '96');
    expect(replied).toMatchObject({ status: 'claimed', unreadReply: true });
    const again = await store.wait({ timeoutMs: 0 }, 'claude-code');
    expect(again.reason).toBe('reply');
    expect(again.request?.unreadReply).toBeUndefined();
    const done = await store.done({ id: r.id, summary: '字号 84 → 96', changedFiles: ['components/card.tsx'] }, 'claude-code');
    expect(done).toMatchObject({ status: 'done', summary: '字号 84 → 96', changedFiles: ['components/card.tsx'] });
    expect(done.thread.map((m) => m.kind)).toEqual(['request', 'note', 'question', 'reply', 'done']);
    expect(store.activeClaim()).toBeUndefined();
    await expect(store.done({ id: r.id, summary: 'x' }, 'c')).rejects.toMatchObject({ code: 'INBOX_STATE' });
    await expect(store.get('req-20990101-000000-0000')).rejects.toMatchObject({ code: 'INBOX_NOT_FOUND' });
  });
  it('long-polls: times out with request null, wakes on a new request and claims it', async () => {
    const started = Date.now();
    expect(await store.wait({ timeoutMs: 300 }, 'a')).toMatchObject({ request: null, reason: 'timeout' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    const waiting = store.wait({ timeoutMs: 5000 }, 'a');
    await new Promise((r) => setTimeout(r, 150));
    const created = await store.create(context(), 'B');
    const got = await waiting;
    expect(got.reason).toBe('new');
    expect(got.request).toMatchObject({ id: created.id, status: 'claimed', claimedBy: { client: 'a' } });
  });
  it('gives each pending request to exactly one of several racing agents (two stores, one folder)', async () => {
    const other = new InboxStore(root);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await store.create(context(), `R${i}`)).id);
    const results = await Promise.all([
      ...ids.map((id) => store.claim(id, 'a').then(() => 'a', (e) => e.code)),
      ...ids.map((id) => other.claim(id, 'b').then(() => 'b', (e) => e.code)),
    ]);
    for (let i = 0; i < 3; i++) {
      const pair = [results[i], results[i + 3]].sort();
      expect(pair.filter((v) => v === 'INBOX_STATE')).toHaveLength(1);
    }
    const waits = await Promise.all([
      store.wait({ timeoutMs: 0 }, 'a'),
      other.wait({ timeoutMs: 0 }, 'b'),
    ]);
    expect(waits.every((w) => w.request === null)).toBe(true);
    // Concurrent waits on fresh requests never claim the same one twice.
    const more = [(await store.create(context(), 'X')).id, (await store.create(context(), 'Y')).id];
    const both = await Promise.all([store.wait({ timeoutMs: 1000 }, 'a'), other.wait({ timeoutMs: 1000 }, 'b')]);
    expect(new Set(both.map((w) => w.request?.id))).toEqual(new Set(more));
  });
  it('ask with waitMs returns the human answer', async () => {
    const r = await store.create(context(), 'C');
    await store.claim(r.id, 'a');
    const asking = store.ask({ id: r.id, question: '哪种颜色？', waitMs: 4000 }, 'a');
    await new Promise((res) => setTimeout(res, 200));
    await new InboxStore(root).reply(r.id, '珊瑚色');
    const answer = await asking;
    expect(answer.answered).toBe(true);
    expect(answer.request.thread.at(-1)).toMatchObject({ from: 'human', kind: 'reply', text: '珊瑚色' });
  });
  it('cancels and requeues; ignores unreadable files', async () => {
    const r = await store.create(context(), 'D');
    await store.claim(r.id, 'a');
    expect((await store.requeue(r.id)).status).toBe('pending');
    expect((await store.cancel(r.id, '不用了')).status).toBe('cancelled');
    await expect(store.cancel(r.id)).rejects.toMatchObject({ code: 'INBOX_STATE' });
    await mkdir(path.join(root, '.vmotion/requests'), { recursive: true });
    await writeFile(path.join(root, '.vmotion/requests/req-broken-000000.json'), '{nope');
    const listed = await store.list({ status: 'all' });
    expect(listed.requests.map((x) => x.id)).toEqual([r.id]);
    expect((await store.list({})).total).toBe(0);
  });
});

describe('canvas inbox: change journal linking', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-inbox-journal-'));
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));
  const snap = (revision: string, y: number): Snapshot =>
    ({ ...snapshot(), revision, files: { 'components/card.tsx': TSX.replace('y={300}', `y={${y}}`) } }) as unknown as Snapshot;

  it('links external changes to the claimed request, never UI edits, and stores them at done', async () => {
    const journal = new ChangeJournal(root);
    const store = new InboxStore(root, { changes: () => journal.entries });
    journal.linker = () => store.activeClaim();
    const before = journal.record({ kind: 'file' }, 'external', snap('r0', 300), snap('r1', 310));
    expect(before?.request).toBeUndefined();
    const r = await store.create(context(), 'E');
    await store.claim(r.id, 'claude-code');
    const a = journal.record({ kind: 'file' }, 'external', snap('r1', 310), snap('r2', 320))!;
    const ui = journal.record({ kind: 'ui' }, 'edit', snap('r2', 320), snap('r3', 330))!;
    const b = journal.record({ kind: 'mcp', client: 'claude-code' }, 'edit', snap('r3', 330), snap('r4', 340))!;
    expect(a.request).toBe(r.id);
    expect(ui.request).toBeUndefined();
    expect(b.request).toBe(r.id);
    const done = await store.done({ id: r.id, summary: 'moved' }, 'claude-code');
    expect(done.changes?.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(done.changes?.[0]).toMatchObject({ revision: 'r2', previous: 'r1', files: ['components/card.tsx'] });
    const after = journal.record({ kind: 'file' }, 'external', snap('r4', 340), snap('r5', 350))!;
    expect(after.request).toBeUndefined();
    await journal.flush();
    const disk = JSON.parse(await readFile(path.join(root, '.vmotion/changes.json'), 'utf8'));
    expect(disk.entries.find((e: { id: string }) => e.id === a.id).request).toBe(r.id);
    const reopened = await new ChangeJournal(root).open();
    expect(reopened.entries.find((e) => e.id === b.id)?.request).toBe(r.id);
  });
  it('computes one-click undo steps for a request only when its changes are the newest', async () => {
    const journal = new ChangeJournal(root);
    journal.linker = () => 'req-20261026-000000-aaaa';
    const a = journal.record({ kind: 'file' }, 'external', snap('r0', 300), snap('r1', 310))!;
    const b = journal.record({ kind: 'file' }, 'external', snap('r1', 310), snap('r2', 320))!;
    const req = { id: 'req-20261026-000000-aaaa', changes: [] } as never;
    expect(requestEntries(req, journal.entries).map((e) => e.id)).toEqual([a.id, b.id]);
    expect(requestUndoSteps(req, journal.entries, 'r2')).toBe(2);
    journal.linker = undefined;
    journal.record({ kind: 'ui' }, 'edit', snap('r2', 320), snap('r3', 330));
    expect(requestUndoSteps(req, journal.entries, 'r3')).toBe(0);
    // Same rule as the change feed's group undo.
    const group = { entries: [a, b] } as FeedGroup;
    expect(undoStepsFor(group, journal.entries.slice(0, 2), 'r2')).toBe(2);
    await journal.flush();
  });
});

describe('canvas inbox: structured Studio-only clarification & sampling helpers', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-inbox-structured-'));
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('stores structured fields/options in Vmotion and wakes ask() immediately on structured reply or skip', async () => {
    const store = new InboxStore(root);
    const created = await store.create(context(), '给标题加动画');
    await store.claim(created.id, 'sampling-agent');

    const t0 = Date.now();
    const asking = store.ask(
      {
        id: created.id,
        question: '确认入场细节',
        fields: [
          { id: 'color', label: '主色', kind: 'select', options: ['#ff8a5b', '#38bdf8'], required: true },
          { id: 'bounce', label: '弹性效果', kind: 'boolean', defaultValue: true },
          { id: 'tags', label: '发光层', kind: 'multiselect', options: ['外发光', '扫描线'] },
        ],
        waitMs: 5000,
      },
      'sampling-agent',
    );
    await new Promise((r) => setTimeout(r, 30));
    const q = await store.get(created.id);
    expect(q.status).toBe('question');
    expect(q.thread.at(-1)?.fields).toHaveLength(3);

    await store.reply(created.id, undefined, {
      answers: { color: '#38bdf8', bounce: true, tags: ['外发光'] },
    });
    const res = await asking;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(res.answered).toBe(true);
    expect(res.answers).toEqual({ color: '#38bdf8', bounce: true, tags: ['外发光'] });
    expect(res.request.thread.at(-1)?.text).toContain('主色：#38bdf8');
    expect(formatInboxAnswers(res.answers, q.thread.at(-1)?.fields)).toBe(
      '主色：#38bdf8；弹性效果：是；发光层：外发光',
    );

    // Skip flow + releaseClaim fallback
    const skipAsk = store.ask({ id: created.id, question: '字号？', options: ['96', '120'], waitMs: 5000 }, 'sampling-agent');
    await new Promise((r) => setTimeout(r, 20));
    await store.reply(created.id, undefined, { skipped: true });
    const skipped = await skipAsk;
    expect(skipped).toMatchObject({ answered: true, skipped: true });
    expect(skipped.request.thread.at(-1)?.text).toBe('按默认处理');

    const released = await store.releaseClaim(created.id, '预检未通过，已退回待处理');
    expect(released.status).toBe('pending');
    expect(released.claimedBy).toBeUndefined();
    expect(released.thread.at(-1)).toMatchObject({ from: 'ai', kind: 'note', text: '预检未通过，已退回待处理' });
  });

  it('extracts JSON objects from fenced and unfenced basic-sampling completions', () => {
    expect(extractJsonCandidate('```json\n{"action":"edit","summary":"ok","files":[]}\n```')).toEqual({
      action: 'edit',
      summary: 'ok',
      files: [],
    });
    expect(extractJsonCandidate('Here is the patch:\n{"action":"ask","question":"Color?"}\nThanks')).toEqual({
      action: 'ask',
      question: 'Color?',
    });
    expect(extractJsonCandidate('not json at all')).toBeUndefined();
  });
});

describe('canvas inbox: sampling loop scope', () => {
  it('pins inbox_done to the pushed request and blocks inbox_wait/inbox_claim inside the loop', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-inbox-scope-'));
    try {
      const store = new InboxStore(root);
      const created = await store.create(context(), '把标题放大一点');
      const request = await store.claim(created.id, 'sampling-agent');
      const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
      let turn = 0;
      const outcome = await runSamplingRequest({
        mode: 'tools',
        request,
        root,
        definitions: [],
        signal: new AbortController().signal,
        waitForReply: async () => request,
        callCapability: async (name, args) => {
          calls.push({ name, args });
          return { value: { ok: true }, text: '{"ok":true}' };
        },
        createMessage: async () => {
          turn++;
          if (turn === 1)
            return {
              model: 'mock',
              role: 'assistant',
              stopReason: 'toolUse',
              content: [
                { type: 'tool_use', id: 'a', name: 'tool_call', input: { name: 'inbox_wait', arguments: {} } },
                { type: 'tool_use', id: 'b', name: 'inbox_claim', input: { id: 'req-other' } },
              ],
            };
          return {
            model: 'mock',
            role: 'assistant',
            stopReason: 'toolUse',
            content: [{ type: 'tool_use', id: 'c', name: 'inbox_done', input: { id: 'req-other', summary: 'ok' } }],
          };
        },
      });
      expect(outcome).toEqual({ outcome: 'completed' });
      expect(calls.some((c) => c.name === 'inbox_claim' || c.args.name === 'inbox_wait')).toBe(false);
      expect(calls.find((c) => c.name === 'inbox_done')?.args.id).toBe(request.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('canvas inbox: brush & mask region', () => {
  it('computes mask bounds, erase strokes, hit-tested JSX/scene nodes, mask PNG and prompt text', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-inbox-mask-'));
    try {
      const store = new InboxStore(root);
      const c = context({
        selection: [],
        mask: {
          strokes: [
            {
              mode: 'brush',
              radius: 28,
              points: [
                { x: 40, y: 40 },
                { x: 90, y: 45 },
                { x: 300, y: 310 },
              ],
            },
            {
              mode: 'erase',
              radius: 36,
              points: [{ x: 300, y: 310 }],
            },
          ],
          candidates: [
            {
              id: 'card/stage/title',
              name: 'Title',
              type: 'text',
              props: { fontSize: 84, text: 'hi' },
              bounds: { x: 20, y: 20, width: 200, height: 80 },
              layerPath: ['card'],
            },
          ],
        },
      });
      expect(c.mask).toBeDefined();
      expect(c.mask!.strokeCount).toBe(2);
      expect(c.mask!.coverageRatio).toBeGreaterThan(0);
      expect(c.mask!.bounds.width).toBeGreaterThan(20);
      expect(c.mask!.hitNodes.map((n) => n.id)).toContain('box');
      expect(c.mask!.hitNodes.map((n) => n.id)).toContain('card/stage/title');
      const titleHit = c.mask!.hitNodes.find((n) => n.id === 'card/stage/title')!;
      expect(titleHit).toMatchObject({
        owner: { nodeId: 'card', component: 'components/card.tsx' },
        localId: 'stage/title',
        source: { file: 'components/card.tsx', line: 13, endLine: 16 },
      });
      expect(titleHit.overlapRatio).toBeGreaterThan(0);

      // Completely erased mask is rejected with INBOX_MASK_EMPTY.
      expect(() =>
        context({
          mask: {
            strokes: [
              { mode: 'brush', radius: 12, points: [{ x: 100, y: 100 }] },
              { mode: 'erase', radius: 24, points: [{ x: 100, y: 100 }] },
            ],
          },
        }),
      ).toThrow(/no visible region/);

      expect(
        computeMaskGeometry(
          [
            { mode: 'brush', radius: 12, points: [{ x: 100, y: 100 }] },
            { mode: 'erase', radius: 24, points: [{ x: 100, y: 100 }] },
          ],
          { width: 1280, height: 720 },
        ),
      ).toBeUndefined();

      const maskPng = await renderInboxMaskPng(
        [{ mode: 'brush', radius: 24, points: [{ x: 50, y: 50 }, { x: 120, y: 80 }] }],
        c.mask!.bounds,
        1280,
        720,
      );
      expect(maskPng.subarray(1, 4).toString()).toBe('PNG');
      const req = await store.create(c, '把这个局部区域调亮', undefined, maskPng);
      expect(req.context.mask?.file).toBe(`${req.id}-mask.png`);
      const view = agentView(store, req) as { files?: { mask?: string } };
      expect(view.files?.mask).toBe(`.vmotion/requests/${req.id}-mask.png`);
      const prompt = inboxPrompt(req, '/p/demo');
      expect(prompt).toContain('涂抹遮罩区域：');
      expect(prompt).toContain(`.vmotion/requests/${req.id}-mask.png`);
      expect(prompt).toContain('## 遮罩命中对象');
      expect(prompt).toContain('`card/stage/title`');

      // Highlight helper includes mask hitNodes even when selection was empty.
      const doneReq = {
        ...req,
        status: 'done' as const,
        changes: [
          {
            id: 'chg-1',
            at: 1000,
            kind: 'file',
            action: 'external',
            revision: 'r2',
            previous: 'r1',
            files: ['components/card.tsx'],
            targets: [],
          },
        ],
      };
      const highlights = requestHighlights([doneReq], [], new Set(), 2000);
      expect(highlights.has('card/stage/title')).toBe(true);
      expect(highlights.has('box')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
