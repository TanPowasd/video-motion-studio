import { zodToJsonSchema } from 'zod-to-json-schema';
import { storyboardSchema } from '../core/storyboard.js';
import { textureSettingsSchema } from '../core/texture-schema.js';
import { pathTextSchema, textAnimatorSchema } from '../core/typography-schema.js';
import { shapeOperatorSchema } from '../core/shape-operator-schema.js';
import { trackingDocumentSchema, trackingSettingsSchema } from '../core/tracking-schema.js';
import { audioMixSchema, audioNormalizationSchema } from '../core/audio-mix-schema.js';
import type { ZodTypeAny } from 'zod';
import {
  projectSchema,
  sceneSchema,
  sequenceSchema,
  nodeSchema,
  operationSchema,
  effectSchema,
  VmotionError,
  FORMAT_VERSION,
} from '../core/model.js';
import { drawingDocumentSchema, drawingOperationSchema } from '../core/drawing-model.js';
import { fileEditSchema } from '../core/file-edits.js';
import { scene3dSchema } from '../core/scene3d-schema.js';
import { meshDocumentSchema } from '../core/mesh-document.js';
import { material3dSchema } from '../core/material3d-schema.js';
import { motionTemplateSchema } from '../core/motion-template.js';
import { effectGraphSchema } from '../core/effect-graph-schema.js';
import { expressionsSchema, layoutSchema, motionPathSchema } from '../core/driver-schema.js';
import {
  soundDocumentSchema,
  soundInstrumentSchema,
  soundEffectSchema,
} from '../core/sound-schema.js';
const schemas = {
  tracking: trackingDocumentSchema,
  trackingSettings: trackingSettingsSchema,
  pathText: pathTextSchema,
  textAnimator: textAnimatorSchema,
  shapeOperator: shapeOperatorSchema,
  storyboard: storyboardSchema,
  textureSettings: textureSettingsSchema,
  audioMix: audioMixSchema,
  audioNormalization: audioNormalizationSchema,
  project: projectSchema,
  scene: sceneSchema,
  sequence: sequenceSchema,
  node: nodeSchema,
  operation: operationSchema,
  drawing: drawingDocumentSchema,
  drawingOperation: drawingOperationSchema,
  fileEdit: fileEditSchema,
  scene3d: scene3dSchema,
  mesh: meshDocumentSchema,
  material3d: material3dSchema,
  effect: effectSchema,
  motionTemplate: motionTemplateSchema,
  effectGraph: effectGraphSchema,
  expressions: expressionsSchema,
  layout: layoutSchema,
  motionPath: motionPathSchema,
  sound: soundDocumentSchema,
  soundInstrument: soundInstrumentSchema,
  soundEffect: soundEffectSchema,
};
export function projectSchemaInfo(name: string, operationType?: string) {
  if (!Object.hasOwn(schemas, name))
    throw new VmotionError(
      'SCHEMA_NAME',
      'Use project, scene, sequence, node, operation, drawing, drawingOperation, fileEdit, scene3d, mesh, material3d, effect, motionTemplate or effectGraph',
    );
  let schema: ZodTypeAny = schemas[name as keyof typeof schemas];
  if (operationType) {
    if (name !== 'operation')
      throw new VmotionError(
        'SCHEMA_OPERATION',
        'operationType is only supported for the operation schema',
      );
    const selected = operationSchema.options.find(
      (option) => option.shape.type.value === operationType,
    );
    if (!selected) throw new VmotionError('SCHEMA_OPERATION', 'Unknown operation type');
    schema = selected;
  }
  return {
    name,
    operationType,
    formatVersion: FORMAT_VERSION,
    schema: zodToJsonSchema(schema, name),
  };
}
