import { unzlibSync } from 'fflate';
import {
  generativeWorkflowSchema,
  isWorkflowLink,
  VMOTION_BRIDGE_SPECS,
  workflowIdSchema,
  type GenerativeWorkflow,
  type WorkflowGraphNode,
  type WorkflowInputValue,
  type WorkflowModality,
  type WorkflowNodeSignature,
  type WorkflowPinnedInput,
  type WorkflowPortSpec,
} from './workflow-schema.js';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Parses a single ComfyUI `/object_info/<ClassName>` entry into a compact `WorkflowNodeSignature`. */
export function parseComfyObjectInfoEntry(
  classType: string,
  raw: Record<string, unknown>,
): WorkflowNodeSignature {
  const inputs: WorkflowPortSpec[] = [];
  const rawInput = (raw.input ?? {}) as {
    required?: Record<string, unknown>;
    optional?: Record<string, unknown>;
  };

  const ingestGroup = (group: Record<string, unknown> | undefined, optional: boolean) => {
    if (!group || typeof group !== 'object') return;
    for (const [name, spec] of Object.entries(group)) {
      if (!Array.isArray(spec) || spec.length === 0) continue;
      const head = spec[0];
      const cfg =
        spec[1] && typeof spec[1] === 'object' && !Array.isArray(spec[1])
          ? (spec[1] as Record<string, unknown>)
          : {};

      if (Array.isArray(head)) {
        const options = head.map((v) => String(v)).slice(0, 500);
        inputs.push({
          name,
          type: 'COMBO',
          optional,
          widget: {
            kind: 'combo',
            options,
            ...(typeof cfg.default === 'string'
              ? { default: cfg.default }
              : options[0] !== undefined
                ? { default: options[0] }
                : {}),
          },
        });
        continue;
      }

      const typeStr = String(head);
      if (typeStr === 'INT' || typeStr === 'FLOAT') {
        inputs.push({
          name,
          type: typeStr,
          optional,
          widget: {
            kind: typeStr === 'INT' ? 'int' : 'float',
            ...(typeof cfg.min === 'number' && Number.isFinite(cfg.min) ? { min: cfg.min } : {}),
            ...(typeof cfg.max === 'number' && Number.isFinite(cfg.max) ? { max: cfg.max } : {}),
            ...(typeof cfg.step === 'number' && cfg.step > 0 ? { step: cfg.step } : {}),
            ...(typeof cfg.default === 'number' && Number.isFinite(cfg.default)
              ? { default: cfg.default }
              : {}),
          },
        });
      } else if (typeStr === 'STRING') {
        inputs.push({
          name,
          type: 'STRING',
          optional,
          widget: {
            kind: 'string',
            ...(cfg.multiline === true ? { multiline: true } : {}),
            ...(typeof cfg.default === 'string' ? { default: cfg.default } : {}),
          },
        });
      } else if (typeStr === 'BOOLEAN') {
        inputs.push({
          name,
          type: 'BOOLEAN',
          optional,
          widget: {
            kind: 'boolean',
            ...(typeof cfg.default === 'boolean' ? { default: cfg.default } : {}),
          },
        });
      } else {
        inputs.push({
          name,
          type: typeStr,
          optional,
        });
      }
    }
  };

  ingestGroup(rawInput.required, false);
  ingestGroup(rawInput.optional, true);

  const outTypes = Array.isArray(raw.output) ? raw.output.map((t) => String(t)) : [];
  const outNames = Array.isArray(raw.output_name) ? raw.output_name.map((n) => String(n)) : [];
  const outLists = Array.isArray(raw.output_is_list) ? raw.output_is_list.map(Boolean) : [];

  const outputs = outTypes.map((type, i) => ({
    name: outNames[i] || type.toLowerCase() || `out_${i}`,
    type,
    isList: outLists[i] ?? false,
  }));

  return {
    displayName: typeof raw.display_name === 'string' ? raw.display_name : classType,
    category: typeof raw.category === 'string' ? raw.category : 'comfyui',
    ...(typeof raw.description === 'string' && raw.description
      ? { description: raw.description.slice(0, 1000) }
      : {}),
    inputs,
    outputs,
    outputNode: Boolean(raw.output_node),
  };
}

