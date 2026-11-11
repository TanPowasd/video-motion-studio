import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/service/template.js';
import { ProjectService } from '../src/service/service.js';
import { loadProject, parseFiles, serialize, validateSnapshot, json } from '../src/service/project.js';
import { ProjectReferences } from '../src/core/project-references.js';
import { Renderer } from '../src/core/renderer.js';
import { resolveAgentPlan } from '../src/service/agent-plans.js';
import { flowFocus, flowOutline, flowPlan, flowPreviewNode } from '../src/service/flow.js';
import { invokeTool } from '../src/mcp/invoke.js';
import { toolDefinitions } from '../src/mcp/catalog.js';
import { searchTools, toolSchema } from '../src/mcp/discovery.js';
import { parseFlowClipId } from '../src/core/flow-edit.js';
import type { BuiltinPluginHost } from '../src/plugins/types.js';

async function createMinimalFlowTestProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-flow-test-'));
  await initProject(root);
  // Create tiny valid local placeholder media files for audio/video asset tests
  await mkdir(path.join(root, 'assets'), { recursive: true });
  const wavHeader = Buffer.alloc(44 + 48000 * 2); // 1.0s 48kHz mono 16-bit PCM silence
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(36 + 48000 * 2, 4);
  wavHeader.write('WAVEfmt ', 8);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(1, 22);
  wavHeader.writeUInt32LE(48000, 24);
  wavHeader.writeUInt32LE(96000, 28);
  wavHeader.writeUInt16LE(2, 32);
  wavHeader.writeUInt16LE(16, 34);
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(48000 * 2, 40);
  await writeFile(path.join(root, 'assets/talk.wav'), wavHeader);
  await writeFile(path.join(root, 'assets/bgm.wav'), wavHeader);

  // Add second scene + registered assets so we can orchestrate multi-shot flows without TSX workers
  const manifest = JSON.parse(await readFile(path.join(root, 'project.vmotion.json'), 'utf8'));
  manifest.scenes = ['scenes/card-a.json', 'scenes/card-b.json'];
  manifest.assets.push(
    {
      id: 'talk-clip',
      name: 'Interview Clip',
      path: 'assets/talk.wav',
      type: 'audio',
      managed: true,
      metadata: { duration: 10 },
    },
    {
      id: 'bgm-bed',
      name: 'LoFi Bed',
      path: 'assets/bgm.wav',
      type: 'audio',
      managed: true,
      metadata: { duration: 30, bpm: 120 },
    },
  );
  await writeFile(path.join(root, 'project.vmotion.json'), json(manifest));
  await writeFile(
    path.join(root, 'scenes/card-a.json'),
    json({
      id: 'card-a',
      name: '开场卡',
      duration: 90,
      background: '#112233',
      nodes: [
        {
          id: 'bg-rect',
          type: 'rect',
          name: '色块A',
          x: 80,
          y: 80,
          width: 400,
          height: 220,
          fill: '#2ee59d',
        },
      ],
    }),
  );
  await writeFile(
    path.join(root, 'scenes/card-b.json'),
    json({
      id: 'card-b',
      name: '重点卡',
      duration: 90,
      background: '#221133',
      nodes: [
        {
          id: 'circle-b',
          type: 'ellipse',
          name: '圆点B',
          x: 200,
          y: 120,
          width: 240,
          height: 240,
          fill: '#ff7a59',
        },
      ],
    }),
  );
  await writeFile(
    path.join(root, 'sequences/main.json'),
    json({
      id: 'main',
      name: '主时间线',
      duration: 150,
      tracks: [
        {
          id: 'v1',
          name: '视频轨',
          type: 'video',
          muted: false,
          clips: [
            { id: 'c1', name: '镜头1', sceneId: 'card-a', start: 0, duration: 60 },
            { id: 'c2', name: '镜头2', sceneId: 'card-b', start: 60, duration: 90 },
          ],
        },
        {
          id: 'bgm-track',
          name: '音乐轨',
          type: 'audio',
          muted: false,
          clips: [{ id: 'bgm-1', name: 'BGM', assetId: 'bgm-bed', start: 0, duration: 150 }],
        },
      ],
      markers: [{ id: 'm-intro', frame: 0, label: '第一章', kind: 'chapter' }],
    }),
  );
  return root;
}

