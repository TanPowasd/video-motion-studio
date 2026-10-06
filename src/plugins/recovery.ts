import { z } from 'zod';
import { VmotionError } from '../core/model.js';
import type { BuiltinPluginModule } from './types.js';
import type { ToolDefinition } from '../mcp/catalog.js';
export const recoveryPlugin: BuiltinPluginModule = {
  id: 'vmotion.recovery',
  name: '共享历史与冲突恢复',
  version: '1.0.0',
  methods: new Set(['undo', 'redo', 'resolve']),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'project_undo',
        description: 'Undo the last accepted transaction.',
        method: 'undo',
        schema: {},

        categories: ['recovery'],
        keywords: '撤销 恢复',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'project_redo',
        description: 'Redo an undone transaction.',
        method: 'redo',
        schema: {},

        categories: ['recovery'],
        keywords: '重做',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'project_resolve_conflict',
        description: 'Resolve a conflict while preserving both versions until chosen.',
        method: 'resolve',
        schema: { index: z.number().int().nonnegative(), choice: z.enum(['ours', 'theirs']) },

        categories: ['recovery'],
        keywords: '',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
    ];
  },
  dispatch(host, method, params) {
    if (method === 'undo') return host.coreService.undo();
    if (method === 'redo') return host.coreService.redo();
    if (method === 'resolve') return host.coreService.resolve(params.index, params.choice);
    throw new VmotionError('METHOD_NOT_FOUND', 'Recovery module does not handle this method', {
      method,
    });
  },
};
