import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { StudioContext } from './types.js';
import { CandidateActions, NumberControl, PanelIntro, SelectControl, Toggle } from './Controls.js';
import { Icon } from '../Icons.js';
import type { FlowNode, FlowSoundBed } from '../../core/flow-schema.js';

export interface FlowOutlineNodeItem {
  id: string;
  role: 'spine' | 'overlay' | 'draft';
  type: 'shot' | 'transcript-cut' | 'beat-cut' | 'broll-overlay';
  name: string;
  enabled: boolean;
  chapter?: string;
  file: string;
  startSeconds?: number;
  endSeconds?: number;
  startFrame?: number;
  durationFrames?: number;
  contentHash: string;
  unbaked: { visual: boolean; voice: boolean };
  summary: string;
}

export interface FlowOutlineView {
  revision: string;
  flowPath: string;
  flowId: string;
  name: string;
  split: boolean;
  nodesDir: string;
  mountedSequences: string[];
  durationFrames: number;
  durationSeconds: number;
  counts: {
    total: number;
    spine: number;
    overlays: number;
    drafts: number;
    unbakedVisual: number;
    unbakedVoice: number;
  };
  soundBed?: {
    assetId: string;
    volume: number;
    ducking: boolean;
  };
  variables?: Record<string, unknown>;
  items: FlowOutlineNodeItem[];
}

/** Pure helper: discovers all Flow manifest paths (`kind: "flow"`) in `snapshot.files`. */
export function discoverFlowFiles(files: Record<string, string>): string[] {
  const found: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    if (!file.startsWith('components/') || !file.endsWith('.json')) continue;
    if (file.includes('/nodes/') || file.endsWith('.workflow.json')) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.kind === 'flow') found.push(file);
    } catch {
      // Ignore malformed JSON files here; surfaced via diagnostics.
    }
  }
  return found.sort((a, b) => a.localeCompare(b, 'en'));
}

/** Pure helper: finds the active Flow node ID covering `frame` on the timeline playhead. */
export function findActiveFlowNodeAtFrame(
  items: readonly FlowOutlineNodeItem[],
  frame: number,
): string | undefined {
  const covering = items.filter(
    (it) =>
      it.enabled &&
      typeof it.startFrame === 'number' &&
      typeof it.durationFrames === 'number' &&
      frame >= it.startFrame &&
      frame < it.startFrame + it.durationFrames,
  );
  const overlayHit = covering.find((it) => it.role === 'overlay');
  if (overlayHit) return overlayHit.id;
  const spineHit = covering.find((it) => it.role === 'spine');
  return spineHit?.id;
}

/** Pure helper: formats a concise human-readable timing badge for a Flow capsule. */
export function formatFlowTimingBadge(node: Partial<FlowNode> | undefined): string {
  if (!node || !node.type) return '未知时长';
  if (node.type === 'transcript-cut') {
    const segs = node.segments ?? [];
    const kept = segs.filter((s) => s.keep !== false).length;
    return `粗剪 ${kept}/${segs.length} 句`;
  }
  if (node.type === 'beat-cut') {
    return `踩点 ${node.bpm ?? 120} BPM`;
  }
  if (node.type === 'broll-overlay') {
    const off = node.anchor?.offsetSeconds ?? 0;
    return `锚定 +${off}s`;
  }
  const t = node.timing;
  if (!t) return '固定时长';
  if (t.mode === 'follow-voice') return '跟随配音';
  if (t.mode === 'follow-visual') return '跟随素材';
  if (t.mode === 'bars') return `${t.bars ?? 2} 小节`;
  if (typeof t.seconds === 'number') return `固定 ${t.seconds}s`;
  if (typeof t.frames === 'number') return `固定 ${t.frames} 帧`;
  return '固定时长';
}

function shortCapsuleFile(file: string): string {
  const parts = file.split('/');
  return parts.length >= 2 ? parts.slice(-2).join('/') : file;
}

function createStarterNode(
  kind: FlowNode['type'],
  index: number,
  defaultSceneId: string,
  defaultAudioAssetId: string,
  anchorSpineId: string,
): Record<string, unknown> {
  const suffix = String(index + 1).padStart(2, '0');
  if (kind === 'transcript-cut') {
    return {
      kind: 'flow-node',
      version: 1,
      id: `talk-${suffix}`,
      type: 'transcript-cut',
      name: `口播粗剪 ${index + 1}`,
      enabled: true,
      assetId: defaultAudioAssetId || 'voice-raw',
      padStart: 0.05,
      padEnd: 0.08,
      jCutSeconds: 0,
      lCutSeconds: 0,
      volume: 1,
      subtitle: { mode: 'from-voice' },
      segments: [
        { id: 's1', start: 0, end: 2.4, text: '第一句口播内容，取消勾选即可无损剔除', keep: true },
        { id: 's2', start: 2.5, end: 4.8, text: '第二句口播内容，后续镜头自动波纹前移', keep: true },
      ],
    };
  }
  if (kind === 'beat-cut') {
    return {
      kind: 'flow-node',
      version: 1,
      id: `beat-${suffix}`,
      type: 'beat-cut',
      name: `踩点快剪 ${index + 1}`,
      enabled: true,
      ...(defaultAudioAssetId ? { soundAssetId: defaultAudioAssetId } : {}),
      bpm: 120,
      beatsPerCut: 2,
      items: [
        {
          id: 'cut-1',
          kind: 'scene',
          refId: defaultSceneId,
          beats: 2,
          sourceIn: 0,
        },
      ],
    };
  }
  if (kind === 'broll-overlay') {
    return {
      kind: 'flow-node',
      version: 1,
      id: `broll-${suffix}`,
      type: 'broll-overlay',
      name: `B-Roll 空镜 ${index + 1}`,
      enabled: true,
      anchor: {
        nodeId: anchorSpineId,
        offsetSeconds: 0.5,
        durationSeconds: 2,
      },
      visual: {
        kind: 'scene',
        sceneId: defaultSceneId,
        sourceIn: 0,
        speed: 1,
      },
    };
  }
  return {
    kind: 'flow-node',
    version: 1,
    id: `shot-${suffix}`,
    type: 'shot',
    name: `镜头 ${index + 1}`,
    enabled: true,
    visual: {
      kind: 'scene',
      sceneId: defaultSceneId,
      sourceIn: 0,
      speed: 1,
    },
    timing: {
      mode: 'fixed',
      seconds: 3,
      beatsPerBar: 4,
      padStart: 0,
      padEnd: 0,
    },
    overlays: [],
  };
}

