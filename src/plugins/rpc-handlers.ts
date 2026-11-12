import { animationRpcHandlers } from './animation.js';
import { audioRpcHandlers } from './audio.js';
import { cacheRpcHandlers } from './cache.js';
import { compositionRpcHandlers } from './composition.js';
import { coreRpcHandlers } from './core.js';
import { designRpcHandlers } from './design.js';
import { drawingRpcHandlers } from './drawing.js';
import { editingRpcHandlers } from './editing.js';
import { graphicsRpcHandlers } from './graphics.js';
import { mathRpcHandlers } from './math.js';
import { mediaRpcHandlers } from './media.js';
import { organizationRpcHandlers } from './organization.js';
import { recoveryRpcHandlers } from './recovery.js';
import { renderRpcHandlers } from './render.js';
import { reviewRpcHandlers } from './review.js';
import { scene3dRpcHandlers } from './scene3d.js';
import { trackingRpcHandlers } from './tracking.js';
import { visualRpcHandlers } from './visual.js';
import { workflowRpcHandlers } from './workflow.js';

export type AnimationH = typeof animationRpcHandlers;
export type AudioH = typeof audioRpcHandlers;
export type CacheH = typeof cacheRpcHandlers;
export type CompositionH = typeof compositionRpcHandlers;
export type CoreH = typeof coreRpcHandlers;
export type DesignH = typeof designRpcHandlers;
export type DrawingH = typeof drawingRpcHandlers;
export type EditingH = typeof editingRpcHandlers;
export type GraphicsH = typeof graphicsRpcHandlers;
export type MathH = typeof mathRpcHandlers;
export type MediaH = typeof mediaRpcHandlers;
export type OrganizationH = typeof organizationRpcHandlers;
export type RecoveryH = typeof recoveryRpcHandlers;
export type RenderH = typeof renderRpcHandlers;
export type ReviewH = typeof reviewRpcHandlers;
export type Scene3dH = typeof scene3dRpcHandlers;
export type TrackingH = typeof trackingRpcHandlers;
export type VisualH = typeof visualRpcHandlers;
export type WorkflowH = typeof workflowRpcHandlers;

export interface BuiltinRpcHandlers
  extends AnimationH,
    AudioH,
    CacheH,
    CompositionH,
    CoreH,
    DesignH,
    DrawingH,
    EditingH,
    GraphicsH,
    MathH,
    MediaH,
    OrganizationH,
    RecoveryH,
    RenderH,
    ReviewH,
    Scene3dH,
    TrackingH,
    VisualH,
    WorkflowH {}

export const builtinRpcHandlers: BuiltinRpcHandlers = {
  ...animationRpcHandlers,
  ...audioRpcHandlers,
  ...cacheRpcHandlers,
  ...compositionRpcHandlers,
  ...coreRpcHandlers,
  ...designRpcHandlers,
  ...drawingRpcHandlers,
  ...editingRpcHandlers,
  ...graphicsRpcHandlers,
  ...mathRpcHandlers,
  ...mediaRpcHandlers,
  ...organizationRpcHandlers,
  ...recoveryRpcHandlers,
  ...renderRpcHandlers,
  ...reviewRpcHandlers,
  ...scene3dRpcHandlers,
  ...trackingRpcHandlers,
  ...visualRpcHandlers,
  ...workflowRpcHandlers,
};
