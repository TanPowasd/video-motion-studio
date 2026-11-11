import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/service/template.js';
import { ProjectService } from '../src/service/service.js';
import { json } from '../src/service/project.js';
import { flowOutline, flowPlan } from '../src/service/flow.js';
import { resolveAgentPlan } from '../src/service/agent-plans.js';
import { buildInboxContext, InboxStore, agentView } from '../src/service/inbox.js';
import { inboxPrompt } from '../src/core/inbox-model.js';
import { editingPlugin } from '../src/plugins/editing.js';
import { studioTabs } from '../src/editor/studio/types.js';
import {
  discoverFlowFiles,
  findActiveFlowNodeAtFrame,
  formatFlowTimingBadge,
} from '../src/editor/studio/FlowPanel.js';
import type { BuiltinPluginHost } from '../src/plugins/types.js';

async function createFlowBridgeProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-flow-ui-inbox-'));
  await initProject(root);
  await mkdir(path.join(root, 'assets'), { recursive: true });

  const manifest = JSON.parse(await readFile(path.join(root, 'project.vmotion.json'), 'utf8'));
  manifest.scenes = ['scenes/card-a.json', 'scenes/card-b.json'];
  await writeFile(path.join(root, 'project.vmotion.json'), json(manifest));

  await writeFile(
    path.join(root, 'scenes/card-a.json'),
    json({
      id: 'card-a',
      name: '开场卡',
      duration: 180,
      background: '#112233',
      nodes: [
        {
          id: 'rect-a',
          type: 'rect',
          name: '主色块',
          x: 60,
          y: 60,
          width: 320,
          height: 180,
          fill: '#ff8a5b',
        },
      ],
    }),
  );
  await writeFile(
    path.join(root, 'scenes/card-b.json'),
    json({
      id: 'card-b',
      name: '收尾卡',
      duration: 180,
      background: '#223344',
      nodes: [
        {
          id: 'rect-b',
          type: 'rect',
          name: '副色块',
          x: 100,
          y: 100,
          width: 300,
          height: 180,
          fill: '#7be0c3',
        },
      ],
    }),
  );
  await writeFile(
    path.join(root, 'sequences/main.json'),
    json({
      id: 'main',
      name: '主时间轴',
      duration: 90,
      tracks: [
        {
          id: 'user-top',
          name: '人工角标轨',
          type: 'video',
          muted: false,
          clips: [
            {
              id: 'user-watermark',
              name: '角标',
              sceneId: 'card-a',
              start: 0,
              duration: 30,
              sourceIn: 0,
              speed: 1,
            },
          ],
        },
      ],
      markers: [],
    }),
  );

  const service = new ProjectService(root);
  await service.open(false);
  const initPlan = await flowPlan(root, service.snapshot, {
    action: {
      op: 'init',
      flowId: 'main',
      name: '双向编排流',
      split: true,
      mountSequenceId: 'main',
      nodes: [
        {
          id: 'intro',
          type: 'shot',
          name: '第一镜',
          visual: { kind: 'scene', sceneId: 'card-a', sourceIn: 0, speed: 1 },
          timing: { mode: 'fixed', seconds: 2 },
          subtitle: { mode: 'custom', text: '欢迎来到第一镜' },
        },
        {
          id: 'outro',
          type: 'shot',
          name: '第二镜',
          visual: { kind: 'scene', sceneId: 'card-b', sourceIn: 0, speed: 1 },
          timing: { mode: 'fixed', seconds: 2 },
        },
        {
          id: 'broll-1',
          type: 'broll-overlay',
          name: '特写空镜',
          anchor: { nodeId: 'intro', offsetSeconds: 0.5, durationSeconds: 0.5 },
          visual: { kind: 'scene', sceneId: 'card-b', sourceIn: 0, speed: 1 },
        },
      ],
    },
  });
  const resolved = await resolveAgentPlan(root, initPlan.apply);
  await service.transact(resolved.operations, resolved.revision);

  return { root, service };
}