export default function FlowPanel({ context }: { context: StudioContext }) {
  const activeSeq = useMemo(
    () =>
      context.snapshot.sequences.find((s) => s.id === context.snapshot.project.activeSequence) ??
      context.snapshot.sequences[0],
    [context.snapshot],
  );

  const flowFiles = useMemo(
    () => discoverFlowFiles(context.snapshot.files),
    [context.snapshot.files],
  );

  const [selectedFlowPath, setSelectedFlowPath] = useState<string>(
    () => activeSeq?.flowSource ?? flowFiles[0] ?? '',
  );
  const [outline, setOutline] = useState<FlowOutlineView | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string>('');
  const [draftNode, setDraftNode] = useState<FlowNode | null>(null);
  const [draftNodeFile, setDraftNodeFile] = useState<string>('');
  const [inspectorTab, setInspectorTab] = useState<'capsule' | 'variables' | 'soundbed'>('capsule');
  const [varsDraft, setVarsDraft] = useState<Record<string, string | number | boolean>>({});
  const [newVarKey, setNewVarKey] = useState('');
  const [newVarVal, setNewVarVal] = useState('');
  const [soundBedDraft, setSoundBedDraft] = useState<FlowSoundBed | null>(null);
  const [previewPng, setPreviewPng] = useState<string>('');
  const [previewLocalSec, setPreviewLocalSec] = useState<number>(0);
  const [busyMsg, setBusyMsg] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [workflowDrawerOpen, setWorkflowDrawerOpen] = useState<boolean>(false);

  const baseScenes = useMemo(
    () =>
      context.snapshot.scenes.filter(
        (_, i) => !context.snapshot.project.scenes[i]?.startsWith('__virtual/flow/'),
      ),
    [context.snapshot],
  );
  const componentFiles = useMemo(
    () =>
      Object.keys(context.snapshot.files)
        .filter((f) => f.startsWith('components/') && f.endsWith('.tsx'))
        .sort(),
    [context.snapshot.files],
  );
  const workflowFiles = useMemo(
    () =>
      Object.keys(context.snapshot.files)
        .filter((f) => f.endsWith('.workflow.json'))
        .sort(),
    [context.snapshot.files],
  );
  const visualAssets = useMemo(
    () => context.snapshot.project.assets.filter((a) => a.type === 'video' || a.type === 'image'),
    [context.snapshot.project.assets],
  );
  const audioAssets = useMemo(
    () => context.snapshot.project.assets.filter((a) => a.type === 'audio'),
    [context.snapshot.project.assets],
  );

  useEffect(() => {
    if (selectedFlowPath && context.snapshot.files[selectedFlowPath] !== undefined) return;
    const next = activeSeq?.flowSource ?? flowFiles[0] ?? '';
    if (next !== selectedFlowPath) setSelectedFlowPath(next);
  }, [activeSeq?.flowSource, context.snapshot.files, flowFiles, selectedFlowPath]);

  const loadOutline = useCallback(
    async (flowPath: string) => {
      if (!flowPath) {
        setOutline(null);
        return;
      }
      try {
        const res = (await context.run('flowOutline', {
          flowPath,
          limit: 200,
          includeVariables: true,
        })) as FlowOutlineView;
        setOutline(res);
        const scalarVars: Record<string, string | number | boolean> = {};
        for (const [k, v] of Object.entries(res.variables ?? {})) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            scalarVars[k] = v;
          }
        }
        setVarsDraft(scalarVars);
        const rawText = context.snapshot.files[res.flowPath];
        if (rawText) {
          const parsed = JSON.parse(rawText);
          setSoundBedDraft(parsed?.soundBed ?? null);
        }
        setSelectedNodeId((prev) => {
          if (prev && res.items.some((it) => it.id === prev)) return prev;
          return findActiveFlowNodeAtFrame(res.items, context.frame) ?? res.items[0]?.id ?? '';
        });
      } catch (e) {
        setErrorMsg((e as Error).message);
      }
    },
    [context],
  );

  useEffect(() => {
    void loadOutline(selectedFlowPath);
  }, [selectedFlowPath, context.snapshot.revision, loadOutline]);

  useEffect(() => {
    if (!selectedFlowPath || !selectedNodeId) {
      setDraftNode(null);
      setDraftNodeFile('');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await context.run('flowFocus', {
          flowPath: selectedFlowPath,
          nodeId: selectedNodeId,
          neighbors: 1,
        });
        if (cancelled) return;
        setDraftNode(structuredClone(res.node));
        setDraftNodeFile(res.nodeFile ?? '');
        setPreviewPng('');
      } catch {
        // Ignore transient focus lookup errors during rapid switching
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedFlowPath, selectedNodeId, context.snapshot.revision, context]);

  const playheadNodeId = useMemo(
    () => (outline ? findActiveFlowNodeAtFrame(outline.items, context.frame) : undefined),
    [outline, context.frame],
  );

  const runDirectPlanAndApply = async (
    label: string,
    params: Record<string, unknown>,
    afterFlowPath?: (plan: any) => void,
  ) => {
    setBusyMsg(label);
    setErrorMsg('');
    try {
      const plan = await context.run('flowPlan', params);
      await context.run('projectApply', plan.apply);
      if (afterFlowPath) afterFlowPath(plan);
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setBusyMsg('');
    }
  };

  const spineItems = useMemo(
    () => (outline?.items ?? []).filter((it) => it.role === 'spine'),
    [outline],
  );
  const overlayItems = useMemo(
    () => (outline?.items ?? []).filter((it) => it.role === 'overlay'),
    [outline],
  );
  const draftItems = useMemo(
    () => (outline?.items ?? []).filter((it) => it.role === 'draft'),
    [outline],
  );

  const moveSpine = (nodeId: string, delta: -1 | 1) => {
    if (!outline) return;
    const ids = spineItems.map((it) => it.id);
    const idx = ids.indexOf(nodeId);
    const target = idx + delta;
    if (idx < 0 || target < 0 || target >= ids.length) return;
    const next = [...ids];
    const [moved] = next.splice(idx, 1);
    next.splice(target, 0, moved);
    void runDirectPlanAndApply('正在重排主干镜头…', {
      flowPath: outline.flowPath,
      action: { op: 'reorder', spine: next },
    });
  };

  const handleAddNode = (kind: FlowNode['type']) => {
    if (!outline) return;
    const defaultScene = baseScenes[0]?.id ?? context.sceneId;
    const defaultAudio = audioAssets[0]?.id ?? visualAssets[0]?.id ?? '';
    const anchorId =
      (selectedNodeId && spineItems.some((s) => s.id === selectedNodeId)
        ? selectedNodeId
        : spineItems[0]?.id) ?? 'shot-01';
    const node = createStarterNode(
      kind,
      outline.counts.total,
      defaultScene,
      defaultAudio,
      anchorId,
    );
    const role = kind === 'broll-overlay' ? 'overlay' : 'spine';
    void runDirectPlanAndApply(
      '正在新增胶囊节点…',
      {
        flowPath: outline.flowPath,
        action: {
          op: 'upsertNode',
          node,
          role,
          ...(role === 'spine' && selectedNodeId && spineItems.some((s) => s.id === selectedNodeId)
            ? { afterNodeId: selectedNodeId }
            : {}),
        },
      },
      () => setSelectedNodeId(String(node.id)),
    );
  };

  if (!selectedFlowPath || !outline) {
    return (
      <div className="flow-panel">
        <PanelIntro title="场景流编排 (Scene-Flow)">
          不用生成式 AI 也能高效使用：将工程拆分为零帧号耦合的独立镜头胶囊（nodes/*.json），实时编译并挂载到传统时间轴。人类照常拖拽时间轴，AI 对点只改单个 ~25 行胶囊文件。
        </PanelIntro>
        {errorMsg && (
          <p className="studio-error" role="alert">
            {errorMsg}
          </p>
        )}
        <div className="flow-empty-cards">
          <div className="flow-empty-card">
            <Icon name="film" size={22} />
            <strong>将当前时间轴拆分为场景流</strong>
            <p>
              一键把序列「{activeSeq?.name ?? '主序列'}」的镜头、配音与背景音乐无损拆分为独立胶囊目录，并开启双向实时挂载。
            </p>
            <button
              className="primary"
              disabled={Boolean(busyMsg) || !activeSeq}
              onClick={() =>
                void runDirectPlanAndApply(
                  '正在拆分当前时间轴…',
                  {
                    action: {
                      op: 'fromSequence',
                      sequenceId: activeSeq?.id,
                      split: true,
                      mount: true,
                    },
                  },
                  (plan) => {
                    if (plan?.flowPath) setSelectedFlowPath(plan.flowPath);
                  },
                )
              }
            >
              {busyMsg || '从当前时间轴拆分'}
            </button>
          </div>
          <div className="flow-empty-card">
            <Icon name="repeat" size={22} />
            <strong>新建空白拆分场景流</strong>
            <p>
              创建 components/flows/main/flow.json 与首个独立镜头胶囊，可随时接入语音跟随、口播粗剪与 ComfyUI 节点子图。
            </p>
            <button
              className="secondary"
              disabled={Boolean(busyMsg)}
              onClick={() => {
                const firstScene = baseScenes[0]?.id ?? context.sceneId;
                const starter = createStarterNode('shot', 0, firstScene, '', 'shot-01');
                void runDirectPlanAndApply(
                  '正在创建场景流…',
                  {
                    action: {
                      op: 'init',
                      flowId: activeSeq?.id || 'main',
                      name: `${context.snapshot.project.name} 场景流`,
                      split: true,
                      mountSequenceId: activeSeq?.id,
                      nodes: [starter],
                    },
                  },
                  (plan) => {
                    if (plan?.flowPath) setSelectedFlowPath(plan.flowPath);
                    setSelectedNodeId(String(starter.id));
                  },
                );
              }}
            >
              {busyMsg || '新建空白场景流'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isMountedOnActive = Boolean(
    activeSeq && outline.mountedSequences.includes(activeSeq.id),
  );

  return (
    <div className="flow-panel">
      <PanelIntro title="场景流编排 (Scene-Flow)">
        每个镜头独立存放在专属胶囊文件中，不写绝对起止帧。修改台词、节拍或 ComfyUI 工作流时自动波纹重算整条传统时间轴。
      </PanelIntro>

      <div className="flow-toolbar">
        <SelectControl
          label="当前场景流"
          value={selectedFlowPath}
          options={flowFiles.map((f) => [f, f] as [string, string])}
          onChange={setSelectedFlowPath}
        />
        <div className="flow-status-chips">
          <span className="flow-chip">
            {outline.split ? '已拆分胶囊 (nodes/*.json)' : '单文件模式 (.flow.json)'}
          </span>
          <span className="flow-chip">
            {outline.counts.spine} 主干 · {outline.counts.overlays} 覆叠 · 总长{' '}
            {outline.durationSeconds.toFixed(1)}s ({outline.durationFrames} 帧)
          </span>
          {(outline.counts.unbakedVisual > 0 || outline.counts.unbakedVoice > 0) && (
            <span className="flow-chip unbaked">
              待烘焙：{outline.counts.unbakedVisual} 画面 / {outline.counts.unbakedVoice} 语音
            </span>
          )}
          <span className={isMountedOnActive ? 'flow-chip mounted' : 'flow-chip'}>
            {isMountedOnActive
              ? `已实时挂载 → ${activeSeq?.name ?? activeSeq?.id}`
              : '未挂载到当前序列'}
          </span>
        </div>
        <div className="flow-toolbar-actions">
          <button
            className="secondary"
            disabled={Boolean(busyMsg)}
            onClick={() =>
              void runDirectPlanAndApply(
                outline.split ? '正在打包为单文件…' : '正在拆分为独立胶囊…',
                {
                  flowPath: outline.flowPath,
                  action: outline.split ? { op: 'pack' } : { op: 'split' },
                },
                (plan) => {
                  if (plan?.flowPath) setSelectedFlowPath(plan.flowPath);
                },
              )
            }
          >
            {outline.split ? '打包单文件' : '拆分为胶囊'}
          </button>
          {activeSeq && (
            <button
              className="secondary"
              disabled={Boolean(busyMsg)}
              onClick={() =>
                void runDirectPlanAndApply(
                  isMountedOnActive ? '正在解除时间轴挂载…' : '正在挂载到时间轴…',
                  {
                    flowPath: outline.flowPath,
                    action: {
                      op: 'mountSequence',
                      sequenceId: activeSeq.id,
                      unmount: isMountedOnActive,
                    },
                  },
                )
              }
            >
              {isMountedOnActive ? '解除挂载' : '挂载到时间轴'}
            </button>
          )}
          {activeSeq && isMountedOnActive && (
            <button
              className="secondary"
              disabled={Boolean(busyMsg)}
              onClick={() =>
                void runDirectPlanAndApply('正在烘焙为静态时间轴…', {
                  flowPath: outline.flowPath,
                  action: {
                    op: 'bakeSequence',
                    sequenceId: activeSeq.id,
                    keepFlowFiles: true,
                  },
                })
              }
            >
              固化为普通轨道
            </button>
          )}
        </div>
      </div>

      {errorMsg && (
        <p className="studio-error" role="alert">
          {errorMsg}
        </p>
      )}

      <div className="flow-workspace-grid">
        {/* Left: Logical Scene-Flow Graph (B-Roll Lane + Spine Chain + Draft Shelf) */}
        <section className="flow-canvas-pane" aria-label="逻辑场景流画布">
          <header className="flow-lane-header">
            <strong>节点编排画布</strong>
            <div className="flow-add-bar">
              <button className="secondary" onClick={() => handleAddNode('shot')}>
                + 镜头胶囊 (Shot)
              </button>
              <button className="secondary" onClick={() => handleAddNode('transcript-cut')}>
                + 口播粗剪 (Transcript)
              </button>
              <button className="secondary" onClick={() => handleAddNode('beat-cut')}>
                + 踩点快剪 (Beat)
              </button>
              <button
                className="secondary"
                disabled={spineItems.length === 0}
                onClick={() => handleAddNode('broll-overlay')}
              >
                + B-Roll 覆叠
              </button>
            </div>
          </header>

          {overlayItems.length > 0 && (
            <div className="flow-lane overlay-lane">
              <span className="flow-lane-label">锚定覆叠轨 (B-Roll Overlays · 随主干自动漂移)</span>
              <div className="flow-card-row">
                {overlayItems.map((item) => {
                  const isSelected = item.id === selectedNodeId;
                  const isPlayhead = item.id === playheadNodeId;
                  return (
                    <div
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      className={`flow-node-card overlay ${isSelected ? 'selected' : ''} ${isPlayhead ? 'at-playhead' : ''}`}
                      onClick={() => {
                        setSelectedNodeId(item.id);
                        setInspectorTab('capsule');
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') setSelectedNodeId(item.id);
                      }}
                    >
                      <div className="flow-card-top">
                        <span className="flow-type-tag overlay">B-Roll</span>
                        <code>{shortCapsuleFile(item.file)}</code>
                      </div>
                      <strong>{item.name}</strong>
                      <small>{item.summary}</small>
                      <div className="flow-card-foot">
                        {typeof item.startSeconds === 'number' && (
                          <span>
                            {item.startSeconds.toFixed(1)}s–{item.endSeconds?.toFixed(1)}s
                          </span>
                        )}
                        {isPlayhead && <span className="flow-playhead-pill">当前播放头</span>}
                        {(item.unbaked.visual || item.unbaked.voice) && (
                          <span className="flow-unbaked-pill">待烘焙</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flow-lane spine-lane">
            <span className="flow-lane-label">主干逻辑流 (Spine · 无绝对帧号顺序编排)</span>
            <div className="flow-spine-chain">
              {spineItems.map((item, idx) => {
                const isSelected = item.id === selectedNodeId;
                const isPlayhead = item.id === playheadNodeId;
                return (
                  <React.Fragment key={item.id}>
                    {idx > 0 && (
                      <div className="flow-connector" aria-hidden="true">
                        <Icon name="arrow" size={14} />
                      </div>
                    )}
                    <div
                      role="button"
                      tabIndex={0}
                      className={`flow-node-card ${item.enabled ? '' : 'disabled'} ${isSelected ? 'selected' : ''} ${isPlayhead ? 'at-playhead' : ''}`}
                      onClick={() => {
                        setSelectedNodeId(item.id);
                        setInspectorTab('capsule');
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') setSelectedNodeId(item.id);
                      }}
                    >
                      <div className="flow-card-top">
                        <span className={`flow-type-tag ${item.type}`}>
                          {item.type === 'shot'
                            ? '镜头'
                            : item.type === 'transcript-cut'
                              ? '口播粗剪'
                              : '踩点快剪'}
                        </span>
                        <code>{shortCapsuleFile(item.file)}</code>
                      </div>
                      <strong>
                        {idx + 1}. {item.name}
                      </strong>
                      <small>{item.summary}</small>
                      <div className="flow-card-foot">
                        {typeof item.startSeconds === 'number' ? (
                          <span>
                            {item.startSeconds.toFixed(1)}s–{item.endSeconds?.toFixed(1)}s (
                            {item.durationFrames}f)
                          </span>
                        ) : (
                          <span>已停用</span>
                        )}
                        {isPlayhead && <span className="flow-playhead-pill">当前播放头</span>}
                        {(item.unbaked.visual || item.unbaked.voice) && (
                          <span className="flow-unbaked-pill">待烘焙</span>
                        )}
                      </div>
                      <div className="flow-card-move" onClick={(e) => e.stopPropagation()}>
                        <button
                          aria-label={`前移 ${item.name}`}
                          disabled={idx === 0 || Boolean(busyMsg)}
                          onClick={() => moveSpine(item.id, -1)}
                        >
                          ←
                        </button>
                        <button
                          aria-label={`后移 ${item.name}`}
                          disabled={idx === spineItems.length - 1 || Boolean(busyMsg)}
                          onClick={() => moveSpine(item.id, 1)}
                        >
                          →
                        </button>
                      </div>
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          </div>

          {draftItems.length > 0 && (
            <div className="flow-lane draft-lane">
              <span className="flow-lane-label">草稿架 (Draft Shelf · 保留在 nodes/ 但未接入时间轴)</span>
              <div className="flow-card-row">
                {draftItems.map((item) => (
                  <div
                    key={item.id}
                    className={`flow-node-card draft ${item.id === selectedNodeId ? 'selected' : ''}`}
                    onClick={() => {
                      setSelectedNodeId(item.id);
                      setInspectorTab('capsule');
                    }}
                  >
                    <div className="flow-card-top">
                      <span className="flow-type-tag">草稿</span>
                      <code>{shortCapsuleFile(item.file)}</code>
                    </div>
                    <strong>{item.name}</strong>
                    <button
                      className="secondary"
                      onClick={(e) => {
                        e.stopPropagation();
                        const nextRole = item.type === 'broll-overlay' ? 'overlay' : 'spine';
                        void runDirectPlanAndApply('正在接入胶囊…', {
                          flowPath: outline.flowPath,
                          action:
                            nextRole === 'spine'
                              ? {
                                  op: 'reorder',
                                  spine: [...spineItems.map((s) => s.id), item.id],
                                }
                              : {
                                  op: 'reorder',
                                  overlays: [...overlayItems.map((o) => o.id), item.id],
                                },
                        });
                      }}
                    >
                      重新接入流
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Right: Pinpoint Capsule Inspector / Variables / SoundBed */}
        <aside className="flow-inspector-pane" aria-label="对点胶囊检查器">
          <div className="studio-tools">
            <button
              className={inspectorTab === 'capsule' ? 'pressed' : ''}
              onClick={() => setInspectorTab('capsule')}
            >
              胶囊对点编辑
            </button>
            <button
              className={inspectorTab === 'variables' ? 'pressed' : ''}
              onClick={() => setInspectorTab('variables')}
            >
              全局变量 ($var)
            </button>
            <button
              className={inspectorTab === 'soundbed' ? 'pressed' : ''}
              onClick={() => setInspectorTab('soundbed')}
            >
              BGM 与闪避
            </button>
          </div>

          {inspectorTab === 'capsule' && draftNode && (
            <div className="flow-capsule-editor">
              <div className="flow-file-banner">
                <span>对点目标胶囊（仅写入此文件）：</span>
                <code>{draftNodeFile || `${outline.nodesDir}/${draftNode.id}.json`}</code>
                <span className="flow-timing-pill">{formatFlowTimingBadge(draftNode)}</span>
              </div>

              <div className="studio-grid">
                <label className="studio-field">
                  <span>胶囊标题</span>
                  <input
                    aria-label="胶囊标题"
                    value={draftNode.name ?? ''}
                    onChange={(e) =>
                      setDraftNode((n) =>
                        n ? { ...n, name: e.target.value || undefined } : n,
                      )
                    }
                  />
                </label>
                <label className="studio-field">
                  <span>分镜意图 (Intent / AI 提示上下文)</span>
                  <input
                    aria-label="分镜意图"
                    placeholder="例如：特写展示核心卖点，节奏紧凑"
                    value={draftNode.intent ?? ''}
                    onChange={(e) =>
                      setDraftNode((n) =>
                        n ? { ...n, intent: e.target.value || undefined } : n,
                      )
                    }
                  />
                </label>
              </div>
              <Toggle
                label="启用此胶囊（关闭后不占时间轴时长，但保留胶囊数据）"
                value={draftNode.enabled !== false}
                onChange={(enabled) => setDraftNode((n) => (n ? { ...n, enabled } : n))}
              />

              {draftNode.type === 'shot' && (
                <>
                  <h4>画面来源 (Visual)</h4>
                  <div className="studio-grid">
                    <SelectControl
                      label="画面模式"
                      value={draftNode.visual.kind}
                      options={[
                        ['scene', '标准场景 (scenes/*.json)'],
                        ['component', 'TSX 动效组件 (components/*.tsx)'],
                        ['asset', '视频 / 图片素材 (Asset)'],
                        ['workflow', 'ComfyUI 生成节点图 (.workflow.json)'],
                      ]}
                      onChange={(kind) => {
                        setDraftNode((n) => {
                          if (!n || n.type !== 'shot') return n;
                          if (kind === 'component') {
                            return {
                              ...n,
                              visual: {
                                kind: 'component',
                                source: componentFiles[0] ?? 'components/Title.tsx',
                                params: {},
                                background: n.visual.kind === 'component' ? n.visual.background : '',
                              } as any,
                            };
                          }
                          if (kind === 'asset') {
                            return {
                              ...n,
                              visual: {
                                kind: 'asset',
                                assetId: visualAssets[0]?.id ?? 'asset-1',
                                sourceIn: 0,
                                speed: 1,
                                audioEnabled: false,
                                volume: 1,
                              },
                            };
                          }
                          if (kind === 'workflow') {
                            return {
                              ...n,
                              visual: {
                                kind: 'workflow',
                                workflow:
                                  workflowFiles[0] ?? 'components/workflows/txt2img.workflow.json',
                                modality: 'image',
                                params: {},
                                fitPolicy: 'trim',
                                fallbackColor: 'black',
                              },
                            };
                          }
                          return {
                            ...n,
                            visual: {
                              kind: 'scene',
                              sceneId: baseScenes[0]?.id ?? context.sceneId,
                              sourceIn: 0,
                              speed: 1,
                            },
                          };
                        });
                      }}
                    />

                    {draftNode.visual.kind === 'scene' && (
                      <SelectControl
                        label="绑定场景"
                        value={draftNode.visual.sceneId}
                        options={baseScenes.map((s) => [s.id, `${s.name} (${s.id})`] as [string, string])}
                        onChange={(sceneId) =>
                          setDraftNode((n) =>
                            n && n.type === 'shot' && n.visual.kind === 'scene'
                              ? { ...n, visual: { ...n.visual, sceneId } }
                              : n,
                          )
                        }
                      />
                    )}

                    {draftNode.visual.kind === 'component' && (
                      <label className="studio-field">
                        <span>组件源码路径</span>
                        <input
                          value={draftNode.visual.source}
                          list="flow-component-files"
                          onChange={(e) =>
                            setDraftNode((n) =>
                              n && n.type === 'shot' && n.visual.kind === 'component'
                                ? {
                                    ...n,
                                    visual: {
                                      ...n.visual,
                                      source: e.target.value,
                                      background: n.visual.background || 'black',
                                    },
                                  }
                                : n,
                            )
                          }
                        />
                        <datalist id="flow-component-files">
                          {componentFiles.map((f) => (
                            <option key={f} value={f} />
                          ))}
                        </datalist>
                      </label>
                    )}

                    {draftNode.visual.kind === 'asset' && (
                      <SelectControl
                        label="媒体素材"
                        value={draftNode.visual.assetId}
                        options={[
                          [draftNode.visual.assetId, draftNode.visual.assetId],
                          ...visualAssets.map((a) => [a.id, `${a.name} (${a.type})`] as [string, string]),
                        ]}
                        onChange={(assetId) =>
                          setDraftNode((n) =>
                            n && n.type === 'shot' && n.visual.kind === 'asset'
                              ? { ...n, visual: { ...n.visual, assetId } }
                              : n,
                          )
                        }
                      />
                    )}

                    {draftNode.visual.kind === 'workflow' && (
                      <>
                        <label className="studio-field">
                          <span>ComfyUI 工作流文件 (.workflow.json)</span>
                          <input
                            value={draftNode.visual.workflow}
                            list="flow-workflow-files"
                            onChange={(e) =>
                              setDraftNode((n) =>
                                n && n.type === 'shot' && n.visual.kind === 'workflow'
                                  ? { ...n, visual: { ...n.visual, workflow: e.target.value } }
                                  : n,
                              )
                            }
                          />
                          <datalist id="flow-workflow-files">
                            {workflowFiles.map((f) => (
                              <option key={f} value={f} />
                            ))}
                          </datalist>
                        </label>
                        <SelectControl
                          label="生成模态"
                          value={draftNode.visual.modality}
                          options={[
                            ['image', '生图 (Image)'],
                            ['video', '生视频 (Video)'],
                          ]}
                          onChange={(modality) =>
                            setDraftNode((n) =>
                              n && n.type === 'shot' && n.visual.kind === 'workflow'
                                ? {
                                    ...n,
                                    visual: {
                                      ...n.visual,
                                      modality: modality as 'image' | 'video',
                                    },
                                  }
                                : n,
                            )
                          }
                        />
                        <SelectControl
                          label="生视频时长回填策略"
                          value={draftNode.visual.fitPolicy}
                          options={[
                            ['trim', '裁切对齐镜头时长 (trim)'],
                            ['fit-speed', '变速适配镜头时长 (fit-speed)'],
                            ['extend-shot', '自动撑开镜头时长 (extend-shot)'],
                          ]}
                          onChange={(fitPolicy) =>
                            setDraftNode((n) =>
                              n && n.type === 'shot' && n.visual.kind === 'workflow'
                                ? {
                                    ...n,
                                    visual: {
                                      ...n.visual,
                                      fitPolicy: fitPolicy as 'trim' | 'fit-speed' | 'extend-shot',
                                    },
                                  }
                                : n,
                            )
                          }
                        />
                      </>
                    )}
                  </div>

                  {draftNode.visual.kind === 'workflow' && (
                    <div className="flow-workflow-callout">
                      <span>
                        {draftNode.visual.bakedAssetId
                          ? `已烘焙资产：${draftNode.visual.bakedAssetId}`
                          : '未烘焙（当前以占位或兜底场景实时参与剪辑，随时可异步出图/生视频）'}
                      </span>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setWorkflowDrawerOpen((v) => !v)}
                      >
                        {workflowDrawerOpen ? '收起工作流详情' : '查看工作流绑定'}
                      </button>
                      {workflowDrawerOpen && (
                        <p className="flow-hint">
                          工作流路径：<code>{draftNode.visual.workflow}</code> · 支持连接本地
                          ComfyUI (127.0.0.1:8188) 或外部 Agent 异步生成并在抽卡确认后一键回填到此胶囊。
                        </p>
                      )}
                    </div>
                  )}

                  <h4>时长弹性与转场 (Timing & Transition)</h4>
                  <div className="studio-grid">
                    <SelectControl
                      label="时长驱动模式"
                      value={draftNode.timing.mode}
                      options={[
                        ['fixed', '固定时长 (Fixed)'],
                        ['follow-voice', '跟随配音 / TTS 自动伸缩 (Follow Voice)'],
                        ['follow-visual', '跟随素材自然长度 (Follow Visual)'],
                        ['bars', '按音乐小节对齐 (Musical Bars)'],
                      ]}
                      onChange={(mode) =>
                        setDraftNode((n) => {
                          if (!n || n.type !== 'shot') return n;
                          return {
                            ...n,
                            timing: {
                              ...n.timing,
                              mode: mode as any,
                              ...(mode === 'fixed' && !n.timing.seconds && !n.timing.frames
                                ? { seconds: 3 }
                                : {}),
                              ...(mode === 'bars' && !n.timing.bars
                                ? { bars: 2, bpm: 120, beatsPerBar: 4 }
                                : {}),
                            },
                          };
                        })
                      }
                    />
                    {draftNode.timing.mode === 'fixed' && (
                      <NumberControl
                        label="镜头秒数 (s)"
                        value={
                          draftNode.timing.seconds ??
                          Number(
                            (
                              ((draftNode.timing.frames ?? 90) *
                                context.snapshot.project.fps.den) /
                              context.snapshot.project.fps.num
                            ).toFixed(2),
                          )
                        }
                        min={0.1}
                        max={600}
                        step={0.1}
                        onChange={(seconds) =>
                          setDraftNode((n) => {
                            if (!n || n.type !== 'shot') return n;
                            const nextTiming = { ...n.timing, mode: 'fixed' as const, seconds };
                            delete (nextTiming as Record<string, unknown>).frames;
                            return { ...n, timing: nextTiming };
                          })
                        }
                      />
                    )}
                    {draftNode.timing.mode === 'bars' && (
                      <>
                        <NumberControl
                          label="小节数 (Bars)"
                          value={draftNode.timing.bars ?? 2}
                          min={0.25}
                          max={64}
                          step={0.5}
                          onChange={(bars) =>
                            setDraftNode((n) =>
                              n && n.type === 'shot'
                                ? { ...n, timing: { ...n.timing, bars } }
                                : n,
                            )
                          }
                        />
                        <NumberControl
                          label="BPM"
                          value={typeof draftNode.timing.bpm === 'number' ? draftNode.timing.bpm : 120}
                          min={20}
                          max={320}
                          step={1}
                          onChange={(bpm) =>
                            setDraftNode((n) =>
                              n && n.type === 'shot'
                                ? { ...n, timing: { ...n.timing, bpm } }
                                : n,
                            )
                          }
                        />
                      </>
                    )}
                    <SelectControl
                      label="入场转场"
                      value={draftNode.transitionIn?.type ?? 'cut'}
                      options={[
                        ['cut', '硬切 (Cut)'],
                        ['dissolve', '叠化溶解 (Dissolve · 自动双轨交叠)'],
                        ['fade', '淡入过渡 (Fade)'],
                      ]}
                      onChange={(tType) =>
                        setDraftNode((n) => {
                          if (!n || n.type !== 'shot') return n;
                          if (tType === 'cut') {
                            const copy = { ...n };
                            delete copy.transitionIn;
                            return copy;
                          }
                          return {
                            ...n,
                            transitionIn: {
                              type: tType as 'dissolve' | 'fade',
                              seconds: n.transitionIn?.seconds || 0.4,
                            },
                          };
                        })
                      }
                    />
                  </div>

                  <h4>配音 / TTS 与流绑定字幕 (Voice & Subtitle)</h4>
                  <div className="studio-grid">
                    <SelectControl
                      label="配音模式"
                      value={draftNode.voice?.kind ?? 'none'}
                      options={[
                        ['none', '无配音'],
                        ['tts', '文稿 / 本地 TTS (未生成前自动估算口播时长)'],
                        ['asset', '已有录音素材 (Audio Asset)'],
                      ]}
                      onChange={(vKind) =>
                        setDraftNode((n) => {
                          if (!n || n.type !== 'shot') return n;
                          if (vKind === 'none') {
                            const copy = { ...n };
                            delete copy.voice;
                            return copy;
                          }
                          if (vKind === 'asset') {
                            return {
                              ...n,
                              voice: {
                                kind: 'asset',
                                assetId: audioAssets[0]?.id ?? 'voice-1',
                                sourceIn: 0,
                                volume: 1,
                                fadeIn: 0,
                                fadeOut: 0,
                              },
                            };
                          }
                          return {
                            ...n,
                            voice: {
                              kind: 'tts',
                              text: '在这里输入本镜头的旁白台词，配合跟随配音模式可自动撑开镜头与字幕。',
                              provider: 'http-local',
                              speed: 1,
                              volume: 1,
                            },
                            timing: {
                              ...n.timing,
                              mode: 'follow-voice',
                            },
                            subtitle:
                              n.subtitle ??
                              ({
                                mode: 'from-voice',
                              } as any),
                          };
                        })
                      }
                    />

                    {draftNode.voice?.kind === 'tts' && (
                      <>
                        <SelectControl
                          label="TTS 提供方"
                          value={draftNode.voice.provider}
                          options={[
                            ['http-local', '本地语音服务 (CosyVoice / GPT-SoVITS / IndexTTS)'],
                            ['comfyui', 'ComfyUI 语音节点流'],
                            ['agent-inbox', '外部 Agent 生成队列'],
                          ]}
                          onChange={(provider) =>
                            setDraftNode((n) =>
                              n && n.type === 'shot' && n.voice?.kind === 'tts'
                                ? { ...n, voice: { ...n.voice, provider } }
                                : n,
                            )
                          }
                        />
                        <label className="studio-field flow-span-full">
                          <span>旁白文稿 (修改字数会立即重算估算时长并联动字幕)</span>
                          <textarea
                            rows={2}
                            value={draftNode.voice.text}
                            onChange={(e) =>
                              setDraftNode((n) =>
                                n && n.type === 'shot' && n.voice?.kind === 'tts'
                                  ? { ...n, voice: { ...n.voice, text: e.target.value } }
                                  : n,
                              )
                            }
                          />
                        </label>
                      </>
                    )}

                    {draftNode.voice?.kind === 'asset' && (
                      <SelectControl
                        label="配音音频素材"
                        value={draftNode.voice.assetId}
                        options={[
                          [draftNode.voice.assetId, draftNode.voice.assetId],
                          ...audioAssets.map((a) => [a.id, a.name] as [string, string]),
                        ]}
                        onChange={(assetId) =>
                          setDraftNode((n) =>
                            n && n.type === 'shot' && n.voice?.kind === 'asset'
                              ? { ...n, voice: { ...n.voice, assetId } }
                              : n,
                          )
                        }
                      />
                    )}

                    <SelectControl
                      label="镜头绑定字幕"
                      value={draftNode.subtitle?.mode ?? 'none'}
                      options={[
                        ['none', '不生成字幕'],
                        ['from-voice', '自动同步配音文稿 / 时间轴词级 Cues'],
                        ['custom', '自定义字幕文本'],
                      ]}
                      onChange={(subMode) =>
                        setDraftNode((n) => {
                          if (!n || n.type !== 'shot') return n;
                          if (subMode === 'none') {
                            const copy = { ...n };
                            delete copy.subtitle;
                            return copy;
                          }
                          return {
                            ...n,
                            subtitle: {
                              ...(n.subtitle ?? {}),
                              mode: subMode as 'from-voice' | 'custom',
                              ...(subMode === 'custom'
                                ? { text: n.subtitle?.text ?? n.name ?? '' }
                                : {}),
                            } as any,
                          };
                        })
                      }
                    />
                  </div>
                </>
              )}

              {draftNode.type === 'transcript-cut' && (
                <>
                  <h4>文稿口播粗剪 (勾选保留，取消勾选即剔除气口/废话并自动波纹拼接)</h4>
                  <div className="studio-grid">
                    <SelectControl
                      label="源口播素材"
                      value={draftNode.assetId}
                      options={[
                        [draftNode.assetId, draftNode.assetId],
                        ...visualAssets
                          .concat(audioAssets)
                          .map((a) => [a.id, `${a.name} (${a.type})`] as [string, string]),
                      ]}
                      onChange={(assetId) =>
                        setDraftNode((n) =>
                          n && n.type === 'transcript-cut' ? { ...n, assetId } : n,
                        )
                      }
                    />
                    <NumberControl
                      label="句尾余量 (s)"
                      value={draftNode.padEnd}
                      min={0}
                      max={2}
                      step={0.02}
                      onChange={(padEnd) =>
                        setDraftNode((n) =>
                          n && n.type === 'transcript-cut' ? { ...n, padEnd } : n,
                        )
                      }
                    />
                  </div>
                  <div className="flow-transcript-list">
                    {draftNode.segments.map((seg, idx) => (
                      <label
                        key={seg.id}
                        className={`flow-segment-row ${seg.keep === false ? 'cut' : 'kept'}`}
                      >
                        <input
                          type="checkbox"
                          checked={seg.keep !== false}
                          onChange={(e) => {
                            const keep = e.target.checked;
                            setDraftNode((n) => {
                              if (!n || n.type !== 'transcript-cut') return n;
                              const segments = n.segments.map((s, i) =>
                                i === idx ? { ...s, keep } : s,
                              );
                              return { ...n, segments };
                            });
                          }}
                        />
                        <code>
                          {seg.start.toFixed(2)}s–{seg.end.toFixed(2)}s
                        </code>
                        <input
                          value={seg.text ?? ''}
                          onChange={(e) => {
                            const text = e.target.value;
                            setDraftNode((n) => {
                              if (!n || n.type !== 'transcript-cut') return n;
                              const segments = n.segments.map((s, i) =>
                                i === idx ? { ...s, text } : s,
                              );
                              return { ...n, segments };
                            });
                          }}
                        />
                      </label>
                    ))}
                  </div>
                </>
              )}

              {draftNode.type === 'beat-cut' && (
                <>
                  <h4>音乐节拍快剪 (Beat-Cut)</h4>
                  <div className="studio-grid">
                    <NumberControl
                      label="BPM"
                      value={typeof draftNode.bpm === 'number' ? draftNode.bpm : 120}
                      min={20}
                      max={320}
                      step={1}
                      onChange={(bpm) =>
                        setDraftNode((n) => (n && n.type === 'beat-cut' ? { ...n, bpm } : n))
                      }
                    />
                    <NumberControl
                      label="每切拍数 (Beats Per Cut)"
                      value={draftNode.beatsPerCut}
                      min={0.25}
                      max={32}
                      step={0.5}
                      onChange={(beatsPerCut) =>
                        setDraftNode((n) =>
                          n && n.type === 'beat-cut' ? { ...n, beatsPerCut } : n,
                        )
                      }
                    />
                  </div>
                </>
              )}

              {draftNode.type === 'broll-overlay' && (
                <>
                  <h4>语义锚点 (跟随目标主干镜头自动移动，绝不因前序增删错位)</h4>
                  <div className="studio-grid">
                    <SelectControl
                      label="锚定主干镜头"
                      value={draftNode.anchor.nodeId}
                      options={spineItems.map((s) => [s.id, `${s.name} (${s.id})`] as [string, string])}
                      onChange={(anchorNodeId) =>
                        setDraftNode((n) =>
                          n && n.type === 'broll-overlay'
                            ? { ...n, anchor: { ...n.anchor, nodeId: anchorNodeId } }
                            : n,
                        )
                      }
                    />
                    <NumberControl
                      label="锚点偏移秒数 (s)"
                      value={draftNode.anchor.offsetSeconds}
                      min={-30}
                      max={600}
                      step={0.1}
                      onChange={(offsetSeconds) =>
                        setDraftNode((n) =>
                          n && n.type === 'broll-overlay'
                            ? { ...n, anchor: { ...n.anchor, offsetSeconds } }
                            : n,
                        )
                      }
                    />
                    <NumberControl
                      label="覆叠持续秒数 (s)"
                      value={draftNode.anchor.durationSeconds ?? 2}
                      min={0.2}
                      max={600}
                      step={0.1}
                      onChange={(durationSeconds) =>
                        setDraftNode((n) =>
                          n && n.type === 'broll-overlay'
                            ? { ...n, anchor: { ...n.anchor, durationSeconds } }
                            : n,
                        )
                      }
                    />
                  </div>
                </>
              )}

              <div className="flow-preview-box">
                <div className="flow-preview-controls">
                  <NumberControl
                    label="胶囊内预览时刻 (s)"
                    value={previewLocalSec}
                    min={0}
                    max={120}
                    step={0.2}
                    onChange={setPreviewLocalSec}
                  />
                  <button
                    type="button"
                    className="secondary"
                    disabled={Boolean(busyMsg)}
                    onClick={async () => {
                      setBusyMsg('正在单镜头隔离渲染…');
                      setErrorMsg('');
                      try {
                        const res = await context.run('flowPreviewNode', {
                          flowPath: outline.flowPath,
                          nodeId: draftNode.id,
                          localSeconds: previewLocalSec,
                          maxWidth: 640,
                          inline: true,
                        });
                        if (res?.data) setPreviewPng(res.data);
                      } catch (e) {
                        setErrorMsg((e as Error).message);
                      } finally {
                        setBusyMsg('');
                      }
                    }}
                  >
                    单镜头隔离预览
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={Boolean(busyMsg)}
                    onClick={() =>
                      void runDirectPlanAndApply(
                        '正在移出胶囊…',
                        {
                          flowPath: outline.flowPath,
                          action: {
                            op: 'removeNode',
                            nodeId: draftNode.id,
                            deleteFile: false,
                          },
                        },
                        () => setSelectedNodeId(spineItems[0]?.id ?? ''),
                      )
                    }
                  >
                    移至草稿架
                  </button>
                </div>
                {previewPng && (
                  <img
                    className="flow-preview-img"
                    alt={`${draftNode.name ?? draftNode.id} 单镜头预览`}
                    src={`data:image/png;base64,${previewPng}`}
                  />
                )}
              </div>

              <CandidateActions
                context={context}
                changeKey={JSON.stringify(draftNode)}
                onApplied={() => void loadOutline(outline.flowPath)}
                prepare={() =>
                  context.run('flowPlan', {
                    revision: context.snapshot.revision,
                    flowPath: outline.flowPath,
                    action: {
                      op: 'upsertNode',
                      node: draftNode,
                    },
                    inline: true,
                  })
                }
              />
            </div>
          )}

          {inspectorTab === 'variables' && (
            <div className="flow-capsule-editor">
              <p className="flow-hint">
                在任意胶囊字段中写入 <code>$var.变量名</code> 或 <code>{'${var.变量名}'}</code>{' '}
                即可实现全片主题色、讲者名、BPM 等统一联动更新，无需逐个修改镜头文件。
              </p>
              <div className="flow-var-list">
                {Object.entries(varsDraft).map(([k, v]) => (
                  <div key={k} className="flow-var-row">
                    <code>$var.{k}</code>
                    <input
                      value={String(v)}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const num = Number(raw);
                        const parsed =
                          raw === 'true'
                            ? true
                            : raw === 'false'
                              ? false
                              : raw !== '' && Number.isFinite(num)
                                ? num
                                : raw;
                        setVarsDraft((prev) => ({ ...prev, [k]: parsed }));
                      }}
                    />
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        setVarsDraft((prev) => {
                          const next = { ...prev };
                          delete next[k];
                          return next;
                        })
                      }
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
              <div className="flow-var-add">
                <input
                  placeholder="变量名 (如 brandColor)"
                  value={newVarKey}
                  onChange={(e) => setNewVarKey(e.target.value)}
                />
                <input
                  placeholder="变量值 (如 coral 或 128)"
                  value={newVarVal}
                  onChange={(e) => setNewVarVal(e.target.value)}
                />
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    const key = newVarKey.trim();
                    if (!key) return;
                    const num = Number(newVarVal);
                    const val =
                      newVarVal === 'true'
                        ? true
                        : newVarVal === 'false'
                          ? false
                          : newVarVal.trim() !== '' && Number.isFinite(num)
                            ? num
                            : newVarVal;
                    setVarsDraft((prev) => ({ ...prev, [key]: val }));
                    setNewVarKey('');
                    setNewVarVal('');
                  }}
                >
                  添加变量
                </button>
              </div>
              <CandidateActions
                context={context}
                changeKey={JSON.stringify(varsDraft)}
                onApplied={() => void loadOutline(outline.flowPath)}
                prepare={() =>
                  context.run('flowPlan', {
                    revision: context.snapshot.revision,
                    flowPath: outline.flowPath,
                    action: {
                      op: 'setVariables',
                      variables: varsDraft,
                      merge: false,
                    },
                    inline: true,
                  })
                }
              />
            </div>
          )}

          {inspectorTab === 'soundbed' && (
            <div className="flow-capsule-editor">
              <p className="flow-hint">
                全局背景音乐床会自动铺满整条场景流时长，并在有人声/TTS 的镜头区间自动启用侧链压限闪避 (Sidechain Ducking)。
              </p>
              <Toggle
                label="启用全局背景音乐床 (SoundBed)"
                value={Boolean(soundBedDraft)}
                onChange={(on) =>
                  setSoundBedDraft(
                    on
                      ? {
                          assetId: audioAssets[0]?.id ?? 'bgm-1',
                          sourceIn: 0,
                          volume: 0.45,
                          fadeInSeconds: 0.3,
                          fadeOutSeconds: 1.0,
                          ducking: {
                            enabled: true,
                            reductionDb: -10,
                            thresholdDb: -28,
                            attackMs: 25,
                            releaseMs: 280,
                          },
                        }
                      : null,
                  )
                }
              />
              {soundBedDraft && (
                <div className="studio-grid">
                  <SelectControl
                    label="BGM 音频素材"
                    value={soundBedDraft.assetId}
                    options={[
                      [soundBedDraft.assetId, soundBedDraft.assetId],
                      ...audioAssets.map((a) => [a.id, a.name] as [string, string]),
                    ]}
                    onChange={(assetId) =>
                      setSoundBedDraft((s) => (s ? { ...s, assetId } : s))
                    }
                  />
                  <NumberControl
                    label="基础音量 (0–4)"
                    value={soundBedDraft.volume}
                    min={0}
                    max={4}
                    step={0.05}
                    onChange={(volume) =>
                      setSoundBedDraft((s) => (s ? { ...s, volume } : s))
                    }
                  />
                  <Toggle
                    label="遇人声自动闪避压低 BGM (Sidechain Ducking)"
                    value={soundBedDraft.ducking.enabled}
                    onChange={(enabled) =>
                      setSoundBedDraft((s) =>
                        s ? { ...s, ducking: { ...s.ducking, enabled } } : s,
                      )
                    }
                  />
                  {soundBedDraft.ducking.enabled && (
                    <NumberControl
                      label="闪避压低幅度 (dB)"
                      value={soundBedDraft.ducking.reductionDb}
                      min={-40}
                      max={0}
                      step={1}
                      onChange={(reductionDb) =>
                        setSoundBedDraft((s) =>
                          s ? { ...s, ducking: { ...s.ducking, reductionDb } } : s,
                        )
                      }
                    />
                  )}
                </div>
              )}
              <CandidateActions
                context={context}
                changeKey={JSON.stringify(soundBedDraft)}
                onApplied={() => void loadOutline(outline.flowPath)}
                prepare={() =>
                  context.run('flowPlan', {
                    revision: context.snapshot.revision,
                    flowPath: outline.flowPath,
                    action: {
                      op: 'setSoundBed',
                      soundBed: soundBedDraft,
                    },
                    inline: true,
                  })
                }
              />
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
