import {
  inspectDrivers,
  planDrivers,
  inspectCurve,
  driversInspectSchema,
  driversPlanSchema,
  curvePathSchema,
} from '../service/drivers.js';
import {
  inspectAnimation,
  animationEdits,
  animationInspectSchema,
  animationEditSchema,
} from '../service/animation.js';
import {
  inspectContentTime,
  editContentTime,
  timeInspectSchema,
  timeEditSchema,
} from '../service/content-time.js';
import {
  inspectComponentParameters,
  editComponentParameters,
  parameterEditSchema,
} from '../service/component-parameters.js';
import { contextFramesSchema } from '../core/content-time.js';
import { VmotionError } from '../core/model.js';
import { z } from 'zod';
import { builtinCandidate } from './candidate.js';
import { parameterQuerySchema, queryParameters } from '../service/parameter-query.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import type { BuiltinPluginModule } from './types.js';

export const animationPlugin: BuiltinPluginModule = {
  id: 'vmotion.animation',
  name: '属性、关键帧与组件控制',
  version: '1.0.0',
  dependencies: { 'vmotion.design': '^1.0.0' },
  methods: new Set([
    'driversInspect',
    'driversPlan',
    'curvePath',
    'animationInspect',
    'animationEdit',
    'timeInspect',
    'timeEdit',
    'componentParameters',
    'componentParametersEdit',
    'component',
    'componentQuery',
  ]),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'component_query',
        method: 'componentQuery',
        schema: parameterQuerySchema.shape,
        description:
          'Read compact paged parameter values/default previews and numeric channels for one component or template instance. Select relative parameter paths, page arrays/channels without repeating full schemas, and request includeSchema/fullValues explicitly. Values cover theme and native keys at the supplied local frame; this is not final driver/pixel evidence.',
        categories: ['animation', 'composition'],
        keywords: '组件 参数 查询 路径 分页 模板 数值 animation parameter inspect',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'drivers_inspect',
        description:
          'Inspect evaluated property expressions, responsive layout constraints and curved motion paths at local frames. Returns actual pose/value dependency evidence, stable layer references and shared driver descriptions without full project source. Native key values precede drivers; expression outputs override layout/path fields. Cycles/missing references/nonfinite outputs have precise diagnostics.',
        method: 'driversInspect',
        schema: driversInspectSchema.shape,
      },
      {
        name: 'drivers_plan',
        description:
          'Plan an atomic multi-scene batch of property expressions, responsive parent/scene/sibling layout constraints, SVG/shape-referenced arc-length motion and their numeric keys. Expression fields resolve lazy dependencies and deterministic clocks; generated edits persist overrides. Returns exact stored candidate for native preflight/apply and one undo, with sample coverage.',
        method: 'driversPlan',
        schema: driversPlanSchema.shape,
      },
      {
        name: 'curve_path',
        description:
          'Measure and sample SVG line/quadratic/cubic/arc motion by length, returning local position, tangent, auto-facing angle and multi-contour jump evidence. Clamp/loop/pingpong handle progress without state. Pure geometry query; does not edit project files.',
        method: 'curvePath',
        schema: curvePathSchema.shape,
      },
      {
        name: 'animation_inspect',
        description:
          'Read layer animation channels and sample evaluated values plus numerical velocity per second at chosen frames. Supports native and generated layers and structured component numeric paths.',
        method: 'animationInspect',
        schema: animationInspectSchema.shape,
      },
      {
        name: 'animation_edit',
        description:
          'Atomically edit keyframes across multiple layers. Actions upsert/remove/ease/transform support selected channels, times or ranges; transform can copy, shift/scale time and values around pivots. Defaults reject time collisions. Component defaults are materialized; generated edits persist as owner overrides.',
        method: 'animationEdit',
        schema: animationEditSchema.shape,
      },
      {
        name: 'time_inspect',
        description:
          'Inspect visual content clocks for a video/component/scene reference: normalized mapping, remap channels, parent-to-source sampled frames, repeat bounds and visibility. Layer transforms/parameters remain on the parent clock while visual content uses the mapped source clock. Nested edits use local frame plus contextFrames from composition_interactions.',
        method: 'timeInspect',
        schema: timeInspectSchema.shape,
      },
      {
        name: 'time_edit',
        description:
          'Revision-checked visual retiming with one undo step: rate/offset/anchor, negative-rate reverse, freeze, clamp/loop/pingpong/blank bounds, numeric remap keys with easing, or reset. Scene/video asset durations are inferred; components need explicit duration for bounded modes. Audio is not implicitly retimed by these visual-layer controls.',
        method: 'timeEdit',
        schema: timeEditSchema.shape,
      },
      {
        name: 'component_parameters',
        description:
          'Inspect parameter descriptors, defaults, JSON Schema, resolved/evaluated values and numeric animation channels for a native or generated programmable component.',
        method: 'componentParameters',
        schema: {
          sceneId: z.string(),
          nodeId: z.string(),
          path: z.array(z.string()).max(32).default([]),
          contextFrames: contextFramesSchema.default([]),
          frame: z.number().int().nonnegative().default(0),
        },
      },
      {
        name: 'component_parameters_edit',
        description:
          'Edit numeric/string/color/boolean/enum/vector/array/object parameters by relative parameter paths, reset defaults or create numeric leaf keyframes. Materializes defaults and preserves sibling values; creates one undo step and supports generated component overrides.',
        method: 'componentParametersEdit',
        schema: parameterEditSchema.shape,
      },
      {
        name: 'component_describe',
        description: 'Read the editable parameter schema of a TypeScript component.',
        method: 'component',
        schema: { source: z.string() },
      },
    ];
  },
  async dispatch(host, method, params) {
    const snapshot = host.snapshot;
    switch (method) {
      case 'curvePath':
        return inspectCurve(params);
      case 'driversInspect':
        return inspectDrivers(host.renderer, snapshot, params);
      case 'animationInspect':
        return inspectAnimation(host.renderer, snapshot, params);
      case 'timeInspect':
        return inspectContentTime(host.renderer, snapshot, params);
      case 'component':
        return host.renderer.components.describe(snapshot, params.source);
      case 'componentQuery':
        return queryParameters(host.renderer, snapshot, params);
      case 'componentParameters': {
        const inspected = await inspectComponentParameters(host.renderer, snapshot, params);
        return {
          nodeId: inspected.node.id,
          source: inspected.node.component,
          parameters: inspected.metadata.parameters,
          jsonSchema: inspected.metadata.jsonSchema,
          defaults: inspected.metadata.defaults,
          values: inspected.values,
          evaluated: inspected.evaluated,
          revision: inspected.revision,
          channels: inspected.channels,
          channelCount: inspected.total,
          truncated: inspected.truncated,
        };
      }
      case 'driversPlan': {
        const base = structuredClone(snapshot),
          planned = await planDrivers(host.root, host.renderer, base, params, host.edit),
          input = {
            revision: base.revision,
            operations: planned.operations,
            samples: planned.samples,
            width: 320,
            determinism: true,
            visual: true,
          };
        return builtinCandidate(
          host.root,
          input,
          planned.candidate.revision,
          planned.request.delivery,
          { layers: planned.layers, coverage: planned.coverage },
        );
      }
      case 'animationEdit': {
        const edited = await animationEdits(host.renderer, snapshot, params),
          operations = await host.edit(
            snapshot,
            edited.request.sceneId,
            edited.request.frame,
            edited.edits,
          );
        return host.transact(operations, edited.request.revision ?? snapshot.revision);
      }
      case 'timeEdit': {
        const edited = await editContentTime(host.renderer, snapshot, params),
          operations = await host.edit(snapshot, edited.request.sceneId, edited.request.frame, [
            {
              nodeId: edited.nodeId,
              path: edited.request.path,
              contextFrames: edited.request.contextFrames,
              patch: edited.patch,
            },
          ]),
          state = await host.transact(operations, edited.request.revision ?? snapshot.revision);
        return { ...state, timing: edited.sample };
      }
      case 'componentParametersEdit': {
        const edited = await editComponentParameters(host.renderer, snapshot, params),
          operations = await host.edit(snapshot, edited.request.sceneId, edited.request.frame, [
            {
              path: edited.request.path,
              contextFrames: edited.request.contextFrames,
              nodeId: edited.nodeId,
              patch: edited.patch,
            },
          ]),
          state = await host.transact(operations, edited.request.revision ?? snapshot.revision);
        return { ...state, parameterValues: edited.values };
      }
      default:
        throw new VmotionError('METHOD_NOT_FOUND', 'Animation module does not handle this method', {
          method,
        });
    }
  },
};
