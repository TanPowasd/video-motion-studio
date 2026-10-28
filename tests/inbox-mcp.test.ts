import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Application } from '../src/service/application.js';
import { rpc, servePipe } from '../src/service/ipc.js';
import type { InboxRequest } from '../src/core/inbox-model.js';

/**
 * The canvas inbox end to end: the Studio side (Application.dispatch inboxCreate/inboxReply)
 * and a real external MCP stdio client attached to the open project (inbox_wait → edit the
 * .tsx file → inbox_done; inbox_ask with a human reply), with change-journal linking.
 */
const starter = path.resolve('skills/vmotion/examples/starter');
describe('canvas inbox over MCP', () => {
  let root: string, app: Application, pipe: Server, client: Client;
  const text = (r: unknown) => ((r as { content: Array<{ type: string; text: string }> }).content.find((c) => c.type === 'text')?.text ?? '');
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } }, undefined, { timeout: 60_000 });
    const value = JSON.parse(text(result));
    if (result.isError) throw Object.assign(new Error(text(result)), value);
    return value;
  };
  const create = async (body: string, selection: unknown[] = []) =>
    ((await app.dispatch('inboxCreate', { text: body, sceneId: 'intro', frame: 45, selection, workspace: 'animation' })) as { request: InboxRequest }).request;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-inbox-mcp-'));
    await cp(starter, root, { recursive: true });
    app = await new Application(root).open(true);
    pipe = await servePipe(app);
    client = new Client({ name: 'inbox-test-agent', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: existsSync(path.resolve('dist/cli/index.mjs'))
          ? ['dist/cli/index.mjs', 'mcp', '--project', root]
          : ['--import', 'tsx', 'src/cli/index.ts', 'mcp', '--project', root],
        cwd: path.resolve('.'),
        stderr: 'pipe',
      }),
      // First tsx start compiles the CLI: slow on small CI hosts.
      { timeout: 170_000 },
    );
  }, 240_000);
  afterAll(async () => {
    await client?.close().catch(() => {});
    pipe?.close();
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('Studio creates a request with context pack and PNG; compact MCP discovers the inbox tools', async () => {
    const request = await create('标题再大一点，颜色换成珊瑚色', [
      { id: 'title-card/stage/title', type: 'text', props: { fontSize: 84 }, layerPath: ['title-card'] },
    ]);
    expect(request.status).toBe('pending');
    const node = request.context.selection[0];
    expect(node).toMatchObject({
      owner: { nodeId: 'title-card', component: 'components/title-card.tsx' },
      localId: 'stage/title',
      source: { file: 'components/title-card.tsx', element: 'title' },
    });
    const source = await readFile(path.join(root, 'components/title-card.tsx'), 'utf8');
    expect(source.split('\n')[node.source!.line! - 1]).toContain('<text');
    const png = await readFile(path.join(root, '.vmotion/requests', request.context.snapshot!));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(request.context).toMatchObject({ frame: 45, seconds: 1.5, sceneId: 'intro' });
    expect((app.applicationState() as { inbox: InboxRequest[] }).inbox[0].id).toBe(request.id);

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(10);
    const found = await client.callTool({ name: 'tools_search', arguments: { category: 'inbox', limit: 20 } });
    expect(JSON.parse(text(found)).items.map((i: { name: string }) => i.name).sort()).toEqual(
      ['inbox_ask', 'inbox_claim', 'inbox_done', 'inbox_get', 'inbox_list', 'inbox_wait'],
    );
    const listed = await call('inbox_list');
    expect(listed.requests).toEqual([expect.objectContaining({ id: request.id, status: 'pending', selection: ['title-card/stage/title'] })]);
  }, 120_000);

  it('wait claims for the MCP client, file edits link to the request, done stores them', async () => {
    const got = await call('inbox_wait', { timeoutMs: 5000 });
    expect(got.reason).toBe('new');
    expect(got.request).toMatchObject({ status: 'claimed', claimedBy: { client: 'inbox-test-agent' } });
    expect(got.files.snapshot).toMatch(/^\.vmotion\/requests\/req-.*\.png$/);
    expect(got.next).toMatch(/inbox_done/);
    const id = got.request.id as string;
    await expect(call('inbox_claim', { id })).rejects.toMatchObject({ code: 'INBOX_STATE' });
    const file = path.join(root, 'components/title-card.tsx');
    await writeFile(file, (await readFile(file, 'utf8')).replace('fontSize={84}', 'fontSize={96}').replace('fill="#f4f7ff"', 'fill="#ff8a5b"'));
    // Done right after the write: the settle step ingests the edit before closing the request.
    const done = await call('inbox_done', { id, summary: '标题字号 84 → 96，颜色改为珊瑚色', changedFiles: ['components/title-card.tsx'] });
    expect(done).toMatchObject({ id, status: 'done', committed: false });
    expect(done.linkedChanges).toBeGreaterThanOrEqual(1);
    expect(done.files).toContain('components/title-card.tsx');
    const linked = app.changeLog().filter((e) => e.request === id);
    expect(linked.length).toBe(done.linkedChanges);
    expect(linked[0].kind).not.toBe('ui');
    const stored = JSON.parse(await readFile(path.join(root, `.vmotion/requests/${id}.json`), 'utf8'));
    expect(stored.changes.map((c: { id: string }) => c.id)).toEqual(linked.map((e) => e.id));
    // Later edits are not linked.
    await app.dispatch('transact', { operations: [{ type: 'updateScene', sceneId: 'intro', patch: { name: 'Intro 2' } }] });
    expect(app.changeLog().at(-1)?.request).toBeUndefined();
  }, 120_000);

  it('ask waits for the person; wait times out with request null; studio-only methods are refused', async () => {
    const request = await create('换个背景');
    const got = await call('inbox_wait', { timeoutMs: 3000 });
    expect(got.request.id).toBe(request.id);
    const asking = call('inbox_ask', { id: request.id, question: '深色还是浅色？', waitMs: 15000 });
    await new Promise((r) => setTimeout(r, 600));
    expect((await app.dispatch('inboxState', {}) as { inbox: InboxRequest[] }).inbox.find((r) => r.id === request.id)?.status).toBe('question');
    await app.dispatch('inboxReply', { id: request.id, text: '深色' });
    const answer = await asking;
    expect(answer.answered).toBe(true);
    expect(answer.request.thread.at(-1)).toMatchObject({ from: 'human', text: '深色' });
    const read = await call('inbox_get', { id: request.id });
    expect(read.request.unreadReply).toBeUndefined();
    await call('inbox_done', { id: request.id, summary: '没有改动' });

    // Masked request: creates <id>-mask.png, lists maskBounds & maskHitNodes, and attaches image on includeMaskImage=true.
    const masked = (
      await app.dispatch('inboxCreate', {
        text: '调整圈出区域的副标题样式',
        sceneId: 'intro',
        frame: 30,
        snapshot: false,
        selection: [],
        mask: {
          strokes: [
            {
              mode: 'brush',
              radius: 32,
              points: [
                { x: 200, y: 260 },
                { x: 600, y: 290 },
              ],
            },
          ],
          candidates: [
            {
              id: 'title-card/stage/title',
              type: 'text',
              props: { fontSize: 96 },
              bounds: { x: 160, y: 220, width: 960, height: 120 },
              layerPath: ['title-card'],
            },
          ],
        },
        workspace: 'animation',
      })
    ) as { request: InboxRequest };
    expect(masked.request.context.mask?.file).toBe(`${masked.request.id}-mask.png`);
    expect(masked.request.context.mask?.hitNodes.map((n) => n.id)).toContain('title-card/stage/title');
    const listedMask = await call('inbox_list', { status: 'pending' });
    expect(listedMask.requests[0]).toMatchObject({
      id: masked.request.id,
      maskHitNodes: expect.arrayContaining(['title-card/stage/title']),
    });
    const rawMaskGet = await client.callTool(
      {
        name: 'tool_call',
        arguments: {
          name: 'inbox_get',
          arguments: { id: masked.request.id, includeMaskImage: true },
        },
      },
      undefined,
      { timeout: 60_000 },
    );
    const maskBlocks = (rawMaskGet as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }).content;
    const maskImg = maskBlocks.find((b) => b.type === 'image');
    expect(maskImg?.mimeType).toBe('image/png');
    expect(Buffer.from(maskImg!.data!, 'base64').subarray(1, 4).toString()).toBe('PNG');
    const maskJsonText = maskBlocks.find((b) => b.type === 'text')!.text!;
    expect(maskJsonText).not.toContain(maskImg!.data!.slice(0, 48));
    await app.dispatch('inboxCancel', { id: masked.request.id });
    const t0 = Date.now();
    expect(await call('inbox_wait', { timeoutMs: 800 })).toMatchObject({ request: null, reason: 'timeout' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(700);
    await expect(rpc(root, 'inboxCreate', { text: 'x' })).rejects.toMatchObject({ code: 'SURFACE_METHOD' });
    await expect(call('inbox_wait', { timeoutMs: 999999 })).rejects.toMatchObject({ code: 'TOOL_ARGUMENTS' });
    expect((await stat(path.join(root, '.vmotion/requests'))).isDirectory()).toBe(true);
  }, 120_000);
});
