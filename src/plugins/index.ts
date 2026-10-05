import { BuiltinPluginRegistry } from './registry.js';
import { designPlugin } from './design.js';
import { mathPlugin } from './math.js';
import { visualPlugin } from './visual.js';
import { mediaPlugin } from './media.js';
import { audioPlugin } from './audio.js';
import { editingPlugin } from './editing.js';
import { renderPlugin } from './render.js';

export const builtinPlugins = new BuiltinPluginRegistry([
  designPlugin,
  mathPlugin,
  visualPlugin,
  mediaPlugin,
  audioPlugin,
  editingPlugin,
  renderPlugin,
]);