/** Computes clean left-to-right layered DAG coordinates for nodes missing `pos`. */
export function autoLayoutWorkflowNodes(
  nodes: Record<string, WorkflowGraphNode>,
): Record<string, WorkflowGraphNode> {
  const depthMemo = new Map<string, number>();
  const visiting = new Set<string>();

  const depthOf = (id: string): number => {
    if (depthMemo.has(id)) return depthMemo.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let maxParent = -1;
    const node = nodes[id];
    if (node) {
      for (const val of Object.values(node.inputs)) {
        if (isWorkflowLink(val) && Object.hasOwn(nodes, val.$link[0])) {
          maxParent = Math.max(maxParent, depthOf(val.$link[0]));
        }
      }
    }
    visiting.delete(id);
    const d = maxParent + 1;
    depthMemo.set(id, d);
    return d;
  };

  const columns = new Map<number, string[]>();
  for (const id of Object.keys(nodes)) {
    const col = depthOf(id);
    const list = columns.get(col) ?? [];
    list.push(id);
    columns.set(col, list);
  }

  const out: Record<string, WorkflowGraphNode> = {};
  for (const [col, ids] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    ids.forEach((id, row) => {
      const n = nodes[id];
      out[id] = {
        ...n,
        pos: n.pos ?? [60 + col * 270, 60 + row * 190],
      };
    });
  }
  return out;
}

function inferModalityFromNodes(nodes: Record<string, WorkflowGraphNode>): WorkflowModality {
  for (const n of Object.values(nodes)) {
    const ct = n.classType;
    if (
      ct === 'vmotion.VideoOut' ||
      /VideoCombine|SaveWEBM|SaveAnimatedWEBP|WanImageToVideo|WanVideo|HunyuanVideo|LTXV|AnimateDiff/i.test(
        ct,
      )
    ) {
      return 'video';
    }
    if (
      ct === 'vmotion.SpeechOut' ||
      ct === 'http.LocalModel' ||
      /SaveAudio|CosyVoice|SoVITS|IndexTTS|FishSpeech|Bark|ChatTTS|TTS/i.test(ct)
    ) {
      return 'tts';
    }
  }
  return 'image';
}

function inferPinnedInputs(
  nodes: Record<string, WorkflowGraphNode>,
): Record<string, WorkflowPinnedInput> {
  const pinned: Record<string, WorkflowPinnedInput> = {};

  // Find positive/negative CLIPTextEncode links via KSampler if available
  const positiveNodeIds = new Set<string>();
  const negativeNodeIds = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (/Sampler/i.test(node.classType)) {
      if (isWorkflowLink(node.inputs.positive)) positiveNodeIds.add(node.inputs.positive.$link[0]);
      if (isWorkflowLink(node.inputs.negative)) negativeNodeIds.add(node.inputs.negative.$link[0]);
    }
  }

  for (const [nodeId, node] of Object.entries(nodes)) {
    if (
      node.classType === 'CLIPTextEncode' &&
      typeof node.inputs.text === 'string'
    ) {
      if (negativeNodeIds.has(nodeId) && !pinned.negativePrompt) {
        pinned.negativePrompt = {
          nodeId,
          inputName: 'text',
          label: '反向提示词 (Negative)',
          type: 'string',
          default: node.inputs.text,
        };
      } else if (!pinned.prompt) {
        pinned.prompt = {
          nodeId,
          inputName: 'text',
          label: '正向提示词 (Prompt)',
          type: 'string',
          default: node.inputs.text,
        };
      }
    }
    if (/Sampler/i.test(node.classType)) {
      const seedField = typeof node.inputs.seed === 'number'
        ? 'seed'
        : typeof node.inputs.noise_seed === 'number'
          ? 'noise_seed'
          : undefined;
      if (seedField && !pinned.seed) {
        pinned.seed = {
          nodeId,
          inputName: seedField,
          label: '随机种子 (Seed)',
          type: 'seed',
          default: node.inputs[seedField] as number,
        };
      }
      if (typeof node.inputs.steps === 'number' && !pinned.steps) {
        pinned.steps = {
          nodeId,
          inputName: 'steps',
          label: '采样步数 (Steps)',
          type: 'number',
          min: 1,
          max: 150,
          default: node.inputs.steps,
        };
      }
    }
    if (node.classType === 'http.LocalModel' && typeof node.inputs.text === 'string' && !pinned.text) {
      pinned.text = {
        nodeId,
        inputName: 'text',
        label: '合成台词文本',
        type: 'string',
        default: node.inputs.text,
      };
    }
  }
  return pinned;
}

