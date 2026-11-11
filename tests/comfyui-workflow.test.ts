import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { zlibSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alignLatentFrames4n1, generativeWorkflowSchema } from '../src/core/workflow-schema.js';
import {
  extractComfyWorkflowFromPng,
  importComfyApiWorkflow,
  importComfyWebWorkflow,
} from '../src/core/workflow-convert.js';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { buildInboxContext, InboxStore } from '../src/service/inbox.js';

/** Builds a valid minimal PNG with custom `tEXt` and/or `zTXt` chunks for workflow extraction tests. */
async function buildPngWithMetadataChunks(chunks: {
  tEXt?: Record<string, string>;
  zTXt?: Record<string, string>;
}): Promise<Uint8Array> {
  const canvas = createCanvas(64, 48);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2468ac';
  ctx.fillRect(0, 0, 64, 48);
  const basePng = await canvas.encode('png');

  // Insert custom chunks right before IEND (last 12 bytes of a standard PNG)
  const iendOffset = basePng.length - 12;
  const head = basePng.subarray(0, iendOffset);
  const tail = basePng.subarray(iendOffset);

  const encodeChunk = (type: string, data: Uint8Array): Buffer => {
    const buf = Buffer.alloc(12 + data.length);
    buf.writeUInt32BE(data.length, 0);
    buf.write(type, 4, 4, 'latin1');
    Buffer.from(data).copy(buf, 8);
    // CRC32 (extractComfyWorkflowFromPng skips CRC validation for speed, write 0)
    buf.writeUInt32BE(0, 8 + data.length);
    return buf;
  };

  const extra: Buffer[] = [];
  for (const [k, v] of Object.entries(chunks.tEXt ?? {})) {
    const keyBytes = Buffer.from(k, 'latin1');
    const valBytes = Buffer.from(v, 'utf8');
    extra.push(encodeChunk('tEXt', Buffer.concat([keyBytes, Buffer.from([0]), valBytes])));
  }
  for (const [k, v] of Object.entries(chunks.zTXt ?? {})) {
    const keyBytes = Buffer.from(k, 'latin1');
    const compressed = Buffer.from(zlibSync(Buffer.from(v, 'utf8')));
    // keyword + NUL + compression_method(0) + zlib stream
    extra.push(encodeChunk('zTXt', Buffer.concat([keyBytes, Buffer.from([0, 0]), compressed])));
  }

  return new Uint8Array(Buffer.concat([head, ...extra, tail]));
}