describe('split scene-flow orchestration (Stage F0)', () => {
  it('converts traditional sequences to split capsules, keeps sequences/main.json untouched on capsule edits, and supports conflict-free parallel edits + 1-step undo', async () => {
    const root = await createMinimalFlowTestProject();
    const service = new ProjectService(root);
    await service.open(false);
    try {
      const initialDuration = service.snapshot.sequences[0].duration;
      expect(initialDuration).toBe(150);

      // 1. Convert traditional sequence -> split flow (`flow.json` + `nodes/*.json`)
      const convertPlan = await flowPlan(root, service.snapshot, {
        action: { op: 'fromSequence', sequenceId: 'main', split: true, mount: true },
      });
      expect(convertPlan.flowPath).toBe('components/flows/main/flow.json');
      expect(convertPlan.touchedFiles.map((f) => f.path)).toEqual(
        expect.arrayContaining([
          'components/flows/main/flow.json',
          'components/flows/main/nodes/c1.json',
          'components/flows/main/nodes/c2.json',
          'sequences/main.json',
        ]),
      );

      // Verify stored candidate immutability guard
      await expect(
        resolveAgentPlan(root, { ...convertPlan.candidate, operations: [] }),
      ).rejects.toMatchObject({ code: 'AGENT_PLAN_OVERRIDE' });

      const resolvedConvert = await resolveAgentPlan(root, convertPlan.candidate);
      await service.transact(resolvedConvert.operations, service.snapshot.revision);

      // Sequence duration & compiled clips match exact frame parity (60 + 90 = 150 frames)
      expect(service.snapshot.sequences[0].flowSource).toBe('components/flows/main/flow.json');
      expect(service.snapshot.sequences[0].duration).toBe(150);
      expect(
        service.snapshot.sequences[0].tracks.some((t) => t.id === 'flow/main/video'),
      ).toBe(true);
      expect(
        service.snapshot.sequences[0].tracks.some((t) => t.id === 'flow/main/bed'),
      ).toBe(true);

      const seqMainBeforeCapsuleEdit = await readFile(path.join(root, 'sequences/main.json'), 'utf8');
      const manifestBeforeCapsuleEdit = await readFile(
        path.join(root, 'project.vmotion.json'),
        'utf8',
      );

      // 2. Pinpoint single-capsule edit with dirtyNodes vs shiftedNodes tracking!
      // Change c1 from 60 frames (2s) to follow-voice TTS text (~3s) -> c1 is dirty, c2 is ONLY shifted!
      const editC1Plan = await flowPlan(root, service.snapshot, {
        action: {
          op: 'patchNode',
          nodeId: 'c1',
          patch: {
            timing: { mode: 'follow-voice', padEnd: 0.2 },
            voice: {
              kind: 'tts',
              text: '欢迎来到模块化场景流剪辑工作台，无需帧号即可精准对点修改每个镜头。',
              provider: 'http-local',
            },
            subtitle: { mode: 'from-voice' },
          },
        },
      });

      // ONLY `nodes/c1.json` is touched — `flow.json`, `nodes/c2.json`, `sequences/main.json`, `project.vmotion.json` untouched!
      expect(editC1Plan.touchedFiles).toEqual([
        { path: 'components/flows/main/nodes/c1.json', type: 'replace' },
      ]);
      expect(editC1Plan.diff.dirtyNodes).toEqual(['c1']);
      expect(editC1Plan.diff.shiftedNodes).toEqual(['c2']);
      expect(editC1Plan.diff.unbakedNodes).toContain('c1');

      // Stored preflight samples target ONLY dirty node c1, never shifted c2!
      const resolvedC1 = await resolveAgentPlan(root, editC1Plan.candidate);
      expect(resolvedC1.samples).toHaveLength(1);
      expect(resolvedC1.samples[0].frame).toBeLessThan(
        editC1Plan.diff.dirtyFrameRanges[0].endFrame,
      );

      const revBeforeC1 = service.snapshot.revision;
      await service.transact(resolvedC1.operations, revBeforeC1);

      // Verify `sequences/main.json` and `project.vmotion.json` on disk are 100% byte-identical!
      expect(await readFile(path.join(root, 'sequences/main.json'), 'utf8')).toBe(
        seqMainBeforeCapsuleEdit,
      );
      expect(await readFile(path.join(root, 'project.vmotion.json'), 'utf8')).toBe(
        manifestBeforeCapsuleEdit,
      );
      // Yet timeline rippled automatically (> 150 frames) and subtitle track is synthesized!
      expect(service.snapshot.sequences[0].duration).toBeGreaterThan(150);
      expect(
        service.snapshot.sequences[0].tracks.some((t) => t.id === 'flow/main/subtitles'),
      ).toBe(true);

      // 3. Single-step undo restores exact revision and timeline duration (150 frames)!
      await service.undo();
      expect(service.snapshot.revision).toBe(revBeforeC1);
      expect(service.snapshot.sequences[0].duration).toBe(150);

      // 4. Two parallel AI agents editing c1 and c2 from the same base snapshot produce disjoint 1-file edits
      const agentAPlan = await flowPlan(root, service.snapshot, {
        inline: true,
        action: {
          op: 'patchNode',
          nodeId: 'c1',
          patch: { name: 'Agent A 开场', timing: { mode: 'fixed', seconds: 2.5 } },
        },
      });
      const agentBPlan = await flowPlan(root, service.snapshot, {
        inline: true,
        action: {
          op: 'patchNode',
          nodeId: 'c2',
          patch: { name: 'Agent B 重点', timing: { mode: 'fixed', seconds: 4.0 } },
        },
      });
      expect(agentAPlan.touchedFiles.map((f) => f.path)).toEqual([
        'components/flows/main/nodes/c1.json',
      ]);
      expect(agentBPlan.touchedFiles.map((f) => f.path)).toEqual([
        'components/flows/main/nodes/c2.json',
      ]);
      // Apply Agent A, then Agent B's exact file edit still applies without conflict because c2.json hash is unchanged!
      await service.transact((agentAPlan.candidate as any).operations, service.snapshot.revision);
      await service.transact((agentBPlan.candidate as any).operations, service.snapshot.revision);
      const outline = flowOutline(service.snapshot, {});
      expect(outline.durationSeconds).toBeCloseTo(6.5, 2);
      expect(JSON.stringify(outline).length).toBeLessThan(2048);
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('compiles non-AI transcript-cut (J/L-cut), anchored B-roll, beat-cut, $var.* interpolation, and lossless split <-> pack round-trip', async () => {
    const root = await createMinimalFlowTestProject();
    try {
      const snap = await loadProject(root);
      const initRes = await flowPlan(root, snap, {
        inline: true,
        action: {
          op: 'init',
          flowId: 'edit-demo',
          name: '纯剪辑逻辑流',
          split: true,
          mountSequenceId: 'main',
          variables: {
            speakerScene: 'card-a',
            cutawayScene: 'card-b',
            brandTag: 'Vmotion Studio',
          },
          soundBed: {
            assetId: 'bgm-bed',
            volume: 0.35,
            sourceIn: 0,
            fadeInSeconds: 0.2,
            fadeOutSeconds: 0.5,
          },
          nodes: [
            {
              kind: 'flow-node',
              version: 1,
              id: 'talk-main',
              type: 'transcript-cut',
              assetId: 'talk-clip',
              jCutSeconds: 0.15,
              lCutSeconds: 0.2,
              subtitle: { mode: 'from-voice' },
              segments: [
                { id: 's1', start: 0.5, end: 2.0, text: '第一句核心观点保留' },
                { id: 's2', start: 2.2, end: 4.0, text: '第二句废话口误剪掉', keep: false },
                { id: 's3', start: 4.5, end: 6.5, text: '第三句在 ${var.brandTag} 展示细节' },
              ],
            },
            {
              kind: 'flow-node',
              version: 1,
              id: 'montage',
              type: 'beat-cut',
              bpm: 120,
              beatsPerCut: 2,
              items: [
                { id: 'b1', kind: 'scene', refId: '$var.speakerScene' },
                { id: 'b2', kind: 'scene', refId: '$var.cutawayScene' },
              ],
              transitionIn: { type: 'dissolve', seconds: 0.25 },
            },
            {
              kind: 'flow-node',
              version: 1,
              id: 'broll-s3',
              type: 'broll-overlay',
              anchor: {
                nodeId: 'talk-main',
                segmentId: 's3',
                offsetSeconds: 0.1,
                durationSeconds: 1.2,
              },
              visual: {
                kind: 'scene',
                sceneId: '$var.cutawayScene',
              },
            },
          ],
        },
      });

      const afterInit = parseFiles(
        Object.assign(
          {},
          snap.files,
          Object.fromEntries(
            (initRes.candidate as any).operations[0].edits.map((e: any) => [e.path, e.content]),
          ),
        ),
      );
      const diags = await validateSnapshot(root, afterInit);
      expect(diags.filter((d) => d.severity === 'error')).toEqual([]);
      expect(afterInit.sequences[0].mix?.tracks['flow/edit-demo/bed']?.ducking).toBeTruthy();

      // Focus on talk-main: rawNode keeps `${var.brandTag}`, resolvedNode interpolates `Vmotion Studio`!
      const focused = flowFocus(afterInit, { nodeId: 'talk-main' });
      expect((focused.node as any).segments[2].text).toContain('${var.brandTag}');
      expect((focused.resolvedNode as any).segments[2].text).toContain('Vmotion Studio');
      expect(focused.neighbors.anchoredOverlays).toHaveLength(1);
      expect(focused.neighbors.anchoredOverlays[0].segmentId).toBe('s3');

      // Focus by timeline timestamp (`atSeconds`) locates the active shot capsule automatically
      const byTime = flowFocus(afterInit, { atSeconds: 0.5 });
      expect(byTime.nodeId).toBe('talk-main');

      // Pack -> Split round-trip preserves `$var.*` placeholders and exact sequence duration
      const packedPlan = await flowPlan(root, afterInit, {
        inline: true,
        action: { op: 'pack' },
      });
      const packedFiles = { ...afterInit.files };
      for (const e of (packedPlan.candidate as any).operations[0].edits) {
        if (e.type === 'delete') delete packedFiles[e.path];
        else packedFiles[e.path] = e.content;
      }
      const packedSnap = parseFiles(packedFiles);
      expect(packedSnap.sequences[0].flowSource).toBe('components/flows/edit-demo.flow.json');
      expect(packedSnap.sequences[0].duration).toBe(afterInit.sequences[0].duration);

      const splitAgainPlan = await flowPlan(root, packedSnap, {
        inline: true,
        action: { op: 'split' },
      });
      const splitFiles = { ...packedSnap.files };
      for (const e of (splitAgainPlan.candidate as any).operations[0].edits) {
        if (e.type === 'delete') delete splitFiles[e.path];
        else splitFiles[e.path] = e.content;
      }
      const splitSnap = parseFiles(splitFiles);
      expect(splitSnap.sequences[0].flowSource).toBe('components/flows/edit-demo/flow.json');
      expect(splitSnap.files['components/flows/edit-demo/nodes/broll-s3.json']).toContain(
        '$var.cutawayScene',
      );

      // ProjectReferences indexes all split flow capsules with zero unrecognized-kind uncertainties
      const refIndex = new ProjectReferences().resolve(splitSnap);
      expect(
        refIndex.uncertainties.filter((u) => u.file.startsWith('components/flows/')),
      ).toEqual([]);
      expect(
        refIndex.references.some(
          (r) =>
            r.file === 'components/flows/edit-demo/nodes/talk-main.json' &&
            r.to.kind === 'asset' &&
            r.to.id === 'talk-clip',
        ),
      ).toBe(true);

      // Timeline clip ID parser + timelineEdit -> pinpoint capsule update + bakeSequence
      const videoClip = splitSnap.sequences[0].tracks[0].clips[0];
      expect(parseFlowClipId(videoClip.id)?.flowId).toBe('edit-demo');
      const bakeRes = await flowPlan(root, splitSnap, {
        inline: true,
        action: { op: 'bakeSequence', sequenceId: 'main', keepFlowFiles: true },
      });
      expect(bakeRes.touchedFiles.some((f) => f.path === 'sequences/main.json')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renders isolated single-node previews in O(1) without duplicating Base64 in MCP JSON and rejects negative schemas', async () => {
    const root = await createMinimalFlowTestProject();
    const renderer = new Renderer(root);
    try {
      const snap = await loadProject(root);
      const initRes = await flowPlan(root, snap, {
        inline: true,
        action: {
          op: 'init',
          flowId: 'preview-flow',
          mountSequenceId: 'main',
          nodes: [
            {
              kind: 'flow-node',
              version: 1,
              id: 'shot-1',
              type: 'shot',
              visual: { kind: 'scene', sceneId: 'card-a' },
              timing: { mode: 'fixed', seconds: 2 },
            },
            {
              kind: 'flow-node',
              version: 1,
              id: 'shot-unbaked',
              type: 'shot',
              intent: '赛博朋克雨夜霓虹街道',
              visual: {
                kind: 'workflow',
                workflow: 'components/flows/preview-flow/workflows/flux.workflow.json',
                modality: 'image',
              },
              timing: { mode: 'fixed', seconds: 3 },
            },
          ],
        },
      });
      // Unbound workflow emits warning (not error) so rough-cut editing stays valid!
      expect(initRes.warnings.some((w) => w.code === 'FLOW_WORKFLOW_UNBOUND')).toBe(true);

      const nextFiles = { ...snap.files };
      for (const e of (initRes.candidate as any).operations[0].edits) nextFiles[e.path] = e.content;
      const flowSnap = parseFiles(nextFiles);

      const mockHost = {
        root,
        renderer,
        snapshot: flowSnap,
        withMediaTask: <T>(work: () => Promise<T>) => work(),
      } as unknown as BuiltinPluginHost;

      const defs = toolDefinitions();
      const search = searchTools(defs, { category: 'workflow' });
      expect(search.items.map((i) => i.name)).toEqual(
        expect.arrayContaining(['flow_outline', 'flow_focus', 'flow_plan', 'flow_preview_node']),
      );
      expect(JSON.stringify(toolSchema(defs, 'flow_plan')).length).toBeLessThan(24000);

      // Invoke flow_preview_node through real MCP invokeTool layer: PNG goes to media block, ZERO Base64 in JSON text!
      const previewTool = defs.find((t) => t.name === 'flow_preview_node')!;
      const invoked = await invokeTool(
        previewTool,
        { nodeId: 'shot-unbaked', width: 240 },
        async (_method, params) => flowPreviewNode(mockHost, params),
      );
      const imageBlocks = invoked.result.content.filter((c) => c.type === 'image');
      expect(imageBlocks).toHaveLength(1);
      const pngBytes = Buffer.from((imageBlocks[0] as any).data, 'base64');
      expect(pngBytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(JSON.stringify(invoked.result.structuredContent)).not.toContain('iVBOR');
      expect((invoked.result.structuredContent as any).unbaked.visual).toBe(true);

      // Negative cases: missing anchor & role mismatch
      await expect(
        flowPlan(root, flowSnap, {
          action: {
            op: 'upsertNode',
            node: {
              kind: 'flow-node',
              version: 1,
              id: 'bad-broll',
              type: 'broll-overlay',
              anchor: { nodeId: 'nonexistent-shot', offsetSeconds: 0 },
              visual: { kind: 'scene', sceneId: 'card-b' },
            },
          },
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      await expect(
        flowPlan(root, flowSnap, {
          action: {
            op: 'upsertNode',
            role: 'spine',
            node: {
              kind: 'flow-node',
              version: 1,
              id: 'wrong-role',
              type: 'broll-overlay',
              anchor: { nodeId: 'shot-1', offsetSeconds: 0 },
              visual: { kind: 'scene', sceneId: 'card-b' },
            },
          },
        }),
      ).rejects.toMatchObject({ code: 'FLOW_ROLE_MISMATCH' });
    } finally {
      renderer.dispose?.();
      await rm(root, { recursive: true, force: true });
    }
  });
});
