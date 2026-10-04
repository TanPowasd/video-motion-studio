import { effectSchema, type Effect } from '../core/model.js';
import type { z } from 'zod';
import type { spatialEffectSchema } from '../core/spatial-effect-schema.js';
import type { temporalEffectSchema } from '../core/temporal-effect.js';
type SpatialInput = z.input<typeof spatialEffectSchema>;
type TemporalInput = z.input<typeof temporalEffectSchema>;
export const motionBlur = (
  options: Omit<Extract<TemporalInput, { type: 'motionBlur' }>, 'type'> = {},
) =>
  effectSchema.parse({ type: 'motionBlur', ...options }) as Extract<Effect, { type: 'motionBlur' }>;
export const echo = (options: Omit<Extract<TemporalInput, { type: 'echo' }>, 'type'> = {}) =>
  effectSchema.parse({ type: 'echo', ...options }) as Extract<Effect, { type: 'echo' }>;
export { makeWarpGrid, pinGrid, type WarpPoint } from '../core/warp-grid.js';
export const meshWarp = (options: Omit<Extract<SpatialInput, { type: 'meshWarp' }>, 'type'>) =>
  effectSchema.parse({ type: 'meshWarp', ...options }) as Extract<Effect, { type: 'meshWarp' }>;
export const cornerPin = (
  corners: Extract<SpatialInput, { type: 'cornerPin' }>['corners'],
  options: Omit<Extract<SpatialInput, { type: 'cornerPin' }>, 'type' | 'corners'> = {},
) =>
  effectSchema.parse({ type: 'cornerPin', corners, ...options }) as Extract<
    Effect,
    { type: 'cornerPin' }
  >;
export const waveWarp = (options: Omit<Extract<SpatialInput, { type: 'waveWarp' }>, 'type'> = {}) =>
  effectSchema.parse({ type: 'waveWarp', ...options }) as Extract<Effect, { type: 'waveWarp' }>;
export const twirl = (options: Omit<Extract<SpatialInput, { type: 'twirl' }>, 'type'> = {}) =>
  effectSchema.parse({ type: 'twirl', ...options }) as Extract<Effect, { type: 'twirl' }>;
export const bulge = (options: Omit<Extract<SpatialInput, { type: 'bulge' }>, 'type'> = {}) =>
  effectSchema.parse({ type: 'bulge', ...options }) as Extract<Effect, { type: 'bulge' }>;
export const rgbSplit = (options: Omit<Extract<SpatialInput, { type: 'rgbSplit' }>, 'type'> = {}) =>
  effectSchema.parse({ type: 'rgbSplit', ...options }) as Extract<Effect, { type: 'rgbSplit' }>;
export const linearWipe = (
  progress: number,
  options: Omit<Extract<SpatialInput, { type: 'linearWipe' }>, 'type' | 'progress'> = {},
) =>
  effectSchema.parse({ type: 'linearWipe', progress, ...options }) as Extract<
    Effect,
    { type: 'linearWipe' }
  >;
export const radialWipe = (
  progress: number,
  options: Omit<Extract<SpatialInput, { type: 'radialWipe' }>, 'type' | 'progress'> = {},
) =>
  effectSchema.parse({ type: 'radialWipe', progress, ...options }) as Extract<
    Effect,
    { type: 'radialWipe' }
  >;
export const chromaKey = (
  color = '#00ff00',
  options: { tolerance?: number; softness?: number; despill?: number } = {},
) => effectSchema.parse({ type: 'chromaKey', color, ...options });
export const levels = (
  options: {
    inputBlack?: number;
    inputWhite?: number;
    gamma?: number;
    outputBlack?: number;
    outputWhite?: number;
  } = {},
) => effectSchema.parse({ type: 'levels', ...options });
export const curves = (options: {
  master?: Array<{ x: number; y: number }>;
  red?: Array<{ x: number; y: number }>;
  green?: Array<{ x: number; y: number }>;
  blue?: Array<{ x: number; y: number }>;
}) => effectSchema.parse({ type: 'curves', ...options });
export const vignette = (amount = 0.5, radius = 0.75, softness = 0.6) =>
  effectSchema.parse({ type: 'vignette', amount, radius, softness });
export const grain = (amount = 0.08, seed = 1, animated = true) =>
  effectSchema.parse({ type: 'grain', amount, seed, animated });
export const displacement = (
  options: {
    amountX?: number;
    amountY?: number;
    scale?: number;
    seed?: number;
    evolution?: number;
    octaves?: number;
    edge?: 'transparent' | 'clamp' | 'wrap';
  } = {},
) => effectSchema.parse({ type: 'displacement', ...options });
export const pixelate = (size = 12) => effectSchema.parse({ type: 'pixelate', size });
export function parseCube(source: string, intensity = 1): Effect {
  let size = 0;
  const data: number[] = [],
    min = [0, 0, 0],
    max = [1, 1, 1];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line || line.startsWith('TITLE')) continue;
    const [command, ...args] = line.split(/\s+/);
    if (command === 'LUT_3D_SIZE') {
      size = Number(args[0]);
      continue;
    }
    if (command === 'DOMAIN_MIN' || command === 'DOMAIN_MAX') {
      const values = args.map(Number);
      if (values.length !== 3 || values.some((v) => !Number.isFinite(v)))
        throw new Error('Invalid LUT domain');
      (command === 'DOMAIN_MIN' ? min : max).splice(0, 3, ...values);
      continue;
    }
    if (command.startsWith('LUT_') || command === 'LUT_1D_SIZE')
      throw new Error('Only a single 3D .cube LUT is supported');
    const values = [command, ...args].map(Number);
    if (values.length !== 3 || values.some((v) => !Number.isFinite(v)))
      throw new Error(`Invalid .cube line: ${raw}`);
    data.push(...values);
  }
  if (
    !Number.isInteger(size) ||
    size < 2 ||
    size > 33 ||
    data.length !== size ** 3 * 3 ||
    max.some((v, i) => v <= min[i])
  )
    throw new Error('LUT size/data/domain mismatch (supported sizes: 2–33)');
  return effectSchema.parse({
    type: 'lut3d',
    size,
    data,
    domainMin: min,
    domainMax: max,
    intensity,
  });
}