function synthesizeFallbackSignatures(
  nodes: Record<string, WorkflowGraphNode>,
  knownSpecs: Record<string, WorkflowNodeSignature>,
): Record<string, WorkflowNodeSignature> {
  const sigs: Record<string, WorkflowNodeSignature> = {};
  const outSlotMax = new Map<string, number>();

  for (const node of Object.values(nodes)) {
    for (const val of Object.values(node.inputs)) {
      if (!isWorkflowLink(val)) continue;
      const [upId, slot] = val.$link;
      const upNode = nodes[upId];
      if (!upNode) continue;
      outSlotMax.set(upNode.classType, Math.max(outSlotMax.get(upNode.classType) ?? -1, slot));
    }
  }

  for (const node of Object.values(nodes)) {
    const ct = node.classType;
    if (sigs[ct]) continue;
    if (VMOTION_BRIDGE_SPECS[ct]) {
      sigs[ct] = VMOTION_BRIDGE_SPECS[ct];
      continue;
    }
    if (knownSpecs[ct]) {
      sigs[ct] = knownSpecs[ct];
      continue;
    }
    const inputs: WorkflowPortSpec[] = Object.entries(node.inputs).map(([name, val]) => {
      if (isWorkflowLink(val)) {
        return { name, type: 'ANY', optional: false };
      }
      if (typeof val === 'number') {
        const isInt = Number.isInteger(val);
        return {
          name,
          type: isInt ? 'INT' : 'FLOAT',
          optional: false,
          widget: { kind: isInt ? 'int' : 'float', default: val },
        };
      }
      if (typeof val === 'boolean') {
        return { name, type: 'BOOLEAN', optional: false, widget: { kind: 'boolean', default: val } };
      }
      return {
        name,
        type: 'STRING',
        optional: false,
        widget: { kind: 'string', default: typeof val === 'string' ? val : JSON.stringify(val) },
      };
    });
    const maxSlot = outSlotMax.get(ct) ?? -1;
    const outputs = Array.from({ length: maxSlot + 1 }, (_, i) => ({
      name: `output_${i}`,
      type: 'ANY',
      isList: false,
    }));
    sigs[ct] = {
      displayName: ct,
      category: 'imported',
      inputs,
      outputs,
      outputNode: maxSlot < 0 && /Save|Preview|Out/i.test(ct),
    };
  }
  return sigs;
}

export interface WorkflowImportOptions {
  id?: string;
  name?: string;
  modality?: WorkflowModality;
  objectInfo?: Record<string, WorkflowNodeSignature>;
}

/**
 * Imports a ComfyUI API-format JSON (`workflow_api.json`) into a Vmotion `GenerativeWorkflow`.
 */
export function importComfyApiWorkflow(
  rawApi: Record<string, unknown>,
  options: WorkflowImportOptions = {},
): GenerativeWorkflow {
  const safeId = workflowIdSchema.parse(options.id ?? 'imported-workflow');
  const rawNodeIds = new Set(Object.keys(rawApi));
  const nodes: Record<string, WorkflowGraphNode> = {};

  for (const [nodeId, rawEntry] of Object.entries(rawApi)) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
    const entry = rawEntry as Record<string, unknown>;
    const classType = typeof entry.class_type === 'string' ? entry.class_type : undefined;
    if (!classType) continue;

    const rawInputs =
      entry.inputs && typeof entry.inputs === 'object' && !Array.isArray(entry.inputs)
        ? (entry.inputs as Record<string, unknown>)
        : {};
    const inputs: Record<string, WorkflowInputValue> = {};

    for (const [inName, inVal] of Object.entries(rawInputs)) {
      if (
        Array.isArray(inVal) &&
        inVal.length === 2 &&
        (typeof inVal[0] === 'string' || typeof inVal[0] === 'number') &&
        typeof inVal[1] === 'number' &&
        rawNodeIds.has(String(inVal[0]))
      ) {
        inputs[inName] = { $link: [String(inVal[0]), Math.max(0, Math.trunc(inVal[1]))] };
      } else if (
        typeof inVal === 'string' ||
        (typeof inVal === 'number' && Number.isFinite(inVal)) ||
        typeof inVal === 'boolean' ||
        inVal === null
      ) {
        inputs[inName] = inVal;
      } else if (Array.isArray(inVal)) {
        inputs[inName] = inVal.map((x) =>
          typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean' || x === null
            ? x
            : String(x),
        );
      }
    }

    const meta =
      entry._meta && typeof entry._meta === 'object'
        ? (entry._meta as { title?: unknown })
        : undefined;
    nodes[String(nodeId)] = {
      classType,
      ...(typeof meta?.title === 'string' && meta.title ? { title: meta.title } : {}),
      bypass: false,
      mute: false,
      inputs,
    };
  }

  const laidOut = autoLayoutWorkflowNodes(nodes);
  const modality = options.modality ?? inferModalityFromNodes(laidOut);
  const pinnedInputs = inferPinnedInputs(laidOut);
  const portSignatures = synthesizeFallbackSignatures(laidOut, options.objectInfo ?? {});

  return generativeWorkflowSchema.parse({
    kind: 'generative-workflow',
    version: 1,
    id: safeId,
    name: options.name ?? safeId,
    modality,
    provider: laidOut && Object.values(laidOut).some((n) => n.classType === 'http.LocalModel')
      ? 'http-local'
      : Object.values(laidOut).some((n) => n.classType === 'inbox.AgentGen')
        ? 'agent-inbox'
        : 'comfyui',
    pinnedInputs,
    nodes: laidOut,
    portSignatures,
  });
}

