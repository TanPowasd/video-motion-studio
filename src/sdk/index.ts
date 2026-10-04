import { newNode, type Node, type Keyframe } from '../core/model.js';
import { ease, interpolate, random } from '../core/time.js';
export { newNode as node, ease, interpolate, random };
export { axes, diagram, stack, cubicBezier, bubbleSortSteps } from './science.js';
export * from './motion.js';
export { applyMotionCues, parseMotionTemplate, builtinMotions } from '../core/motion-template.js';
export type {
  MotionTemplate,
  MotionTemplateInput,
  MotionCue,
  MotionOptions,
  BuiltinMotion,
} from '../core/motion-template.js';
export * from './effects.js';
export {
  particleField,
  particleState,
  particleFieldParameters,
  particleFieldSchema,
} from '../core/particle-field.js';
export type {
  ParticleFieldInput,
  ParticleFieldConfig,
  ParticleRecord,
  ParticleCallbacks,
} from '../core/particle-field.js';
export * from './post.js';
export * from './repeater.js';
export * from './linear-algebra.js';
export * from './matrix3d.js';
export * from './meshes.js';
export * from './materials3d.js';
export * from './normals3d.js';
export { editEffectStack } from '../core/effect-stack.js';
export type { EffectAction } from '../core/effect-stack.js';
export { parseOBJ } from './obj.js';
export type { MeshDocument } from '../core/mesh-document.js';
export { editSequence, sequenceActionSchema } from '../core/editing.js';
export type { SequenceAction } from '../core/editing.js';
export { parseCaptions, captionsSchema } from '../core/captions.js';
export type { CaptionDocument } from '../core/captions.js';
export { measureTextBlock } from '../core/text-layout.js';
export { mapContentTime, contentTiming, contentTimeSchema } from '../core/content-time.js';
export type { ContentTime, ContentTiming } from '../core/content-time.js';
export {
  booleanPath,
  trimPath,
  outlinePath,
  simplifyPath,
  roundPath,
  pathGeometry,
} from '../core/vector.js';
export type {
  PathTrim,
  PathOperation,
  OutlineOptions,
  PathGeometryRequest,
} from '../core/vector-schema.js';
export { editKeyframes, sampleAnimation } from '../core/keyframes.js';
export type { KeyframeAction } from '../core/keyframes.js';
export {
  auditFrame,
  auditMotion,
  auditGeometry,
  visualOptionsSchema,
} from '../core/visual-audit.js';
export type { VisualOptions, VisualFinding } from '../core/visual-audit.js';
export type { Node, Keyframe, Gradient, Effect } from '../core/model.js';
export type {
  DrawingDocument,
  DrawingLayer,
  DrawingStroke,
  DrawingOperation,
} from '../core/drawing-model.js';
import {
  resolveParameters,
  validateParameterDefinitions,
  type ParameterDefinitions,
  type ParameterValues,
} from '../core/parameters.js';
export { resolveParameters, parameterDefault, parameterJsonSchema } from '../core/parameters.js';
export type {
  Parameter,
  ParameterDefinitions,
  ParameterValues,
  ParameterValue,
} from '../core/parameters.js';
export interface ComponentContext {
  frame: number;
  seconds: number;
  fps: number;
  width: number;
  height: number;
  seed: number;
  audio?: {
    rms: number;
    peak: number;
    bass: number;
    mid: number;
    treble: number;
    onset: number;
    beat: number;
    bpm: number;
  };
}
export interface Component<P extends ParameterDefinitions = ParameterDefinitions> {
  name: string;
  parameters: P;
  render: (
    context: ComponentContext,
    params: ParameterValues<P>,
  ) => Array<Partial<Node> & Pick<Node, 'id' | 'type'>>;
}
export function defineComponent<const P extends ParameterDefinitions>(
  component: Component<P>,
): Component<P> {
  validateParameterDefinitions(component.parameters);
  return {
    ...component,
    render: (ctx, params) => component.render(ctx, resolveParameters(component.parameters, params)),
  };
}
export const rect = (id: string, props: Partial<Node> = {}) =>
  newNode({ id, type: 'rect', ...props });
export const text = (id: string, value: string, props: Partial<Node> = {}) =>
  newNode({ id, type: 'text', text: value, ...props });
export const ellipse = (id: string, props: Partial<Node> = {}) =>
  newNode({ id, type: 'ellipse', ...props });
export const path = (id: string, value: string, props: Partial<Node> = {}) =>
  newNode({ id, type: 'path', path: value, ...props });
export const formula = (id: string, tex: string, props: Partial<Node> = {}) =>
  newNode({ id, type: 'formula', text: tex, ...props });
export const sceneRef = (id: string, sceneId: string, props: Partial<Node> = {}) =>
  newNode({ ...props, id, type: 'scene', sceneId });
export const keyframes = (property: Node['animations'][number]['property'], keys: Keyframe[]) => ({
  property,
  keys,
});
export function plot(
  id: string,
  fn: (x: number) => number,
  range: [number, number],
  props: Partial<Node> = {},
) {
  const w = props.width ?? 600,
    h = props.height ?? 300,
    samples = 300;
  const points = Array.from({ length: samples + 1 }, (_, i) => {
    const x = range[0] + ((range[1] - range[0]) * i) / samples;
    return `${i ? 'L' : 'M'} ${(i * w) / samples} ${h / 2 - (fn(x) * h) / 4}`;
  });
  return path(id, points.join(' '), {
    fill: 'transparent',
    stroke: '#7c8cff',
    strokeWidth: 3,
    ...props,
  });
}
