import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { parseMp4DurationSeconds } from '../src/service/workflow-runner.js';
import {
  buildPortMapForNode,
  computeWireBezierPath,
  socketColorVar,
} from '../src/editor/studio/ComfyGraphCanvas.js';

/** Builds a minimal valid ISO BMFF (`mp4`) container with an exact `moov -> mvhd` duration. */
function makeMinimalMp4Header(durationSeconds: number, timescale = 1000): Buffer {
  const durationUnits = Math.round(durationSeconds * timescale);
  // ftyp box (20 bytes)
  const ftyp = Buffer.alloc(20);
  ftyp.writeUInt32BE(20, 0);
  ftyp.write('ftyp', 4, 'ascii');
  ftyp.write('isom', 8, 'ascii');
  ftyp.writeUInt32BE(0x200, 12);
  ftyp.write('isom', 16, 'ascii');

  // mvhd v0 box (108 bytes total: 8 header + 100 body)
  const mvhd = Buffer.alloc(108);
  mvhd.writeUInt32BE(108, 0);
  mvhd.write('mvhd', 4, 'ascii');
  mvhd[8] = 0; // version 0
  mvhd.writeUInt32BE(timescale, 8 + 12); // timescale at body+12
  mvhd.writeUInt32BE(durationUnits, 8 + 16); // duration at body+16
  mvhd.writeUInt32BE(0x00010000, 8 + 20); // rate 1.0
  mvhd.writeUInt16BE(0x0100, 8 + 24); // volume 1.0

  // moov box (8 + 108 = 116 bytes)
  const moov = Buffer.alloc(8 + mvhd.length);
  moov.writeUInt32BE(8 + mvhd.length, 0);
  moov.write('moov', 4, 'ascii');
  mvhd.copy(moov, 8);

  return Buffer.concat([ftyp, moov]);
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
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 260 * i) / sampleRate) * 5000);
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

function sendWsTextFrame(socket: import('node:stream').Duplex, text: string) {
  const payload = Buffer.from(text, 'utf8');
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : (() => {
          const b = Buffer.alloc(4);
          b[0] = 0x81;
          b[1] = 126;
          b.writeUInt16BE(payload.length, 2);
          return b;
        })();
  socket.write(Buffer.concat([header, payload]));
}