/**
 * Imports a ComfyUI Web UI JSON (`workflow.json` containing `nodes: [...]` & `links: [...]`),
 * resolving `Reroute` pass-throughs, `PrimitiveNode` constants, `[x, y]` positions and `widgets_values`.
 */
export function importComfyWebWorkflow(
  rawWeb: Record<string, unknown>,
  options: WorkflowImportOptions = {},
): GenerativeWorkflow {
  const safeId = workflowIdSchema.parse(options.id ?? 'imported-web-workflow');
  const webNodes = Array.isArray(rawWeb.nodes) ? (rawWeb.nodes as Array<Record<string, unknown>>) : [];
  const webLinks = Array.isArray(rawWeb.links) ? (rawWeb.links as Array<unknown[]>) : [];

  // linkId -> { originId, originSlot, targetId, targetSlot, type }
  const linkById = new Map<
    number,
    { originId: string; originSlot: number; targetId: string; targetSlot: number; type: string }
  >();
  for (const row of webLinks) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const linkId = Number(row[0]);
    if (!Number.isFinite(linkId)) continue;
    linkById.set(linkId, {
      originId: String(row[1]),
      originSlot: Number(row[2]) || 0,
      targetId: String(row[3]),
      targetSlot: Number(row[4]) || 0,
      type: typeof row[5] === 'string' ? row[5] : 'ANY',
    });
  }

  const webNodeById = new Map<string, Record<string, unknown>>();
  for (const wn of webNodes) {
    if (wn && wn.id !== undefined) webNodeById.set(String(wn.id), wn);
  }

  // Follow Reroute chains upstream
  const resolveOrigin = (
    linkId: number,
    seen = new Set<number>(),
  ): { kind: 'link'; nodeId: string; slot: number } | { kind: 'primitive'; value: WorkflowInputValue } | null => {
    if (seen.has(linkId)) return null;
    seen.add(linkId);
    const link = linkById.get(linkId);
    if (!link) return null;
    const srcNode = webNodeById.get(link.originId);
    if (!srcNode) return null;
    const srcType = String(srcNode.type ?? '');
    if (srcType === 'Reroute') {
      const inArr = Array.isArray(srcNode.inputs) ? (srcNode.inputs as Array<Record<string, unknown>>) : [];
      const upLink = Number(inArr[0]?.link);
      return Number.isFinite(upLink) ? resolveOrigin(upLink, seen) : null;
    }
    if (srcType === 'PrimitiveNode') {
      const wv = Array.isArray(srcNode.widgets_values) ? srcNode.widgets_values[0] : undefined;
      if (
        typeof wv === 'string' ||
        (typeof wv === 'number' && Number.isFinite(wv)) ||
        typeof wv === 'boolean' ||
        wv === null
      ) {
        return { kind: 'primitive', value: wv };
      }
      return null;
    }
    return { kind: 'link', nodeId: link.originId, slot: link.originSlot };
  };

  const nodes: Record<string, WorkflowGraphNode> = {};
  const webSignatures: Record<string, WorkflowNodeSignature> = { ...(options.objectInfo ?? {}) };

  for (const wn of webNodes) {
    const nodeId = String(wn.id ?? '');
    const classType = String(wn.type ?? '');
    if (!nodeId || !classType || classType === 'Reroute' || classType === 'PrimitiveNode' || classType === 'Note') {
      continue;
    }

    const posArr = Array.isArray(wn.pos)
      ? wn.pos
      : wn.pos && typeof wn.pos === 'object'
        ? [(wn.pos as Record<string, unknown>)['0'], (wn.pos as Record<string, unknown>)['1']]
        : undefined;
    const pos: [number, number] | undefined =
      Array.isArray(posArr) &&
      typeof posArr[0] === 'number' &&
      typeof posArr[1] === 'number' &&
      Number.isFinite(posArr[0]) &&
      Number.isFinite(posArr[1])
        ? [Math.round(posArr[0]), Math.round(posArr[1])]
        : undefined;

    const mode = Number(wn.mode ?? 0);
    const mute = mode === 2;
    const bypass = mode === 4;

    const inputs: Record<string, WorkflowInputValue> = {};
    const linkedInputNames = new Set<string>();
    const wnInputs = Array.isArray(wn.inputs)
      ? (wn.inputs as Array<Record<string, unknown>>)
      : [];

    for (const slot of wnInputs) {
      const inName = typeof slot.name === 'string' ? slot.name : '';
      if (!inName) continue;
      if (slot.link !== null && slot.link !== undefined) {
        const resolved = resolveOrigin(Number(slot.link));
        if (resolved?.kind === 'link') {
          inputs[inName] = { $link: [resolved.nodeId, resolved.slot] };
          linkedInputNames.add(inName);
        } else if (resolved?.kind === 'primitive') {
          inputs[inName] = resolved.value;
          linkedInputNames.add(inName);
        }
      }
    }

    // Map widgets_values using known signature if available, else unlinked widget slots
    const widgetsValues = Array.isArray(wn.widgets_values) ? wn.widgets_values : [];
    const knownSig = webSignatures[classType] ?? VMOTION_BRIDGE_SPECS[classType];
    const widgetNames: string[] = knownSig
      ? knownSig.inputs.filter((p) => Boolean(p.widget)).map((p) => p.name)
      : wnInputs
          .filter((s) => s.widget !== undefined && typeof s.name === 'string')
          .map((s) => String(s.name));

    let wCursor = 0;
    for (const wName of widgetNames) {
      if (wCursor >= widgetsValues.length) break;
      const rawVal = widgetsValues[wCursor++];
      // ComfyUI web workflows insert an extra control_after_generate value ('randomize'|'fixed'|'increment'|'decrement') right after seed/noise_seed!
      if (
        (wName === 'seed' || wName === 'noise_seed') &&
        wCursor < widgetsValues.length &&
        typeof widgetsValues[wCursor] === 'string' &&
        ['fixed', 'increment', 'decrement', 'randomize'].includes(String(widgetsValues[wCursor]))
      ) {
        wCursor++;
      }
      if (linkedInputNames.has(wName)) continue;
      if (
        typeof rawVal === 'string' ||
        (typeof rawVal === 'number' && Number.isFinite(rawVal)) ||
        typeof rawVal === 'boolean' ||
        rawVal === null
      ) {
        inputs[wName] = rawVal;
      }
    }

    // Build port signature from Web UI node ports if not already known
    if (!webSignatures[classType] && !VMOTION_BRIDGE_SPECS[classType]) {
      const wnOutputs = Array.isArray(wn.outputs)
        ? (wn.outputs as Array<Record<string, unknown>>)
        : [];
      webSignatures[classType] = {
        displayName: typeof wn.title === 'string' && wn.title ? wn.title : classType,
        category: 'comfyui',
        inputs: wnInputs
          .filter((s) => typeof s.name === 'string')
          .map((s) => ({
            name: String(s.name),
            type: typeof s.type === 'string' ? s.type : 'ANY',
            optional: false,
          })),
        outputs: wnOutputs.map((o, idx) => ({
          name: typeof o.name === 'string' ? o.name : `out_${idx}`,
          type: typeof o.type === 'string' ? o.type : 'ANY',
          isList: false,
        })),
        outputNode: wnOutputs.length === 0,
      };
    }

    nodes[nodeId] = {
      classType,
      ...(typeof wn.title === 'string' && wn.title ? { title: wn.title } : {}),
      ...(pos ? { pos } : {}),
      bypass,
      mute,
      inputs,
    };
  }

  const laidOut = autoLayoutWorkflowNodes(nodes);
  const modality = options.modality ?? inferModalityFromNodes(laidOut);
  const pinnedInputs = inferPinnedInputs(laidOut);
  const portSignatures = synthesizeFallbackSignatures(laidOut, webSignatures);

  return generativeWorkflowSchema.parse({
    kind: 'generative-workflow',
    version: 1,
    id: safeId,
    name: options.name ?? safeId,
    modality,
    provider: 'comfyui',
    pinnedInputs,
    nodes: laidOut,
    portSignatures,
  });
}