describe('Stage F1: Inbox Flow Locator, Bidirectional Timeline Edits & Studio Flow Panel', () => {
  it('resolves pinpoint flowNode capsule and virtual subtitle source in InboxContext, prompt and agentView', async () => {
    const { root, service } = await createFlowBridgeProject();
    try {
      const fps = service.snapshot.project.fps.num / service.snapshot.project.fps.den;
      // Frame 5 (~0.16s): inside `intro` spine shot, before `broll-1` (0.5s..1.0s)
      const ctxSpine = buildInboxContext(service.snapshot, {
        text: '把第一镜缩短一点',
        sequenceId: 'main',
        frame: 5,
        selection: [],
        snapshot: false,
      });
      expect(ctxSpine.flowNode).toMatchObject({
        flowId: 'main',
        flowPath: 'components/flows/main/flow.json',
        nodeId: 'intro',
        nodeFile: 'components/flows/main/nodes/intro.json',
        role: 'spine',
        nodeType: 'shot',
        label: '第一镜',
        startFrame: 0,
        endFrame: Math.round(2 * fps),
      });

      // Frame at 0.6s: inside `broll-1` overlay (0.5s..1.0s)
      const overlayFrame = Math.round(0.6 * fps);
      const ctxOverlay = buildInboxContext(service.snapshot, {
        text: '替换这个空镜画面',
        sequenceId: 'main',
        frame: overlayFrame,
        selection: [],
        snapshot: false,
      });
      expect(ctxOverlay.flowNode).toMatchObject({
        nodeId: 'broll-1',
        nodeFile: 'components/flows/main/nodes/broll-1.json',
        role: 'overlay',
        nodeType: 'broll-overlay',
      });

      // Selecting a virtual subtitle node maps source.file straight to nodes/intro.json
      const virtualSubScene = service.snapshot.scenes.find((s) =>
        s.id.startsWith('flow:main:intro:sub'),
      );
      expect(virtualSubScene).toBeDefined();
      const subNode = virtualSubScene!.nodes.find((n) => n.type === 'text')!;
      const ctxVirtual = buildInboxContext(service.snapshot, {
        text: '修改这句字幕文案',
        sceneId: virtualSubScene!.id,
        frame: 5,
        selection: [{ id: subNode.id }],
        snapshot: false,
      });
      expect(ctxVirtual.selection[0]?.source?.file).toBe(
        'components/flows/main/nodes/intro.json',
      );
      expect(ctxVirtual.flowNode?.nodeFile).toBe('components/flows/main/nodes/intro.json');

      const store = new InboxStore(root);
      const created = await store.create(ctxVirtual, '修改第一镜字幕与时长');
      const prompt = inboxPrompt(created, root);
      expect(prompt).toContain('components/flows/main/nodes/intro.json');
      expect(prompt).toContain('vmotion flow preview');
      expect(prompt).not.toContain(`scenes/${virtualSubScene!.id}.json`);

      const claimed = await store.claim(created.id, 'test-agent');
      const view = agentView(store, claimed);
      expect(view.files.flowNode).toBe('components/flows/main/nodes/intro.json');
      expect(view.next).toContain('components/flows/main/nodes/intro.json');
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bridges traditional timeline sequenceEdit (trim, slip, move, split, remove) to split capsules with 1-step undo', async () => {
    const { root, service } = await createFlowBridgeProject();
    try {
      const host = {
        root,
        get snapshot() {
          return service.snapshot;
        },
        transact: service.transact.bind(service),
      } as unknown as BuiltinPluginHost;

      const fps = service.snapshot.project.fps.num / service.snapshot.project.fps.den; // 60 fps in template
      const oneSec = Math.round(fps);
      const twoSec = Math.round(2 * fps);

      // 1. Trim `out` of `flow/main/intro/v` from 2s down to 1.5s -> ripples `outro` left automatically!
      const oneHalfSec = Math.round(1.5 * fps);
      const revBeforeTrim = service.snapshot.revision;
      await editingPlugin.dispatch(host, 'sequenceEdit', {
        sequenceId: 'main',
        actions: [{ type: 'trim', clipId: 'flow/main/intro/v', edge: 'out', frame: oneHalfSec }],
      });
      const introAfterTrim = JSON.parse(
        service.snapshot.files['components/flows/main/nodes/intro.json'],
      );
      expect(introAfterTrim.timing.frames).toBe(oneHalfSec);

      const seqAfterTrim = service.snapshot.sequences.find((s) => s.id === 'main')!;
      const outroClipAfterTrim = seqAfterTrim.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === 'flow/main/outro/v')!;
      expect(outroClipAfterTrim.start).toBe(oneHalfSec);

      // `sequences/main.json` on disk stays untouched (no baked `flow/*` tracks leaked)
      const rawSeqJson = JSON.parse(service.snapshot.files['sequences/main.json']);
      expect(rawSeqJson.tracks.every((t: { id: string }) => !t.id.startsWith('flow/'))).toBe(true);

      // 1-step undo restores exact revision & timing
      await service.undo();
      expect(service.snapshot.revision).toBe(revBeforeTrim);

      // 2. Slip `flow/main/intro/v` by +15 frames & reject out-of-bounds slip
      await editingPlugin.dispatch(host, 'sequenceEdit', {
        sequenceId: 'main',
        actions: [{ type: 'slip', clipIds: ['flow/main/intro/v'], delta: 15 }],
      });
      const introAfterSlip = JSON.parse(
        service.snapshot.files['components/flows/main/nodes/intro.json'],
      );
      expect(introAfterSlip.visual.sourceIn).toBeCloseTo(15 / fps, 3);
      await expect(
        editingPlugin.dispatch(host, 'sequenceEdit', {
          sequenceId: 'main',
          actions: [{ type: 'slip', clipIds: ['flow/main/intro/v'], delta: 500 }],
        }),
      ).rejects.toMatchObject({ code: 'EDIT_HANDLES' });

      // 3. Move B-roll overlay onto `outro` (delta = +2s) -> re-anchors `broll-1` to `outro`!
      await editingPlugin.dispatch(host, 'sequenceEdit', {
        sequenceId: 'main',
        actions: [{ type: 'move', clipIds: ['flow/main/broll-1/broll'], delta: twoSec }],
      });
      const brollAfterMove = JSON.parse(
        service.snapshot.files['components/flows/main/nodes/broll-1.json'],
      );
      expect(brollAfterMove.anchor.nodeId).toBe('outro');
      expect(brollAfterMove.anchor.offsetSeconds).toBeCloseTo(0.5, 2);

      // 4. Split `flow/main/intro/v` at 1s -> creates split capsule `nodes/intro-2.json`!
      const revBeforeSplit = service.snapshot.revision;
      const splitRes: any = await editingPlugin.dispatch(host, 'sequenceEdit', {
        sequenceId: 'main',
        actions: [{ type: 'split', frame: oneSec, clipIds: ['flow/main/intro/v'] }],
      });
      expect(splitRes.edit.selection).toContain('flow/main/intro-2/v');
      expect(service.snapshot.files['components/flows/main/nodes/intro-2.json']).toBeDefined();
      const flowDocAfterSplit = JSON.parse(
        service.snapshot.files['components/flows/main/flow.json'],
      );
      expect(flowDocAfterSplit.spine).toEqual(['intro', 'intro-2', 'outro']);

      // 1-step undo removes `nodes/intro-2.json` and restores 2-shot spine
      await service.undo();
      expect(service.snapshot.revision).toBe(revBeforeSplit);
      expect(service.snapshot.files['components/flows/main/nodes/intro-2.json']).toBeUndefined();

      // 5. Remove `flow/main/outro/v` -> moves `outro` (and anchored `broll-1`) to draft shelf cleanly
      await editingPlugin.dispatch(host, 'sequenceEdit', {
        sequenceId: 'main',
        actions: [{ type: 'remove', clipIds: ['flow/main/outro/v'], ripple: true }],
      });
      const outlineAfterRemove = flowOutline(service.snapshot, {
        flowPath: 'components/flows/main/flow.json',
      });
      expect(outlineAfterRemove.counts).toMatchObject({
        spine: 1,
        overlays: 0,
        drafts: 2,
      });
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('registers Studio Flow tab and pure FlowPanel helpers accurately', async () => {
    const { root, service } = await createFlowBridgeProject();
    try {
      expect(studioTabs.some((t) => t.id === 'flow' && t.name === '场景流编排')).toBe(true);
      expect(discoverFlowFiles(service.snapshot.files)).toEqual([
        'components/flows/main/flow.json',
      ]);

      const outline = flowOutline(service.snapshot, {
        flowPath: 'components/flows/main/flow.json',
      });
      const fps = service.snapshot.project.fps.num / service.snapshot.project.fps.den;
      expect(findActiveFlowNodeAtFrame(outline.items as any, 5)).toBe('intro');
      // At 0.6s, overlay `broll-1` is active above `intro`
      expect(findActiveFlowNodeAtFrame(outline.items as any, Math.round(0.6 * fps))).toBe(
        'broll-1',
      );
      expect(findActiveFlowNodeAtFrame(outline.items as any, Math.round(2.5 * fps))).toBe('outro');

      expect(
        formatFlowTimingBadge({ type: 'shot', timing: { mode: 'follow-voice' } as any }),
      ).toBe('跟随配音');
      expect(
        formatFlowTimingBadge({
          type: 'transcript-cut',
          segments: [
            { id: 's1', start: 0, end: 1, keep: true },
            { id: 's2', start: 1, end: 2, keep: false },
          ],
        } as any),
      ).toBe('粗剪 1/2 句');
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
