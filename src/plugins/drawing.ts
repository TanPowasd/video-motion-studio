import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import {
  getDrawing,
  drawingEdit,
  publishDrawing,
  drawingFromAsset,
  drawingPreview,
} from '../service/drawings.js';
import { drawingDocumentSchema, drawingOperationSchema } from '../core/drawing-model.js';
import { atomicWrite, safePath } from '../service/project.js';
import { VmotionError } from '../core/model.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import type { BuiltinPluginModule } from './types.js';
import { drawingQuerySchema, queryDrawing } from '../service/library-query.js';
export const drawingPlugin: BuiltinPluginModule = {
  id: 'vmotion.drawing',
  name: '绘画文档与发布',
  version: '1.0.0',
  methods: new Set([
    'drawingList',
    'drawingGet',
    'drawingCreate',
    'drawingEdit',
    'drawingPublish',
    'drawingOpenAsset',
    'drawingFrame',
    'drawingQuery',
  ]),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'drawing_query',
        method: 'drawingQuery',
        schema: drawingQuerySchema.shape,
        description:
          'Inspect paged drawing layers/strokes by stable IDs without returning every brush point. Layer counts, stroke appearance and point totals are compact; includePoints requests an explicit bounded point page. Coordinates are layer-local with pressure. drawing_get keeps the full editable document; drawing_frame supplies native pixels.',
        categories: ['drawing'],
        keywords: '绘画 画稿 图层 笔迹 压感 分页 query stroke layer',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'drawing_list',
        description:
          'List independent drawing documents. Documents are separate from scene layers until published and placed.',
        method: 'drawingList',
        schema: {},
      },
      {
        name: 'drawing_get',
        description:
          'Read editable layers, brush strokes and document size for an independent drawing document.',
        method: 'drawingGet',
        schema: { id: z.string() },
      },
      {
        name: 'drawing_create',
        description:
          'Create a transparent layered drawing document without adding scene layers or publishing assets.',
        method: 'drawingCreate',
        schema: {
          id: z.string().optional(),
          name: z.string().optional(),
          width: z.number().int().min(16).max(8192).optional(),
          height: z.number().int().min(16).max(8192).optional(),
          revision: z.string().optional(),
        },
      },
      {
        name: 'drawing_edit',
        description:
          'Apply brush/eraser strokes, create/edit/delete/copy/order layers, or update document dimensions atomically. Uses the shared undo history and revision checks.',
        method: 'drawingEdit',
        schema: {
          id: z.string(),
          operations: z.array(drawingOperationSchema).min(1).max(1000),
          revision: z.string().optional(),
        },
      },
      {
        name: 'drawing_publish',
        description:
          'Publish the whole drawing or selected layers as an immutable visual asset. The source document remains editable.',
        method: 'drawingPublish',
        schema: {
          id: z.string(),
          layerIds: z.array(z.string()).optional(),
          name: z.string().optional(),
          revision: z.string().optional(),
        },
      },
      {
        name: 'drawing_open_asset',
        description:
          'Create an editable drawing document from a published or legacy drawing asset.',
        method: 'drawingOpenAsset',
        schema: { assetId: z.string(), revision: z.string().optional() },
      },
      {
        name: 'drawing_frame',
        description: 'Get the native rendered image of a drawing document for visual checks.',
        method: 'drawingFrame',
        schema: {
          id: z.string(),
          width: z.number().int().min(16).max(2048).optional(),
          height: z.number().int().min(16).max(2048).optional(),
          output: z.string().optional(),
          inline: z.boolean().default(true),
        },
      },
    ];
  },
  async dispatch(host, method, params) {
    const snapshot = host.snapshot;
    switch (method) {
      case 'drawingQuery':
        return queryDrawing(snapshot, params);
      case 'drawingList':
        return snapshot.project.drawings;
      case 'drawingGet':
        return { document: getDrawing(snapshot, params.id), revision: snapshot.revision };
      case 'drawingCreate': {
        const id = params.id ?? randomUUID(),
          document = drawingDocumentSchema.parse({
            id,
            name: params.name ?? '未命名画稿',
            width: params.width ?? snapshot.project.width,
            height: params.height ?? snapshot.project.height,
            layers: [{ id: randomUUID(), name: '图层 1', strokes: [] }],
          });
        if (snapshot.project.drawings.some((d) => d.id === id))
          throw new VmotionError('DUPLICATE_ID', '画稿 ID 已存在');
        return {
          ...(await host.transact(
            [{ type: 'writeDrawing', document }],
            params.revision ?? snapshot.revision,
          )),
          document,
        };
      }
      case 'drawingEdit':
        return drawingEdit(host.drawingService, params.id, params.operations, params.revision);
      case 'drawingPublish':
        return publishDrawing(
          host.root,
          host.drawingService,
          params.id,
          params.layerIds,
          params.name,
          params.revision,
        );
      case 'drawingOpenAsset': {
        const doc = await drawingFromAsset(host.root, snapshot, params.assetId),
          document = { ...doc, id: randomUUID(), name: doc.name + ' · 编辑' };
        return {
          ...(await host.transact(
            [{ type: 'writeDrawing', document }],
            params.revision ?? snapshot.revision,
          )),
          document,
        };
      }
      case 'drawingFrame': {
        const result = await drawingPreview(
            snapshot,
            params.id,
            params.width,
            params.height,
            params.draft,
          ),
          output = path.resolve(
            params.output ?? safePath(host.root, `.vmotion/frames/drawing-${params.id}.png`),
          );
        await atomicWrite(output, result.buffer);
        return {
          output,
          revision: result.revision,
          mimeType: 'image/png',
          ...(params.inline ? { data: result.buffer.toString('base64') } : {}),
        };
      }
      default:
        throw new VmotionError('METHOD_NOT_FOUND', 'Drawing module does not handle this method', {
          method,
        });
    }
  },
};