/**
 * Extracts embedded ComfyUI `prompt` (API) and/or `workflow` (Web UI) metadata from PNG chunks
 * (`tEXt`, `zTXt`, `iTXt`). When both exist, combines API's exact named inputs with Web UI's `[x, y]` layout!
 */
export function extractComfyWorkflowFromPng(
  pngBytes: Uint8Array,
  options: WorkflowImportOptions = {},
): GenerativeWorkflow {
  if (
    pngBytes.length < 24 ||
    PNG_MAGIC.some((b, idx) => pngBytes[idx] !== b)
  ) {
    throw new Error('Invalid PNG file signature');
  }

  const view = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
  const utf8 = new TextDecoder('utf-8');
  const latin1 = new TextDecoder('latin1');
  const chunks = new Map<string, string>();

  let offset = 8;
  while (offset + 8 <= pngBytes.length) {
    const length = view.getUint32(offset, false);
    const type = latin1.decode(pngBytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > pngBytes.length) break;
    const payload = pngBytes.subarray(dataStart, dataEnd);

    if (type === 'tEXt') {
      const nul = payload.indexOf(0);
      if (nul > 0) {
        const keyword = latin1.decode(payload.subarray(0, nul));
        const text = utf8.decode(payload.subarray(nul + 1));
        chunks.set(keyword, text);
      }
    } else if (type === 'zTXt') {
      const nul = payload.indexOf(0);
      if (nul > 0 && nul + 2 <= payload.length) {
        const keyword = latin1.decode(payload.subarray(0, nul));
        const decompressed = unzlibSync(payload.subarray(nul + 2));
        chunks.set(keyword, utf8.decode(decompressed));
      }
    } else if (type === 'iTXt') {
      const nul1 = payload.indexOf(0);
      if (nul1 > 0 && nul1 + 3 <= payload.length) {
        const keyword = latin1.decode(payload.subarray(0, nul1));
        const compFlag = payload[nul1 + 1];
        // Skip language tag & translated keyword
        let p = nul1 + 3;
        while (p < payload.length && payload[p] !== 0) p++;
        p++;
        while (p < payload.length && payload[p] !== 0) p++;
        p++;
        if (p <= payload.length) {
          const textBytes =
            compFlag === 1 ? unzlibSync(payload.subarray(p)) : payload.subarray(p);
          chunks.set(keyword, utf8.decode(textBytes));
        }
      }
    }

    offset = dataEnd + 4; // skip CRC
    if (type === 'IEND') break;
  }

  const promptJsonStr = chunks.get('prompt');
  const webJsonStr = chunks.get('workflow');

  if (!promptJsonStr && !webJsonStr) {
    throw new Error('PNG does not contain ComfyUI "prompt" or "workflow" metadata chunks');
  }

  if (promptJsonStr) {
    const apiDoc = importComfyApiWorkflow(JSON.parse(promptJsonStr), options);
    if (webJsonStr) {
      try {
        const webDoc = importComfyWebWorkflow(JSON.parse(webJsonStr), options);
        // Enrich API nodes with Web UI coordinates, titles and richer port signatures
        for (const [id, apiNode] of Object.entries(apiDoc.nodes)) {
          const webNode = webDoc.nodes[id];
          if (webNode?.pos) apiNode.pos = webNode.pos;
          if (webNode?.title && !apiNode.title) apiNode.title = webNode.title;
        }
        for (const [ct, sig] of Object.entries(webDoc.portSignatures)) {
          apiDoc.portSignatures[ct] = sig;
        }
      } catch {
        // Keep exact API import if optional web UI layout chunk is malformed
      }
    }
    return generativeWorkflowSchema.parse(apiDoc);
  }

  return importComfyWebWorkflow(JSON.parse(webJsonStr!), options);
}