describe('ComfyGraphCanvas UI & 3-Modality Atomic Bake/Ripple/Undo (Stage F3)', () => {
  let comfyServer: http.Server;
  let comfyBaseUrl = '';
  let ttsServer: http.Server;
  let ttsEndpoint = '';

  const uploadedNames: string[] = [];
  const submittedPrompts: Array<Record<string, any>> = [];
  const wsClients = new Map<string, import('node:stream').Duplex>();
  const historyStore = new Map<string, unknown>();
  let generatedPngBytes: Buffer;
  let generatedMp4Bytes: Buffer;

  beforeAll(async () => {
    // 320x180 solid emerald (#18b47c -> RGB 24, 180, 124)
    const outCanvas = createCanvas(320, 180);
    const octx = outCanvas.getContext('2d');
    octx.fillStyle = '#18b47c';
    octx.fillRect(0, 0, 320, 180);
    generatedPngBytes = await outCanvas.encode('png');
    generatedMp4Bytes = makeMinimalMp4Header(4.5, 1000);

    comfyServer = http.createServer(async (req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && u.pathname === '/system_stats') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ system: { comfyui_version: '0.3.12' } }));
        return;
      }
      if (req.method === 'GET' && u.pathname === '/object_info') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({}));
        return;
      }
      if (req.method === 'POST' && u.pathname === '/upload/image') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        const rawBody = Buffer.concat(chunks).toString('latin1');
        const m = rawBody.match(/filename="([^"]+)"/);
        const name = m ? m[1] : `upload_${uploadedNames.length}.png`;
        uploadedNames.push(name);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name, subfolder: '', type: 'input' }));
        return;
      }
      if (req.method === 'POST' && u.pathname === '/prompt') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          client_id: string;
          prompt: Record<string, any>;
        };
        submittedPrompts.push(body.prompt);
        const promptId = `pid_mod_${submittedPrompts.length}`;

        // Detect whether the prompt contains a SaveVideo / SaveWEBM / VHS_VideoCombine node
        const isVideo = Object.values(body.prompt).some(
          (n: any) =>
            n?.class_type === 'SaveVideo' ||
            n?.class_type === 'SaveWEBM' ||
            n?.class_type === 'VHS_VideoCombine' ||
            String(n?.inputs?.filename_prefix ?? '').includes('vid'),
        );
        const outNodeId =
          Object.keys(body.prompt).find(
            (k) =>
              body.prompt[k]?.class_type === 'SaveVideo' ||
              body.prompt[k]?.class_type === 'SaveWEBM' ||
              body.prompt[k]?.class_type === 'SaveImage',
          ) ?? 'out';

        historyStore.set(promptId, {
          outputs: {
            [outNodeId]: isVideo
              ? { videos: [{ filename: `${promptId}.mp4`, subfolder: '', type: 'output' }] }
              : { images: [{ filename: `${promptId}.png`, subfolder: '', type: 'output' }] },
          },
        });

        setTimeout(() => {
          const sock = wsClients.get(body.client_id);
          if (sock && !sock.destroyed) {
            sendWsTextFrame(
              sock,
              JSON.stringify({ type: 'executing', data: { prompt_id: promptId, node: null } }),
            );
          }
        }, 15);

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ prompt_id: promptId, number: submittedPrompts.length }));
        return;
      }
      if (req.method === 'GET' && u.pathname.startsWith('/history/')) {
        const pid = u.pathname.slice('/history/'.length);
        const entry = historyStore.get(pid);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(entry ? { [pid]: entry } : {}));
        return;
      }
      if (req.method === 'GET' && u.pathname === '/view') {
        const fn = u.searchParams.get('filename') ?? '';
        if (fn.endsWith('.mp4')) {
          res.writeHead(200, { 'content-type': 'video/mp4' });
          res.end(generatedMp4Bytes);
        } else {
          res.writeHead(200, { 'content-type': 'image/png' });
          res.end(generatedPngBytes);
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });

    comfyServer.on('upgrade', (req, socket) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      const clientId = u.searchParams.get('clientId') ?? 'default';
      const key = req.headers['sec-websocket-key'];
      if (!key) {
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
          '',
          '',
        ].join('\r\n'),
      );
      wsClients.set(clientId, socket);
    });

    await new Promise<void>((resolve) => comfyServer.listen(0, '127.0.0.1', resolve));
    comfyBaseUrl = `http://127.0.0.1:${(comfyServer.address() as { port: number }).port}`;

    // Local HTTP TTS server returning 3.60s 48kHz WAV + 3 explicit timestamped cues
    ttsServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/tts') {
        for await (const _ of req) {
          /* drain */
        }
        const wav = makePcmWav(3.6, 48000);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            audio_base64: wav.toString('base64'),
            cues: [
              { text: '第一句：传统时间轴与逻辑流实时双向联动', start: 0, end: 1.2 },
              { text: '第二句：无需云端密钥即可接入本地三模态生成', start: 1.2, end: 2.5 },
              { text: '第三句：一键烘焙自动驱动全局波纹与词句字幕', start: 2.5, end: 3.6 },
            ],
          }),
        );
        return;
      }
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((resolve) => ttsServer.listen(0, '127.0.0.1', resolve));
    ttsEndpoint = `http://127.0.0.1:${(ttsServer.address() as { port: number }).port}/tts`;
  });

  afterAll(async () => {
    for (const sock of wsClients.values()) sock.destroy();
    await new Promise<void>((resolve) => comfyServer.close(() => resolve()));
    await new Promise<void>((resolve) => ttsServer.close(() => resolve()));
  });

  it('validates ComfyGraphCanvas helpers, TSX token purity, and MP4 header duration parsing', async () => {
    // 1. Socket colour tokens strictly reference --vm-* CSS custom properties
    expect(socketColorVar('MODEL')).toBe('var(--vm-purple)');
    expect(socketColorVar('CONDITIONING')).toBe('var(--vm-gold)');
    expect(socketColorVar('LATENT')).toBe('var(--vm-coral)');
    expect(socketColorVar('IMAGE')).toBe('var(--vm-ai)');
    expect(socketColorVar('AUDIO')).toBe('var(--vm-success)');
    expect(socketColorVar('CUSTOM_UNKNOWN')).toBe('var(--vm-text-3)');

    // 2. Smooth cubic Bezier wire SVG path
    const pathD = computeWireBezierPath(100, 120, 340, 220);
    expect(pathD.startsWith('M 100 120 C ')).toBe(true);
    expect(pathD.endsWith(', 340 220')).toBe(true);

    // 3. Offline-resilient port map synthesis when ComfyUI /object_info is unreachable
    const allNodes = {
      custom_loader: {
        classType: 'MyOfflineCustomLoader',
        bypass: false,
        mute: false,
        inputs: { weight: 0.75, steps: 20, use_fp16: true },
      },
      consumer: {
        classType: 'MyOfflineConsumer',
        bypass: false,
        mute: false,
        inputs: { upstream_b: { $link: ['custom_loader', 2] as [string, number] } },
      },
    };
    const loaderPorts = buildPortMapForNode(allNodes.custom_loader, allNodes, 'custom_loader', {});
    expect(loaderPorts.inputs.map((p) => [p.name, p.type])).toEqual([
      ['weight', 'FLOAT'],
      ['steps', 'INT'],
      ['use_fp16', 'BOOLEAN'],
    ]);
    // Because consumer links to slot 2, slots 0..2 are synthesized offline!
    expect(loaderPorts.outputs).toHaveLength(3);

    // 4. Verify ComfyGraphCanvas.tsx has zero raw colour literals (#hex, rgb(), hsl())
    const tsxSource = await readFile(
      path.resolve('src/editor/studio/ComfyGraphCanvas.tsx'),
      'utf8',
    );
    const rawColorOffenders = tsxSource
      .split('\n')
      .map((line, idx) => ({ line, no: idx + 1 }))
      .filter(
        ({ line }) =>
          !/theme-ok/.test(line) && /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(line),
      );
    expect(rawColorOffenders).toEqual([]);

    // 5. Verify ISO BMFF MP4 moov -> mvhd parser extracts exact 4.5s duration
    expect(parseMp4DurationSeconds(makeMinimalMp4Header(4.5, 30000)).durationSeconds).toBeCloseTo(
      4.5,
      3,
    );
  });

  it('executes 3-modality workflow_accept (Image, Video extend-shot/fit-speed, Speech TTS) with ripple & 1-step undo', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-f3-modalities-'));
    let app: Application | undefined;
    try {
      await initProject(root, 'F3 3-Modality Bake Test', {
        width: 320,
        height: 180,
        fps: { num: 30, den: 1 },
        durationSeconds: 6,
      });
      app = await new Application(root).open();

      await app.dispatch('workflowProviders', {
        action: 'configure',
        comfyui: { baseUrl: comfyBaseUrl, timeoutMs: 10000 },
        httpLocal: {
          cosyvoice: { preset: 'cosyvoice', endpoint: ttsEndpoint, method: 'POST' },
        },
      });

      const baseSceneId = app.service.snapshot.scenes[0].id;
      const activeSeqId = app.service.snapshot.project.activeSequence!;

      // Initialize a 3-shot split Scene-Flow (2.0s + 2.0s + 2.0s = 6.0s at 30fps) mounted on active sequence
      const initFlow = (await app.dispatch('flowPlan', {
        action: {
          op: 'init',
          flowId: 'main',
          name: '三模态烘焙验证流',
          split: true,
          mountSequenceId: activeSeqId,
          nodes: [
            {
              kind: 'flow-node',
              version: 1,
              id: 'shot-01',
              type: 'shot',
              name: '开场镜',
              enabled: true,
              visual: { kind: 'scene', sceneId: baseSceneId, sourceIn: 0, speed: 1 },
              timing: { mode: 'fixed', seconds: 2, beatsPerBar: 4, padStart: 0, padEnd: 0 },
              overlays: [],
            },
            {
              kind: 'flow-node',
              version: 1,
              id: 'shot-02',
              type: 'shot',
              name: '中景生视频镜',
              enabled: true,
              visual: { kind: 'scene', sceneId: baseSceneId, sourceIn: 0, speed: 1 },
              timing: { mode: 'fixed', seconds: 2, beatsPerBar: 4, padStart: 0, padEnd: 0 },
              overlays: [],
            },
            {
              kind: 'flow-node',
              version: 1,
              id: 'shot-03',
              type: 'shot',
              name: '收尾镜',
              enabled: true,
              visual: { kind: 'scene', sceneId: baseSceneId, sourceIn: 0, speed: 1 },
              timing: { mode: 'fixed', seconds: 2, beatsPerBar: 4, padStart: 0, padEnd: 0 },
              overlays: [],
            },
          ],
        },
      })) as any;
      await app.dispatch('projectApply', initFlow.apply);
      const flowPath = initFlow.flowPath as string;

      // ────────────────────────────────────────────────────────────────────────
      // MODALITY 1: IMAGE (`comfy-txt2img`) -> Flow Shot + Traditional Scene + 1-Step Undo
      // ────────────────────────────────────────────────────────────────────────
      const imgWfPlan = (await app.dispatch('workflowPlan', {
        action: { op: 'create', id: 'keyframe-img', template: 'comfy-txt2img' },
      })) as any;
      await app.dispatch('projectApply', imgWfPlan.apply);

      const bindImgPlan = (await app.dispatch('workflowPlan', {
        workflowPath: imgWfPlan.workflowPath,
        action: { op: 'bindToFlowNode', flowPath, nodeId: 'shot-01', slot: 'visual' },
      })) as any;
      await app.dispatch('projectApply', bindImgPlan.apply);

      // Before baking, shot-01 is flagged as unbaked.visual === true
      const outlineBeforeImg = (await app.dispatch('flowOutline', { flowPath })) as any;
      expect(outlineBeforeImg.items.find((i: any) => i.id === 'shot-01').unbaked.visual).toBe(true);

      const runImg = (await app.dispatch('workflowRun', {
        workflowPath: imgWfPlan.workflowPath,
        flowPath,
        nodeId: 'shot-01',
        seed: 777,
      })) as any;
      expect(runImg.takes).toHaveLength(1);
      const imgTakeId = runImg.takes[0].takeId as string;

      // Accept image take onto shot-01 -> preflight -> apply
      const acceptImgShot = (await app.dispatch('workflowAccept', {
        takeId: imgTakeId,
        flowPath,
        nodeId: 'shot-01',
        slot: 'visual',
      })) as any;
      const preflightImg = (await app.dispatch('projectPreflight', {
        ...acceptImgShot.candidate,
        visual: false,
      })) as any;
      expect(preflightImg.valid).toBe(true);
      await app.dispatch('projectApply', acceptImgShot.apply);

      // Verify unbaked.visual turned false, provenance stored, and isolated flowPreviewNode renders #18b47c!
      const outlineAfterImg = (await app.dispatch('flowOutline', { flowPath })) as any;
      expect(outlineAfterImg.items.find((i: any) => i.id === 'shot-01').unbaked.visual).toBe(false);
      await expect(stat(path.join(root, acceptImgShot.assetPath))).resolves.toBeTruthy();

      const bakedAsset = app.service.snapshot.project.assets.find(
        (a) => a.id === acceptImgShot.assetId,
      )!;
      expect((bakedAsset.metadata as any).generativeProvenance).toMatchObject({
        takeId: imgTakeId,
        provider: 'comfyui',
        modality: 'image',
        seed: 777,
      });

      const previewRes = (await app.dispatch('flowPreviewNode', {
        flowPath,
        nodeId: 'shot-01',
        localSeconds: 0.5,
        width: 320,
        inline: true,
      })) as any;
      const renderedImg = await loadImage(Buffer.from(previewRes.data, 'base64'));
      const checkCanvas = createCanvas(renderedImg.width, renderedImg.height);
      const cctx = checkCanvas.getContext('2d');
      cctx.drawImage(renderedImg, 0, 0);
      const px = cctx.getImageData(160, 90, 1, 1).data;
      expect(Math.abs(px[0] - 24)).toBeLessThanOrEqual(3);
      expect(Math.abs(px[1] - 180)).toBeLessThanOrEqual(3);
      expect(Math.abs(px[2] - 124)).toBeLessThanOrEqual(3);

      // 1-step Undo reverts BOTH project.assets AND nodes/shot-01.json!
      await app.dispatch('undo', {});
      expect(
        app.service.snapshot.project.assets.some((a) => a.id === acceptImgShot.assetId),
      ).toBe(false);
      const outlineUndoImg = (await app.dispatch('flowOutline', { flowPath })) as any;
      expect(outlineUndoImg.items.find((i: any) => i.id === 'shot-01').unbaked.visual).toBe(true);

      // Also verify workflowAccept directly onto a traditional Scene (`sceneId`) + 1-step Undo
      const origNodeCount = app.service.snapshot.scenes.find((s) => s.id === baseSceneId)!.nodes
        .length;
      const acceptImgScene = (await app.dispatch('workflowAccept', {
        takeId: imgTakeId,
        sceneId: baseSceneId,
        assetId: 'scene_baked_img',
        layerId: 'baked_bg_layer',
      })) as any;
      await app.dispatch('projectApply', acceptImgScene.apply);
      const updatedScene = app.service.snapshot.scenes.find((s) => s.id === baseSceneId)!;
      expect(updatedScene.nodes.length).toBe(origNodeCount + 1);
      expect(updatedScene.nodes.some((n) => n.id === 'baked_bg_layer')).toBe(true);
      await app.dispatch('undo', {});
      expect(app.service.snapshot.scenes.find((s) => s.id === baseSceneId)!.nodes.length).toBe(
        origNodeCount,
      );

      // ────────────────────────────────────────────────────────────────────────
      // MODALITY 2: VIDEO (`comfy-i2v-4n1`) -> 4n+1 Context + `extend-shot` Ripple & `fit-speed` + Undo
      // ────────────────────────────────────────────────────────────────────────
      const vidWfPlan = (await app.dispatch('workflowPlan', {
        action: { op: 'create', id: 'shot02-i2v', template: 'comfy-i2v-4n1' },
      })) as any;
      await app.dispatch('projectApply', vidWfPlan.apply);

      // Wire ShotContext slot 0 (prev_end_frame from shot-01) into i2v_latent.start_image for seamless shot continuity
      const wirePrevPlan = (await app.dispatch('workflowPlan', {
        workflowPath: vidWfPlan.workflowPath,
        action: {
          op: 'connect',
          fromNode: 'shot_ctx',
          fromSlot: 0,
          toNode: 'i2v_latent',
          toInput: 'start_image',
        },
      })) as any;
      await app.dispatch('projectApply', wirePrevPlan.apply);

      const runVid = (await app.dispatch('workflowRun', {
        workflowPath: vidWfPlan.workflowPath,
        flowPath,
        nodeId: 'shot-02',
        seed: 2026,
      })) as any;
      expect(runVid.takes).toHaveLength(1);
      // Verify 4.5s duration parsed from ISO BMFF MP4 header!
      expect(runVid.takes[0].durationSeconds).toBeCloseTo(4.5, 2);
      // Verify ShotContext uploaded prev_end_frame from shot-01 and injected 4n+1 aligned frames (60 -> 61)!
      expect(uploadedNames.some((n) => n.includes('vmotion_prev_'))).toBe(true);
      const vidPrompt = submittedPrompts.at(-1)!;
      expect(vidPrompt.i2v_latent.inputs.length).toBe(61);

      // 2A. Accept video with `fitPolicy: 'extend-shot'`: shot-02 (2.0s) stretches to 4.5s and ripples shot-03 from 4.0s -> 6.5s!
      const acceptVidExtend = (await app.dispatch('workflowAccept', {
        takeId: runVid.takes[0].takeId,
        flowPath,
        nodeId: 'shot-02',
        fitPolicy: 'extend-shot',
      })) as any;
      await app.dispatch('projectApply', acceptVidExtend.apply);

      const outlineExtend = (await app.dispatch('flowOutline', { flowPath })) as any;
      const s2Extend = outlineExtend.items.find((i: any) => i.id === 'shot-02');
      const s3Extend = outlineExtend.items.find((i: any) => i.id === 'shot-03');
      expect(s2Extend.unbaked.visual).toBe(false);
      expect(s2Extend.durationFrames).toBe(135); // 4.5s * 30fps = 135f
      expect(s3Extend.startSeconds).toBeCloseTo(6.5, 2); // 2.0s + 4.5s = 6.5s!

      // 1-step Undo restores shot-02 to 2.0s (60f) and shot-03 to 4.0s!
      await app.dispatch('undo', {});
      const outlineUndoExtend = (await app.dispatch('flowOutline', { flowPath })) as any;
      expect(outlineUndoExtend.items.find((i: any) => i.id === 'shot-02').durationFrames).toBe(60);
      expect(outlineUndoExtend.items.find((i: any) => i.id === 'shot-03').startSeconds).toBeCloseTo(
        4.0,
        2,
      );

      // 2B. Accept video with `fitPolicy: 'fit-speed'`: shot-02 keeps 2.0s slot while clip speed adjusts to 4.5 / 2.0 = 2.25!
      const acceptVidSpeed = (await app.dispatch('workflowAccept', {
        takeId: runVid.takes[0].takeId,
        flowPath,
        nodeId: 'shot-02',
        fitPolicy: 'fit-speed',
      })) as any;
      await app.dispatch('projectApply', acceptVidSpeed.apply);

      const outlineSpeed = (await app.dispatch('flowOutline', { flowPath })) as any;
      expect(outlineSpeed.items.find((i: any) => i.id === 'shot-02').durationFrames).toBe(60);
      expect(outlineSpeed.items.find((i: any) => i.id === 'shot-03').startSeconds).toBeCloseTo(
        4.0,
        2,
      );
      const videoTrack = app.service.snapshot.sequences
        .find((s) => s.id === activeSeqId)!
        .tracks.find((t) => t.id === 'flow/main/video')!;
      const shot02Clip = videoTrack.clips.find((c) => c.id.includes('shot-02'))!;
      expect(shot02Clip.speed).toBeCloseTo(2.25, 2);

      await app.dispatch('undo', {});

      // ────────────────────────────────────────────────────────────────────────
      // MODALITY 3: SPEECH (`local-tts`) -> Follow-Voice Ripple + Frame-Accurate Subtitle Cues + Undo
      // ────────────────────────────────────────────────────────────────────────
      const setupVoiceShot = (await app.dispatch('flowPlan', {
        flowPath,
        action: {
          op: 'upsertNode',
          node: {
            kind: 'flow-node',
            version: 1,
            id: 'shot-01',
            type: 'shot',
            name: '开场口播镜',
            enabled: true,
            visual: { kind: 'scene', sceneId: baseSceneId, sourceIn: 0, speed: 1 },
            timing: { mode: 'follow-voice', beatsPerBar: 4, padStart: 0, padEnd: 0.2 },
            voice: {
              kind: 'tts',
              text: '第一句：传统时间轴与逻辑流实时双向联动。第二句：无需云端密钥即可接入本地三模态生成。第三句：一键烘焙自动驱动全局波纹与词句字幕。',
              provider: 'http-local',
              speed: 1,
              volume: 1,
            },
            subtitle: { mode: 'from-voice' },
            overlays: [],
          },
        },
      })) as any;
      await app.dispatch('projectApply', setupVoiceShot.apply);

      const outlinePreTts = (await app.dispatch('flowOutline', { flowPath })) as any;
      expect(outlinePreTts.items.find((i: any) => i.id === 'shot-01').unbaked.voice).toBe(true);

      const ttsWfPlan = (await app.dispatch('workflowPlan', {
        action: { op: 'create', id: 'shot01-tts', template: 'local-tts' },
      })) as any;
      await app.dispatch('projectApply', ttsWfPlan.apply);

      const runTts = (await app.dispatch('workflowRun', {
        workflowPath: ttsWfPlan.workflowPath,
        flowPath,
        nodeId: 'shot-01',
      })) as any;
      expect(runTts.takes).toHaveLength(1);
      expect(runTts.takes[0].durationSeconds).toBeCloseTo(3.6, 2);
      expect(runTts.takes[0].cuesCount).toBe(3);

      const acceptTts = (await app.dispatch('workflowAccept', {
        takeId: runTts.takes[0].takeId,
        flowPath,
        nodeId: 'shot-01',
        slot: 'voice',
      })) as any;
      await app.dispatch('projectApply', acceptTts.apply);

      // Verify unbaked.voice === false, shot-01 ripples to 3.6s + 0.2s = 3.8s (114f), shot-02 ripples to 3.8s, and 3 subtitle clips exist!
      const outlinePostTts = (await app.dispatch('flowOutline', { flowPath })) as any;
      const s1PostTts = outlinePostTts.items.find((i: any) => i.id === 'shot-01');
      const s2PostTts = outlinePostTts.items.find((i: any) => i.id === 'shot-02');
      expect(s1PostTts.unbaked.voice).toBe(false);
      expect(s1PostTts.durationFrames).toBe(114); // 3.8s * 30fps
      expect(s2PostTts.startSeconds).toBeCloseTo(3.8, 2);

      const mountedSeq = app.service.snapshot.sequences.find((s) => s.id === activeSeqId)!;
      const subTrack = mountedSeq.tracks.find((t) => t.id === 'flow/main/subtitles')!;
      expect(subTrack).toBeDefined();
      expect(subTrack.clips).toHaveLength(3);
      expect(subTrack.clips.map((c) => [c.start, c.duration])).toEqual([
        [0, 36], // 0.0s..1.2s
        [36, 39], // 1.2s..2.5s
        [75, 33], // 2.5s..3.6s
      ]);

      // 1-step Undo reverts both the WAV asset and shot-01's unbaked TTS state!
      await app.dispatch('undo', {});
      const outlineUndoTts = (await app.dispatch('flowOutline', { flowPath })) as any;
      expect(outlineUndoTts.items.find((i: any) => i.id === 'shot-01').unbaked.voice).toBe(true);
      expect(app.service.snapshot.project.assets.some((a) => a.id === acceptTts.assetId)).toBe(
        false,
      );
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
