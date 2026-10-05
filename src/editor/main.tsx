import React, { useEffect, useState, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import type { Snapshot, Node, Operation, Scene, Diagnostic, Conflict } from '../core/model.js';
import type { RenderJob } from '../media/export.js';
import { evaluateNode, getNumericPath } from '../core/time.js';
import './workbench.css';
import { Icon } from './Icons.js';
import { Timeline } from './Timeline.js';
import { CanvasViewport } from './CanvasViewport.js';
import { usePanelLayout, Splitter } from './panelLayout.js';
import { readCompositionRoute, compositionUrl } from './navigation.js';
import { EffectInspector } from './EffectInspector.js';
import { VectorInspector } from './VectorInspector.js';
import { GraphicsInspector } from './GraphicsInspector.js';
import { TrackingInspector } from './TrackingInspector.js';
import { MatrixInspector } from './MatrixInspector.js';
import { SceneReferenceInspector } from './SceneReferenceInspector.js';
import { TimeInspector } from './TimeInspector.js';
import { FilmToolbar } from './FilmToolbar.js';
import type { SequenceAction } from '../core/editing.js';
import { AnimationInspector } from './AnimationInspector.js';
import { DriverInspector } from './DriverInspector.js';
import { CanvasInteraction } from './CanvasInteraction.js';
import { CodeEditor } from './CodeEditor.js';
import { CodeCheck, type CodeCheckReport } from './CodeCheck.js';
import { ParameterInspector } from './ParameterInspector.js';
import { VisualAuditPanel, type VisualAuditReport } from './VisualAuditPanel.js';
import { usePlayback } from './usePlayback.js';
import { canPresentPreview, paintPreview, readPreviewBitmap } from './preview.js';
import type { ParameterDefinitions } from '../core/parameters.js';
import type { KeyframeAction } from '../core/keyframes.js';
import { DrawingWorkspace } from './DrawingWorkspace.js';
import { AssetItem, ASSET_DROP_EVENT, type AssetDropDetail } from './AssetItem.js';
import type { CompositionDraft, InteractionGraph } from '../core/interaction.js';
import { ProjectActions, ProjectHome } from './ProjectHome.js';
import { SoundEditor } from './SoundEditor.js';
import { MediaManager } from './MediaManager.js';
type State = {
  mediaEpoch?: number;
  snapshot: Snapshot;
  root: string;
  connection: unknown;
  pendingFiles?: Record<string, string>;
  diagnostics: Diagnostic[];
  conflicts: Conflict[];
  selection: string[];
  canUndo: boolean;
  canRedo: boolean;
  jobs: RenderJob[];
};
async function rpc(method: string, params: unknown = {}): Promise<any> {
  const response = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const value = await response.json();
  if (value.error) throw new Error(value.error.message);
  return value.result;
}
const uid = () => crypto.randomUUID();
function App() {
  const [state, setState] = useState<State>();
  const initialRoute = useRef(readCompositionRoute()).current;
  const [workspace, setWorkspace] = useState<string>(initialRoute.workspace);
  const [drawingId, setDrawingId] = useState(initialRoute.drawingId ?? '');
  const [focusPath, setFocusPath] = useState<string[]>(initialRoute.path),
    [composition, setComposition] = useState<
      | {
          scene: Scene;
          width: number;
          height: number;
          breadcrumbs: Array<{ id: string; name: string; type: string }>;
        }
      | undefined
    >();
  const [sceneId, setSceneId] = useState(initialRoute.sceneId);
  const [focusContextFrames, setFocusContextFrames] = useState<number[]>(
    initialRoute.contextFrames ?? [],
  );
  const [sceneFrames, setSceneFrames] = useState<Record<string, number>>({}),
    [sequenceFrame, setSequenceFrame] = useState(0);
  const scopeKey = `${sceneId}:${JSON.stringify(focusPath)}${focusContextFrames.length ? `:${JSON.stringify(focusContextFrames)}` : ''}`,
    sceneFrame = sceneFrames[scopeKey] ?? 0;
  const setSceneFrame = (value: React.SetStateAction<number>) =>
    setSceneFrames((current) => ({
      ...current,
      [scopeKey]: typeof value === 'function' ? value(current[scopeKey] ?? 0) : value,
    }));
  const frame = workspace === 'editing' ? sequenceFrame : sceneFrame;
  const setFrame = workspace === 'editing' ? setSequenceFrame : setSceneFrame;
  const { layout, setLayout, reset: resetLayout } = usePanelLayout();
  const [inspectorTab, setInspectorTab] = useState<'properties' | 'effects' | 'animation'>(
    'properties',
  );
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selected = selectedIds.at(-1) ?? '';
  const setSelected = (id: string) => setSelectedIds(id ? [id] : []);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<'export' | 'connect' | 'settings' | undefined>();
  const [exportPath, setExportPath] = useState('');
  const [format, setFormat] = useState('mp4');
  const [codePath, setCodePath] = useState('');
  const [code, setCode] = useState('');
  const [codeDirty, setCodeDirty] = useState(false);
  const [codeBusy, setCodeBusy] = useState(false),
    [codeCheck, setCodeCheck] = useState<CodeCheckReport>(),
    [codeJump, setCodeJump] = useState<{ line: number; column?: number }>(),
    [codeBase, setCodeBase] = useState<{
      path: string;
      hash: string;
      version: 'active' | 'pending';
    }>();
  const codeBaseTicket = useRef(0);
  const codeDrafts = useRef(
    new Map<
      string,
      { content: string; base?: { path: string; hash: string; version: 'active' | 'pending' } }
    >(),
  );
  const draftKey = (file: string) => `vmotion-code-draft:${state?.root ?? ''}:${file}`;
  const [brush, setBrush] = useState(6);
  const [paintColor, setPaintColor] = useState('#c1b6ff');
  const [hold, setHold] = useState(30);
  const [onion, setOnion] = useState(false);
  const [stroke, setStroke] = useState<Node['points']>([]);
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [previewReady, setPreviewReady] = useState(false);
  const [previewFrame, setPreviewFrame] = useState(0);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [visualCheck, setVisualCheck] = useState<VisualAuditReport>(),
    [visualCheckBusy, setVisualCheckBusy] = useState(false);
  const visualCheckOpen =
    workspace === 'animation' &&
    visualCheck?.sceneId === sceneId &&
    JSON.stringify(visualCheck.path) === JSON.stringify(focusPath);
  const [interactions, setInteractions] = useState<InteractionGraph>();
  const [canvasDraft, setCanvasDraft] = useState<CompositionDraft[]>();
  const [componentParams, setComponentParams] = useState<ParameterDefinitions>({});
  const componentMetadataSource = useRef('');
  const [assetTab, setAssetTab] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState('');
  const [soundEditing, setSoundEditing] = useState<string>();
  const [mediaManaging, setMediaManaging] = useState(false);
  const [clipSelection, setClipSelection] = useState<string[]>([]),
    clipSelected = clipSelection.at(-1) ?? '';
  const setClipSelected = (id: string) => setClipSelection(id ? [id] : []);
  const selectClip = (id: string, additive = false) =>
    setClipSelection((current) =>
      additive
        ? current.includes(id)
          ? current.filter((value) => value !== id)
          : [...current, id]
        : [id],
    );
  const previewRef = useRef<HTMLDivElement>(null);
  const strokeRef = useRef<Node['points']>([]);
  const abort = useRef<AbortController | undefined>(undefined);
  const previewCanvas = useRef<HTMLCanvasElement | null>(null),
    previewBitmap = useRef<{ bitmap: ImageBitmap; key: string; frame: number } | undefined>(
      undefined,
    );
  const [previewQuality, setPreviewQuality] = useState(960);
  const [previewMedia, setPreviewMedia] = useState<'auto' | 'original'>('auto');
  const attachPreviewCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    previewCanvas.current = canvas;
    if (canvas && previewBitmap.current) paintPreview(canvas, previewBitmap.current.bitmap);
  }, []);
  const previewTarget = useRef<
    | {
        signature: string;
        key: string;
        quality: number;
        mediaQuality: 'auto' | 'original';
        frame: number;
        sceneId: string;
        editing: boolean;
        width: number;
        height: number;
        playing: boolean;
        revision: string;
        path: string[];
        contextFrames: number[];
        draft?: CompositionDraft[];
      }
    | undefined
  >(undefined);
  const previewFlight = useRef(false),
    unmounted = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [waveforms, setWaveforms] = useState<Record<string, number[]>>({});
  const run = useCallback(async (method: string, params: unknown = {}) => {
    try {
      setError('');
      const result = await rpc(method, params);
      if (result?.snapshot) setState((s) => ({ ...s!, ...result }));
      return result;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    }
  }, []);
  useEffect(() => {
    rpc('state')
      .then((s) => {
        setState(s);
        setJobs(s.jobs);
        const selectedScene =
          s.snapshot.scenes.find((scene: Scene) => scene.id === initialRoute.sceneId) ??
          s.snapshot.scenes[0];
        setSceneId(selectedScene?.id ?? '');
        setSelected('');
        setExportPath(`${s.root}/exports/video.mp4`);
      })
      .catch((e) => setError(e.message));
    const events = new EventSource('/api/events');
    events.onmessage = (event) => {
      const v = JSON.parse(event.data);
      if (v.kind === 'change') setState((s) => ({ ...s!, ...v.state }));
      else setJobs(v.jobs);
    };
    return () => {
      unmounted.current = true;
      events.close();
      abort.current?.abort();
      previewBitmap.current?.bitmap.close();
      previewBitmap.current = undefined;
    };
  }, []);
  const snapshot = state?.snapshot,
    project = snapshot?.project,
    rootScene = snapshot?.scenes.find((s) => s.id === sceneId),
    scene = focusPath.length && composition ? composition.scene : rootScene,
    node =
      scene?.nodes.find((n) => n.id === selected) ??
      interactions?.layers.find((l) => l.node.id === selected)?.node,
    sequence = snapshot?.sequences.find((s) => s.id === project?.activeSequence),
    fps = project ? project.fps.num / project.fps.den : 30;
  const selectedLayer = interactions?.layers.find((layer) => layer.node.id === node?.id),
    nodeFrame = selectedLayer?.frame ?? frame,
    nodeContextFrames = selectedLayer?.contextFrames ?? focusContextFrames;
  const activeDuration =
    workspace === 'editing' ? (sequence?.duration ?? 1) : (scene?.duration ?? 1);
  const viewWidth =
      focusPath.length && composition
        ? composition.width
        : ((workspace !== 'editing' ? rootScene?.width : undefined) ?? project?.width ?? 1920),
    viewHeight =
      focusPath.length && composition
        ? composition.height
        : ((workspace !== 'editing' ? rootScene?.height : undefined) ?? project?.height ?? 1080);
  const playback = usePlayback({
    snapshot,
    sequenceId: sequence?.id,
    audio: workspace === 'editing',
    scope: workspace === 'editing' ? `editing:${sequence?.id ?? ''}` : workspace + scopeKey,
    playing,
    frame,
    duration: activeDuration,
    fps,
    onFrame: setFrame,
    onStop: () => setPlaying(false),
  });
  useEffect(() => {
    if (!sceneId) return;
    window.history.replaceState(
      null,
      '',
      workspace === 'drawing'
        ? `#/drawing/${encodeURIComponent(drawingId)}`
        : workspace === 'editing'
          ? '#/project'
          : compositionUrl(sceneId, focusPath, focusContextFrames),
    );
  }, [sceneId, workspace, focusPath.join('/'), focusContextFrames.join(','), drawingId]);
  useEffect(() => {
    const back = () => {
      const route = readCompositionRoute();
      setPlaying(false);
      setWorkspace(route.workspace);
      if (route.drawingId) setDrawingId(route.drawingId);
      if (route.sceneId) setSceneId(route.sceneId);
      setFocusContextFrames(route.contextFrames ?? []);
      setFocusPath(route.path);
      setSelected('');
      setComposition(undefined);
    };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  useEffect(() => {
    if (!snapshot || workspace === 'editing' || !focusPath.length) {
      setComposition(undefined);
      return;
    }
    let cancelled = false;
    rpc('compositionInspect', {
      sceneId,
      frame,
      path: focusPath,
      contextFrames: focusContextFrames,
    })
      .then((result) => {
        if (!cancelled) setComposition(result);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [
    snapshot?.revision,
    sceneId,
    focusPath.join('/'),
    focusContextFrames.join(','),
    frame,
    workspace,
  ]);
  useEffect(() => {
    setSelected('');
  }, [sceneId]);
  useEffect(() => {
    if (!snapshot || workspace !== 'animation' || playing) return;
    let cancelled = false;
    rpc('compositionInteractions', {
      sceneId,
      frame,
      path: focusPath,
      contextFrames: focusContextFrames,
    })
      .then((result) => {
        if (!cancelled) setInteractions(result);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [
    snapshot?.revision,
    sceneId,
    frame,
    focusPath.join('/'),
    focusContextFrames.join(','),
    workspace,
    playing,
  ]);
  useEffect(() => {
    setInteractions(undefined);
    setCanvasDraft(undefined);
  }, [sceneId, focusPath.join('/'), workspace]);
  useEffect(() => {
    if (snapshot && !snapshot.scenes.some((s) => s.id === sceneId)) {
      setSceneId(snapshot.scenes[0]?.id ?? '');
    }
  }, [snapshot?.revision]);
  useEffect(() => {
    for (const asset of project?.assets ?? [])
      if (asset.type === 'audio' && !waveforms[asset.id])
        rpc('waveform', { assetId: asset.id })
          .then((peaks) => setWaveforms((w) => ({ ...w, [asset.id]: peaks })))
          .catch(() => setWaveforms((w) => ({ ...w, [asset.id]: [] })));
  }, [project?.assets.length]);
  useEffect(() => {
    if (!project || workspace === 'drawing') return;
    previewTarget.current = {
      key: JSON.stringify([
        snapshot?.revision,
        sceneId,
        workspace,
        focusPath,
        focusContextFrames,
        canvasDraft,
        playback.clockId,
        previewQuality,
        previewMedia,
        state?.mediaEpoch,
      ]),
      quality: previewQuality,
      mediaQuality: previewMedia,
      signature: JSON.stringify([
        frame,
        snapshot?.revision,
        sceneId,
        workspace,
        playing,
        project.width,
        project.height,
        focusPath,
        focusContextFrames,
        canvasDraft,
        previewQuality,
        previewMedia,
        state?.mediaEpoch,
      ]),
      frame,
      sceneId,
      contextFrames: focusContextFrames,
      editing: workspace === 'editing',
      width: viewWidth,
      height: viewHeight,
      playing,
      revision: snapshot!.revision,
      path: focusPath,
      draft: canvasDraft,
    };
    const pump = async () => {
      if (previewFlight.current || unmounted.current) return;
      const target = previewTarget.current!;
      previewFlight.current = true;
      setPreviewBusy(true);
      const controller = new AbortController();
      abort.current = controller;
      const w = Math.min(target.width, target.quality),
        h = Math.round((w * target.height) / target.width);
      try {
        const r = await fetch(
          `/api/frame?format=rgba&media=${target.mediaQuality}&frame=${target.frame}&width=${w}&height=${h}&${target.editing ? '' : `scene=${encodeURIComponent(target.sceneId)}&path=${encodeURIComponent(JSON.stringify(target.path))}&context=${encodeURIComponent(JSON.stringify(target.contextFrames))}`}&revision=${target.revision}${target.draft ? `&draft=${encodeURIComponent(JSON.stringify(target.draft))}` : ''}`,
          { signal: controller.signal },
        );
        if (!r.ok) {
          const v = await r.json();
          throw new Error(v.error.message);
        }
        if (r.headers.get('X-Vmotion-Stale') === 'true')
          setError(decodeURIComponent(r.headers.get('X-Vmotion-Error') ?? '正在使用最后有效画面'));
        const bitmap = await readPreviewBitmap(r),
          reply = {
            revision: r.headers.get('X-Vmotion-Revision') ?? '',
            frame: Number(r.headers.get('X-Vmotion-Frame') ?? target.frame),
          };
        if (
          !unmounted.current &&
          canPresentPreview(
            target,
            previewTarget.current,
            reply,
            target.revision,
            previewBitmap.current,
            fps * 2,
          )
        ) {
          if (previewCanvas.current) paintPreview(previewCanvas.current, bitmap);
          const previous = previewBitmap.current;
          previewBitmap.current = { bitmap, key: target.key, frame: reply.frame };
          previous?.bitmap.close();
          setPreviewReady(true);
          setPreviewFrame(reply.frame);
        } else bitmap.close();
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      } finally {
        previewFlight.current = false;
        if (!unmounted.current) {
          setPreviewBusy(false);
          if (previewTarget.current?.signature !== target.signature) void pump();
        }
      }
    };
    void pump();
  }, [
    frame,
    snapshot?.revision,
    sceneId,
    workspace,
    viewWidth,
    viewHeight,
    playing,
    focusPath.join('/'),
    focusContextFrames.join(','),
    playback.clockId,
    previewQuality,
    previewMedia,
    state?.mediaEpoch,
    canvasDraft,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (componentMetadataSource.current !== node?.component) {
      setComponentParams({});
      componentMetadataSource.current = node?.component ?? '';
    }
    if (node?.type === 'component' && node.component)
      rpc('component', { source: node.component })
        .then((value) => {
          if (!cancelled) setComponentParams(value.parameters);
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        });
    else setComponentParams({});
    return () => {
      cancelled = true;
    };
  }, [node?.id, node?.component, snapshot?.revision]);
  useEffect(() => {
    if (!snapshot || codeDirty) return;
    const file = codePath || Object.keys(snapshot.files).find((f) => f.endsWith('.ts')) || '';
    setCodePath(file);
    const ticket = ++codeBaseTicket.current;
    const content = state?.pendingFiles?.[file] ?? snapshot.files[file] ?? '';
    let draft = codeDrafts.current.get(file);
    if (!draft)
      try {
        const stored = sessionStorage.getItem(draftKey(file));
        if (stored) {
          const parsed = JSON.parse(stored);
          if (
            typeof parsed.content === 'string' &&
            parsed.base?.path === file &&
            typeof parsed.base.hash === 'string'
          )
            draft = parsed;
        }
      } catch {}
    if (draft && draft.content !== content) {
      codeDrafts.current.set(file, draft);
      setCode(draft.content);
      setCodeBase(draft.base);
      setCodeDirty(true);
      return;
    }
    setCode(content);
    setCodeBase(undefined);
    void crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)).then((bytes) => {
      if (ticket === codeBaseTicket.current && !unmounted.current) {
        const base = {
          path: file,
          hash: Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, '0')).join(''),
          version: state?.pendingFiles ? ('pending' as const) : ('active' as const),
        };
        setCodeBase(base);
        const current = codeDrafts.current.get(file);
        if (current && !current.base) {
          current.base = base;
          try {
            sessionStorage.setItem(draftKey(file), JSON.stringify(current));
          } catch {}
        }
      }
    });
  }, [codePath, snapshot?.revision, codeDirty, state?.pendingFiles]);
  const checkCode = async (commit = false) => {
    if (!codeBase || codeBase.path !== codePath) return;
    setCodeBusy(true);
    try {
      const frames = [
          ...new Set([0, frame, Math.floor(activeDuration / 2), Math.max(0, activeDuration - 1)]),
        ],
        request = {
          revision: stateRef.current?.snapshot.revision,
          version: codeBase.version,
          files: [{ type: 'replace', path: codePath, expectedHash: codeBase.hash, content: code }],
          samples: frames.map((frame) => ({
            sceneId,
            frame,
            path: focusPath,
            contextFrames: focusContextFrames,
          })),
          width: 320,
          determinism: true,
          inline: !commit,
        },
        result = await run(commit ? 'projectApply' : 'projectPreflight', request);
      if (result) {
        if (commit && result.applied) {
          codeDrafts.current.delete(codePath);
          try {
            sessionStorage.removeItem(draftKey(codePath));
          } catch {}
          const fresh = await rpc('state');
          setState(fresh);
          setCodeDirty(false);
          setCodeCheck(undefined);
        } else setCodeCheck(result);
      }
    } finally {
      setCodeBusy(false);
    }
  };
  const checkVisual = async () => {
    if (visualCheckBusy || !scene) return;
    setVisualCheckBusy(true);
    setPlaying(false);
    try {
      const samples = [
          ...new Set([
            0,
            Math.max(0, frame - 1),
            frame,
            Math.min(activeDuration - 1, frame + 1),
            Math.floor((activeDuration - 1) / 2),
            activeDuration - 1,
          ]),
        ],
        result = await run('visualAudit', {
          sceneId,
          path: focusPath,
          contextFrames: focusContextFrames,
          revision: stateRef.current?.snapshot.revision,
          frames: samples,
          width: 320,
          inline: true,
        });
      if (result) setVisualCheck(result);
    } finally {
      setVisualCheckBusy(false);
    }
  };
  const transact = async (operations: Operation[]) => {
    setSaving(true);
    try {
      if (
        operations.every((op) => op.type === 'updateNode') &&
        (focusPath.length ||
          operations.some((op) => !rootScene?.nodes.some((n) => n.id === (op as any).nodeId)))
      ) {
        return await run('compositionTransactBatch', {
          sceneId,
          frame,
          revision: stateRef.current?.snapshot.revision,
          edits: operations.map((operation) => {
            const op = operation as Extract<Operation, { type: 'updateNode' }>;
            return {
              path: interactions?.layers.find((l) => l.node.id === op.nodeId)?.path ?? focusPath,
              contextFrames:
                interactions?.layers.find((l) => l.node.id === op.nodeId)?.contextFrames ??
                focusContextFrames,
              frame: interactions?.layers.find((l) => l.node.id === op.nodeId)?.frame ?? frame,
              nodeId: op.nodeId,
              patch: op.patch,
            };
          }),
        });
      }
      return await run('transact', { operations, revision: stateRef.current?.snapshot.revision });
    } finally {
      setSaving(false);
    }
  };
  const enterScene = (id: string) => {
    setFocusContextFrames([]);
    window.history.pushState(null, '', compositionUrl(id, []));
    setFilter('');
    setPlaying(false);
    setFocusPath([]);
    setComposition(undefined);
    setSceneId(id);
    setWorkspace('animation');
    const key = `${id}:[]`;
    setSceneFrames((current) => ({ ...current, [key]: current[key] ?? 0 }));
    setSelected('');
  };
  const enterGroup = (id: string) => {
    const layer = interactions?.layers.find((l) => l.node.id === id),
      contexts = [...(layer?.contextFrames ?? focusContextFrames), layer?.frame ?? frame],
      sourceFrame = Math.round(layer?.contentFrame ?? layer?.frame ?? sceneFrame);
    const nextPath = [
      ...(interactions?.layers.find((l) => l.node.id === id)?.path ?? focusPath),
      id,
    ];
    const key = `${sceneId}:${JSON.stringify(nextPath)}:${JSON.stringify(contexts)}`;
    setSceneFrames((current) => ({ ...current, [key]: current[key] ?? sourceFrame }));
    setFocusContextFrames(contexts);
    window.history.pushState(null, '', compositionUrl(sceneId, nextPath, contexts));
    setFilter('');
    setPlaying(false);
    setSelected('');
    setFocusPath(nextPath);
    setComposition(undefined);
  };
  const returnProject = () => {
    setFocusContextFrames([]);
    window.history.pushState(null, '', '#/project');
    setFilter('');
    setPlaying(false);
    setFocusPath([]);
    setComposition(undefined);
    setWorkspace('editing');
    setSelected('');
  };
  const update = (patch: Partial<Node>) => {
    if (!node) return;
    const current = evaluateNode(node, nodeFrame),
      keyFrame = Math.round(nodeFrame);
    if (
      Object.entries(patch).every(
        ([key, value]) => JSON.stringify(value) === JSON.stringify((current as any)[key]),
      )
    )
      return;
    const animations = structuredClone(node.animations);
    let keyed = false;
    for (const [property, value] of Object.entries(patch)) {
      const channel = animations.find((a) => a.property === property);
      if (channel && typeof value === 'number') {
        channel.keys = channel.keys.filter((k) => k.frame !== keyFrame);
        channel.keys.push({ frame: keyFrame, value, easing: 'easeInOut' });
        channel.keys.sort((a, b) => a.frame - b.frame);
        keyed = true;
      }
    }
    if (patch.params) {
      for (const [name, value] of Object.entries(patch.params)) {
        const channel = animations.find((a) => a.property === `params.${name}`);
        if (channel && typeof value === 'number') {
          channel.keys = channel.keys.filter((k) => k.frame !== keyFrame);
          channel.keys.push({ frame: keyFrame, value, easing: 'easeInOut' });
          channel.keys.sort((a, b) => a.frame - b.frame);
          keyed = true;
        }
      }
    }
    return transact([
      {
        type: 'updateNode',
        sceneId,
        nodeId: node.id,
        patch: { ...patch, ...(keyed ? { animations } : {}) },
      },
    ]);
  };
  const selectMany = (ids: string[]) => {
    if (JSON.stringify(ids) === JSON.stringify(selectedIds)) return;
    setSelectedIds(ids);
    void run('selection', { ids });
  };
  const select = (id: string, additive = false) =>
    selectMany(
      additive
        ? selectedIds.includes(id)
          ? selectedIds.filter((value) => value !== id)
          : [...selectedIds, id]
        : id
          ? [id]
          : [],
    );
  const editSequenceActions = async (actions: SequenceAction[]) => {
    if (!sequence) return;
    setSaving(true);
    setPlaying(false);
    try {
      const result = await run('sequenceEdit', {
        sequenceId: sequence.id,
        actions,
        revision: stateRef.current?.snapshot.revision,
      });
      if (result?.edit) {
        const ids = new Set(
          result.snapshot.sequences
            .find((s: { id: string }) => s.id === sequence.id)
            ?.tracks.flatMap((t: { clips: Array<{ id: string }> }) => t.clips.map((c) => c.id)) ??
            [],
        );
        setClipSelection((current) =>
          result.edit.selection.length
            ? result.edit.selection
            : current.filter((id) => ids.has(id)),
        );
        setSequenceFrame((at) => Math.min(at, result.edit.duration - 1));
      }
      return result;
    } finally {
      setSaving(false);
    }
  };
  const editParameters = async (data: Record<string, unknown>) => {
    if (!node) return;
    setSaving(true);
    try {
      return await run('componentParametersEdit', {
        sceneId,
        nodeId: node.id,
        path: interactions?.layers.find((l) => l.node.id === node.id)?.path ?? focusPath,
        frame: Math.round(nodeFrame),
        contextFrames: nodeContextFrames,
        revision: stateRef.current?.snapshot.revision,
        ...data,
      });
    } finally {
      setSaving(false);
    }
  };
  const editTime = async (data: Record<string, unknown>) => {
    if (!node) return;
    setSaving(true);
    try {
      return await run('timeEdit', {
        sceneId,
        nodeId: node.id,
        path: selectedLayer?.path ?? focusPath,
        contextFrames: nodeContextFrames,
        frame: nodeFrame,
        revision: stateRef.current?.snapshot.revision,
        ...data,
      });
    } finally {
      setSaving(false);
    }
  };
  const editAnimation = async (actions: KeyframeAction[]) => {
    if (!node) return;
    setSaving(true);
    try {
      return await run('animationEdit', {
        sceneId,
        frame,
        revision: stateRef.current?.snapshot.revision,
        edits: [
          {
            nodeId: node.id,
            path: interactions?.layers.find((l) => l.node.id === node.id)?.path ?? focusPath,
            actions,
            frame: nodeFrame,
            contextFrames: nodeContextFrames,
          },
        ],
      });
    } finally {
      setSaving(false);
    }
  };
  const editStructure = async (
    type: string,
    options: Record<string, unknown> = {},
    ids = selectedIds,
  ) => {
    const buckets = new Map<
      string,
      { path: string[]; ids: string[]; frame: number; contextFrames: number[] }
    >();
    for (const id of ids) {
      const path = interactions?.layers.find((l) => l.node.id === id)?.path ?? focusPath,
        layer = interactions?.layers.find((l) => l.node.id === id),
        at = layer?.frame ?? frame,
        contexts = layer?.contextFrames ?? focusContextFrames,
        key = JSON.stringify([path, at, contexts]),
        bucket = buckets.get(key) ?? { path, ids: [], frame: at, contextFrames: contexts };
      bucket.ids.push(id);
      buckets.set(key, bucket);
    }
    if (type === 'group' && buckets.size > 1) {
      setError('编组需要同一组件的图层；请进入对应合成后选择图层。');
      return;
    }
    const actions =
      type === 'add'
        ? [
            {
              path: focusPath,
              contextFrames: focusContextFrames,
              frame,
              action: { type, ...options },
            },
          ]
        : [...buckets.values()].map((bucket) => ({
            path: bucket.path,
            frame: bucket.frame,
            contextFrames: bucket.contextFrames,
            action: { type, ids: bucket.ids, ...options },
          }));
    if (!actions.length) return;
    setSaving(true);
    try {
      const result = await run('compositionStructureBatch', {
        sceneId,
        frame,
        actions,
        revision: stateRef.current?.snapshot.revision,
      });
      if (result) selectMany(result.selection);
      return result;
    } finally {
      setSaving(false);
    }
  };
  const bakeVector = async (operation: string, radius: number) => {
    const paths = selectedIds.map(
      (id) => interactions?.layers.find((l) => l.node.id === id)?.path ?? focusPath,
    );
    if (paths.some((path) => JSON.stringify(path) !== JSON.stringify(paths[0]))) {
      setError('请进入共同的组件合成，再选择同一父级的矢量图层。');
      return;
    }
    setSaving(true);
    try {
      const result = await run('vectorBake', {
        sceneId,
        path: paths[0] ?? focusPath,
        nodeIds: selectedIds,
        frame: nodeFrame,
        contextFrames: nodeContextFrames,
        operation,
        radius,
        hideSources: true,
        revision: stateRef.current?.snapshot.revision,
      });
      if (result) selectMany(result.selection);
      return result;
    } finally {
      setSaving(false);
    }
  };
  const createRepeated = async () => {
    if (!selectedIds.length) return;
    const paths = selectedIds.map(
      (id) => interactions?.layers.find((l) => l.node.id === id)?.path ?? focusPath,
    );
    if (paths.some((path) => JSON.stringify(path) !== JSON.stringify(paths[0]))) {
      setError('请进入共同的组件合成，再选择同一父级的图层。');
      return;
    }
    setSaving(true);
    try {
      const result = await run('repeatCreate', {
        sceneId,
        path: paths[0] ?? focusPath,
        frame: nodeFrame,
        contextFrames: nodeContextFrames,
        nodeIds: selectedIds,
        hideSources: true,
        revision: stateRef.current?.snapshot.revision,
      });
      if (result) selectMany(result.selection);
      return result;
    } finally {
      setSaving(false);
    }
  };
  const createSharedScene = async () => {
    if (!selectedIds.length) return;
    const paths = selectedIds.map(
      (id) => interactions?.layers.find((l) => l.node.id === id)?.path ?? focusPath,
    );
    if (paths.some((path) => JSON.stringify(path) !== JSON.stringify(paths[0]))) {
      setError('请在共同合成中选择同一父级的图层。');
      return;
    }
    setSaving(true);
    try {
      const result = await run('scenePrecompose', {
        sceneId,
        path: paths[0] ?? focusPath,
        frame: nodeFrame,
        contextFrames: nodeContextFrames,
        nodeIds: selectedIds,
        name: `${node?.name ?? '图层'} · 共享场景`,
        revision: stateRef.current?.snapshot.revision,
      });
      if (result) selectMany(result.selection);
      return result;
    } finally {
      setSaving(false);
    }
  };
  const insertSharedScene = async (sourceId: string) => {
    if (!sourceId) return;
    setSaving(true);
    try {
      const result = await run('scenePlace', {
        sceneId,
        sourceId,
        path: focusPath,
        frame,
        contextFrames: focusContextFrames,
        revision: stateRef.current?.snapshot.revision,
      });
      if (result) selectMany(result.selection);
      return result;
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (workspace === 'drawing' || visualCheckOpen || document.querySelector('.project-modal'))
        return;
      if (
        (e.target as HTMLElement).closest(
          'input,textarea,select,[role="separator"],[contenteditable="true"]',
        )
      )
        return;
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((p) => !p);
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setFrame((f) => Math.min(f + 1, activeDuration - 1));
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setFrame((f) => Math.max(0, f - 1));
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void run(e.shiftKey ? 'redo' : 'undo');
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void run('save');
      }
      if (workspace === 'editing') {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
          e.preventDefault();
          void editSequenceActions([
            { type: 'split', frame, clipIds: clipSelected ? [clipSelected] : undefined },
          ]);
        }
        if (!e.ctrlKey && !e.metaKey && ['i', 'o'].includes(e.key.toLowerCase())) {
          e.preventDefault();
          void editSequenceActions([
            { type: e.key.toLowerCase() === 'i' ? 'rangeIn' : 'rangeOut', frame },
          ]);
        }
        if (e.key === 'Delete' && clipSelected) {
          e.preventDefault();
          void editSequenceActions([
            { type: 'remove', clipIds: [clipSelected], ripple: e.shiftKey },
          ]);
        }
        return;
      }
      if (e.key === 'Delete' && selected && scene) {
        e.preventDefault();
        void editStructure('delete');
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        void editStructure('duplicate', { offset: { x: 0, y: 0 } });
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        void editStructure(e.shiftKey ? 'ungroup' : 'group');
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [
    selectedIds,
    clipSelected,
    sceneId,
    sequence?.duration,
    scene,
    interactions,
    focusPath.join('/'),
    frame,
    workspace,
    visualCheckOpen,
  ]);
  const addNode = async (type: Node['type']) => {
    if (!scene) return;
    const id = uid();
    const props: Partial<Node> = {
      id,
      type,
      name:
        type === 'text'
          ? 'Text layer'
          : type === 'formula'
            ? 'Equation'
            : type === 'chart'
              ? 'Data chart'
              : type === 'group'
                ? 'Group'
                : `${type[0].toUpperCase() + type.slice(1)}`,
      x: 240,
      y: 240,
      width: type === 'text' ? 1000 : 600,
      height: type === 'text' ? 180 : 300,
      fill: type === 'text' || type === 'formula' ? '#f4f6ff' : '#92a0ff',
      text: type === 'text' ? 'Write your next idea' : type === 'formula' ? 'e^{i\\pi}+1=0' : '',
      fontSize: 64,
      params: type === 'chart' ? { values: [30, 65, 45, 90, 72], mode: 'bar' } : {},
    };
    return editStructure('add', { node: props });
  };
  const addKey = (property: Node['animations'][number]['property']) => {
    if (!node) return;
    const existing = node.animations.find((a) => a.property === property);
    const keyFrame = Math.round(nodeFrame),
      keys = existing?.keys.filter((k) => k.frame !== keyFrame) ?? [];
    keys.push({
      frame: keyFrame,
      value: getNumericPath(evaluateNode(node, nodeFrame), property),
      easing: 'easeInOut',
    });
    const animations = node.animations.filter((a) => a.property !== property);
    animations.push({ property, keys: keys.sort((a, b) => a.frame - b.frame) });
    void update({ animations });
  };
  const importAsset = async () => {
    const file = window.vmotionDesktop
      ? await window.vmotionDesktop.pickAsset()
      : window.prompt('Absolute path to a local image, video, audio or font');
    if (!file) return;
    const ext = file.split('.').at(-1)?.toLowerCase();
    const type = ['mp4', 'mov', 'mkv', 'webm'].includes(ext ?? '')
      ? 'video'
      : ['mp3', 'wav', 'flac', 'ogg', 'm4a'].includes(ext ?? '')
        ? 'audio'
        : ['ttf', 'otf', 'woff', 'woff2'].includes(ext ?? '')
          ? 'font'
          : 'image';
    await run('import', { path: file, type });
    setAssetTab(true);
  };
  const placeAsset = async (asset: any, drop?: { x: number; y: number }) => {
    if (!scene) return;
    if (asset.type === 'font') return;
    const result = await run('assetPlace', {
      assetId: asset.id,
      frame: asset.type === 'audio' && workspace !== 'editing' ? sequenceFrame : frame,
      revision: stateRef.current?.snapshot.revision,
      ...(workspace === 'editing' || asset.type === 'audio'
        ? { sequenceId: sequence!.id }
        : {
            sceneId,
            path: focusPath,
            contextFrames: focusContextFrames,
            ...drop,
            anchor: drop ? 'center' : undefined,
          }),
    });
    if (result?.nodeId) select(result.nodeId);
    if (result?.clipId) {
      setClipSelected(result.clipId);
      if (asset.type === 'audio' && workspace !== 'editing') {
        setPlaying(false);
        setWorkspace('editing');
      }
    }
  };
  useEffect(() => {
    const drop = (event: Event) => {
      const { assetId, clientX, clientY } = (event as CustomEvent<AssetDropDetail>).detail,
        target = document.elementFromPoint(clientX, clientY);
      if (!target?.closest('.canvas-interaction') || !previewRef.current) return;
      const bounds = previewRef.current.getBoundingClientRect(),
        asset = project?.assets.find((a) => a.id === assetId);
      if (asset)
        void placeAsset(asset, {
          x: ((clientX - bounds.left) * viewWidth) / bounds.width,
          y: ((clientY - bounds.top) * viewHeight) / bounds.height,
        });
    };
    window.addEventListener(ASSET_DROP_EVENT, drop);
    return () => window.removeEventListener(ASSET_DROP_EVENT, drop);
  }, [project?.assets, workspace, sceneId, focusPath.join('/'), frame, viewWidth, viewHeight]);
  function position(e: React.PointerEvent) {
    const box = previewRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - box.left) / box.width) * viewWidth,
      y: ((e.clientY - box.top) / box.height) * viewHeight,
      pressure: e.pointerType === 'pen' ? e.pressure : 1,
    };
  }
  function pointerDown(e: React.PointerEvent) {
    if (e.altKey || e.button === 1) return;
    if (workspace !== 'drawing') return;
    const p = position(e);
    strokeRef.current = [p];
    setStroke([p]);
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function pointerMove(e: React.PointerEvent) {
    if (workspace === 'drawing' && strokeRef.current.length) {
      const p = position(e);
      strokeRef.current = [...strokeRef.current, p];
      setStroke(strokeRef.current);
    }
  }
  async function pointerUp() {
    if (workspace === 'drawing' && strokeRef.current.length > 1) {
      await run('drawingStroke', {
        sceneId,
        points: strokeRef.current,
        color: paintColor,
        width: brush,
        start: frame,
        end: Math.min(scene?.duration ?? 300, frame + hold),
      });
    }
    strokeRef.current = [];
    setStroke([]);
  }
  const timecode = (f: number) =>
    `${String(Math.floor(f / fps / 60)).padStart(2, '0')}:${String(Math.floor(f / fps) % 60).padStart(2, '0')}:${String(Math.floor(f % fps)).padStart(2, '0')}`;
  if (!state || !project || !scene || !sequence)
    return (
      <div className="loading">
        <div className="brand-mark">V</div>
        <h2>正在打开工作区</h2>
        <p>{error || '正在读取本地工程…'}</p>
      </div>
    );
  const selectedClip = sequence.tracks
    .flatMap((t) => t.clips.map((c) => ({ ...c, trackId: t.id })))
    .find((c) => c.id === clipSelected);
  if (workspace === 'drawing')
    return (
      <DrawingWorkspace
        snapshot={snapshot!}
        initialId={drawingId}
        run={run}
        onDocument={setDrawingId}
        onExit={() => setWorkspace('animation')}
        onPublish={() => {
          setAssetTab(true);
        }}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
        error={error || state.diagnostics.find((d) => d.severity === 'error')?.message}
      />
    );
  return (
    <div
      className={`app ${!layout.showLeft ? 'hide-left' : ''} ${!layout.showRight ? 'hide-right' : ''}`}
      style={
        {
          '--left-width': `${layout.left}px`,
          '--right-width': `${layout.right}px`,
          '--timeline-height': `${layout.timeline}px`,
        } as React.CSSProperties
      }
    >
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">V</div>
          <span>
            vmotion<span className="brand-dot">.</span>
          </span>
        </div>
        <ProjectActions onError={setError} onPause={() => setPlaying(false)} />
        <button className="project-title" onClick={() => setModal('settings')} title="工程设置">
          <Icon name="folder" size={16} />
          {project.name}
          <span className="tag">LOCAL</span>
        </button>
        <div className="top-spacer" />
        <div className="history-buttons">
          <button aria-label="Undo" disabled={!state.canUndo} onClick={() => run('undo')}>
            <Icon name="undo" />
          </button>
          <button aria-label="Redo" disabled={!state.canRedo} onClick={() => run('redo')}>
            <Icon name="redo" />
          </button>
        </div>
        <button className="subtle" onClick={() => setModal('connect')}>
          <Icon name="link" size={16} />
          连接 agent
        </button>
        <button className="primary" onClick={() => setModal('export')}>
          <Icon name="export" size={16} />
          导出
        </button>
      </header>
      <nav className="workspaces">
        <span className="workspace-label">创作工作区</span>
        {[
          ['animation', 'layers', '动画'],
          ['editing', 'film', '剪辑'],
          ['drawing', 'brush', '绘画'],
          ['code', 'code', '代码'],
        ].map(([id, icon, label]) => (
          <button
            key={id}
            className={workspace === id ? 'active' : ''}
            onClick={() => {
              if (id === 'editing') {
                returnProject();
                return;
              }
              setWorkspace(id);
              setPlaying(false);
            }}
          >
            <Icon name={icon} size={16} />
            {label}
          </button>
        ))}
        <div className="top-spacer" />
        <button
          className="layout-control"
          title="显示或隐藏工程面板"
          aria-pressed={layout.showLeft}
          onClick={() => setLayout((v) => ({ ...v, showLeft: !v.showLeft }))}
        >
          <Icon name="panel" size={15} />
        </button>
        <button
          className="layout-control"
          title="显示或隐藏属性面板"
          aria-pressed={layout.showRight}
          onClick={() => setLayout((v) => ({ ...v, showRight: !v.showRight }))}
        >
          <Icon name="settings" size={15} />
        </button>
        <button className="layout-control reset" title="恢复工作区布局" onClick={resetLayout}>
          重置布局
        </button>
        <span className="saved">
          <span />
          {saving ? '正在保存…' : error ? '需要检查' : '已保存到本地'}
        </span>
        <button className="icon-button" aria-label="工程设置" onClick={() => setModal('settings')}>
          <Icon name="settings" size={16} />
        </button>
      </nav>
      <aside className="left-panel">
        <div className="panel-tabs">
          <button className={!assetTab ? 'active' : ''} onClick={() => setAssetTab(false)}>
            工程
          </button>
          <button className={assetTab ? 'active' : ''} onClick={() => setAssetTab(true)}>
            素材 <span>{project.assets.length}</span>
          </button>
        </div>
        <label className="panel-search">
          <Icon name="search" size={14} />
          <input
            aria-label="搜索场景或图层"
            placeholder={focusPath.length ? '搜索当前合成' : '搜索工程'}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter && (
            <button title="清空搜索" onClick={() => setFilter('')}>
              ×
            </button>
          )}
        </label>
        {assetTab ? (
          <>
            <div className="section-title">
              素材库
              <button aria-label="媒体与缓存" onClick={() => setMediaManaging(true)}>
                <Icon name="settings" size={15} />
              </button>
              <button aria-label="新建声音" onClick={() => setSoundEditing('new')}>
                <Icon name="music" size={15} />
              </button>
              <button aria-label="导入素材" onClick={importAsset}>
                <Icon name="plus" size={15} />
              </button>
            </div>
            {project.assets.length ? (
              project.assets.map((a) => (
                <AssetItem
                  key={a.id}
                  asset={a}
                  revision={snapshot!.revision}
                  selected={selectedAsset === a.id}
                  onSelect={() => setSelectedAsset(a.id)}
                  onPlace={() => void placeAsset(a)}
                />
              ))
            ) : (
              <div className="empty">
                <Icon name="image" size={32} />
                <p>在这里管理素材</p>
                <small>图片、视频、音频与字体</small>
                <button className="secondary" onClick={importAsset}>
                  导入素材
                </button>
              </div>
            )}
            {selectedAsset && (
              <div className="asset-actions">
                {project.assets.find((a) => a.id === selectedAsset)?.soundSource && (
                  <button onClick={() => setSoundEditing(selectedAsset)}>编辑声音</button>
                )}
                <button
                  onClick={() => {
                    const asset = project.assets.find((a) => a.id === selectedAsset);
                    if (asset) void placeAsset(asset);
                  }}
                >
                  加入当前{workspace === 'editing' ? '轨道' : '合成'}
                </button>
                <button
                  onClick={async () => {
                    const result = await run('assetPlace', {
                      assetId: selectedAsset,
                      sequenceId: sequence.id,
                      frame: sequenceFrame,
                      revision: stateRef.current?.snapshot.revision,
                    });
                    if (result?.clipId) {
                      setWorkspace('editing');
                      setClipSelected(result.clipId);
                    }
                  }}
                >
                  加入主时间轴
                </button>
                {project.assets.find((a) => a.id === selectedAsset)?.type === 'drawing' && (
                  <button
                    onClick={async () => {
                      const result = await run('drawingOpenAsset', {
                        assetId: selectedAsset,
                        revision: stateRef.current?.snapshot.revision,
                      });
                      if (result?.document) {
                        setDrawingId(result.document.id);
                        setWorkspace('drawing');
                      }
                    }}
                  >
                    打开画稿编辑
                  </button>
                )}
              </div>
            )}
            <div className="drawing-help">
              拖入画布或时间轴放置。画稿从绘画工作区发布；已发布的画稿可再次打开编辑。
            </div>
          </>
        ) : (
          <>
            <div className="section-title">
              场景
              <button
                aria-label="新场景"
                onClick={async () => {
                  const id = uid();
                  await transact([
                    {
                      type: 'addScene',
                      scene: {
                        id,
                        name: '新场景',
                        duration: 300,
                        background: '#101525',
                        nodes: [],
                      },
                    },
                  ]);
                  setSceneId(id);
                  setSelected('');
                }}
              >
                <Icon name="plus" size={15} />
              </button>
            </div>
            {snapshot!.scenes
              .filter((s) => s.name.toLowerCase().includes(filter.toLowerCase()))
              .map((s, i) => (
                <button
                  className={`scene-row ${sceneId === s.id ? 'selected' : ''}`}
                  key={s.id}
                  onClick={() => {
                    enterScene(s.id);
                  }}
                >
                  <div className="scene-thumb">
                    <span>{String(i + 1).padStart(2, '0')}</span>
                    <img
                      loading="lazy"
                      src={`/api/frame?frame=90&width=240&height=${Math.round((240 * project.height) / project.width)}&scene=${s.id}&revision=${snapshot!.revision}`}
                      alt=""
                    />
                  </div>
                  <div>
                    <strong>{s.name}</strong>
                    <small>
                      {(s.duration / fps).toFixed(1)}s · {s.nodes.length} 图层
                    </small>
                  </div>
                </button>
              ))}
            <div className="section-title layers-title">
              图层<span>{scene.nodes.length}</span>
            </div>
            <div className="layer-list">
              {scene.nodes
                .filter(
                  (n) =>
                    !n.parentId && `${n.name} ${n.id}`.toLowerCase().includes(filter.toLowerCase()),
                )
                .reverse()
                .map((n) => (
                  <div
                    key={n.id}
                    className={`layer-row ${selectedIds.includes(n.id) ? 'selected' : ''}`}
                    style={{ paddingLeft: n.parentId ? 26 : 12 }}
                  >
                    <button
                      className="layer-name"
                      onClick={(e) => select(n.id, e.ctrlKey || e.metaKey)}
                      onDoubleClick={() => {
                        if (n.type === 'group' || n.type === 'component' || n.type === 'scene')
                          enterGroup(n.id);
                      }}
                    >
                      <Icon
                        name={
                          n.type === 'text'
                            ? 'text'
                            : n.type === 'component'
                              ? 'code'
                              : n.type === 'formula'
                                ? 'text'
                                : n.type === 'drawing'
                                  ? 'brush'
                                  : n.type
                        }
                        size={15}
                      />
                      <span>{n.name}</span>
                      {n.animations.length > 0 && <span className="key-dot">◆</span>}
                    </button>
                    <button
                      aria-label={`Toggle ${n.name}`}
                      className={n.visible ? 'visibility' : 'visibility off'}
                      onClick={() =>
                        transact([
                          {
                            type: 'updateNode',
                            sceneId,
                            nodeId: n.id,
                            patch: { visible: !n.visible },
                          },
                        ])
                      }
                    >
                      <Icon name="eye" size={13} />
                    </button>
                    {(n.type === 'group' || n.type === 'component' || n.type === 'scene') && (
                      <button
                        className="layer-enter"
                        title={`进入 ${n.name} 内部`}
                        onClick={() => enterGroup(n.id)}
                      >
                        <Icon name="arrow" size={12} />
                      </button>
                    )}
                  </div>
                ))}
            </div>
            <div className="section-title">组件</div>
            {Object.keys(snapshot!.files)
              .filter((f) => f.endsWith('.ts'))
              .map((file) => (
                <button
                  className="component-row"
                  disabled={codeBusy}
                  key={file}
                  onClick={() => {
                    setCodePath(file);
                    setCodeDirty(false);
                    setWorkspace('code');
                    setPlaying(false);
                  }}
                >
                  <Icon name="code" size={15} />
                  {file.split('/').at(-1)}
                  <span>TS</span>
                </button>
              ))}
          </>
        )}
        <div className="sidebar-footer">
          <span className="status-dot" />
          本地工程<span className="mono">v{project.formatVersion}</span>
        </div>
      </aside>
      <Splitter
        label="调整工程面板宽度"
        direction="vertical"
        value={layout.left}
        min={180}
        max={420}
        onChange={(left) => setLayout((v) => ({ ...v, left }))}
      />
      <main className="main-panel">
        {workspace === 'editing' && (
          <FilmToolbar
            sequence={sequence}
            frame={frame}
            selectedClipIds={clipSelection}
            onEdit={editSequenceActions}
            onCaptions={async (content, format) => {
              setPlaying(false);
              return run('captionsImport', {
                sequenceId: sequence.id,
                content,
                format,
                revision: stateRef.current?.snapshot.revision,
              });
            }}
          />
        )}
        <nav className="composition-breadcrumb" aria-label="合成导航">
          <button onClick={returnProject}>
            <Icon name="film" size={13} />
            工程总览
          </button>
          {workspace !== 'editing' && (
            <>
              <Icon name="arrow" size={11} />
              <button
                onClick={() => {
                  setFocusPath([]);
                  setFocusContextFrames([]);
                  setComposition(undefined);
                }}
              >
                {rootScene?.name}
              </button>
              {focusPath.map((id, index) => (
                <React.Fragment key={id}>
                  <Icon name="arrow" size={11} />
                  <button
                    onClick={() => {
                      setFocusPath((path) => path.slice(0, index + 1));
                      setFocusContextFrames((contexts) => contexts.slice(0, index + 1));
                      setSelected('');
                    }}
                  >
                    {composition?.breadcrumbs[index]?.name ?? id.split('/').at(-1)}
                  </button>
                </React.Fragment>
              ))}
              <span className="scope-badge">
                独立合成 · 内容时间 · {scene?.duration ?? 0} 帧
                {focusContextFrames.length
                  ? ` · 父帧 ${focusContextFrames.at(-1)!.toFixed(1)}`
                  : ''}
              </span>
            </>
          )}
        </nav>
        <div className="canvas-toolbar">
          <div className="tool-group">
            {workspace === 'drawing' ? (
              <>
                <Icon name="brush" />
                <input
                  aria-label="笔刷颜色"
                  type="color"
                  value={paintColor}
                  onChange={(e) => setPaintColor(e.target.value)}
                />
                <label>
                  笔刷{' '}
                  <input
                    aria-label="笔刷大小"
                    type="number"
                    value={brush}
                    min={1}
                    max={100}
                    onChange={(e) => setBrush(Number(e.target.value))}
                  />
                </label>
                <label>
                  持帧{' '}
                  <input
                    aria-label="持帧帧数"
                    type="number"
                    value={hold}
                    min={1}
                    onChange={(e) => setHold(Number(e.target.value))}
                  />
                </label>
                <button className={onion ? 'pressed' : ''} onClick={() => setOnion(!onion)}>
                  洋葱皮
                </button>
              </>
            ) : workspace === 'code' ? (
              <>
                <Icon name="code" />
                <span>{codePath}</span>
                <span className="tag">TYPESCRIPT</span>
              </>
            ) : (
              <>
                {[
                  ['text', 'Text'],
                  ['rect', 'Shape'],
                  ['ellipse', 'Ellipse'],
                  ['formula', 'Formula'],
                  ['chart', 'Chart'],
                ].map(([type, label]) => (
                  <button
                    key={type}
                    title={`Add ${label}`}
                    aria-label={label}
                    onClick={() => addNode(type as Node['type'])}
                  >
                    <Icon name={type === 'formula' ? 'text' : type} size={17} />
                    <span>{label}</span>
                  </button>
                ))}
                {workspace === 'animation' && (
                  <>
                    <span className="toolbar-separator" />
                    <button
                      title="编组 · Ctrl+G"
                      aria-label="编组"
                      disabled={!selectedIds.length}
                      onClick={() => editStructure('group')}
                    >
                      <Icon name="layers" />
                    </button>
                    <button
                      title="复制图层 · Ctrl+D"
                      aria-label="复制图层"
                      disabled={!selectedIds.length}
                      onClick={() => editStructure('duplicate', { offset: { x: 0, y: 0 } })}
                    >
                      <Icon name="copy" />
                    </button>
                    <button
                      title="从选中图层创建重复器，保留并隐藏来源"
                      aria-label="创建重复器"
                      disabled={!selectedIds.length || saving}
                      onClick={createRepeated}
                    >
                      <Icon name="repeat" />
                    </button>
                    <button
                      title="将选中图层预合成为可复用共享场景"
                      aria-label="生成共享场景"
                      disabled={!selectedIds.length || saving}
                      onClick={createSharedScene}
                    >
                      <Icon name="scene" />
                    </button>
                    <select
                      aria-label="添加共享场景"
                      title="添加已存在的共享场景"
                      value=""
                      disabled={saving}
                      className="scene-place-select"
                      onChange={(e) => {
                        void insertSharedScene(e.target.value);
                      }}
                    >
                      <option value="">引用场景…</option>
                      {snapshot!.scenes
                        .filter((s) => s.id !== sceneId)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                    </select>
                    <button
                      title="删除图层 · Delete"
                      aria-label="删除图层"
                      disabled={!selectedIds.length}
                      onClick={() => editStructure('delete')}
                    >
                      <Icon name="delete" />
                    </button>
                    <button
                      title="上移一层"
                      aria-label="上移图层"
                      disabled={!selectedIds.length}
                      onClick={() => editStructure('order', { direction: 'up' })}
                    >
                      <Icon name="up" />
                    </button>
                    <button
                      title="下移一层"
                      aria-label="下移图层"
                      disabled={!selectedIds.length}
                      onClick={() => editStructure('order', { direction: 'down' })}
                    >
                      <Icon name="down" />
                    </button>
                  </>
                )}
              </>
            )}
          </div>
          <div className="top-spacer" />
          {workspace === 'code' ? (
            <>
              <button
                className="compact"
                disabled={codeBusy || !codeBase}
                onClick={() => checkCode()}
              >
                {' '}
                {codeBusy ? '检查中…' : '预检代码'}{' '}
              </button>
              <button
                className="primary compact"
                disabled={!codeDirty || codeBusy || !codeBase}
                onClick={() => checkCode(true)}
              >
                保存组件
              </button>
            </>
          ) : (
            <span className="preview-quality">
              <select
                aria-label="素材预览方式"
                value={previewMedia}
                onChange={(e) => setPreviewMedia(e.target.value as 'auto' | 'original')}
              >
                <option value="auto">代理优先</option>
                <option value="original">原始素材</option>
              </select>
              <span />
              <select
                aria-label="预览质量"
                value={previewQuality}
                onChange={(e) => setPreviewQuality(Number(e.target.value))}
              >
                {[480, 720, 960, 1280, 1920].map((width) => (
                  <option key={width} value={width}>
                    稳定预览 · {width}px
                  </option>
                ))}
              </select>
            </span>
          )}
          {workspace === 'animation' && (
            <button className="compact" disabled={visualCheckBusy || playing} onClick={checkVisual}>
              {visualCheckBusy ? '画面检查中…' : '检查画面'}
            </button>
          )}
        </div>
        {workspace === 'code' ? (
          <>
            <CodeEditor
              key={codePath}
              value={code}
              readOnly={codeBusy}
              jumpTo={codeJump}
              onChange={(value) => {
                setCode(value);
                setCodeDirty(true);
                const draft = { content: value, base: codeBase };
                codeDrafts.current.set(codePath, draft);
                try {
                  sessionStorage.setItem(draftKey(codePath), JSON.stringify(draft));
                } catch {}
                setCodeCheck(undefined);
              }}
            />
            {codeCheck && (
              <CodeCheck
                report={codeCheck}
                onClose={() => setCodeCheck(undefined)}
                onJump={(d) => {
                  if (d.line && d.file?.replace(/\\/g, '/').endsWith(codePath))
                    setCodeJump({ line: d.line, column: d.column });
                  else setError(`${d.file ?? '工程'} ${d.path ?? ''}: ${d.message}`);
                }}
              />
            )}
          </>
        ) : (
          <>
            <CanvasViewport
              width={viewWidth}
              height={viewHeight}
              name={workspace === 'editing' ? sequence.name : scene.name}
              onStageRef={(element) => {
                previewRef.current = element;
              }}
            >
              <div
                className="canvas-interaction"
                style={{ width: '100%', height: '100%' }}
                onPointerDown={pointerDown}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes('application/x-vmotion-asset')) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                  }
                }}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData('application/x-vmotion-asset'),
                    asset = project.assets.find((a) => a.id === id);
                  if (!asset) return;
                  e.preventDefault();
                  const b = previewRef.current!.getBoundingClientRect();
                  void placeAsset(asset, {
                    x: ((e.clientX - b.left) / b.width) * viewWidth,
                    y: ((e.clientY - b.top) / b.height) * viewHeight,
                  });
                }}
                onPointerMove={pointerMove}
                onPointerUp={pointerUp}
                onPointerCancel={() => {
                  strokeRef.current = [];
                  setStroke([]);
                }}
              >
                {onion && workspace === 'drawing' && (
                  <>
                    <img
                      className="onion previous"
                      src={`/api/frame?frame=${Math.max(0, frame - hold)}&width=960&height=540&scene=${sceneId}`}
                      alt="Previous exposure"
                    />
                    <img
                      className="onion next"
                      src={`/api/frame?frame=${frame + hold}&width=960&height=540&scene=${sceneId}`}
                      alt="Next exposure"
                    />
                  </>
                )}
                <canvas
                  ref={attachPreviewCanvas}
                  className="rendered-frame"
                  role="img"
                  aria-label={`Native rendered frame ${previewFrame}`}
                  data-preview-frame={previewFrame}
                />
                {!previewReady && <div className="preview-placeholder">正在渲染场景…</div>}
                {workspace === 'animation' &&
                  !playing &&
                  interactions &&
                  interactions.revision === snapshot!.revision &&
                  interactions.frame === frame &&
                  interactions.sceneId === sceneId &&
                  JSON.stringify(interactions.path) === JSON.stringify(focusPath) && (
                    <CanvasInteraction
                      key={scopeKey}
                      graph={interactions}
                      selection={selectedIds}
                      frame={frame}
                      width={viewWidth}
                      height={viewHeight}
                      stage={previewRef}
                      onSelect={selectMany}
                      onDraft={setCanvasDraft}
                      onEnter={enterGroup}
                      onCommit={async (draft, revision) => {
                        setSaving(true);
                        try {
                          return await run('compositionTransactBatch', {
                            sceneId,
                            frame,
                            edits: draft,
                            revision,
                          });
                        } finally {
                          setSaving(false);
                        }
                      }}
                    />
                  )}
                {workspace === 'drawing' && (
                  <svg
                    className="stroke-overlay"
                    viewBox={`0 0 ${project.width} ${project.height}`}
                  >
                    <polyline
                      points={stroke.map((p) => `${p.x},${p.y}`).join(' ')}
                      stroke={paintColor}
                      strokeWidth={brush}
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </div>
            </CanvasViewport>
            {visualCheck &&
              visualCheck.sceneId === sceneId &&
              JSON.stringify(visualCheck.path) === JSON.stringify(focusPath) &&
              workspace === 'animation' && (
                <VisualAuditPanel
                  report={visualCheck}
                  revision={snapshot!.revision}
                  onClose={() => setVisualCheck(undefined)}
                  onFinding={(finding) => {
                    setPlaying(false);
                    const path = finding.path,
                      contexts = finding.contextFrames ?? focusContextFrames,
                      at = Math.round(finding.localFrame ?? finding.frame),
                      key = `${sceneId}:${JSON.stringify(path)}${contexts.length ? `:${JSON.stringify(contexts)}` : ''}`;
                    setFocusPath(path);
                    setFocusContextFrames(contexts);
                    setComposition(undefined);
                    setSceneFrames((current) => ({ ...current, [key]: at }));
                    if (finding.nodeId) select(finding.nodeId);
                    setVisualCheck(undefined);
                  }}
                />
              )}
          </>
        )}
      </main>
      <Splitter
        label="调整属性面板宽度"
        direction="vertical"
        value={layout.right}
        min={240}
        max={480}
        invert
        onChange={(right) => setLayout((v) => ({ ...v, right }))}
      />
      <aside className={`inspector tab-${inspectorTab}`}>
        <div className="inspector-heading">
          <span>{workspace === 'editing' ? '片段属性' : '图层检查器'}</span>
          <Icon name="settings" size={16} />
        </div>
        <div className="inspector-tabs">
          {[
            ['properties', '属性'],
            ['effects', '效果'],
            ['animation', '动画'],
          ].map(([id, label]) => (
            <button
              key={id}
              className={inspectorTab === id ? 'active' : ''}
              onClick={() => setInspectorTab(id as typeof inspectorTab)}
            >
              {label}
            </button>
          ))}
        </div>
        {workspace === 'editing' && selectedClip ? (
          <>
            <div className="inspector-node">
              <Icon name="film" />
              <strong>{selectedClip.id.slice(0, 20)}</strong>
            </div>
            <Section title="时间设置">
              <label className="select-row">
                片段名称
                <input
                  aria-label="片段名称"
                  key={selectedClip.id}
                  defaultValue={selectedClip.name ?? ''}
                  onBlur={(e) =>
                    transact([
                      {
                        type: 'updateClip',
                        sequenceId: sequence.id,
                        trackId: selectedClip.trackId,
                        clipId: selectedClip.id,
                        patch: { name: e.target.value },
                      },
                    ])
                  }
                />
              </label>
              {(
                ['start', 'duration', 'sourceIn', 'speed', 'volume', 'fadeIn', 'fadeOut'] as const
              ).map((property) => (
                <Field
                  key={property}
                  label={property}
                  value={selectedClip[property]}
                  onChange={(value) =>
                    transact([
                      {
                        type: 'updateClip',
                        sequenceId: sequence.id,
                        trackId: selectedClip.trackId,
                        clipId: selectedClip.id,
                        patch: { [property]: value },
                      },
                    ])
                  }
                />
              ))}
            </Section>
            <Section title="源片段与链接">
              <div className="clip-actions">
                <button
                  onClick={() =>
                    void editSequenceActions([
                      { type: 'slip', clipIds: [selectedClip.id], delta: -1 },
                    ])
                  }
                >
                  源向前 1f
                </button>
                <button
                  onClick={() =>
                    void editSequenceActions([
                      { type: 'slip', clipIds: [selectedClip.id], delta: 1 },
                    ])
                  }
                >
                  源向后 1f
                </button>
              </div>
              <label className="select-row">
                播放片段声音
                <input
                  type="checkbox"
                  aria-label="播放片段声音"
                  checked={selectedClip.audioEnabled !== false}
                  onChange={(e) =>
                    transact([
                      {
                        type: 'updateClip',
                        sequenceId: sequence.id,
                        trackId: selectedClip.trackId,
                        clipId: selectedClip.id,
                        patch: { audioEnabled: e.target.checked },
                      },
                    ])
                  }
                />
              </label>
              {selectedClip.linkedGroup && (
                <button
                  onClick={() =>
                    void editSequenceActions([{ type: 'unlink', clipIds: [selectedClip.id] }])
                  }
                >
                  解除当前片段链接
                </button>
              )}
              {selectedClip.fadeWindow && (
                <p className="hint">
                  裁切保留了原始淡化位置；编辑淡入/淡出数值可重新以当前片段为起点。
                </p>
              )}
            </Section>
            <button
              className="danger"
              onClick={() =>
                transact([
                  {
                    type: 'removeClip',
                    sequenceId: sequence.id,
                    trackId: selectedClip.trackId,
                    clipId: selectedClip.id,
                  },
                ])
              }
            >
              移除片段
            </button>
          </>
        ) : node && workspace !== 'editing' ? (
          <>
            <div className="inspector-node">
              <Icon
                name={
                  node.type === 'component' ? 'code' : node.type === 'text' ? 'text' : node.type
                }
              />
              <input
                aria-label="图层名称"
                key={node.id + node.name}
                defaultValue={node.name}
                onBlur={(e) => update({ name: e.target.value })}
              />
              <span>{selectedIds.length > 1 ? `${selectedIds.length} 个已选中` : node.type}</span>
            </div>
            {(node.type === 'group' || node.type === 'component' || node.type === 'scene') && (
              <button className="enter-composition" onClick={() => enterGroup(node.id)}>
                <Icon name="layers" size={14} />
                进入独立合成
                <Icon name="arrow" size={13} />
              </button>
            )}
            {node.type === 'scene' && (
              <Section title="共享场景引用">
                <SceneReferenceInspector
                  node={node}
                  snapshot={snapshot!}
                  rootSceneId={sceneId}
                  onChange={update}
                  onSource={enterScene}
                  onReset={() =>
                    run('sceneReset', {
                      sceneId,
                      nodeId: node.id,
                      path:
                        interactions?.layers.find((l) => l.node.id === node.id)?.path ?? focusPath,
                      frame: nodeFrame,
                      contextFrames: nodeContextFrames,
                      revision: stateRef.current?.snapshot.revision,
                    })
                  }
                />
              </Section>
            )}
            {node.type === 'component' && (
              <Section title="组件参数">
                <ParameterInspector
                  specs={componentParams}
                  values={evaluateNode(node, nodeFrame).params}
                  onUpdate={(path, value) => editParameters({ updates: [{ path, value }] })}
                  onKey={(path) =>
                    void editParameters({ keys: [{ path, frame: Math.round(nodeFrame) }] })
                  }
                  onReset={(path) => void editParameters({ reset: [path] })}
                  onArray={(action) => editParameters({ arrays: [action] })}
                />
                <button
                  className="source-link"
                  onClick={() => {
                    setCodePath(node.component!);
                    setCodeDirty(false);
                    setWorkspace('code');
                    setPlaying(false);
                  }}
                >
                  打开组件代码 <Icon name="arrow" size={13} />
                </button>
              </Section>
            )}
            {['video', 'component', 'scene'].includes(node.type) && (
              <Section title="内容时间">
                <TimeInspector
                  key={node.id}
                  node={node}
                  snapshot={snapshot!}
                  frame={nodeFrame}
                  onEdit={editTime}
                  onKey={addKey}
                />
              </Section>
            )}
            <Section title="变换">
              <div className="field-grid">
                {(
                  [
                    'x',
                    'y',
                    'width',
                    'height',
                    'rotation',
                    'scaleX',
                    'scaleY',
                    'originX',
                    'originY',
                  ] as const
                ).map((property) => (
                  <Field
                    key={`${node.id}-${property}-${node[property]}`}
                    label={property}
                    value={evaluateNode(node, nodeFrame)[property]}
                    onChange={(value) => update({ [property]: value })}
                    onKey={() => addKey(property)}
                  />
                ))}
              </div>
              <MatrixInspector
                key={node.id}
                node={node}
                frame={nodeFrame}
                onChange={update}
                onKey={addKey}
              />
            </Section>
            <Section title="外观">
              <Field
                label="不透明度"
                value={Math.round(evaluateNode(node, nodeFrame).opacity * 100)}
                onChange={(v) => update({ opacity: Math.max(0, Math.min(1, v / 100)) })}
                onKey={() => addKey('opacity')}
              />
              <div className="color-row">
                <label>填充</label>
                <input
                  aria-label="填充颜色"
                  type="color"
                  value={/^#[0-9a-f]{6}$/i.test(node.fill) ? node.fill : '#ffffff'}
                  onChange={(e) => update({ fill: e.target.value })}
                />
                <span className="mono">{node.fill.toUpperCase()}</span>
              </div>
              <label className="select-row">
                混合
                <select
                  value={node.blend}
                  onChange={(e) => update({ blend: e.target.value as Node['blend'] })}
                >
                  {[
                    'source-over',
                    'multiply',
                    'screen',
                    'overlay',
                    'darken',
                    'lighten',
                    'difference',
                  ].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <Field
                label="模糊"
                value={node.blur}
                onChange={(v) => update({ blur: Math.max(0, v) })}
              />
            </Section>
            {['rect', 'ellipse', 'path', 'text'].includes(node.type) && (
              <Section title="描边与路径">
                <VectorInspector
                  key={node.id}
                  node={node}
                  frame={nodeFrame}
                  selectedCount={selectedIds.length}
                  onChange={update}
                  onKey={addKey}
                  onBake={bakeVector}
                />
              </Section>
            )}
            <Section title="效果栈">
              <EffectInspector node={node} frame={nodeFrame} onChange={update} onKey={addKey} />
            </Section>
            <Section title="遮罩与羽化">
              <label className="select-row">
                遮罩图层
                <select
                  value={node.maskId ?? ''}
                  onChange={(e) => update({ maskId: e.target.value || undefined })}
                >
                  <option value="">无</option>
                  {scene.nodes
                    .filter((n) => n.id !== node.id && n.parentId === node.parentId)
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="select-row">
                模式
                <select
                  value={node.maskMode}
                  onChange={(e) => update({ maskMode: e.target.value as Node['maskMode'] })}
                >
                  {[
                    ['alpha', 'Alpha'],
                    ['alphaInverted', 'Alpha 反向'],
                    ['luma', '亮度'],
                    ['lumaInverted', '亮度反向'],
                  ].map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <Field
                label="羽化"
                value={node.maskFeather}
                onChange={(v) => update({ maskFeather: v })}
                onKey={() => addKey('maskFeather')}
              />
            </Section>
            {(node.type === 'text' || node.type === 'formula') && (
              <Section title={node.type === 'formula' ? '公式' : '文字排版'}>
                <textarea
                  aria-label="图层文字"
                  className="text-content"
                  key={node.id + node.text}
                  defaultValue={node.text}
                  onBlur={(e) => update({ text: e.target.value })}
                />
                {node.type === 'text' && (
                  <>
                    <input
                      className="full-input"
                      aria-label="字体"
                      key={node.fontFamily}
                      defaultValue={node.fontFamily}
                      onBlur={(e) => update({ fontFamily: e.target.value })}
                    />
                    <Field
                      label="字号"
                      value={node.fontSize}
                      onChange={(v) => update({ fontSize: v })}
                      onKey={() => addKey('fontSize')}
                    />
                    <div className="alignment">
                      {['left', 'center', 'right'].map((a) => (
                        <button
                          className={node.align === a ? 'pressed' : ''}
                          key={a}
                          onClick={() => update({ align: a as Node['align'] })}
                        >
                          {a}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </Section>
            )}
            {node.type === 'chart' && (
              <Section title="DATA">
                <textarea
                  className="text-content"
                  aria-label="Chart values"
                  key={JSON.stringify(node.params.values)}
                  defaultValue={JSON.stringify(node.params.values ?? [30, 65, 45])}
                  onBlur={(e) => {
                    try {
                      const values = JSON.parse(e.target.value);
                      void update({ params: { ...node.params, values } });
                    } catch {
                      setError('Chart values must be a JSON number array');
                    }
                  }}
                />
                <select
                  value={String(node.params.mode ?? 'bar')}
                  onChange={(e) => update({ params: { ...node.params, mode: e.target.value } })}
                >
                  <option value="bar">Bar chart</option>
                  <option value="line">Line chart</option>
                </select>
              </Section>
            )}
            <Section title="动画">
              <TrackingInspector
                key={`tracking-${node.id}`}
                node={node}
                snapshot={snapshot!}
                sceneId={sceneId}
                path={selectedLayer?.path ?? focusPath}
                contextFrames={nodeContextFrames}
                duration={activeDuration}
                rpc={rpc}
                onApplied={() => run('state')}
              />
              <GraphicsInspector
                key={`graphics-${node.id}`}
                node={node}
                onEdit={async (fields) => {
                  const plan = await rpc('graphicsPlan', {
                    sceneId,
                    revision: state.snapshot.revision,
                    frame: nodeFrame,
                    targets: [
                      {
                        nodeId: node.id,
                        path: selectedLayer?.path ?? focusPath,
                        contextFrames: selectedLayer?.contextFrames ?? focusContextFrames,
                        ...fields,
                      },
                    ],
                  });
                  const result = await run('projectApply', plan.apply);
                  if (!result) throw new Error('保存失败，请查看工程诊断');
                  return result;
                }}
              />
              <DriverInspector node={node} onChange={update} onKey={addKey} />
              <AnimationInspector
                key={node.id}
                node={node}
                frame={nodeFrame}
                onFrame={(at) => {
                  const path = selectedLayer?.path ?? focusPath,
                    contexts = selectedLayer?.contextFrames ?? focusContextFrames,
                    key = `${sceneId}:${JSON.stringify(path)}${contexts.length ? `:${JSON.stringify(contexts)}` : ''}`;
                  if (JSON.stringify(path) !== JSON.stringify(focusPath)) {
                    setFocusPath(path);
                    setFocusContextFrames(contexts);
                    setComposition(undefined);
                  }
                  setSceneFrames((current) => ({ ...current, [key]: at }));
                }}
                onEdit={(actions) => editAnimation(actions)}
              />
            </Section>
          </>
        ) : (
          <div className="empty inspector-empty">
            <Icon name="layers" size={32} />
            <p>{workspace === 'editing' ? '选择一个片段' : '选择一个图层'}</p>
            <small>
              {workspace === 'editing'
                ? '在时间轴中选择片段，或点击场景进入独立合成。'
                : '直接拖动图层移动；Ctrl 单击多选，拖动任一选中图层一起移动。空白处拖框选择。'}
            </small>
          </div>
        )}
        {jobs.length > 0 && (
          <Section title="渲染队列">
            {jobs.slice(-3).map((job) => (
              <div className="render-job" key={job.id}>
                <div>
                  <span>{job.status}</span>
                  <span>{Math.round(job.progress * 100)}%</span>
                </div>
                <progress max={1} value={job.progress} />
                <small>
                  {job.stage}
                  {job.error && ` · ${job.error}`}
                </small>
                {job.status === 'running' && (
                  <button onClick={() => run('cancel', { id: job.id })}>取消</button>
                )}
                {job.status === 'completed' && window.vmotionDesktop && (
                  <button onClick={() => window.vmotionDesktop!.showFile(job.output)}>
                    显示文件
                  </button>
                )}
              </div>
            ))}
          </Section>
        )}
      </aside>
      <Splitter
        label="调整时间轴高度"
        direction="horizontal"
        value={layout.timeline}
        min={150}
        max={500}
        invert
        onChange={(timeline) => setLayout((v) => ({ ...v, timeline }))}
      />
      <Timeline
        snapshot={snapshot!}
        scene={scene}
        sequence={sequence}
        sequenceMode={workspace === 'editing'}
        frame={frame}
        selected={selected}
        selection={selectedIds}
        playing={playing}
        onFrame={setFrame}
        onPlaying={setPlaying}
        onSelect={select}
        onScene={setSceneId}
        onClip={selectClip}
        clipSelection={clipSelection}
        onSequenceEdit={editSequenceActions}
        selectedClip={clipSelected}
        transact={transact}
        waveforms={waveforms}
        audioMonitor={{
          status: playback.status,
          muted: playback.muted,
          volume: playback.volume,
          onMute: () => playback.setMuted((value) => !value),
          onVolume: playback.setVolume,
          enabled: workspace === 'editing',
        }}
        onAssetDrop={async (assetId, at, trackId) => {
          const result = await run('assetPlace', {
            assetId,
            frame: at,
            trackId,
            revision: stateRef.current?.snapshot.revision,
            ...(workspace === 'editing'
              ? { sequenceId: sequence.id }
              : { sceneId, path: focusPath, contextFrames: focusContextFrames }),
          });
          if (result?.nodeId) select(result.nodeId);
          if (result?.clipId) setClipSelected(result.clipId);
          return result;
        }}
        onAnimationEdit={async (edits, revision) => {
          setSaving(true);
          try {
            return await run('animationEdit', {
              sceneId,
              frame,
              revision: revision ?? stateRef.current?.snapshot.revision,
              edits: edits.map((edit) => ({
                ...edit,
                path:
                  interactions?.layers.find((l) => l.node.id === edit.nodeId)?.path ?? focusPath,
                contextFrames:
                  interactions?.layers.find((l) => l.node.id === edit.nodeId)?.contextFrames ??
                  focusContextFrames,
                frame: interactions?.layers.find((l) => l.node.id === edit.nodeId)?.frame ?? frame,
              })),
            });
          } finally {
            setSaving(false);
          }
        }}
      />
      <footer className="statusbar">
        <span>
          <span className="status-dot" />
          工程服务已连接
        </span>
        <span>{error || `${scene.nodes.length} 图层 · ${project.assets.length} 素材`}</span>
        <div className="top-spacer" />
        <span>
          {project.width} × {project.height} · {fps.toFixed(2)} fps
        </span>
        <span className="mono">{snapshot!.revision.slice(0, 8)}</span>
      </footer>
      {(state.diagnostics.length > 0 || state.conflicts.length > 0) && (
        <div className="diagnostics">
          <strong>{state.conflicts.length ? '文件冲突' : '工程诊断'}</strong>
          {state.conflicts.map((c, i) => (
            <div key={i}>
              <span>
                {c.file} {c.path}
              </span>
              <button onClick={() => run('resolve', { index: i, choice: 'ours' })}>
                保留界面版本
              </button>
              <button onClick={() => run('resolve', { index: i, choice: 'theirs' })}>
                采用文件版本
              </button>
            </div>
          ))}
          {state.diagnostics.map((d, i) => (
            <p key={i}>
              {d.code}: {d.message}
            </p>
          ))}
        </div>
      )}
      {soundEditing && (
        <SoundEditor
          key={soundEditing}
          assetId={soundEditing}
          snapshot={snapshot!}
          run={run}
          onClose={() => setSoundEditing(undefined)}
          onSaved={setSelectedAsset}
        />
      )}
      {mediaManaging && <MediaManager run={run} onClose={() => setMediaManaging(false)} />}
      {modal && (
        <div className="modal-backdrop" onClick={() => setModal(undefined)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button
              className="modal-close"
              aria-label="Close dialog"
              onClick={() => setModal(undefined)}
            >
              <Icon name="close" />
            </button>
            {modal === 'export' ? (
              <>
                <span className="eyebrow">让想法成为影片</span>
                <h2>导出你的作品</h2>
                <p>基于固定工程版本，在本地渲染。</p>
                <label className="modal-field">
                  格式
                  <select
                    value={format}
                    onChange={(e) => {
                      setFormat(e.target.value);
                      setExportPath(
                        `${state.root}/exports/${e.target.value === 'png' ? 'frames' : `video.${e.target.value}`}`,
                      );
                    }}
                  >
                    <option value="mp4">MP4 视频</option>
                    <option value="png">PNG 图像序列</option>
                    <option value="wav">WAV 音频</option>
                  </select>
                </label>
                <label className="modal-field">
                  输出路径
                  <input value={exportPath} onChange={(e) => setExportPath(e.target.value)} />
                </label>
                <div className="export-summary">
                  <span>
                    分辨率
                    <strong>
                      {project.width} × {project.height}
                    </strong>
                  </span>
                  <span>
                    时长<strong>{(sequence.duration / fps).toFixed(1)} sec</strong>
                  </span>
                  <span>
                    帧率<strong>{fps.toFixed(2)} fps</strong>
                  </span>
                </div>
                <button
                  className="primary modal-primary"
                  onClick={async () => {
                    const result = await run('render', {
                      output: exportPath,
                      format,
                      ...(sequence.workArea
                        ? { start: sequence.workArea.start, end: sequence.workArea.end }
                        : {}),
                    });
                    if (result) {
                      setJobs((j) => [...j, result]);
                      setModal(undefined);
                    }
                  }}
                >
                  <Icon name="export" />
                  开始本地渲染
                </button>
              </>
            ) : modal === 'connect' ? (
              <>
                <span className="eyebrow">外部工具</span>
                <h2>连接你的 agent</h2>
                <p>
                  外部 agent 可以直接修改工程文件，也可通过本地 MCP 检查工程、执行编辑并获取画面。
                </p>
                <pre>
                  {JSON.stringify(
                    {
                      mcpServers: {
                        vmotion: state.connection,
                      },
                    },
                    null,
                    2,
                  )}
                </pre>
                <button
                  className="secondary"
                  onClick={() => navigator.clipboard.writeText(state.root)}
                >
                  复制工程路径
                </button>
              </>
            ) : (
              <>
                <span className="eyebrow">工程设置</span>
                <h2>工程画布</h2>
                <Field
                  label="宽度"
                  value={project.width}
                  onChange={(v) => transact([{ type: 'updateProject', patch: { width: v } }])}
                />
                <Field
                  label="高度"
                  value={project.height}
                  onChange={(v) => transact([{ type: 'updateProject', patch: { height: v } }])}
                />
                <Field
                  label="FPS numerator"
                  value={project.fps.num}
                  onChange={(v) =>
                    transact([
                      { type: 'updateProject', patch: { fps: { ...project.fps, num: v } } },
                    ])
                  }
                />
                <Field
                  label="FPS denominator"
                  value={project.fps.den}
                  onChange={(v) =>
                    transact([
                      { type: 'updateProject', patch: { fps: { ...project.fps, den: v } } },
                    ])
                  }
                />
                <Field
                  label="序列帧数"
                  value={sequence.duration}
                  onChange={(v) =>
                    transact([
                      { type: 'updateSequence', sequenceId: sequence.id, patch: { duration: v } },
                    ])
                  }
                />
                <p>SDR · sRGB · 48 kHz audio</p>
                <p>新建或打开其他工程请使用顶部项目入口（Ctrl+N / Ctrl+O）。</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className="inspector-section"
      data-category={
        ['效果栈', '遮罩与羽化'].includes(title)
          ? 'effects'
          : title === '动画'
            ? 'animation'
            : 'properties'
      }
    >
      <h3>{title}</h3>
      {children}
    </section>
  );
}
function Field({
  label,
  value,
  onChange,
  onKey,
}: {
  label: string;
  value: number;
  onChange: (value: number) => unknown;
  onKey?: () => void;
}) {
  return (
    <label className="number-field">
      <span>{label}</span>
      <input
        aria-label={label}
        key={value}
        type="number"
        defaultValue={Number(value.toFixed(3))}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n !== Number(value.toFixed(3))) onChange(n);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      {onKey && (
        <button title={`Add ${label} keyframe`} type="button" onClick={onKey}>
          ◇
        </button>
      )}
    </label>
  );
}
function Root() {
  const [home, setHome] = useState(location.hash.startsWith('#/welcome'));
  useEffect(() => {
    const changed = () => setHome(location.hash.startsWith('#/welcome'));
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  return home ? <ProjectHome /> : <App />;
}
createRoot(document.getElementById('root')!).render(<Root />);
