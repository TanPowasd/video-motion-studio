import { z } from 'zod';
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from './catalog.js';
import { VmotionError } from '../core/model.js';
export const toolCallSchema = z
  .object({
    name: z.string().min(1),
    arguments: z.record(z.unknown()).default({}),
    response: z.enum(['compact', 'full']).default('compact'),
  })
  .strict();
export type BackendCall = (method: string, params: unknown) => Promise<any>;
const imageMethods = new Set([
  'frame',
  'sample',
  'drawingFrame',
  'assetThumbnail',
  'projectPreflight',
  'visualAudit',
  'mediaSample',
]);
const retry: Record<string, string> = {
  MOTION_CHANNEL_EXISTS:
    'Inspect animation_inspect; choose replaceChannels deliberately to replace controlled channels, or merge to keep existing keys and reject time collisions.',
  MOTION_OVERLAP:
    'Sequence cues on a shared property or split them into separate layer groups. Motion plans do not implicitly add overlapping tracks.',
  MOTION_TIME_COLLISION:
    'Increase duration or simplify normalized keys; distinct key times must map to distinct video frames.',
  MOTION_RANGE:
    'Inspect the local composition duration and adjust cue start/duration/target offset or extend that composition explicitly.',
  MOTION_BINDING:
    'Read motion_templates for parameter schemas and cue IDs, then correct bindings. Nested objects preserve siblings; arrays replace as a whole.',
  VISUAL_REPAIR_FIT:
    'Inspect requiredHeight/bounds and explicitly choose text width/font size or a larger canvas. Repairs do not silently scale or shorten content.',
  VISUAL_REPAIR_TRANSFORM:
    'Inspect the owner transform; a zero parent scale cannot convert canvas displacement. Edit owner parameters or source first.',
  VISUAL_REPAIR_TARGET: 'Use one ordered action list per expanded stable layer ID.',
  REVISION_CONFLICT:
    'Read project_context again, rebuild the candidate against the current revision, and preflight.',
  FILE_HASH_CONFLICT: 'Read project_file_read again and use its current hash.',
  CANDIDATE_REVISION: 'Use exactly the operations/files from the inspected preflight.',
  ASSET_CHANGED:
    'Inspect and sample the media again, then rebuild the plan with fresh assetChecks.',
  INVALID_ON_DISK: 'Read pending files and repair using version=pending.',
  UNRESOLVED_CONFLICTS: 'Inspect project_context conflicts and resolve explicitly before editing.',
  VALIDATION_FAILED: 'Fix reported diagnostics, preflight the corrected candidate, then apply.',
  TRACK_LOCKED: 'Inspect the affected track; unlock it explicitly before editing.',
  TOOL_NOT_FOUND: 'Use tools_search to select a real tool name.',
  FILE_WRITE:
    'Inspect the reported file/systemCode, release a persistent file lock or fix storage access, then re-read context before retrying.',
  AGENT_PLAN_MISSING: 'Generate/import the candidate again and use its new planId.',
  AGENT_PLAN_CHANGED: 'Regenerate the candidate; never modify a stored plan file in place.',
  AGENT_PLAN_OVERRIDE:
    'Create a new candidate when operations, files, revision or asset checks must change. Only sampling/output options may override a stored plan.',
  TOOL_ARGUMENTS: 'Read tool_schema for this tool and correct the reported argument paths.',
};
export function toolError(error: unknown): CallToolResult {
  const code =
      error instanceof VmotionError
        ? error.code
        : error instanceof z.ZodError
          ? 'TOOL_ARGUMENTS'
          : 'INTERNAL_ERROR',
    details =
      error instanceof VmotionError
        ? error.details
        : error instanceof z.ZodError
          ? error.issues.map((i) => ({ path: '/' + i.path.join('/'), message: i.message }))
          : undefined,
    value = {
      code,
      message: (error as Error).message,
      ...(details === undefined ? {} : { details }),
      ...(retry[code] ? { recovery: retry[code] } : {}),
    };
  return {
    isError: true,
    structuredContent: { error: value },
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}
export function compactResult(method: string, result: any) {
  if (!result?.snapshot || method === 'state') return result;
  const { snapshot, pendingFiles, document, ...rest } = result;
  return {
    ...rest,
    revision: snapshot.revision,
    pendingFiles: !!pendingFiles,
    ...(document
      ? {
          document: {
            id: document.id,
            name: document.name,
            width: document.width,
            height: document.height,
            layers: document.layers?.map((l: any) => ({
              id: l.id,
              name: l.name,
              visible: l.visible,
              strokes: l.strokes?.length ?? 0,
            })),
          },
        }
      : {}),
  };
}
export async function invokeTool(
  tool: ToolDefinition,
  raw: unknown,
  call: BackendCall,
  options: { response?: 'compact' | 'full'; inline?: boolean } = {},
) {
  let params: Record<string, unknown>;
  try {
    params = z.object(tool.schema).strict().parse(raw);
  } catch (e) {
    if (e instanceof z.ZodError)
      throw new VmotionError(
        'TOOL_ARGUMENTS',
        `Invalid arguments for ${tool.name}`,
        e.issues.map((i) => ({ path: '/' + i.path.join('/'), message: i.message })),
      );
    throw e;
  }
  const inline = options.inline ?? true,
    payload =
      imageMethods.has(tool.method) || ['audioPreview', 'scene3dRender'].includes(tool.method)
        ? { ...params, inline }
        : ['linearAlgebra', 'matrix3d'].includes(tool.method)
          ? params.request
          : params;
  let rawResult: any;
  try {
    rawResult = await call(tool.method, payload);
  } catch (e) {
    if (e instanceof z.ZodError)
      throw new VmotionError(
        'TOOL_ARGUMENTS',
        `Invalid arguments for ${tool.name}`,
        e.issues.map((i) => ({ path: '/' + i.path.join('/'), message: i.message })),
      );
    throw e;
  }
  const result = options.response === 'full' ? rawResult : compactResult(tool.method, rawResult);
  const media: ContentBlock[] = [];
  let value: any = result;
  if (tool.method === 'scene3dRender') {
    const { images, ...info } = result;
    value = { ...info, images: images.map(({ data, ...image }: any) => image) };
    for (const image of images)
      if (image.data) media.push({ type: 'image', data: image.data, mimeType: 'image/png' });
  } else if (result?.data && (imageMethods.has(tool.method) || tool.method === 'audioPreview')) {
    const { data, ...info } = result;
    value = info;
    media.push(
      tool.method === 'audioPreview'
        ? { type: 'audio', data, mimeType: 'audio/wav' }
        : { type: 'image', data, mimeType: 'image/png' },
    );
  }
  // A few legacy mutations already exposed compact fields; full mode preserves their legacy shape.
  if (options.response === 'full' && tool.method === 'animationEdit')
    value = {
      revision: result.snapshot.revision,
      canUndo: result.canUndo,
      canRedo: result.canRedo,
    };
  if (options.response === 'full' && tool.method === 'componentParametersEdit')
    value = {
      revision: result.snapshot.revision,
      values: result.parameterValues,
      canUndo: result.canUndo,
      canRedo: result.canRedo,
    };
  const structuredContent =
    value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value };
  return {
    value,
    result: {
      structuredContent,
      content: [{ type: 'text' as const, text: JSON.stringify(value) }, ...media],
    } satisfies CallToolResult,
  };
}