/** Synthesizes a valid 16-bit PCM RIFF/WAVE buffer with exact durationSeconds. */
function makePcmWav(durationSeconds: number, sampleRate = 48000): Buffer {
  const numSamples = Math.round(durationSeconds * sampleRate);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // Mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // ByteRate
  buf.writeUInt16LE(2, 32); // BlockAlign
  buf.writeUInt16LE(16, 34); // BitsPerSample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 6000);
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

/** Sends a single unmasked RFC6455 text WebSocket frame from server to client. */
function sendWsTextFrame(socket: import('node:stream').Duplex, text: string) {
  const payload = Buffer.from(text, 'utf8');
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

describe('ComfyUI & Multi-Provider Generative Workflow Engine (Stage F2)', () => {
  let comfyServer: http.Server;
  let comfyBaseUrl = '';
  let ttsServer: http.Server;
  let ttsEndpoint = '';

  const uploadedBlobs = new Map<string, Buffer>();
  const submittedPrompts: Array<Record<string, unknown>> = [];
  const wsClients = new Map<string, import('node:stream').Duplex>();
  const historyStore = new Map<string, unknown>();
  let generatedPngBytes: Buffer;
  let interruptCount = 0;

  beforeAll(async () => {
    const outCanvas = createCanvas(320, 180);
    const octx = outCanvas.getContext('2d');
    octx.fillStyle = '#18b47c';
    octx.fillRect(0, 0, 320, 180);
    generatedPngBytes = await outCanvas.encode('png');

    // Start Mock ComfyUI HTTP + RFC6455 WebSocket server
    comfyServer = http.createServer(async (req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (req.method === 'GET' && u.pathname === '/system_stats') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ system: { comfyui_version: '0.3.12' }, devices: [{ name: 'MockGPU', vram_total: 24_000_000_000 }] }));
        return;
      }

      if (req.method === 'GET' && u.pathname === '/object_info') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            CheckpointLoaderSimple: {
              display_name: 'Load Checkpoint',
              category: 'loaders',
              input: {
                required: {
                  ckpt_name: [['v1-5-pruned-emaonly.safetensors', 'wan2.1_i2v_480p.safetensors']],
                },
              },
              output: ['MODEL', 'CLIP', 'VAE'],
              output_name: ['MODEL', 'CLIP', 'VAE'],
              output_node: false,
            },
            CLIPTextEncode: {
              display_name: 'CLIP Text Encode (Prompt)',
              category: 'conditioning',
              input: {
                required: {
                  text: ['STRING', { multiline: true, default: '' }],
                  clip: ['CLIP'],
                },
              },
              output: ['CONDITIONING'],
              output_name: ['CONDITIONING'],
              output_node: false,
            },
            VAEEncodeForInpaint: {
              display_name: 'VAE Encode (for Inpainting)',
              category: 'latent/inpaint',
              input: {
                required: {
                  pixels: ['IMAGE'],
                  vae: ['VAE'],
                  mask: ['MASK'],
                  grow_mask_by: ['INT', { default: 6, min: 0, max: 64 }],
                },
              },
              output: ['LATENT'],
              output_name: ['LATENT'],
              output_node: false,
            },
            KSampler: {
              display_name: 'KSampler',
              category: 'sampling',
              input: {
                required: {
                  model: ['MODEL'],
                  seed: ['INT', { default: 0, min: 0, max: 999999999 }],
                  steps: ['INT', { default: 20, min: 1, max: 100 }],
                  cfg: ['FLOAT', { default: 7.5, min: 0, max: 30, step: 0.5 }],
                  sampler_name: [['euler', 'uni_pc']],
                  scheduler: [['normal', 'simple']],
                  positive: ['CONDITIONING'],
                  negative: ['CONDITIONING'],
                  latent_image: ['LATENT'],
                  denoise: ['FLOAT', { default: 1.0, min: 0, max: 1, step: 0.05 }],
                },
              },
              output: ['LATENT'],
              output_name: ['LATENT'],
              output_node: false,
            },
            SaveImage: {
              display_name: 'Save Image',
              category: 'image',
              input: {
                required: {
                  images: ['IMAGE'],
                  filename_prefix: ['STRING', { default: 'ComfyUI' }],
                },
              },
              output: [],
              output_node: true,
            },
          }),
        );
        return;
      }

      if (req.method === 'POST' && u.pathname === '/upload/image') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        const rawBody = Buffer.concat(chunks);
        // Extract filename and PNG signature slice from multipart body
        const headerStr = rawBody.subarray(0, Math.min(rawBody.length, 600)).toString('latin1');
        const fnMatch = /filename="([^"]+)"/.exec(headerStr);
        const filename = fnMatch ? fnMatch[1] : `upload_${uploadedBlobs.size}.png`;
        const pngStart = rawBody.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const iendIdx = rawBody.indexOf(Buffer.from('IEND'), Math.max(0, pngStart));
        if (pngStart >= 0 && iendIdx > pngStart) {
          uploadedBlobs.set(filename, rawBody.subarray(pngStart, iendIdx + 8));
        } else {
          uploadedBlobs.set(filename, rawBody);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: filename, subfolder: '', type: 'input' }));
        return;
      }

      if (req.method === 'POST' && u.pathname === '/prompt') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          prompt: Record<string, unknown>;
          client_id?: string;
        };
        submittedPrompts.push(body.prompt);
        const promptId = `prompt_${submittedPrompts.length}`;

        // Emit live WS frames asynchronously
        setTimeout(() => {
          const sock = body.client_id ? wsClients.get(body.client_id) : undefined;
          if (sock && !sock.destroyed) {
            sendWsTextFrame(
              sock,
              JSON.stringify({ type: 'executing', data: { prompt_id: promptId, node: 'sampler' } }),
            );
            sendWsTextFrame(
              sock,
              JSON.stringify({ type: 'progress', data: { prompt_id: promptId, value: 20, max: 20 } }),
            );
          }
          historyStore.set(promptId, {
            outputs: {
              img_out: {
                images: [{ filename: `${promptId}_out.png`, subfolder: '', type: 'output' }],
              },
            },
          });
          if (sock && !sock.destroyed) {
            sendWsTextFrame(
              sock,
              JSON.stringify({ type: 'executing', data: { prompt_id: promptId, node: null } }),
            );
          }
        }, 25);

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ prompt_id: promptId, number: submittedPrompts.length }));
        return;
      }

      if (req.method === 'GET' && u.pathname.startsWith('/history/')) {
        const pid = decodeURIComponent(u.pathname.slice('/history/'.length));
        const entry = historyStore.get(pid);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(entry ? { [pid]: entry } : {}));
        return;
      }

      if (req.method === 'GET' && u.pathname === '/view') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(generatedPngBytes);
        return;
      }

      if (req.method === 'POST' && u.pathname === '/interrupt') {
        interruptCount++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ interrupted: true }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    comfyServer.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      if (!key || typeof key !== 'string') {
        socket.destroy();
        return;
      }
      const accept = createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '\r\n',
        ].join('\r\n'),
      );
      const u = new URL(req.url ?? '/ws', 'http://127.0.0.1');
      const clientId = u.searchParams.get('clientId') ?? 'default';
      wsClients.set(clientId, socket);
      socket.on('close', () => wsClients.delete(clientId));
      socket.on('error', () => wsClients.delete(clientId));
    });

    await new Promise<void>((resolve) => comfyServer.listen(0, '127.0.0.1', resolve));
    const comfyAddr = comfyServer.address() as { port: number };
    comfyBaseUrl = `http://127.0.0.1:${comfyAddr.port}`;

    // Start Mock Local HTTP TTS Server (CosyVoice style)
    ttsServer = http.createServer(async (req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method === 'POST' && req.url === '/tts') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          text: string;
          speed?: number;
        };
        const wav = makePcmWav(payload.speed && payload.speed > 1 ? 1.8 : 2.5, 48000);
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(wav);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => ttsServer.listen(0, '127.0.0.1', resolve));
    const ttsAddr = ttsServer.address() as { port: number };
    ttsEndpoint = `http://127.0.0.1:${ttsAddr.port}/tts`;
  });

  afterAll(async () => {
    for (const s of wsClients.values()) s.destroy();
    comfyServer?.closeAllConnections();
    comfyServer?.close();
    ttsServer?.closeAllConnections();
    ttsServer?.close();
  });

  it('converts ComfyUI API JSON, Web UI JSON (Reroute + Primitive + seed control) and PNG tEXt/zTXt chunks, and rejects cycles', async () => {
    expect(alignLatentFrames4n1(1)).toBe(1);
    expect(alignLatentFrames4n1(80)).toBe(81);
    expect(alignLatentFrames4n1(90)).toBe(89);

    // 1. Web UI JSON with Reroute, PrimitiveNode, and seed control_after_generate='randomize'
    const webJson = {
      nodes: [
        {
          id: 1,
          type: 'CheckpointLoaderSimple',
          pos: [40, 80],
          outputs: [{ name: 'MODEL', type: 'MODEL' }, { name: 'CLIP', type: 'CLIP' }, { name: 'VAE', type: 'VAE' }],
          widgets_values: ['sdxl.safetensors'],
        },
        {
          id: 2,
          type: 'Reroute',
          inputs: [{ name: '', link: 10 }],
          outputs: [{ name: '', type: 'MODEL' }],
        },
        {
          id: 3,
          type: 'PrimitiveNode',
          outputs: [{ name: 'INT', type: 'INT' }],
          widgets_values: [28],
        },
        {
          id: 4,
          type: 'KSampler',
          pos: [420, 120],
          inputs: [
            { name: 'model', type: 'MODEL', link: 11 },
            { name: 'steps', type: 'INT', link: 12, widget: { name: 'steps' } },
            { name: 'seed', type: 'INT', link: null, widget: { name: 'seed' } },
            { name: 'cfg', type: 'FLOAT', link: null, widget: { name: 'cfg' } },
          ],
          outputs: [{ name: 'LATENT', type: 'LATENT' }],
          widgets_values: [20, 777888, 'randomize', 6.5],
        },
      ],
      links: [
        [10, 1, 0, 2, 0, 'MODEL'],
        [11, 2, 0, 4, 0, 'MODEL'],
        [12, 3, 0, 4, 1, 'INT'],
      ],
    };

    const importedWeb = importComfyWebWorkflow(webJson, { id: 'web-import' });
    expect(importedWeb.nodes['2']).toBeUndefined(); // Reroute collapsed
    expect(importedWeb.nodes['3']).toBeUndefined(); // PrimitiveNode inlined
    expect(importedWeb.nodes['4'].inputs.model).toEqual({ $link: ['1', 0] });
    expect(importedWeb.nodes['4'].inputs.steps).toBe(28); // From PrimitiveNode
    expect(importedWeb.nodes['4'].inputs.seed).toBe(777888);
    expect(importedWeb.nodes['4'].inputs.cfg).toBe(6.5); // Correctly skipped 'randomize'!
    expect(importedWeb.nodes['4'].pos).toEqual([420, 120]);

    // 2. PNG zTXt compressed prompt + tEXt layout extraction
    const apiJson = {
      '10': {
        class_type: 'CLIPTextEncode',
        inputs: { text: 'cyberpunk neon alley', clip: ['1', 1] },
      },
      '1': {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: 'sdxl.safetensors' },
      },
    };
    const pngBytes = await buildPngWithMetadataChunks({
      zTXt: { prompt: JSON.stringify(apiJson) },
      tEXt: {
        workflow: JSON.stringify({
          nodes: [{ id: 10, type: 'CLIPTextEncode', pos: [333, 444], title: 'Neon Prompt' }],
          links: [],
        }),
      },
    });
    const fromPng = extractComfyWorkflowFromPng(pngBytes, { id: 'png-wf' });
    expect(fromPng.nodes['10'].inputs.text).toBe('cyberpunk neon alley');
    expect(fromPng.nodes['10'].inputs.clip).toEqual({ $link: ['1', 1] });
    expect(fromPng.nodes['10'].pos).toEqual([333, 444]);
    expect(fromPng.nodes['10'].title).toBe('Neon Prompt');
    expect(fromPng.pinnedInputs.prompt).toMatchObject({ nodeId: '10', inputName: 'text' });

    // 3. Cycle rejection
    const cyclic = structuredClone(importComfyApiWorkflow(apiJson, { id: 'cyc' }));
    cyclic.nodes['1'].inputs.loop = { $link: ['10', 0] };
    expect(() => generativeWorkflowSchema.parse(cyclic)).toThrow(/cycle/i);
  });

  it('executes end-to-end ComfyUI Inpaint + Local TTS + Agent Inbox workflows, stages takes, and cleans cache', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-comfy-f2-'));
    let app: Application | undefined;
    try {
      await initProject(root, 'Comfy F2 Film', {
        width: 320,
        height: 180,
        fps: { num: 24, den: 1 },
        durationSeconds: 4,
      });
      app = await new Application(root).open();

      // 1. Configure local ComfyUI + HTTP TTS providers (.vmotion/providers.local.json)
      const provRes = (await app.dispatch('workflowProviders', {
        action: 'configure',
        probe: true,
        comfyui: { baseUrl: comfyBaseUrl },
        httpLocal: {
          cosyvoice: { preset: 'cosyvoice', endpoint: ttsEndpoint, method: 'POST', timeoutMs: 15_000 },
        },
      })) as any;
      expect(provRes.aiCloudKeysEmbedded).toBe(false);
      expect(provRes.comfyui.probe.reachable).toBe(true);
      expect(provRes.httpLocal.cosyvoice.probe.reachable).toBe(true);

      // 2. Dynamic `/object_info` query + offline cache check
      const maskNodes = (await app.dispatch('workflowNodesQuery', {
        refresh: true,
        inputType: 'MASK',
        detail: true,
      })) as any;
      expect(maskNodes.source).toBe('live');
      expect(maskNodes.items.some((i: any) => i.classType === 'VAEEncodeForInpaint')).toBe(true);

      const cachedQuery = (await app.dispatch('workflowNodesQuery', {
        refresh: false,
        search: 'sampler',
      })) as any;
      expect(cachedQuery.source).toBe('cached');
      expect(cachedQuery.items.some((i: any) => i.classType === 'KSampler')).toBe(true);

      // 3. Create split flow + bind starter workflows
      const flowInit = (await app.dispatch('flowPlan', {
        action: { op: 'fromSequence', flowId: 'main', split: true, mount: true },
      })) as any;
      await app.dispatch('projectPreflight', { ...flowInit.candidate, visual: false });
      await app.dispatch('projectApply', flowInit.apply);

      const outline = (await app.dispatch('flowOutline', {})) as any;
      const firstNodeId = outline.items[0].id as string;

      // Create ComfyUI Canvas Inpaint workflow
      const wfPlan = (await app.dispatch('workflowPlan', {
        action: { op: 'create', id: 'shot-inpaint', template: 'comfy-inpaint-canvas' },
      })) as any;
      await app.dispatch('projectPreflight', { ...wfPlan.candidate, visual: false });
      await app.dispatch('projectApply', wfPlan.apply);

      // Create a Canvas Inbox request with painted brush strokes in center (160, 90)
      const inbox = new InboxStore(root);
      const maskCtx = buildInboxContext(app.service.snapshot, {
        text: '把这个区域重绘成霓虹灯牌',
        sequenceId: app.service.snapshot.project.activeSequence,
        frame: 0,
        selection: [],
        mask: {
          strokes: [
            {
              mode: 'brush',
              radius: 24,
              points: [
                { x: 140, y: 90 },
                { x: 180, y: 90 },
              ],
            },
          ],
        },
      });
      const inboxReq = await inbox.create(maskCtx, '把这个区域重绘成霓虹灯牌');

      // Run 2 ComfyUI takes with CanvasFrame + InpaintMask bridge!
      const runImg = (await app.dispatch('workflowRun', {
        workflowPath: wfPlan.workflowPath,
        nodeId: firstNodeId,
        inboxRequestId: inboxReq.id,
        params: { prompt: 'glowing neon signboard' },
        seed: 500,
        takes: 2,
      })) as any;

      expect(runImg.status).toBe('completed');
      expect(runImg.takes).toHaveLength(2);
      expect(runImg.takes[0].seed).toBe(500);
      expect(runImg.takes[1].seed).toBe(501);
      expect(runImg.takes[0].width).toBe(320);
      expect(runImg.takes[0].height).toBe(180);

      // Verify ComfyUI received uploaded RGBA mask with alpha===0 inside painted stroke (160,90) and alpha===255 at corner (4,4)!
      const uploadedMaskKey = [...uploadedBlobs.keys()].find((k) => k.startsWith('vmotion_mask_'));
      expect(uploadedMaskKey).toBeDefined();
      const maskImg = await loadImage(uploadedBlobs.get(uploadedMaskKey!)!);
      const verifyCanvas = createCanvas(maskImg.width, maskImg.height);
      const vctx = verifyCanvas.getContext('2d');
      vctx.drawImage(maskImg, 0, 0);
      const centerPixel = vctx.getImageData(160, 90, 1, 1).data;
      const cornerPixel = vctx.getImageData(4, 4, 1, 1).data;
      expect(centerPixel[3]).toBe(0); // Transparent -> ComfyUI LoadImage MASK = 1.0!
      expect(cornerPixel[3]).toBe(255); // Opaque -> ComfyUI LoadImage MASK = 0.0!

      // Verify compiled prompt wired LoadImage slot 1 for mask!
      const lastPrompt = submittedPrompts.at(-1)! as Record<string, any>;
      expect(lastPrompt.encode_inpaint.inputs.mask).toEqual(['inpaint_mask', 1]);
      expect(lastPrompt.pos_prompt.inputs.text).toBe('glowing neon signboard');

      // 4. Create & Run Local HTTP TTS workflow (`local-tts`) -> 2.5s WAV + proportional cues
      const ttsPlan = (await app.dispatch('workflowPlan', {
        action: { op: 'create', id: 'narrator-tts', template: 'local-tts' },
      })) as any;
      await app.dispatch('projectPreflight', { ...ttsPlan.candidate, visual: false });
      await app.dispatch('projectApply', ttsPlan.apply);

      const runTts = (await app.dispatch('workflowRun', {
        workflowPath: ttsPlan.workflowPath,
        nodeId: firstNodeId,
        params: { text: '第一句开场白，第二句核心亮点，第三句收尾总结。' },
      })) as any;
      expect(runTts.status).toBe('completed');
      expect(runTts.takes).toHaveLength(1);
      expect(runTts.takes[0].durationSeconds).toBeCloseTo(2.5, 2);
      expect(runTts.takes[0].cuesCount).toBe(3);

      // 5. Create & Run Agent-Inbox workflow (`inbox-gen`) -> queues structured pending request
      const inboxGenPlan = (await app.dispatch('workflowPlan', {
        action: { op: 'create', id: 'ext-agent-img', template: 'inbox-gen' },
      })) as any;
      await app.dispatch('projectPreflight', { ...inboxGenPlan.candidate, visual: false });
      await app.dispatch('projectApply', inboxGenPlan.apply);

      const runInbox = (await app.dispatch('workflowRun', {
        workflowPath: inboxGenPlan.workflowPath,
        nodeId: firstNodeId,
        params: { prompt: 'hand-drawn ink storyboard keyframe' },
      })) as any;
      expect(runInbox.status).toBe('queued-inbox');
      const queuedReq = await inbox.get(runInbox.inboxRequestId);
      expect(queuedReq.status).toBe('pending');
      expect(queuedReq.context.snapshot).toBeTruthy();

      // 6. Verify `workflowTakes` lists all 3 staged takes, and `cachePlan` (`gen-takes`) reclaims them cleanly!
      const listedTakes = (await app.dispatch('workflowTakes', { action: 'list' })) as any;
      expect(listedTakes.total).toBe(3);

      const cachePlanRes = (await app.dispatch('cachePlan', {
        groups: ['gen-takes'],
        maxBytes: 0,
        minAgeSeconds: 0,
      })) as any;
      expect(cachePlanRes.fileCount).toBeGreaterThanOrEqual(6); // 3 output files + 3 take.json files
      await app.dispatch('cacheApply', { planId: cachePlanRes.planId });

      const afterClean = (await app.dispatch('workflowTakes', { action: 'list' })) as any;
      expect(afterClean.total).toBe(0);

      // Verify project.vmotion.json never stored provider URLs or cloud keys
      const rawManifest = await readFile(path.join(root, 'project.vmotion.json'), 'utf8');
      expect(rawManifest).not.toContain(comfyBaseUrl);
      await expect(stat(path.join(root, '.vmotion/providers.local.json'))).resolves.toBeTruthy();
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