/** Auto-detects whether a parsed JSON object is already a Vmotion `.workflow.json`, ComfyUI Web JSON, or ComfyUI API JSON. */
export function importAnyWorkflowJson(
  raw: Record<string, unknown>,
  options: WorkflowImportOptions = {},
): GenerativeWorkflow {
  if (raw.kind === 'generative-workflow') {
    return generativeWorkflowSchema.parse({
      ...raw,
      ...(options.id ? { id: options.id } : {}),
      ...(options.name ? { name: options.name } : {}),
    });
  }
  if (Array.isArray(raw.nodes) && Array.isArray(raw.links)) {
    return importComfyWebWorkflow(raw, options);
  }
  return importComfyApiWorkflow(raw, options);
}

export interface BridgeRuntimeValues {
  /** Uploaded filenames on ComfyUI (by nodeId) for `CanvasFrame`, `InpaintMask`, `AssetInput`, `ShotContext`. */
  uploadedFiles?: Record<
    string,
    {
      image?: string;
      mask?: string;
      audio?: string;
      prevEndImage?: string;
      nextStartImage?: string;
    }
  >;
  projectWidth?: number;
  projectHeight?: number;
  projectFps?: number;
  shotAlignedFrames4n1?: number;
  shotDurationSeconds?: number;
  scriptText?: string;
}

