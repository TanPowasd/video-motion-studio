import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  type CreateMessageRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { Application } from '../src/service/application.js';
import { servePipe } from '../src/service/ipc.js';
import type { InboxRequest } from '../src/core/inbox-model.js';

const starter = path.resolve('skills/vmotion/examples/starter');

const waitFor = async <T>(
  fn: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 20_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const val = await fn();
    if (val !== undefined) return val;
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 40));
  }
};

describe('canvas instructions: MCP sampling push & Vmotion-only clarification', () => {
  let root: string, app: Application, pipe: Server;
  const openClients = new Set<Client>();

  const spawnMcpClient = async (
    name: string,
    capabilities: Record<string, unknown>,
    setup?: (client: Client) => void,
  ): Promise<Client> => {
    const client = new Client({ name, version: '1.0.0' }, { capabilities });
    setup?.(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', 'src/cli/index.ts', 'mcp', '--project', root],
        cwd: path.resolve('.'),
        stderr: 'pipe',
      }),
      { timeout: 170_000 },
    );
    openClients.add(client);
    return client;
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-mcp-sampling-'));
    await cp(starter, root, { recursive: true });
    app = await new Application(root).open(true);
    pipe = await servePipe(app);
  }, 240_000);

  afterEach(async () => {
    for (const c of openClients) await c.close().catch(() => {});
    openClients.clear();
    const list = ((await app.dispatch('inboxState', {})) as { inbox: InboxRequest[] }).inbox;
    for (const r of list) {
      if (r.status === 'pending' || r.status === 'claimed' || r.status === 'question') {
        await app.dispatch('inboxCancel', { id: r.id }).catch(() => {});
      }
    }
  });

  afterAll(async () => {
    for (const c of openClients) await c.close().catch(() => {});
    openClients.clear();
    pipe?.close();
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it(
    'pushes requests immediately to sampling.tools clients (default pure text), keeps structured ask strictly in Vmotion (never elicitation/create), and links one-step undo',
    async () => {
      const client = await spawnMcpClient('sampling-tools-agent', {
        sampling: { tools: {} },
        elicitation: { form: {} },
      });

      let elicitationCalls = 0;
      client.setRequestHandler(ElicitRequestSchema, async () => {
        elicitationCalls++;
        throw new Error('External agent must NOT display elicitation popups');
      });

      await waitFor(() =>
        app.agentState().clients.find((c) => c.client === 'sampling-tools-agent' && c.sampling === 'tools'),
      );

      // Default compact startup surface remains 10 entry tools; vmotion://inbox resource is listed.
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(10);
      const resources = await client.listResources();
      expect(resources.resources.some((r) => r.uri === 'vmotion://inbox')).toBe(true);
      expect(client.getServerCapabilities()?.resources?.subscribe).toBe(true);
      await expect(client.subscribeResource({ uri: 'vmotion://inbox' })).resolves.toBeDefined();

      const seenRequests: CreateMessageRequest['params'][] = [];
      let expectedHash = '';
      let turn = 0;

      client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
        seenRequests.push(req.params);
        turn++;
        if (turn === 1) {
          const firstBlocks = req.params.messages[0].content;
          const arr = Array.isArray(firstBlocks) ? firstBlocks : [firstBlocks];
          const textBlock = arr.find((b) => b.type === 'text') as { type: 'text'; text: string };
          const match = /expectedHash=([a-f0-9]{64})/.exec(textBlock.text);
          expectedHash = match?.[1] ?? '';
          return {
            model: 'mock-tools-llm',
            role: 'assistant',
            stopReason: 'toolUse',
            content: [
              {
                type: 'tool_use',
                id: 'call-ask-1',
                name: 'inbox_ask',
                input: {
                  question: '标题要改成哪种主题色？',
                  fields: [
                    {
                      id: 'color',
                      label: '主题色',
                      kind: 'select',
                      options: ['#ff8a5b', '#38bdf8'],
                      required: true,
                    },
                  ],
                },
              },
            ],
          };
        }
        if (turn === 2) {
          return {
            model: 'mock-tools-llm',
            role: 'assistant',
            stopReason: 'toolUse',
            content: [
              {
                type: 'tool_use',
                id: 'call-preflight-1',
                name: 'project_preflight',
                input: {
                  files: [
                    {
                      type: 'text',
                      path: 'components/title-card.tsx',
                      expectedHash,
                      replacements: [{ before: 'fill="#f4f7ff"', after: 'fill="#38bdf8"' }],
                    },
                  ],
                  visual: false,
                },
              },
              {
                type: 'tool_use',
                id: 'call-apply-1',
                name: 'project_apply',
                input: {
                  files: [
                    {
                      type: 'text',
                      path: 'components/title-card.tsx',
                      expectedHash,
                      replacements: [{ before: 'fill="#f4f7ff"', after: 'fill="#38bdf8"' }],
                    },
                  ],
                  visual: false,
                },
              },
            ],
          };
        }
        return {
          model: 'mock-tools-llm',
          role: 'assistant',
          stopReason: 'endTurn',
          content: { type: 'text', text: '已按所选颜色更新标题为霓虹蓝 #38bdf8' },
        };
      });

      const baseRevision = app.service.snapshot.revision;
      // Studio UI default: snapshot=false (pure text context, zero frame render overhead).
      const created = (
        await app.dispatch('inboxCreate', {
          text: '把标题改个主题色，先问我选哪个颜色',
          sceneId: 'intro',
          frame: 30,
          snapshot: false,
          selection: [
            {
              id: 'title-card/stage/title',
              type: 'text',
              props: { fontSize: 84, fill: '#f4f7ff' },
              layerPath: ['title-card'],
            },
          ],
          workspace: 'animation',
        })
      ) as { request: InboxRequest };

      // Wait until the pushed sampling loop posts inbox_ask into Vmotion Studio.
      const askingReq = await waitFor(async () => {
        const list = ((await app.dispatch('inboxState', {})) as { inbox: InboxRequest[] }).inbox;
        return list.find((r) => r.id === created.request.id && r.status === 'question');
      });
      expect(elicitationCalls).toBe(0);
      expect(askingReq.thread.at(-1)).toMatchObject({
        from: 'ai',
        kind: 'question',
        text: '标题要改成哪种主题色？',
      });
      expect(askingReq.thread.at(-1)?.fields?.[0]).toMatchObject({ id: 'color', kind: 'select' });

      // First sampling message had pure text only (no image block) and tools array.
      const msg0Content = seenRequests[0].messages[0].content;
      const msg0Blocks = Array.isArray(msg0Content) ? msg0Content : [msg0Content];
      expect(msg0Blocks.some((b) => b.type === 'image')).toBe(false);
      expect(seenRequests[0].tools?.some((t) => t.name === 'project_apply')).toBe(true);
      expect(expectedHash).toMatch(/^[a-f0-9]{64}$/);

      // Human answers inside Vmotion Studio.
      await app.dispatch('inboxReply', {
        id: created.request.id,
        answers: { color: '#38bdf8' },
      });

      // Sampling loop finishes automatically via project_preflight -> project_apply -> auto inbox_done.
      const doneReq = await waitFor(async () => {
        const list = ((await app.dispatch('inboxState', {})) as { inbox: InboxRequest[] }).inbox;
        return list.find((r) => r.id === created.request.id && r.status === 'done');
      });
      expect(elicitationCalls).toBe(0);
      expect(doneReq.summary).toContain('#38bdf8');
      expect(doneReq.changes?.length).toBe(1);
      const updatedTsx = await readFile(path.join(root, 'components/title-card.tsx'), 'utf8');
      expect(updatedTsx).toContain('fill="#38bdf8"');

      // Single-step Studio undo reverts the sampling edit cleanly.
      await app.dispatch('undo', {});
      expect(app.service.snapshot.revision).toBe(baseRevision);
      expect(await readFile(path.join(root, 'components/title-card.tsx'), 'utf8')).toContain(
        'fill="#f4f7ff"',
      );

      // Next test checks opt-in screenshot attachment on the same client.
      let optInBlocks: unknown[] = [];
      client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
        const c = req.params.messages[0].content;
        optInBlocks = Array.isArray(c) ? c : [c];
        return {
          model: 'mock-tools-llm',
          role: 'assistant',
          stopReason: 'toolUse',
          content: [
            {
              type: 'tool_use',
              id: 'done-snap',
              name: 'inbox_done',
              input: { summary: '已确认当前帧画面' },
            },
          ],
        };
      });

      const snapCreated = (
        await app.dispatch('inboxCreate', {
          text: '检查当前画面构图',
          sceneId: 'intro',
          frame: 15,
          snapshot: true,
          selection: [],
          workspace: 'animation',
        })
      ) as { request: InboxRequest };

      await waitFor(async () => {
        const list = ((await app.dispatch('inboxState', {})) as { inbox: InboxRequest[] }).inbox;
        return list.find((r) => r.id === snapCreated.request.id && r.status === 'done');
      });
      const imgBlock = optInBlocks.find(
        (b): b is { type: 'image'; mimeType: string; data: string } =>
          (b as { type?: string }).type === 'image',
      );
      const txtBlock = optInBlocks.find(
        (b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text',
      );
      expect(imgBlock?.mimeType).toBe('image/png');
      expect(Buffer.from(imgBlock!.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
      // Never duplicate Base64 in text block.
      expect(txtBlock!.text).not.toContain(imgBlock!.data.slice(0, 48));

      await client.close();
      openClients.delete(client);
      await waitFor(() =>
        app.agentState().clients.every((c) => c.client !== 'sampling-tools-agent' || !c.active)
          ? true
          : undefined,
      );
    },
    180_000,
  );

  it(
    'supports basic sampling (no sampling.tools) with preflight diagnostic retries and safe fallback when all retries fail',
    async () => {
      const client = await spawnMcpClient('basic-sampling-agent', {
        sampling: {},
      });
      await waitFor(() =>
        app.agentState().clients.find((c) => c.client === 'basic-sampling-agent' && c.sampling === 'basic'),
      );

      let attempt = 0;
      const promptsSeen: string[] = [];
      client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
        expect(req.params.tools).toBeUndefined();
        const lastMsg = req.params.messages.at(-1)!;
        const lastText = Array.isArray(lastMsg.content)
          ? (lastMsg.content.find((b) => b.type === 'text') as { text?: string } | undefined)?.text ?? ''
          : (lastMsg.content as { text?: string }).text ?? '';
        promptsSeen.push(lastText);
        attempt++;
        if (attempt === 1) {
          // Deliberately broken patch (non-deterministic Math.random() + syntax error) -> preflight rejects!
          return {
            model: 'mock-basic-llm',
            role: 'assistant',
            stopReason: 'endTurn',
            content: {
              type: 'text',
              text: JSON.stringify({
                action: 'edit',
                summary: '错误尝试',
                files: [
                  {
                    path: 'components/title-card.tsx',
                    replacements: [{ before: 'fontSize={84}', after: 'fontSize={Math.random() > 0.5 ? 96 : }' }],
                  },
                ],
              }),
            },
          };
        }
        return {
          model: 'mock-basic-llm',
          role: 'assistant',
          stopReason: 'endTurn',
          content: {
            type: 'text',
            text:
              '```json\n' +
              JSON.stringify({
                action: 'edit',
                summary: '标题字号放大到 104',
                files: [
                  {
                    path: 'components/title-card.tsx',
                    replacements: [{ before: 'fontSize={84}', after: 'fontSize={104}' }],
                  },
                ],
              }) +
              '\n```',
          },
        };
      });

      const baseRev = app.service.snapshot.revision;
      const created = (
        await app.dispatch('inboxCreate', {
          text: '把标题字号放大到 104',
          sceneId: 'intro',
          frame: 20,
          snapshot: false,
          selection: [{ id: 'title-card/stage/title', type: 'text', layerPath: ['title-card'] }],
        })
      ) as { request: InboxRequest };

      const doneReq = await waitFor(async () => {
        const list = ((await app.dispatch('inboxState', {})) as { inbox: InboxRequest[] }).inbox;
        return list.find((r) => r.id === created.request.id && r.status === 'done');
      });
      expect(attempt).toBe(2);
      expect(promptsSeen[1]).toMatch(/project_preflight failed/i);
      expect(doneReq.summary).toBe('标题字号放大到 104');
      expect(await readFile(path.join(root, 'components/title-card.tsx'), 'utf8')).toContain('fontSize={104}');
      await app.dispatch('undo', {});
      expect(app.service.snapshot.revision).toBe(baseRev);

      // Persistent failure (initial + 2 retries = 3 calls): project must stay untouched and request returns to pending.
      let failCalls = 0;
      client.setRequestHandler(CreateMessageRequestSchema, async () => {
        failCalls++;
        return {
          model: 'mock-basic-llm',
          role: 'assistant',
          stopReason: 'endTurn',
          content: {
            type: 'text',
            text: JSON.stringify({
              action: 'edit',
              summary: '坏代码',
              files: [
                {
                  path: 'components/title-card.tsx',
                  replacements: [{ before: 'fontSize={84}', after: 'fontSize={<<<syntax_error>>>}' }],
                },
              ],
            }),
          },
        };
      });

      const badCreated = (
        await app.dispatch('inboxCreate', {
          text: '测试预检连续失败保护',
          sceneId: 'intro',
          frame: 0,
          snapshot: false,
          selection: [{ id: 'title-card/stage/title', type: 'text', layerPath: ['title-card'] }],
        })
      ) as { request: InboxRequest };

      const requeued = await waitFor(async () => {
        const list = ((await app.dispatch('inboxState', {})) as { inbox: InboxRequest[] }).inbox;
        return list.find(
          (r) =>
            r.id === badCreated.request.id &&
            r.status === 'pending' &&
            r.thread.some((m) => m.from === 'ai' && m.kind === 'note' && m.text.includes('预检未通过')),
        );
      });
      expect(failCalls).toBe(3);
      expect(requeued.claimedBy).toBeUndefined();
      expect(app.service.snapshot.revision).toBe(baseRev);
      expect(await readFile(path.join(root, 'components/title-card.tsx'), 'utf8')).toContain('fontSize={84}');

      // Cancel that pending request so queue is clean for the next test.
      await app.dispatch('inboxCancel', { id: badCreated.request.id });
      await client.close();
      openClients.delete(client);
    },
    180_000,
  );

  it(
    'claims each request for at most one sampling client and sends notifications/cancelled when cancelled in Studio',
    async () => {
      const clientA = await spawnMcpClient('agent-alpha', { sampling: { tools: {} } });
      const clientB = await spawnMcpClient('agent-beta', { sampling: { tools: {} } });

      await waitFor(() =>
        app.agentState().clients.filter((c) => c.active && c.sampling === 'tools').length >= 2
          ? true
          : undefined,
      );

      let activeCalls = 0;
      let cancelledByServer = false;
      const hangHandler = async (_req: unknown, extra: { signal: AbortSignal }) => {
        activeCalls++;
        await new Promise<void>((resolve) => {
          if (extra.signal.aborted) {
            cancelledByServer = true;
            resolve();
            return;
          }
          extra.signal.addEventListener(
            'abort',
            () => {
              cancelledByServer = true;
              resolve();
            },
            { once: true },
          );
        });
        throw new Error('Request cancelled');
      };
      clientA.setRequestHandler(CreateMessageRequestSchema, hangHandler);
      clientB.setRequestHandler(CreateMessageRequestSchema, hangHandler);

      const created = (
        await app.dispatch('inboxCreate', {
          text: '测试多客户端单次认领与取消传播',
          sceneId: 'intro',
          frame: 0,
          snapshot: false,
          selection: [],
        })
      ) as { request: InboxRequest };

      await waitFor(() => (activeCalls > 0 ? activeCalls : undefined));
      await new Promise((r) => setTimeout(r, 150));
      // Exactly ONE client received sampling/createMessage despite two connected sampling clients!
      expect(activeCalls).toBe(1);

      await app.dispatch('inboxCancel', { id: created.request.id, reason: '用户点击取消' });
      await waitFor(() => (cancelledByServer ? true : undefined));
      expect(cancelledByServer).toBe(true);

      const finalState = ((await app.dispatch('inboxState', {})) as { inbox: InboxRequest[] }).inbox.find(
        (r) => r.id === created.request.id,
      );
      expect(finalState?.status).toBe('cancelled');

      await clientA.close();
      await clientB.close();
      openClients.delete(clientA);
      openClients.delete(clientB);
    },
    180_000,
  );
});
