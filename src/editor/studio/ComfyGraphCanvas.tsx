import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StudioContext } from './types.js';
import { CandidateActions, NumberControl, SelectControl } from './Controls.js';
import {
  isWorkflowLink,
  VMOTION_BRIDGE_SPECS,
  type GenerativeWorkflow,
  type WorkflowGraphNode,
  type WorkflowInputValue,
  type WorkflowModality,
  type WorkflowNodeSignature,
  type WorkflowPortSpec,
} from '../../core/workflow-schema.js';

/** Maps ComfyUI / Vmotion port types exclusively to `--vm-*` design system colour variables. */
export function socketColorVar(portType: string): string {
  const upper = portType.toUpperCase();
  if (upper === 'MODEL') return 'var(--vm-purple)';
  if (upper === 'CLIP' || upper === 'CONDITIONING') return 'var(--vm-gold)';
  if (upper === 'VAE') return 'var(--vm-danger)';
  if (upper === 'LATENT') return 'var(--vm-coral)';
  if (upper === 'IMAGE') return 'var(--vm-ai)';
  if (upper === 'MASK') return 'var(--vm-text-1)';
  if (upper === 'AUDIO') return 'var(--vm-success)';
  if (upper === 'INT' || upper === 'FLOAT') return 'var(--vm-orange)';
  return 'var(--vm-text-3)';
}

/** Computes a smooth horizontal cubic Bezier SVG path between output socket `(x1,y1)` and input `(x2,y2)`. */
export function computeWireBezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(48, Math.abs(x2 - x1) * 0.48);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

/** Synthesizes effective input/output socket definitions for a node even when ComfyUI is offline. */
export function buildPortMapForNode(
  node: WorkflowGraphNode,
  allNodes: Record<string, WorkflowGraphNode>,
  nodeId: string,
  signatures: Record<string, WorkflowNodeSignature>,
): {
  inputs: WorkflowPortSpec[];
  outputs: Array<{ name: string; type: string }>;
} {
  const sig = signatures[node.classType] ?? VMOTION_BRIDGE_SPECS[node.classType];
  const inputsByName = new Map<string, WorkflowPortSpec>();

  for (const p of sig?.inputs ?? []) {
    inputsByName.set(p.name, p);
  }
  for (const [inName, val] of Object.entries(node.inputs)) {
    if (!inputsByName.has(inName)) {
      inputsByName.set(inName, {
        name: inName,
        type: isWorkflowLink(val)
          ? 'ANY'
          : typeof val === 'number'
            ? Number.isInteger(val)
              ? 'INT'
              : 'FLOAT'
            : typeof val === 'boolean'
              ? 'BOOLEAN'
              : 'STRING',
        optional: false,
      });
    }
  }

  let outputs = (sig?.outputs ?? []).map((o) => ({ name: o.name, type: o.type }));
  let maxOutSlot = outputs.length - 1;
  for (const other of Object.values(allNodes)) {
    for (const v of Object.values(other.inputs)) {
      if (isWorkflowLink(v) && v.$link[0] === nodeId) {
        maxOutSlot = Math.max(maxOutSlot, v.$link[1]);
      }
    }
  }
  if (maxOutSlot >= outputs.length) {
    outputs = [
      ...outputs,
      ...Array.from({ length: maxOutSlot + 1 - outputs.length }, (_, idx) => ({
        name: `out_${outputs.length + idx}`,
        type: 'ANY',
      })),
    ];
  }

  return { inputs: [...inputsByName.values()], outputs };
}

interface CatalogNodeItem {
  classType: string;
  displayName: string;
  category: string;
  outputNode: boolean;
  inputTypes?: string[];
  outputTypes?: string[];
  inputs?: WorkflowPortSpec[];
  outputs?: Array<{ name: string; type: string; isList: boolean }>;
}

interface StagedTakeSummary {
  takeId: string;
  scope: string;
  modality: WorkflowModality;
  provider: string;
  workflowPath?: string;
  nodeId?: string;
  seed?: number;
  file: string;
  ext: string;
  bytes: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  cuesCount?: number;
  createdAt: string;
}

interface ActiveRunSummary {
  runId: string;
  provider: string;
  workflowId: string;
  scope: string;
  status: string;
  currentNode?: string;
  step?: number;
  maxSteps?: number;
}

export interface ComfyGraphCanvasProps {
  context: StudioContext;
  initialWorkflowPath?: string;
  flowPath?: string;
  flowNodeId?: string;
  slot?: 'visual' | 'voice';
  onBack?: () => void;
  onAccepted?: () => void;
}

const NODE_WIDTH = 236;
const HEADER_HEIGHT = 30;
const PORT_ROW_HEIGHT = 24;