/**
 * Compiles a Vmotion `GenerativeWorkflow` (plus `params` overrides & `BridgeRuntimeValues`)
 * into a standard ComfyUI `POST /prompt` API dictionary.
 */
export function compileWorkflowToComfyApi(
  workflow: GenerativeWorkflow,
  options: {
    params?: Record<string, WorkflowInputValue>;
    seedOverride?: number;
    bridge?: BridgeRuntimeValues;
  } = {},
): {
  apiPrompt: Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } }>;
  effectiveParams: Record<string, WorkflowInputValue>;
  effectiveSeed?: number;
} {
  const workingNodes = structuredClone(workflow.nodes);
  const effectiveParams: Record<string, WorkflowInputValue> = {};

  for (const [pinKey, pin] of Object.entries(workflow.pinnedInputs)) {
    const target = workingNodes[pin.nodeId];
    if (!target) continue;
    const override = options.params?.[pinKey];
    if (override !== undefined) {
      target.inputs[pin.inputName] = override;
      effectiveParams[pinKey] = override;
    } else if (target.inputs[pin.inputName] !== undefined) {
      effectiveParams[pinKey] = target.inputs[pin.inputName];
    }
  }

  let effectiveSeed: number | undefined = options.seedOverride;
  if (options.seedOverride !== undefined) {
    for (const node of Object.values(workingNodes)) {
      if (typeof node.inputs.seed === 'number') node.inputs.seed = options.seedOverride;
      if (typeof node.inputs.noise_seed === 'number') node.inputs.noise_seed = options.seedOverride;
    }
  } else {
    for (const node of Object.values(workingNodes)) {
      if (typeof node.inputs.seed === 'number') {
        effectiveSeed = node.inputs.seed;
        break;
      }
      if (typeof node.inputs.noise_seed === 'number') {
        effectiveSeed = node.inputs.noise_seed;
        break;
      }
    }
  }

  const bridge = options.bridge ?? {};
  const apiPrompt: Record<
    string,
    { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } }
  > = {};

  // Helper to resolve links targeting scalar-emitting bridge nodes (`ProjectSpec`, `ScriptText`, `ShotContext`)
  const resolveInput = (val: WorkflowInputValue): unknown => {
    if (!isWorkflowLink(val)) return val;
    const [srcId, slot] = val.$link;
    const srcNode = workingNodes[srcId];
    if (!srcNode) return [srcId, slot];

    if (srcNode.classType === 'vmotion.ProjectSpec') {
      if (slot === 0) return bridge.projectWidth ?? 1920;
      if (slot === 1) return bridge.projectHeight ?? 1080;
      if (slot === 2) return bridge.projectFps ?? 30;
    }
    if (srcNode.classType === 'vmotion.ScriptText') {
      const fallback =
        typeof srcNode.inputs.fallbackText === 'string' ? srcNode.inputs.fallbackText : '';
      return bridge.scriptText || fallback;
    }
    if (srcNode.classType === 'vmotion.ShotContext') {
      if (slot === 0) return [`${srcId}__prev`, 0];
      if (slot === 1) return [`${srcId}__next`, 0];
      if (slot === 2) return bridge.shotAlignedFrames4n1 ?? 81;
      if (slot === 3) return bridge.shotDurationSeconds ?? 3;
      if (slot === 4) return bridge.projectWidth ?? 1920;
      if (slot === 5) return bridge.projectHeight ?? 1080;
    }
    if (srcNode.classType === 'vmotion.InpaintMask') {
      // ComfyUI `LoadImage` outputs: slot 0 = IMAGE, slot 1 = MASK!
      // Whereas `vmotion.InpaintMask` outputs: slot 0 = MASK, slot 1 = IMAGE!
      return [srcId, slot === 0 ? 1 : 0];
    }
    return [srcId, slot];
  };

  for (const [nodeId, node] of Object.entries(workingNodes)) {
    if (node.mute || node.bypass) continue;

    if (
      node.classType === 'vmotion.ProjectSpec' ||
      node.classType === 'vmotion.ScriptText' ||
      node.classType === 'http.LocalModel' ||
      node.classType === 'inbox.AgentGen'
    ) {
      continue;
    }

    if (node.classType === 'vmotion.CanvasFrame') {
      const uploaded = bridge.uploadedFiles?.[nodeId]?.image ?? 'vmotion_canvas_frame.png';
      apiPrompt[nodeId] = {
        class_type: 'LoadImage',
        inputs: { image: uploaded },
        _meta: { title: node.title ?? 'Vmotion CanvasFrame' },
      };
      continue;
    }

    if (node.classType === 'vmotion.InpaintMask') {
      const uploaded = bridge.uploadedFiles?.[nodeId]?.mask ?? 'vmotion_inpaint_mask.png';
      apiPrompt[nodeId] = {
        class_type: 'LoadImage',
        inputs: { image: uploaded },
        _meta: { title: node.title ?? 'Vmotion InpaintMask' },
      };
      continue;
    }

    if (node.classType === 'vmotion.AssetInput') {
      const up = bridge.uploadedFiles?.[nodeId];
      if (up?.audio && !up.image) {
        apiPrompt[nodeId] = {
          class_type: 'LoadAudio',
          inputs: { audio: up.audio },
          _meta: { title: node.title ?? 'Vmotion AssetInput' },
        };
      } else {
        apiPrompt[nodeId] = {
          class_type: 'LoadImage',
          inputs: { image: up?.image ?? String(node.inputs.assetId ?? 'asset.png') },
          _meta: { title: node.title ?? 'Vmotion AssetInput' },
        };
      }
      continue;
    }

    if (node.classType === 'vmotion.ShotContext') {
      const up = bridge.uploadedFiles?.[nodeId];
      if (up?.prevEndImage) {
        apiPrompt[`${nodeId}__prev`] = {
          class_type: 'LoadImage',
          inputs: { image: up.prevEndImage },
          _meta: { title: 'Vmotion Prev Shot End Frame' },
        };
      }
      if (up?.nextStartImage) {
        apiPrompt[`${nodeId}__next`] = {
          class_type: 'LoadImage',
          inputs: { image: up.nextStartImage },
          _meta: { title: 'Vmotion Next Shot Start Frame' },
        };
      }
      continue;
    }

    if (node.classType === 'vmotion.ImageOut') {
      apiPrompt[nodeId] = {
        class_type: 'SaveImage',
        inputs: {
          images: resolveInput(node.inputs.images),
          filename_prefix:
            typeof node.inputs.prefix === 'string' && node.inputs.prefix
              ? node.inputs.prefix
              : 'vmotion_img',
        },
        _meta: { title: node.title ?? 'Vmotion ImageOut' },
      };
      continue;
    }

    if (node.classType === 'vmotion.VideoOut') {
      apiPrompt[nodeId] = {
        class_type: 'SaveWEBM',
        inputs: {
          images: resolveInput(node.inputs.images),
          filename_prefix: 'vmotion_vid',
          codec: 'vp9',
          fps: typeof node.inputs.fps === 'number' ? node.inputs.fps : (bridge.projectFps ?? 24),
          crf: 24,
        },
        _meta: { title: node.title ?? 'Vmotion VideoOut' },
      };
      continue;
    }

    if (node.classType === 'vmotion.SpeechOut') {
      apiPrompt[nodeId] = {
        class_type: 'SaveAudio',
        inputs: {
          audio: resolveInput(node.inputs.audio),
          filename_prefix: 'vmotion_tts',
        },
        _meta: { title: node.title ?? 'Vmotion SpeechOut' },
      };
      continue;
    }

    const compiledInputs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.inputs)) {
      compiledInputs[k] = resolveInput(v);
    }
    apiPrompt[nodeId] = {
      class_type: node.classType,
      inputs: compiledInputs,
      ...(node.title ? { _meta: { title: node.title } } : {}),
    };
  }

  return {
    apiPrompt,
    effectiveParams,
    ...(effectiveSeed !== undefined ? { effectiveSeed } : {}),
  };
}
