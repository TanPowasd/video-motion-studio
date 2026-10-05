import { z } from 'zod';
import { builtinPlugins } from '../plugins/index.js';
import type { ToolCategory } from './discovery.js';

export interface ToolDefinition {
  name: string;
  description: string;
  method: string;
  schema: Record<string, z.ZodTypeAny>;
  plugin?: { id: string; version: string; origin: 'builtin' | 'project'; hash?: string };
  categories?: ToolCategory[];
  keywords?: string;
  annotations?: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}
export function toolDefinitions(): ToolDefinition[] {
  return [...builtinPlugins.tools];
}
