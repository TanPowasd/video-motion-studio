import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  CreateMessageRequestParams,
  CreateMessageResult,
  CreateMessageResultWithTools,
  SamplingMessage,
  ToolResultContent,
  ToolUseContent,
} from '@modelcontextprotocol/sdk/types.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { INBOX_DIR, type InboxRequest } from '../core/inbox-model.js';
import type { FileEdit } from '../core/file-edits.js';
import { VmotionError } from '../core/model.js';
import { safePath } from '../platform/project-files.js';
import type { ToolDefinition } from './catalog.js';
import { metaToolDescriptions, metaToolSchemas } from './discovery.js';

export type SamplingExecutionOutcome =
  | { outcome: 'completed' }
  | { outcome: 'aborted' }
  | { outcome: 'requeue'; note: string; unsupported?: boolean };

export interface SamplingToolResult {
  value: unknown;
  text: string;
  isError?: boolean;
}

export interface RunSamplingOptions {
  mode: 'tools' | 'basic';
  request: InboxRequest;
  root: string;
  definitions: readonly ToolDefinition[];
  createMessage: (
    params: CreateMessageRequestParams,
    options?: RequestOptions,
  ) => Promise<CreateMessageResult | CreateMessageResultWithTools>;
  callCapability: (name: string, args: Record<string, unknown>) => Promise<SamplingToolResult>;
  waitForReply: (requestId: string, signal: AbortSignal) => Promise<InboxRequest>;
  signal: AbortSignal;
  maxToolTurns?: number;
  maxDiagnosticRetries?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

const DIRECT_SAMPLING_CAPABILITIES = [
  'project_file_read',
  'project_preflight',
  'project_apply',
  'inbox_ask',
  'inbox_done',
] as const;

/**
 * Inbox tools a pushed sampling loop must not reach: they would claim (inbox_wait/inbox_claim)
 * another pending request that no runner owns, leaving it stuck in claimed.
 */
const SAMPLING_BLOCKED_CAPABILITIES = new Set(['inbox_wait', 'inbox_claim']);
const blockedResult = (name: string): SamplingToolResult => {
  const value = {
    code: 'SAMPLING_TOOL_BLOCKED',
    message: `${name} is not available inside a pushed canvas request; finish this request with inbox_done`,
  };
  return { value, text: JSON.stringify(value), isError: true };
};

const TOOLS_SYSTEM_PROMPT = [
  'You are fulfilling a Vmotion Studio canvas instruction (画布指令) pushed over MCP sampling.',
  'Rules:',
  '1. Keep existing node/element IDs stable unless asked to add or remove elements.',
  '2. SDK components must remain deterministic: derive animation from supplied frame/fps clocks and seeded randomness (never Date.now() or Math.random()).',
  '3. If the instruction is ambiguous, call inbox_ask {id, question, options?, fields?} — the structured form is shown inside Vmotion Studio and returns the human reply directly.',
  '4. Validate edits with project_preflight before committing with project_apply (using files text/replace edits with expectedHash, or scene operations, or a planner planId via tool_call).',
  '5. Finish by calling inbox_done {id, summary, changedFiles?}.',
].join('\n');

const BASIC_SYSTEM_PROMPT = [
  'You are fulfilling a Vmotion Studio canvas instruction (画布指令) pushed over MCP sampling.',
  'Reply with ONE valid JSON object only (no prose outside JSON), in one of two shapes:',
  '1) Clarify with the person in Vmotion Studio:',
  '   {"action":"ask","question":"...","options":["choice A","choice B"],"fields":[{"id":"key","label":"...","kind":"select|multiselect|text|number|boolean","options":["..."]}]}',
  '2) Propose validated project edits:',
  '   {"action":"edit","summary":"short Chinese summary","files":[{"path":"components/example.tsx","replacements":[{"before":"exact old text","after":"new text"}]}],"operations":[]}',
  'Rules:',
  '- Keep existing element/node IDs unchanged.',
  '- Never use Date.now() or Math.random() in components; derive motion from frame/fps.',
  '- Prefer minimal `replacements` on `.tsx` files or `updateNode` scene operations (`{"type":"updateNode","sceneId":"...","nodeId":"...","patch":{...}}`).',
].join('\n');

function buildSamplingTools(definitions: readonly ToolDefinition[]) {
  const byName = new Map(definitions.map((d) => [d.name, d] as const));
  const out: NonNullable<CreateMessageRequestParams['tools']> = [];
  const toInputSchema = (shape: z.ZodRawShape) => {
    const raw = zodToJsonSchema(z.object(shape).strict(), {
      $refStrategy: 'none',
    }) as Record<string, unknown>;
    const { $schema: _s, ...rest } = raw;
    return {
      ...rest,
      type: 'object' as const,
      ...(rest.properties && typeof rest.properties === 'object'
        ? { properties: rest.properties as Record<string, object> }
        : { properties: {} }),
    };
  };
  for (const name of DIRECT_SAMPLING_CAPABILITIES) {
    const def = byName.get(name);
    if (!def) continue;
    out.push({
      name: def.name,
      description: def.description.split(/\.\s/)[0].slice(0, 220),
      inputSchema: toInputSchema(def.schema),
    });
  }
  for (const meta of ['tools_search', 'tool_schema', 'tool_call'] as const) {
    out.push({
      name: meta,
      description: metaToolDescriptions[meta].split(/\.\s/)[0].slice(0, 220),
      inputSchema: toInputSchema(metaToolSchemas[meta].shape),
    });
  }
  return out;
}

async function buildInitialUserContent(
  request: InboxRequest,
  root: string,
  callCapability: RunSamplingOptions['callCapability'],
): Promise<SamplingMessage['content']> {
  const c = request.context,
    lines: string[] = [];
  lines.push(`# Vmotion 画布指令 ${request.id}`);
  lines.push(`请求内容：${request.text}`);
  lines.push(
    `工程：${c.project.name} (${c.project.width}x${c.project.height}, ${c.fps} fps, revision=${c.revision})`,
  );
  if (c.sceneId)
    lines.push(`场景：${c.sceneName ? `${c.sceneName} ` : ''}${c.sceneId} (scenes/${c.sceneId}.json)`);
  if (c.sequenceId) lines.push(`序列：${c.sequenceId}`);
  if (c.path?.length) lines.push(`聚焦路径：${c.path.join(' / ')}`);
  lines.push(
    `当前帧：${c.frame} (${c.seconds}s)${c.range ? ` · 指定范围：${c.range.start}–${c.range.end} 帧` : ''}`,
  );
  if (c.selection.length) {
    lines.push('');
    lines.push(`## 选中对象 (${c.selection.length})`);
    for (const n of c.selection) {
      lines.push(`- id=${JSON.stringify(n.id)} type=${n.type}${n.name ? ` name=${JSON.stringify(n.name)}` : ''}`);
      if (n.owner)
        lines.push(
          `  owner=${JSON.stringify(n.owner.nodeId)}${n.owner.component ? ` component=${n.owner.component}` : ''}${n.localId ? ` localId=${JSON.stringify(n.localId)}` : ''}`,
        );
      if (n.source)
        lines.push(
          `  source=${n.source.file}${n.source.line ? `:${n.source.line}${n.source.endLine ? `-${n.source.endLine}` : ''}` : ''}${n.source.note ? ` (${n.source.note})` : ''}`,
        );
      if (n.bounds) lines.push(`  bounds=${JSON.stringify(n.bounds)}`);
      if (Object.keys(n.props).length) lines.push(`  props=${JSON.stringify(n.props)}`);
    }
  } else {
    lines.push('选中对象：无（针对当前整个场景画面）');
  }

  // Pre-attach bounded source snippets + sha256 hashes for directly referenced files.
  const targets = new Map<string, { startLine: number; endLine: number }>();
  for (const n of c.selection) {
    const src = n.source;
    if (!src?.file) continue;
    const start = src.line ? Math.max(1, src.line - 25) : 1,
      end = src.endLine ? src.endLine + 35 : src.line ? src.line + 45 : 160,
      prev = targets.get(src.file);
    targets.set(
      src.file,
      prev
        ? { startLine: Math.min(prev.startLine, start), endLine: Math.max(prev.endLine, end) }
        : { startLine: start, endLine: Math.min(start + 220, end) },
    );
  }
  if (!targets.size && c.sceneId) targets.set(`scenes/${c.sceneId}.json`, { startLine: 1, endLine: 160 });

  for (const [file, range] of [...targets.entries()].slice(0, 4)) {
    try {
      const lineCount = Math.max(1, Math.min(220, range.endLine - range.startLine + 1));
      const read = await callCapability('project_file_read', {
        path: file,
        startLine: range.startLine,
        lineCount,
      });
      if (!read.isError && read.value && typeof read.value === 'object') {
        const info = read.value as {
          hash?: string;
          totalLines?: number;
          startLine?: number;
          endLine?: number;
          content?: string;
        };
        if (typeof info.content === 'string') {
          lines.push('');
          lines.push(
            `## 文件片段：${file} (lines ${info.startLine ?? range.startLine}..${info.endLine ?? range.endLine} of ${info.totalLines ?? '?'}${info.hash ? `, expectedHash=${info.hash}` : ''})`,
          );
          lines.push('```');
          lines.push(info.content);
          lines.push('```');
        }
      }
    } catch {
      /* optional context snippet */
    }
  }

  const textBlock = { type: 'text' as const, text: lines.join('\n') };
  if (!c.snapshot) return [textBlock];
  try {
    const png = await readFile(safePath(root, `${INBOX_DIR}/${c.snapshot}`));
    return [
      textBlock,
      {
        type: 'image' as const,
        mimeType: 'image/png',
        data: png.toString('base64'),
      },
    ];
  } catch {
    return [textBlock];
  }
}

function asArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

function extractText(content: CreateMessageResult['content'] | CreateMessageResultWithTools['content']): string {
  return asArray(content)
    .filter((b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export function extractJsonCandidate(raw: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidates = fenced ? [fenced[1].trim(), raw.trim()] : [raw.trim()];
  for (const text of candidates) {
    const first = text.indexOf('{'),
      last = text.lastIndexOf('}');
    if (first < 0 || last <= first) continue;
    try {
      const parsed = JSON.parse(text.slice(first, last + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

async function normalizeCandidateFiles(
  rawFiles: unknown[],
  callCapability: RunSamplingOptions['callCapability'],
): Promise<FileEdit[]> {
  const out: FileEdit[] = [];
  for (const item of rawFiles) {
    if (!item || typeof item !== 'object')
      throw new VmotionError('TOOL_ARGUMENTS', 'Each files[] item must be an object');
    const entry = item as Record<string, unknown>,
      filePath = typeof entry.path === 'string' ? entry.path.trim() : '';
    if (!filePath) throw new VmotionError('TOOL_ARGUMENTS', 'files[].path is required');

    let hash: string | null =
      typeof entry.expectedHash === 'string' && /^[a-f0-9]{64}$/.test(entry.expectedHash)
        ? entry.expectedHash
        : null;
    if (!hash && entry.expectedHash !== null) {
      const read = await callCapability('project_file_read', {
        path: filePath,
        startLine: 1,
        lineCount: 1,
      });
      if (!read.isError && read.value && typeof read.value === 'object') {
        const h = (read.value as { hash?: unknown }).hash;
        if (typeof h === 'string' && /^[a-f0-9]{64}$/.test(h)) hash = h;
      }
    }

    if (entry.type === 'delete') {
      if (!hash) throw new VmotionError('NOT_FOUND', `Cannot delete missing file ${filePath}`);
      out.push({ type: 'delete', path: filePath, expectedHash: hash });
      continue;
    }
    if (Array.isArray(entry.replacements)) {
      if (!hash)
        throw new VmotionError('NOT_FOUND', `Cannot apply text replacements to missing file ${filePath}`);
      out.push({
        type: 'text',
        path: filePath,
        expectedHash: hash,
        replacements: entry.replacements as Array<{ before: string; after: string }>,
      });
      continue;
    }
    if (typeof entry.content === 'string') {
      out.push({
        type: 'replace',
        path: filePath,
        content: entry.content,
        expectedHash: hash,
      });
      continue;
    }
    throw new VmotionError(
      'TOOL_ARGUMENTS',
      `files[] item for ${filePath} must specify replacements or content`,
    );
  }
  return out;
}

function formatReplyPayload(updated: InboxRequest) {
  const lastReply = [...updated.thread].reverse().find((m) => m.kind === 'reply');
  return {
    id: updated.id,
    status: updated.status,
    answered: Boolean(lastReply),
    reply: lastReply?.text ?? '',
    ...(lastReply?.answers ? { answers: lastReply.answers } : {}),
    ...(lastReply?.skipped ? { skipped: true } : {}),
  };
}

function summarizeDiagnostics(value: unknown, fallbackText: string): string {
  if (value && typeof value === 'object') {
    const v = value as { diagnostics?: unknown[]; message?: string; details?: unknown };
    if (Array.isArray(v.diagnostics) && v.diagnostics.length) {
      return JSON.stringify(v.diagnostics.slice(0, 12));
    }
    if (v.details !== undefined) {
      return `${v.message ?? 'Error'}: ${JSON.stringify(v.details).slice(0, 1200)}`;
    }
  }
  return fallbackText.slice(0, 1500);
}

export async function runSamplingRequest(
  options: RunSamplingOptions,
): Promise<SamplingExecutionOutcome> {
  const {
      mode,
      request,
      root,
      definitions,
      createMessage,
      callCapability,
      waitForReply,
      signal,
      maxToolTurns = 12,
      maxDiagnosticRetries = 2,
      maxTokens = 4096,
      timeoutMs = 300_000,
    } = options,
    reqOptions: RequestOptions = {
      signal,
      timeout: timeoutMs,
      resetTimeoutOnProgress: true,
    };

  if (signal.aborted) return { outcome: 'aborted' };

  const initialContent = await buildInitialUserContent(request, root, callCapability);
  if (signal.aborted) return { outcome: 'aborted' };

  const messages: SamplingMessage[] = [{ role: 'user', content: initialContent }];

  const askInStudio = async (args: Record<string, unknown>) => {
    const posted = await callCapability('inbox_ask', {
      id: request.id,
      question: typeof args.question === 'string' ? args.question : '请确认修改细节',
      ...(Array.isArray(args.options) ? { options: args.options } : {}),
      ...(Array.isArray(args.fields) ? { fields: args.fields } : {}),
      waitMs: 0,
    });
    if (posted.isError) return posted;
    const updated = await waitForReply(request.id, signal);
    if (updated.status === 'cancelled' || updated.status === 'pending')
      throw new VmotionError('INBOX_ABORTED', `Request ${request.id} became ${updated.status}`);
    const payload = formatReplyPayload(updated);
    // Clear unreadReply flag since this sampling loop just consumed it.
    await callCapability('inbox_get', { id: request.id }).catch(() => {});
    return { value: payload, text: JSON.stringify(payload), isError: false };
  };

  try {
    if (mode === 'tools') {
      const tools = buildSamplingTools(definitions);
      let appliedChanges = 0,
        finished = false;

      for (let turn = 0; turn < maxToolTurns; turn++) {
        if (signal.aborted) return { outcome: 'aborted' };
        const response = (await createMessage(
          {
            messages,
            systemPrompt: TOOLS_SYSTEM_PROMPT,
            tools,
            toolChoice: { mode: 'auto' },
            maxTokens,
          },
          reqOptions,
        )) as CreateMessageResultWithTools;

        if (signal.aborted) return { outcome: 'aborted' };
        const blocks = asArray(response.content),
          toolUses = blocks.filter((b): b is ToolUseContent => b.type === 'tool_use');
        messages.push({ role: 'assistant', content: response.content });

        if (!toolUses.length) {
          const finalText = extractText(response.content);
          if (finished) return { outcome: 'completed' };
          if (appliedChanges > 0) {
            await callCapability('inbox_done', {
              id: request.id,
              summary: (finalText || '已完成画布修改').slice(0, 500),
            });
            return { outcome: 'completed' };
          }
          return {
            outcome: 'requeue',
            note: finalText
              ? `AI 未执行修改：${finalText.slice(0, 300)}`
              : 'AI 未执行任何修改，已退回待处理',
          };
        }

        const results: ToolResultContent[] = [];
        for (const use of toolUses) {
          if (signal.aborted) return { outcome: 'aborted' };
          const input =
            use.input && typeof use.input === 'object'
              ? (use.input as Record<string, unknown>)
              : {};
          let res: SamplingToolResult;
          if (use.name === 'inbox_ask') {
            res = await askInStudio(input);
          } else if (use.name === 'inbox_done') {
            // Always finish the pushed request itself, never another id the model names.
            res = await callCapability('inbox_done', { ...input, id: request.id });
            if (!res.isError) finished = true;
          } else if (SAMPLING_BLOCKED_CAPABILITIES.has(use.name)) {
            res = blockedResult(use.name);
          } else if (use.name === 'tool_call') {
            const innerName = typeof input.name === 'string' ? input.name : '',
              innerArgs =
                input.arguments && typeof input.arguments === 'object'
                  ? (input.arguments as Record<string, unknown>)
                  : {};
            if (innerName === 'inbox_ask') {
              res = await askInStudio(innerArgs);
            } else if (innerName === 'inbox_done') {
              res = await callCapability('inbox_done', { ...innerArgs, id: request.id });
              if (!res.isError) finished = true;
            } else if (SAMPLING_BLOCKED_CAPABILITIES.has(innerName)) {
              res = blockedResult(innerName);
            } else {
              res = await callCapability('tool_call', input);
              if (
                !res.isError &&
                res.value &&
                typeof res.value === 'object' &&
                ((res.value as { committed?: unknown }).committed === true ||
                  (res.value as { applied?: unknown }).applied === true)
              ) {
                appliedChanges++;
              }
            }
          } else {
            res = await callCapability(use.name, input);
            if (
              !res.isError &&
              use.name === 'project_apply' &&
              res.value &&
              typeof res.value === 'object' &&
              (res.value as { applied?: unknown }).applied === true
            ) {
              appliedChanges++;
            }
          }
          results.push({
            type: 'tool_result',
            toolUseId: use.id,
            content: [{ type: 'text', text: res.text.slice(0, 24_000) }],
            ...(res.isError ? { isError: true } : {}),
          });
        }

        if (finished) return { outcome: 'completed' };
        messages.push({ role: 'user', content: results });
      }

      return {
        outcome: 'requeue',
        note: `AI 工具调用超过 ${maxToolTurns} 轮仍未结束，已退回待处理`,
      };
    }

    // ── Basic sampling mode (no sampling.tools): structured JSON + local preflight/apply ──
    let editFailures = 0,
      askCount = 0;
    while (editFailures <= maxDiagnosticRetries) {
      if (signal.aborted) return { outcome: 'aborted' };
      const response = await createMessage(
        {
          messages,
          systemPrompt: BASIC_SYSTEM_PROMPT,
          maxTokens,
        },
        reqOptions,
      );
      if (signal.aborted) return { outcome: 'aborted' };
      const rawText = extractText(response.content);
      messages.push({ role: 'assistant', content: { type: 'text', text: rawText } });

      const parsed = extractJsonCandidate(rawText);
      if (!parsed) {
        editFailures++;
        if (editFailures > maxDiagnosticRetries)
          return {
            outcome: 'requeue',
            note: 'AI 返回内容不是有效 JSON 补丁，已退回待处理',
          };
        messages.push({
          role: 'user',
          content: {
            type: 'text',
            text: 'Error: Response was not valid JSON. Reply with ONE JSON object (`{"action":"edit","summary":"...","files":[...],"operations":[...]}` or `{"action":"ask",...}`).',
          },
        });
        continue;
      }

      if (parsed.action === 'ask' || (typeof parsed.question === 'string' && !parsed.files && !parsed.operations)) {
        askCount++;
        if (askCount > 4)
          return { outcome: 'requeue', note: 'AI 连续追问超过上限，已退回待处理' };
        const asked = await askInStudio(parsed);
        if (asked.isError)
          return { outcome: 'requeue', note: `提问失败：${asked.text.slice(0, 200)}` };
        messages.push({
          role: 'user',
          content: {
            type: 'text',
            text: `用户在 Vmotion 画布已回复：${asked.text}\n请返回最终修改 JSON（action: "edit"）。`,
          },
        });
        continue;
      }

      const rawFiles = Array.isArray(parsed.files) ? parsed.files : [],
        rawOps = Array.isArray(parsed.operations) ? parsed.operations : [];
      if (!rawFiles.length && !rawOps.length) {
        editFailures++;
        if (editFailures > maxDiagnosticRetries)
          return {
            outcome: 'requeue',
            note: 'AI 返回的补丁为空（无 files 或 operations），已退回待处理',
          };
        messages.push({
          role: 'user',
          content: {
            type: 'text',
            text: 'Error: `files` and `operations` were both empty. Provide non-empty `files` or `operations`.',
          },
        });
        continue;
      }

      let normalizedFiles: FileEdit[];
      try {
        normalizedFiles = await normalizeCandidateFiles(rawFiles, callCapability);
      } catch (e) {
        editFailures++;
        const msg = (e as Error).message;
        if (editFailures > maxDiagnosticRetries)
          return { outcome: 'requeue', note: `补丁文件格式无效：${msg}` };
        messages.push({
          role: 'user',
          content: { type: 'text', text: `File edit schema error: ${msg}. Fix and return valid JSON.` },
        });
        continue;
      }

      const preflightRes = await callCapability('project_preflight', {
        files: normalizedFiles,
        operations: rawOps,
        visual: false,
        samples: [],
      });
      const preflightVal = preflightRes.value as
        | { valid?: boolean; candidateRevision?: string; diagnostics?: unknown[] }
        | undefined;
      if (preflightRes.isError || preflightVal?.valid !== true) {
        editFailures++;
        const diag = summarizeDiagnostics(preflightRes.value, preflightRes.text);
        if (editFailures > maxDiagnosticRetries) {
          return {
            outcome: 'requeue',
            note: `预检未通过（已重试 ${maxDiagnosticRetries} 次）：${diag.slice(0, 260)}`,
          };
        }
        messages.push({
          role: 'user',
          content: {
            type: 'text',
            text: `project_preflight failed with diagnostics:\n${diag}\nFix the errors and return the corrected JSON object.`,
          },
        });
        continue;
      }

      const applyRes = await callCapability('project_apply', {
        files: normalizedFiles,
        operations: rawOps,
        ...(preflightVal.candidateRevision
          ? { expectedCandidateRevision: preflightVal.candidateRevision }
          : {}),
        visual: false,
      });
      const noChange =
        !applyRes.isError &&
        (applyRes.value as { applied?: unknown } | undefined)?.applied !== true;
      if (applyRes.isError || noChange) {
        editFailures++;
        const diag = noChange
          ? 'project_apply made no changes (the edit produced identical files/operations)'
          : summarizeDiagnostics(applyRes.value, applyRes.text);
        if (editFailures > maxDiagnosticRetries) {
          return {
            outcome: 'requeue',
            note: `提交未通过（已重试 ${maxDiagnosticRetries} 次）：${diag.slice(0, 260)}`,
          };
        }
        messages.push({
          role: 'user',
          content: {
            type: 'text',
            text: `project_apply failed:\n${diag}\nFix and return the corrected JSON object.`,
          },
        });
        continue;
      }

      const summary =
        typeof parsed.summary === 'string' && parsed.summary.trim()
          ? parsed.summary.trim().slice(0, 500)
          : '已通过主动推送完成修改';
      await callCapability('inbox_done', {
        id: request.id,
        summary,
        ...(normalizedFiles.length ? { changedFiles: normalizedFiles.map((f) => f.path) } : {}),
      });
      return { outcome: 'completed' };
    }

    return { outcome: 'requeue', note: 'AI 补丁预检未通过，已退回待处理' };
  } catch (e) {
    if (signal.aborted || (e as { code?: string }).code === 'INBOX_ABORTED') {
      return { outcome: 'aborted' };
    }
    const code = (e as { code?: unknown }).code,
      unsupported = code === -32601 || /does not support sampling/i.test((e as Error).message);
    return {
      outcome: 'requeue',
      note: `主动推送未完成（${(e as Error).message.slice(0, 220)}），已退回待处理`,
      ...(unsupported ? { unsupported: true } : {}),
    };
  }
}
