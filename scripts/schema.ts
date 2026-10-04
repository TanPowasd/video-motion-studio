import { mkdir, writeFile } from 'node:fs/promises';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  projectSchema,
  sceneSchema,
  sequenceSchema,
  nodeSchema,
  operationSchema,
  effectSchema,
} from '../src/core/model.js';
import { drawingDocumentSchema, drawingOperationSchema } from '../src/core/drawing-model.js';
import { fileEditSchema } from '../src/core/file-edits.js';
import { scene3dSchema } from '../src/core/scene3d-schema.js';
import { meshDocumentSchema } from '../src/core/mesh-document.js';
import { material3dSchema } from '../src/core/material3d-schema.js';
import { motionTemplateSchema } from '../src/core/motion-template.js';
await mkdir('schemas', { recursive: true });
for (const [name, schema] of Object.entries({
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
}))
  await writeFile(
    `schemas/${name}.schema.json`,
    JSON.stringify(zodToJsonSchema(schema, name), null, 2) + '\n',
  );
