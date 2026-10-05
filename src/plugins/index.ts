import { BuiltinPluginRegistry } from './registry.js';
import { designPlugin } from './design.js';
import { mathPlugin } from './math.js';
import { visualPlugin } from './visual.js';
import { mediaPlugin } from './media.js';
import { audioPlugin } from './audio.js';
import { editingPlugin } from './editing.js';
import { renderPlugin } from './render.js';
import { scene3dPlugin } from './scene3d.js';
import { graphicsPlugin } from './graphics.js';
import { animationPlugin } from './animation.js';

export const builtinPlugins = new BuiltinPluginRegistry([
  designPlugin,
  mathPlugin,
  visualPlugin,
  mediaPlugin,
  audioPlugin,
  editingPlugin,
  renderPlugin,
  scene3dPlugin,
  graphicsPlugin,
  animationPlugin,
]);