export function ComfyGraphCanvas({
  context,
  initialWorkflowPath,
  flowPath,
  flowNodeId,
  slot = 'visual',
  onBack,
  onAccepted,
}: ComfyGraphCanvasProps) {
  const workflowFiles = useMemo(
    () =>
      Object.keys(context.snapshot.files)
        .filter((f) => f.endsWith('.workflow.json'))
        .sort(),
    [context.snapshot.files],
  );

  const [workflowPath, setWorkflowPath] = useState<string>(
    () => initialWorkflowPath || workflowFiles[0] || '',
  );
  const [draft, setDraft] = useState<GenerativeWorkflow | null>(null);
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string>('');
  const [pendingSource, setPendingSource] = useState<{
    nodeId: string;
    slot: number;
    type: string;
  } | null>(null);

  // Node palette search state
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);
  const [paletteSearch, setPaletteSearch] = useState<string>('');
  const [paletteInputFilter, setPaletteInputFilter] = useState<string>('');
  const [catalogItems, setCatalogItems] = useState<CatalogNodeItem[]>([]);
  const [catalogSource, setCatalogSource] = useState<string>('builtin-only');

  // Local provider settings state
  const [providerDrawerOpen, setProviderDrawerOpen] = useState<boolean>(false);
  const [comfyBaseUrl, setComfyBaseUrl] = useState<string>('http://127.0.0.1:8188');
  const [ttsEndpoint, setTtsEndpoint] = useState<string>('http://127.0.0.1:9880/tts');
  const [probeSummary, setProbeSummary] = useState<string>('');

  // Run & Takes state
  const [takesCount, setTakesCount] = useState<number>(1);
  const [seedOverride, setSeedOverride] = useState<string>('');
  const [fitPolicy, setFitPolicy] = useState<'trim' | 'fit-speed' | 'extend-shot'>('trim');
  const [stagedTakes, setStagedTakes] = useState<StagedTakeSummary[]>([]);
  const [activeRuns, setActiveRuns] = useState<ActiveRunSummary[]>([]);
  const [runningNow, setRunningNow] = useState<boolean>(false);
  const [busyMsg, setBusyMsg] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');

  const dragRef = useRef<{
    nodeId: string;
    startClientX: number;
    startClientY: number;
    origX: number;
    origY: number;
  } | null>(null);

  // Sync draft when workflowPath or snapshot changes
  useEffect(() => {
    if (!workflowPath) {
      setDraft(null);
      return;
    }
    const raw = context.snapshot.files[workflowPath];
    if (!raw) {
      setDraft(null);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as GenerativeWorkflow;
      if (parsed?.kind === 'generative-workflow') {
        setDraft(structuredClone(parsed));
        setSelectedGraphNodeId((prev) =>
          prev && parsed.nodes[prev] ? prev : (Object.keys(parsed.nodes)[0] ?? ''),
        );
      }
    } catch (e) {
      setErrorMsg((e as Error).message);
    }
  }, [workflowPath, context.snapshot.files]);

  const refreshTakes = useCallback(async () => {
    try {
      const res = await context.run('workflowTakes', {
        action: 'list',
        ...(flowNodeId ? { scope: flowNodeId } : {}),
        limit: 16,
      });
      setStagedTakes((res?.takes ?? []) as StagedTakeSummary[]);
      setActiveRuns((res?.activeRuns ?? []) as ActiveRunSummary[]);
    } catch {}
  }, [context, flowNodeId]);

  useEffect(() => {
    void refreshTakes();
  }, [refreshTakes, workflowPath]);

  // Poll live progress while generating
  useEffect(() => {
    if (!runningNow && activeRuns.length === 0) return;
    const timer = window.setInterval(() => {
      void refreshTakes();
    }, 450);
    return () => window.clearInterval(timer);
  }, [runningNow, activeRuns.length, refreshTakes]);

  // Load node catalog when palette opens or filters change
  const queryNodeCatalog = useCallback(
    async (refresh = false) => {
      try {
        const res = await context.run('workflowNodesQuery', {
          ...(paletteSearch.trim() ? { search: paletteSearch.trim() } : {}),
          ...(paletteInputFilter ? { inputType: paletteInputFilter } : {}),
          ...(workflowPath ? { workflowPath } : {}),
          refresh,
          detail: true,
          limit: 40,
        });
        setCatalogItems((res?.items ?? []) as CatalogNodeItem[]);
        setCatalogSource(String(res?.source ?? 'builtin-only'));
      } catch (e) {
        setErrorMsg((e as Error).message);
      }
    },
    [context, paletteSearch, paletteInputFilter, workflowPath],
  );

  useEffect(() => {
    if (paletteOpen) void queryNodeCatalog(false);
  }, [paletteOpen, queryNodeCatalog]);

  const handleCreateTemplate = async (
    template:
      | 'comfy-txt2img'
      | 'comfy-inpaint-canvas'
      | 'comfy-i2v-4n1'
      | 'local-tts'
      | 'inbox-gen',
  ) => {
    const idBase = `${flowNodeId || 'shot'}-${template.replace(/^comfy-/, '')}`.replace(
      /[^a-zA-Z0-9_-]/g,
      '-',
    );
    setBusyMsg('正在创建工作流模板…');
    setErrorMsg('');
    try {
      const plan = await context.run('workflowPlan', {
        action: {
          op: 'create',
          id: idBase,
          name: `${flowNodeId ? `${flowNodeId} · ` : ''}${template}`,
          template,
        },
      });
      await context.run('projectApply', plan.apply);
      if (plan.workflowPath) {
        setWorkflowPath(plan.workflowPath);
        if (flowPath && flowNodeId) {
          const bindPlan = await context.run('workflowPlan', {
            workflowPath: plan.workflowPath,
            action: {
              op: 'bindToFlowNode',
              flowPath,
              nodeId: flowNodeId,
              slot: template === 'local-tts' ? 'voice' : slot,
            },
          });
          await context.run('projectApply', bindPlan.apply);
        }
      }
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setBusyMsg('');
    }
  };

  const handleImportFile = async (file: File) => {
    setBusyMsg(`正在导入 ${file.name}…`);
    setErrorMsg('');
    try {
      const cleanId =
        file.name
          .replace(/\.(workflow\.json|json|png)$/i, '')
          .replace(/[^a-zA-Z0-9_-]/g, '-')
          .replace(/^-+|-+$/g, '') || 'imported-comfy';

      let plan: any;
      if (file.name.toLowerCase().endsWith('.png')) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const pngBase64 = btoa(binary);
        plan = await context.run('workflowPlan', {
          action: { op: 'importPng', id: cleanId, name: file.name, pngBase64 },
        });
      } else {
        const parsed = JSON.parse(await file.text());
        plan = await context.run('workflowPlan', {
          action: { op: 'importJson', id: cleanId, name: file.name, workflowJson: parsed },
        });
      }
      await context.run('projectApply', plan.apply);
      if (plan.workflowPath) setWorkflowPath(plan.workflowPath);
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setBusyMsg('');
    }
  };

  const handleNodePointerDown = (
    e: React.PointerEvent<HTMLElement>,
    nodeId: string,
    pos: [number, number],
  ) => {
    if ((e.target as HTMLElement).closest('button, input, select, textarea')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelectedGraphNodeId(nodeId);
    dragRef.current = {
      nodeId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origX: pos[0],
      origY: pos[1],
    };
  };

  const handleNodePointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const nx = Math.max(16, Math.round(drag.origX + (e.clientX - drag.startClientX)));
    const ny = Math.max(16, Math.round(drag.origY + (e.clientY - drag.startClientY)));
    setDraft((prev) => {
      if (!prev || !prev.nodes[drag.nodeId]) return prev;
      return {
        ...prev,
        nodes: {
          ...prev.nodes,
          [drag.nodeId]: {
            ...prev.nodes[drag.nodeId],
            pos: [nx, ny],
          },
        },
      };
    });
  };

  const handleNodePointerUp = () => {
    dragRef.current = null;
  };

  const handleAddNodeFromCatalog = (item: CatalogNodeItem) => {
    if (!draft) return;
    const baseKey = item.classType.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    let idx = Object.keys(draft.nodes).length + 1;
    let newNodeId = `${baseKey}_${idx}`;
    while (draft.nodes[newNodeId]) {
      idx++;
      newNodeId = `${baseKey}_${idx}`;
    }

    const defaultInputs: Record<string, WorkflowInputValue> = {};
    for (const p of item.inputs ?? []) {
      if (p.widget?.default !== undefined) {
        defaultInputs[p.name] = p.widget.default;
      }
    }

    // Auto-wire if user clicked an output socket before opening palette!
    if (pendingSource && item.inputs) {
      const compat = item.inputs.find(
        (p) =>
          p.type.toUpperCase() === pendingSource.type.toUpperCase() ||
          p.type === 'ANY' ||
          pendingSource.type === 'ANY',
      );
      if (compat) {
        defaultInputs[compat.name] = { $link: [pendingSource.nodeId, pendingSource.slot] };
      }
    }

    const col = Object.keys(draft.nodes).length;
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        nodes: {
          ...prev.nodes,
          [newNodeId]: {
            classType: item.classType,
            title: item.displayName,
            pos: [80 + (col % 4) * 265, 80 + Math.floor(col / 4) * 210],
            bypass: false,
            mute: false,
            inputs: defaultInputs,
          },
        },
        portSignatures: {
          ...prev.portSignatures,
          ...(item.inputs && item.outputs
            ? {
                [item.classType]: {
                  displayName: item.displayName,
                  category: item.category,
                  inputs: item.inputs,
                  outputs: item.outputs,
                  outputNode: item.outputNode,
                },
              }
            : {}),
        },
      };
    });
    setSelectedGraphNodeId(newNodeId);
    setPendingSource(null);
    setPaletteOpen(false);
  };

  const handleConnectToInput = (toNodeId: string, inputName: string) => {
    if (!draft) return;
    if (pendingSource) {
      if (pendingSource.nodeId === toNodeId) {
        setPendingSource(null);
        return;
      }
      setDraft((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          nodes: {
            ...prev.nodes,
            [toNodeId]: {
              ...prev.nodes[toNodeId],
              inputs: {
                ...prev.nodes[toNodeId].inputs,
                [inputName]: { $link: [pendingSource.nodeId, pendingSource.slot] },
              },
            },
          },
        };
      });
      setPendingSource(null);
      return;
    }

    // Clicking an already-linked input disconnects it
    const curVal = draft.nodes[toNodeId]?.inputs[inputName];
    if (isWorkflowLink(curVal)) {
      setDraft((prev) => {
        if (!prev) return prev;
        const nextInputs = { ...prev.nodes[toNodeId].inputs };
        delete nextInputs[inputName];
        return {
          ...prev,
          nodes: {
            ...prev.nodes,
            [toNodeId]: { ...prev.nodes[toNodeId], inputs: nextInputs },
          },
        };
      });
    }
  };

  const togglePinInput = (nodeId: string, port: WorkflowPortSpec, currentVal: unknown) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const existingEntry = Object.entries(prev.pinnedInputs).find(
        ([, p]) => p.nodeId === nodeId && p.inputName === port.name,
      );
      const nextPins = { ...prev.pinnedInputs };
      if (existingEntry) {
        delete nextPins[existingEntry[0]];
      } else {
        const key = prev.pinnedInputs[port.name] ? `${nodeId}_${port.name}` : port.name;
        nextPins[key] = {
          nodeId,
          inputName: port.name,
          label: `${nodeId}.${port.name}`,
          type:
            port.name === 'seed' || port.name === 'noise_seed'
              ? 'seed'
              : port.widget?.kind === 'combo'
                ? 'combo'
                : port.widget?.kind === 'int' || port.widget?.kind === 'float'
                  ? 'number'
                  : port.widget?.kind === 'boolean'
                    ? 'boolean'
                    : 'string',
          ...(port.widget?.options ? { options: port.widget.options } : {}),
          ...(typeof currentVal === 'string' ||
          typeof currentVal === 'number' ||
          typeof currentVal === 'boolean'
            ? { default: currentVal }
            : {}),
        };
      }
      return { ...prev, pinnedInputs: nextPins };
    });
  };

  const handleRunWorkflow = async () => {
    if (!draft) return;
    setRunningNow(true);
    setErrorMsg('');
    try {
      await context.run('workflowRun', {
        workflow: draft,
        ...(workflowPath ? { workflowPath } : {}),
        ...(flowPath ? { flowPath } : {}),
        ...(flowNodeId ? { nodeId: flowNodeId } : {}),
        ...(seedOverride.trim() !== '' && Number.isFinite(Number(seedOverride))
          ? { seed: Number(seedOverride) }
          : {}),
        takes: takesCount,
      });
      await refreshTakes();
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setRunningNow(false);
    }
  };

  const handleAcceptTake = async (take: StagedTakeSummary) => {
    setBusyMsg(`正在烘焙候选 ${take.takeId.slice(0, 12)}…`);
    setErrorMsg('');
    try {
      const plan = await context.run('workflowAccept', {
        takeId: take.takeId,
        ...(flowPath ? { flowPath } : {}),
        ...(flowNodeId ? { nodeId: flowNodeId } : {}),
        slot: take.modality === 'tts' ? 'voice' : slot,
        fitPolicy,
      });
      await context.run('projectApply', plan.apply);
      if (onAccepted) onAccepted();
    } catch (e) {
      setErrorMsg((e as Error).message);
    } finally {
      setBusyMsg('');
    }
  };

  // Precompute node geometry + SVG Bezier wires
  const graphLayout = useMemo(() => {
    if (!draft) return { nodeBoxes: [], wires: [], canvasW: 960, canvasH: 520 };
    const nodeBoxes: Array<{
      id: string;
      node: WorkflowGraphNode;
      x: number;
      y: number;
      inputs: WorkflowPortSpec[];
      outputs: Array<{ name: string; type: string }>;
    }> = [];
    const outputSocketCoords = new Map<string, { x: number; y: number; type: string }>();
    const inputSocketCoords = new Map<string, { x: number; y: number; type: string }>();

    let maxX = 920;
    let maxY = 480;

    Object.entries(draft.nodes).forEach(([id, node], idx) => {
      const x = node.pos?.[0] ?? 60 + (idx % 4) * 265;
      const y = node.pos?.[1] ?? 60 + Math.floor(idx / 4) * 210;
      const ports = buildPortMapForNode(node, draft.nodes, id, draft.portSignatures);
      ports.outputs.forEach((out, sIdx) => {
        outputSocketCoords.set(`${id}:${sIdx}`, {
          x: x + NODE_WIDTH,
          y: y + HEADER_HEIGHT + 14 + sIdx * PORT_ROW_HEIGHT,
          type: out.type,
        });
      });
      ports.inputs.forEach((inp, iIdx) => {
        inputSocketCoords.set(`${id}:${inp.name}`, {
          x,
          y:
            y +
            HEADER_HEIGHT +
            14 +
            ports.outputs.length * PORT_ROW_HEIGHT +
            iIdx * PORT_ROW_HEIGHT,
          type: inp.type,
        });
      });
      maxX = Math.max(maxX, x + NODE_WIDTH + 120);
      maxY = Math.max(
        maxY,
        y + HEADER_HEIGHT + (ports.outputs.length + ports.inputs.length) * PORT_ROW_HEIGHT + 140,
      );
      nodeBoxes.push({ id, node, x, y, inputs: ports.inputs, outputs: ports.outputs });
    });

    const wires: Array<{
      key: string;
      d: string;
      color: string;
    }> = [];
    for (const box of nodeBoxes) {
      for (const [inName, val] of Object.entries(box.node.inputs)) {
        if (!isWorkflowLink(val)) continue;
        const src = outputSocketCoords.get(`${val.$link[0]}:${val.$link[1]}`);
        const dst = inputSocketCoords.get(`${box.id}:${inName}`);
        if (!src || !dst) continue;
        wires.push({
          key: `${val.$link[0]}:${val.$link[1]}->${box.id}:${inName}`,
          d: computeWireBezierPath(src.x, src.y, dst.x, dst.y),
          color: socketColorVar(src.type !== 'ANY' ? src.type : dst.type),
        });
      }
    }

    return { nodeBoxes, wires, canvasW: maxX, canvasH: maxY };
  }, [draft]);

  return (
    <div
      className="comfy-workbench"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (f) void handleImportFile(f);
      }}
    >
      <div className="comfy-topbar">
        {onBack && (
          <button type="button" className="secondary" onClick={onBack}>
            ← 返回场景流
          </button>
        )}
        {flowNodeId && (
          <span className="flow-chip mounted">
            目标胶囊：{flowNodeId} ({slot === 'voice' ? '配音/TTS' : '画面/视频'})
          </span>
        )}
        {workflowFiles.length > 0 && (
          <SelectControl
            label="当前工作流"
            value={workflowPath}
            options={workflowFiles.map((f) => [f, f.replace(/^components\//, '')] as [string, string])}
            onChange={setWorkflowPath}
          />
        )}
        <div className="comfy-topbar-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setPaletteInputFilter('');
              setPaletteOpen((v) => !v);
            }}
          >
            + 动态节点库 (/object_info)
          </button>
          <label className="secondary comfy-upload-btn">
            导入 ComfyUI JSON / PNG
            <input
              type="file"
              accept=".json,.png"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleImportFile(f);
                e.currentTarget.value = '';
              }}
            />
          </label>
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              const next = !providerDrawerOpen;
              setProviderDrawerOpen(next);
              if (next) {
                try {
                  const p = await context.run('workflowProviders', { action: 'inspect' });
                  if (p?.comfyui?.baseUrl) setComfyBaseUrl(p.comfyui.baseUrl);
                  if (p?.httpLocal?.cosyvoice?.endpoint) {
                    setTtsEndpoint(p.httpLocal.cosyvoice.endpoint);
                  }
                } catch {}
              }
            }}
          >
            本地引擎配置
          </button>
        </div>
      </div>

      {providerDrawerOpen && (
        <div className="comfy-provider-bar">
          <label className="studio-field">
            <span>本地 / 局域网 ComfyUI 地址 (不写入工程 Git，零云端 Key)</span>
            <input value={comfyBaseUrl} onChange={(e) => setComfyBaseUrl(e.target.value)} />
          </label>
          <label className="studio-field">
            <span>本地 TTS 地址 (CosyVoice / GPT-SoVITS / IndexTTS)</span>
            <input value={ttsEndpoint} onChange={(e) => setTtsEndpoint(e.target.value)} />
          </label>
          <button
            type="button"
            className="primary"
            onClick={async () => {
              setProbeSummary('正在探测…');
              try {
                const res = await context.run('workflowProviders', {
                  action: 'configure',
                  probe: true,
                  comfyui: { baseUrl: comfyBaseUrl.trim() },
                  httpLocal: {
                    cosyvoice: {
                      preset: 'cosyvoice',
                      endpoint: ttsEndpoint.trim(),
                      method: 'POST',
                    },
                  },
                });
                const cOk = res?.comfyui?.probe?.reachable;
                const tOk = res?.httpLocal?.cosyvoice?.probe?.reachable;
                setProbeSummary(
                  `ComfyUI: ${cOk ? '在线' : '离线'} · 本地 TTS: ${tOk ? '在线' : '离线'}`,
                );
              } catch (e) {
                setProbeSummary(`配置失败: ${(e as Error).message}`);
              }
            }}
          >
            保存并探测连接
          </button>
          {probeSummary && <span className="flow-chip">{probeSummary}</span>}
        </div>
      )}

      {paletteOpen && (
        <div className="comfy-palette-drawer" role="region" aria-label="ComfyUI 节点搜索面板">
          <div className="comfy-palette-controls">
            <input
              placeholder="搜索节点类名 / 中文名 / 分类 (如 KSampler, ControlNet, WanImageToVideo, Mask)…"
              value={paletteSearch}
              onChange={(e) => setPaletteSearch(e.target.value)}
            />
            <input
              placeholder="按输入类型过滤 (如 IMAGE, MASK, LATENT)"
              value={paletteInputFilter}
              onChange={(e) => setPaletteInputFilter(e.target.value)}
            />
            <button type="button" className="secondary" onClick={() => void queryNodeCatalog(true)}>
              从 ComfyUI 刷新 /object_info
            </button>
            <span className="flow-chip">数据源：{catalogSource}</span>
          </div>
          <div className="comfy-palette-grid">
            {catalogItems.map((item) => (
              <button
                key={item.classType}
                type="button"
                className="comfy-palette-item"
                onClick={() => handleAddNodeFromCatalog(item)}
              >
                <strong>{item.displayName}</strong>
                <code>{item.classType}</code>
                <span>{item.category}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {errorMsg && (
        <p className="studio-error" role="alert">
          {errorMsg}
        </p>
      )}

      {/* Starter onboarding if no workflow exists yet */}
      {!draft ? (
        <div className="comfy-starter-grid">
          <button
            type="button"
            className="flow-empty-card"
            disabled={Boolean(busyMsg)}
            onClick={() => void handleCreateTemplate('comfy-txt2img')}
          >
            <strong>新建 ComfyUI 文生图子图</strong>
            <p>自动接入工程画幅 (ProjectSpec)，支持直接拖入任意 ComfyUI 导出的 PNG 或 JSON 覆盖。</p>
          </button>
          <button
            type="button"
            className="flow-empty-card"
            disabled={Boolean(busyMsg)}
            onClick={() => void handleCreateTemplate('comfy-inpaint-canvas')}
          >
            <strong>新建画布涂抹局部重绘 (Inpaint)</strong>
            <p>自动桥接 Vmotion 当前画面帧与画布指令 (Canvas Inbox) 涂抹遮罩，无缝送入 VAEEncodeForInpaint。</p>
          </button>
          <button
            type="button"
            className="flow-empty-card"
            disabled={Boolean(busyMsg)}
            onClick={() => void handleCreateTemplate('comfy-i2v-4n1')}
          >
            <strong>新建 4n+1 图生视频工作流</strong>
            <p>自动提取前后镜参考帧与 4n+1 潜空间对齐帧数 (Wan / HunyuanVideo / LTX-Video)。</p>
          </button>
          <button
            type="button"
            className="flow-empty-card"
            disabled={Boolean(busyMsg)}
            onClick={() => void handleCreateTemplate('local-tts')}
          >
            <strong>新建本地 HTTP 配音合成 (TTS)</strong>
            <p>连接本地 CosyVoice / GPT-SoVITS / IndexTTS，采纳后自动驱动镜头时长涟漪与词句字幕对齐。</p>
          </button>
          <button
            type="button"
            className="flow-empty-card"
            disabled={Boolean(busyMsg)}
            onClick={() => void handleCreateTemplate('inbox-gen')}
          >
            <strong>新建外部 Agent 生成委托</strong>
            <p>无需本机显卡或任何 API Key，将当前镜头参考帧与意图打包进画布指令队列交由外部 Agent 完成。</p>
          </button>
        </div>
      ) : (
        <>
          {pendingSource && (
            <div className="flow-workflow-callout">
              <span>
                正在连线：从 <code>{pendingSource.nodeId}</code> 端口 #{pendingSource.slot} (
                {pendingSource.type}) — 请点击目标节点的左侧输入插槽，或：
              </span>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setPaletteInputFilter(pendingSource.type === 'ANY' ? '' : pendingSource.type);
                  setPaletteOpen(true);
                }}
              >
                搜索接收 {pendingSource.type} 的节点
              </button>
              <button type="button" className="secondary" onClick={() => setPendingSource(null)}>
                取消连线
              </button>
            </div>
          )}

          {/* Main SVG + Draggable Node Cards Viewport */}
          <div className="comfy-viewport" role="region" aria-label="ComfyUI 节点连线画布">
            <div
              className="comfy-surface"
              style={{ width: `${graphLayout.canvasW}px`, height: `${graphLayout.canvasH}px` }}
            >
              <svg
                className="comfy-wires-svg"
                width={graphLayout.canvasW}
                height={graphLayout.canvasH}
              >
                {graphLayout.wires.map((w) => (
                  <path
                    key={w.key}
                    d={w.d}
                    fill="none"
                    stroke={w.color}
                    strokeWidth={2.2}
                    strokeLinecap="round"
                  />
                ))}
              </svg>

              {graphLayout.nodeBoxes.map((box) => {
                const isBridge =
                  box.node.classType.startsWith('vmotion.') ||
                  box.node.classType === 'http.LocalModel' ||
                  box.node.classType === 'inbox.AgentGen';
                return (
                  <article
                    key={box.id}
                    className={`comfy-node-card ${selectedGraphNodeId === box.id ? 'selected' : ''} ${
                      isBridge ? 'bridge' : ''
                    }`}
                    style={{ left: `${box.x}px`, top: `${box.y}px`, width: `${NODE_WIDTH}px` }}
                    onPointerDown={(e) => handleNodePointerDown(e, box.id, [box.x, box.y])}
                    onPointerMove={handleNodePointerMove}
                    onPointerUp={handleNodePointerUp}
                  >
                    <header className="comfy-node-header">
                      <strong title={box.node.classType}>
                        {box.node.title || box.node.classType}
                      </strong>
                      <button
                        type="button"
                        className="comfy-node-del"
                        title="删除节点"
                        onClick={() =>
                          setDraft((prev) => {
                            if (!prev) return prev;
                            const nextNodes = { ...prev.nodes };
                            delete nextNodes[box.id];
                            for (const [nid, n] of Object.entries(nextNodes)) {
                              const cleaned = { ...n.inputs };
                              for (const [k, v] of Object.entries(cleaned)) {
                                if (isWorkflowLink(v) && v.$link[0] === box.id) delete cleaned[k];
                              }
                              nextNodes[nid] = { ...n, inputs: cleaned };
                            }
                            const nextPins = { ...prev.pinnedInputs };
                            for (const [pk, pv] of Object.entries(nextPins)) {
                              if (pv.nodeId === box.id) delete nextPins[pk];
                            }
                            return { ...prev, nodes: nextNodes, pinnedInputs: nextPins };
                          })
                        }
                      >
                        ×
                      </button>
                    </header>

                    {/* Output sockets */}
                    <div className="comfy-ports-out">
                      {box.outputs.map((out, sIdx) => (
                        <button
                          key={`${box.id}:out:${sIdx}`}
                          type="button"
                          className="comfy-socket-row out"
                          onClick={() =>
                            setPendingSource({ nodeId: box.id, slot: sIdx, type: out.type })
                          }
                        >
                          <span>
                            {out.name} <small>({out.type})</small>
                          </span>
                          <i
                            className="comfy-socket-dot"
                            style={{ background: socketColorVar(out.type) }}
                          />
                        </button>
                      ))}
                    </div>

                    {/* Input sockets & inline widgets */}
                    <div className="comfy-ports-in">
                      {box.inputs.map((inp) => {
                        const rawVal = box.node.inputs[inp.name];
                        const linked = isWorkflowLink(rawVal);
                        const isPinned = Object.values(draft.pinnedInputs).some(
                          (p) => p.nodeId === box.id && p.inputName === inp.name,
                        );
                        return (
                          <div key={`${box.id}:in:${inp.name}`} className="comfy-input-block">
                            <div className="comfy-socket-line">
                              <button
                                type="button"
                                className={`comfy-socket-row in ${linked ? 'linked' : ''}`}
                                onClick={() => handleConnectToInput(box.id, inp.name)}
                                title={
                                  linked
                                    ? `已连接自 ${rawVal.$link[0]}#${rawVal.$link[1]}（点击断开）`
                                    : '点击接入当前连线'
                                }
                              >
                                <i
                                  className="comfy-socket-dot"
                                  style={{ background: socketColorVar(inp.type) }}
                                />
                                <span>
                                  {inp.name}{' '}
                                  <small>
                                    {linked ? `← ${rawVal.$link[0]}` : `(${inp.type})`}
                                  </small>
                                </span>
                              </button>
                              {!linked && inp.widget && (
                                <button
                                  type="button"
                                  className={`comfy-pin-btn ${isPinned ? 'pinned' : ''}`}
                                  title="暴露到胶囊面板 (pinnedInputs)"
                                  onClick={() => togglePinInput(box.id, inp, rawVal)}
                                >
                                  {isPinned ? '已暴露' : '暴露'}
                                </button>
                              )}
                            </div>

                            {!linked && inp.widget && (
                              <div className="comfy-inline-widget">
                                {inp.widget.kind === 'combo' && inp.widget.options ? (
                                  <select
                                    value={String(rawVal ?? inp.widget.default ?? '')}
                                    onChange={(e) => {
                                      const v = e.target.value;
                                      setDraft((prev) =>
                                        prev
                                          ? {
                                              ...prev,
                                              nodes: {
                                                ...prev.nodes,
                                                [box.id]: {
                                                  ...prev.nodes[box.id],
                                                  inputs: {
                                                    ...prev.nodes[box.id].inputs,
                                                    [inp.name]: v,
                                                  },
                                                },
                                              },
                                            }
                                          : prev,
                                      );
                                    }}
                                  >
                                    {inp.widget.options.map((opt) => (
                                      <option key={opt} value={opt}>
                                        {opt}
                                      </option>
                                    ))}
                                  </select>
                                ) : inp.widget.kind === 'boolean' ? (
                                  <input
                                    type="checkbox"
                                    checked={Boolean(rawVal ?? inp.widget.default)}
                                    onChange={(e) => {
                                      const v = e.target.checked;
                                      setDraft((prev) =>
                                        prev
                                          ? {
                                              ...prev,
                                              nodes: {
                                                ...prev.nodes,
                                                [box.id]: {
                                                  ...prev.nodes[box.id],
                                                  inputs: {
                                                    ...prev.nodes[box.id].inputs,
                                                    [inp.name]: v,
                                                  },
                                                },
                                              },
                                            }
                                          : prev,
                                      );
                                    }}
                                  />
                                ) : inp.widget.kind === 'int' || inp.widget.kind === 'float' ? (
                                  <input
                                    type="number"
                                    step={inp.widget.step ?? (inp.widget.kind === 'int' ? 1 : 0.05)}
                                    value={Number(rawVal ?? inp.widget.default ?? 0)}
                                    onChange={(e) => {
                                      const num = Number(e.target.value);
                                      if (!Number.isFinite(num)) return;
                                      setDraft((prev) =>
                                        prev
                                          ? {
                                              ...prev,
                                              nodes: {
                                                ...prev.nodes,
                                                [box.id]: {
                                                  ...prev.nodes[box.id],
                                                  inputs: {
                                                    ...prev.nodes[box.id].inputs,
                                                    [inp.name]:
                                                      inp.widget?.kind === 'int'
                                                        ? Math.round(num)
                                                        : num,
                                                  },
                                                },
                                              },
                                            }
                                          : prev,
                                      );
                                    }}
                                  />
                                ) : inp.widget.multiline ? (
                                  <textarea
                                    rows={2}
                                    value={String(rawVal ?? inp.widget.default ?? '')}
                                    onChange={(e) => {
                                      const v = e.target.value;
                                      setDraft((prev) =>
                                        prev
                                          ? {
                                              ...prev,
                                              nodes: {
                                                ...prev.nodes,
                                                [box.id]: {
                                                  ...prev.nodes[box.id],
                                                  inputs: {
                                                    ...prev.nodes[box.id].inputs,
                                                    [inp.name]: v,
                                                  },
                                                },
                                              },
                                            }
                                          : prev,
                                      );
                                    }}
                                  />
                                ) : (
                                  <input
                                    value={String(rawVal ?? inp.widget.default ?? '')}
                                    onChange={(e) => {
                                      const v = e.target.value;
                                      setDraft((prev) =>
                                        prev
                                          ? {
                                              ...prev,
                                              nodes: {
                                                ...prev.nodes,
                                                [box.id]: {
                                                  ...prev.nodes[box.id],
                                                  inputs: {
                                                    ...prev.nodes[box.id].inputs,
                                                    [inp.name]: v,
                                                  },
                                                },
                                              },
                                            }
                                          : prev,
                                      );
                                    }}
                                  />
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>

          {/* Save Graph Candidate + Run & Multi-Take Gallery Footer */}
          <div className="comfy-footer">
            <div className="comfy-run-bar">
              <NumberControl
                label="抽卡数量 (Takes)"
                value={takesCount}
                min={1}
                max={4}
                step={1}
                onChange={(n) => setTakesCount(Math.max(1, Math.min(4, Math.round(n))))}
              />
              <label className="studio-field">
                <span>固定种子 (留空用节点默认)</span>
                <input
                  placeholder="可选 Seed"
                  value={seedOverride}
                  onChange={(e) => setSeedOverride(e.target.value)}
                />
              </label>
              {draft.modality === 'video' && (
                <SelectControl
                  label="生视频烘焙策略"
                  value={fitPolicy}
                  options={[
                    ['trim', '裁切对齐 (trim)'],
                    ['fit-speed', '变速适配 (fit-speed)'],
                    ['extend-shot', '撑开镜头波纹 (extend-shot)'],
                  ]}
                  onChange={(p) => setFitPolicy(p as 'trim' | 'fit-speed' | 'extend-shot')}
                />
              )}
              <button
                type="button"
                className="primary"
                disabled={runningNow || Boolean(busyMsg)}
                onClick={() => void handleRunWorkflow()}
              >
                {runningNow ? '正在推理生成…' : `▶ 运行工作流 (${draft.modality.toUpperCase()})`}
              </button>
              {activeRuns.map((r) => (
                <div key={r.runId} className="comfy-progress-pill">
                  <span>
                    运行中 {r.currentNode ? `[${r.currentNode}]` : ''}{' '}
                    {r.step !== undefined && r.maxSteps ? `${r.step}/${r.maxSteps}` : ''}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void context
                        .run('workflowTakes', { action: 'cancel', runId: r.runId })
                        .then(() => refreshTakes())
                    }
                  >
                    中断
                  </button>
                </div>
              ))}
            </div>

            {stagedTakes.length > 0 && (
              <div className="comfy-takes-strip">
                {stagedTakes.map((t) => (
                  <div key={t.takeId} className="comfy-take-card">
                    <div className="comfy-take-meta">
                      <strong>
                        {t.modality.toUpperCase()} · {t.ext}
                      </strong>
                      <span>
                        {t.width && t.height ? `${t.width}×${t.height} · ` : ''}
                        {t.durationSeconds !== undefined ? `${t.durationSeconds.toFixed(2)}s · ` : ''}
                        {t.cuesCount !== undefined ? `${t.cuesCount} 句字幕 · ` : ''}
                        {t.seed !== undefined ? `Seed ${t.seed}` : t.provider}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="primary"
                      disabled={Boolean(busyMsg)}
                      onClick={() => void handleAcceptTake(t)}
                    >
                      ✓ 采纳并烘焙
                    </button>
                  </div>
                ))}
              </div>
            )}

            {workflowPath && (
              <CandidateActions
                context={context}
                changeKey={JSON.stringify(draft)}
                prepare={() =>
                  context.run('workflowPlan', {
                    workflowPath,
                    action: { op: 'replaceGraph', workflow: draft },
                    inline: true,
                  })
                }
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
